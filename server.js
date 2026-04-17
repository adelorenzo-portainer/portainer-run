/**
 * Portainer Run — CORS proxy + AI relay + session cache
 *
 * Responsibilities:
 *  1. Serve HTTPS (443 by default) with self-signed or real certs
 *  2. Redirect HTTP (80) → HTTPS
 *  3. Proxy /portainer-api/* → Portainer (CORS bypass, user token passed through)
 *  4. Proxy /ai/triage → Anthropic OR any OpenAI-compatible API
 *     (key stored server-side, never in browser). Frontend always speaks the
 *     Anthropic /v1/messages shape; the proxy translates request + SSE response
 *     when the active provider is OpenAI-compatible.
 *  5. File-backed session cache keyed by hashed PAT (/cache GET/POST/DELETE)
 *     Default path: /app/data/cache.json — mount /app/data as a volume to persist
 *     across container restarts, or set CACHE_DIR to an external path.
 *
 * .env config:
 *   PORTAINER_URL=https://portainer.example.com:9443   (required)
 *   AI_PROVIDER=anthropic|openai                       (optional, auto-detected)
 *   ANTHROPIC_API_KEY=sk-ant-...                       (enables Anthropic provider)
 *   ANTHROPIC_MODEL=<model-id>                         (required when using Anthropic)
 *   OPENAI_API_KEY=sk-...                              (enables OpenAI provider)
 *   OPENAI_BASE_URL=https://api.openai.com/v1          (optional, OpenAI-compatible endpoint)
 *   OPENAI_MODEL=gpt-4o-mini                           (required when using OpenAI)
 *   PORT=443                                           (optional, default 443)
 *   HTTP_PORT=80                                       (optional, default 80)
 *   SSL_CERT=/path/to/fullchain.pem                    (optional, uses self-signed if not set)
 *   SSL_KEY=/path/to/privkey.pem                       (optional, uses self-signed if not set)
 *   SSL_CERT_DIR=/certs                                (optional, dir for self-signed cert storage)
 *   CACHE_DIR=/app/data                                (optional, dir for cache.json)
 */

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const url     = require('url');
const cp      = require('child_process');
const crypto  = require('crypto');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .forEach(l => {
      const [k, ...v] = l.split('=');
      if (k && !process.env[k.trim()]) {
        process.env[k.trim()] = v.join('=').trim().replace(/^["']|["']$/g, '');
      }
    });
}

const PORTAINER_URL    = (process.env.PORTAINER_URL || '').replace(/\/$/, '');
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL  = process.env.ANTHROPIC_MODEL || '';
const OPENAI_KEY       = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL  = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const OPENAI_MODEL     = process.env.OPENAI_MODEL || '';
const AI_PROVIDER_ENV  = (process.env.AI_PROVIDER || '').toLowerCase();
const PORT             = parseInt(process.env.PORT      || '443');
const HTTP_PORT        = parseInt(process.env.HTTP_PORT || '80');
const SSL_CERT_PATH    = process.env.SSL_CERT     || '';
const SSL_KEY_PATH     = process.env.SSL_KEY      || '';
const CERT_DIR         = process.env.SSL_CERT_DIR || __dirname;
const CACHE_DIR        = process.env.CACHE_DIR    || path.join(__dirname, 'data');
const CACHE_FILE       = path.join(CACHE_DIR, 'cache.json');

if (!PORTAINER_URL) {
  console.error('\n❌  PORTAINER_URL must be set\n');
  process.exit(1);
}

try { new URL(PORTAINER_URL); } catch(_) {
  console.error(`\n❌  Invalid PORTAINER_URL: "${PORTAINER_URL}"\n`);
  process.exit(1);
}

// ── AI PROVIDER SELECTION ────────────────────────────────────────────────────
// Frontend always speaks the Anthropic /v1/messages shape. The proxy picks an
// upstream provider once at startup and translates requests/responses when the
// active provider is OpenAI-compatible.
function pickProvider() {
  if (AI_PROVIDER_ENV === 'openai')    return OPENAI_KEY    ? 'openai'    : null;
  if (AI_PROVIDER_ENV === 'anthropic') return ANTHROPIC_KEY ? 'anthropic' : null;
  if (AI_PROVIDER_ENV) {
    console.error(`\n❌  Unknown AI_PROVIDER: "${AI_PROVIDER_ENV}" (expected "anthropic" or "openai")\n`);
    process.exit(1);
  }
  if (ANTHROPIC_KEY) return 'anthropic';
  if (OPENAI_KEY)    return 'openai';
  return null;
}
const AI_PROVIDER = pickProvider();

let OPENAI_ORIGIN = null;
if (AI_PROVIDER === 'openai') {
  if (!OPENAI_MODEL) {
    console.error('\n❌  OPENAI_MODEL must be set when using the OpenAI provider\n');
    process.exit(1);
  }
  try { OPENAI_ORIGIN = new URL(OPENAI_BASE_URL); } catch(_) {
    console.error(`\n❌  Invalid OPENAI_BASE_URL: "${OPENAI_BASE_URL}"\n`);
    process.exit(1);
  }
}

if (AI_PROVIDER === 'anthropic' && !ANTHROPIC_MODEL) {
  console.error('\n❌  ANTHROPIC_MODEL must be set when using the Anthropic provider\n');
  process.exit(1);
}

const ACTIVE_MODEL = AI_PROVIDER === 'openai' ? OPENAI_MODEL
                   : AI_PROVIDER === 'anthropic' ? ANTHROPIC_MODEL
                   : null;

if (!AI_PROVIDER) {
  console.warn('\n⚠️   No AI provider configured (set ANTHROPIC_API_KEY or OPENAI_API_KEY) — AI triage will be unavailable\n');
}

const pOrigin  = new URL(PORTAINER_URL);
const pIsHttps = pOrigin.protocol === 'https:';
const pHost    = pOrigin.hostname;
const pPort    = pOrigin.port ? parseInt(pOrigin.port) : (pIsHttps ? 443 : 80);

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-API-Key,Authorization',
};

// ── FILE-BACKED SESSION CACHE ─────────────────────────────────────────────────
// Keyed by SHA-256 hash of the user's PAT.
// Cleared on disconnect (DELETE /cache). Persists across container restarts
// if CACHE_DIR is mounted as an external volume.

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheKey(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function readCacheFile() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch(_) {}
  return {};
}

function writeCacheFile(data) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf8');
  } catch(e) {
    console.warn('[cache] write failed:', e.message);
  }
}

function handleCache(req, res) {
  const token = req.headers['x-api-key'] || '';
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: 'X-API-Key header required' }));
    return;
  }
  const key = cacheKey(token);

  if (req.method === 'GET') {
    const all   = readCacheFile();
    const entry = all[key] || null;
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(entry));
    return;
  }

  if (req.method === 'POST') {
    readBody(req).then(body => {
      try {
        const data  = JSON.parse(body.toString());
        const all   = readCacheFile();
        all[key]    = { ...data, savedAt: Date.now() };
        writeCacheFile(all);
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ ok: true }));
      } catch(_) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (req.method === 'DELETE') {
    const all = readCacheFile();
    delete all[key];
    writeCacheFile(all);
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(405, CORS);
  res.end();
}

// ── TLS CERT SETUP ────────────────────────────────────────────────────────────
function ensureSelfSignedCert(certFile, keyFile) {
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) return;
  console.log('🔐  Generating self-signed certificate (3 year validity)...');
  try {
    cp.execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes` +
      ` -keyout "${keyFile}"` +
      ` -out "${certFile}"` +
      ` -days 1095` +
      ` -subj "/CN=portainer-run"` +
      ` -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"`,
      { stdio: 'pipe' }
    );
    console.log('✅  Self-signed certificate generated');
  } catch(e) {
    console.error('❌  Failed to generate self-signed cert:', e.message);
    process.exit(1);
  }
}

function loadTlsOptions() {
  if (SSL_CERT_PATH && SSL_KEY_PATH) {
    if (!fs.existsSync(SSL_CERT_PATH)) { console.error(`\n❌  SSL_CERT not found: ${SSL_CERT_PATH}\n`); process.exit(1); }
    if (!fs.existsSync(SSL_KEY_PATH))  { console.error(`\n❌  SSL_KEY not found: ${SSL_KEY_PATH}\n`);  process.exit(1); }
    console.log('🔐  Using provided TLS certificates');
    return { cert: fs.readFileSync(SSL_CERT_PATH), key: fs.readFileSync(SSL_KEY_PATH) };
  }
  const certFile = path.join(CERT_DIR, 'portainer-run.crt');
  const keyFile  = path.join(CERT_DIR, 'portainer-run.key');
  ensureSelfSignedCert(certFile, keyFile);
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : null));
    req.on('error', reject);
  });
}

function proxyToPortainer(req, res, upstreamPath, body) {
  const userToken = req.headers['x-api-key'] || '';
  const headers = {
    'Content-Type': req.headers['content-type'] || 'application/json',
    'Accept': 'application/json',
  };
  if (userToken) headers['X-API-Key'] = userToken;
  if (body && body.length) headers['Content-Length'] = body.length;

  const opts = {
    hostname: pHost, port: pPort, path: upstreamPath,
    method: req.method, headers, rejectUnauthorized: false,
  };
  const transport = pIsHttps ? https : http;
  const upstream = transport.request(opts, upRes => {
    const resHeaders = { ...CORS, 'Content-Type': upRes.headers['content-type'] || 'application/json' };
    if (upRes.headers['content-encoding']) resHeaders['Content-Encoding'] = upRes.headers['content-encoding'];
    res.writeHead(upRes.statusCode, resHeaders);
    upRes.pipe(res);
  });
  upstream.on('error', e => {
    console.error('[portainer proxy error]', e.message);
    res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: 'Proxy error', message: e.message }));
  });
  if (body && body.length) upstream.write(body);
  upstream.end();
}

function proxyToAnthropic(req, res, payload) {
  // Server is authoritative on model selection; ignore any model field the
  // frontend sent so the choice lives entirely in env config.
  payload = { ...payload, model: ANTHROPIC_MODEL };
  const outBody = Buffer.from(JSON.stringify(payload));
  const headers = {
    'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY,
    'anthropic-version': '2023-06-01', 'Content-Length': outBody.length,
  };
  const upstream = https.request(
    { hostname: 'api.anthropic.com', port: 443, path: '/v1/messages', method: 'POST', headers },
    upRes => {
      res.writeHead(upRes.statusCode, {
        ...CORS,
        'Content-Type':  upRes.headers['content-type'] || 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      upRes.pipe(res);
    }
  );
  upstream.on('error', e => {
    console.error('[anthropic proxy error]', e.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: { message: e.message } }));
    }
  });
  upstream.write(outBody);
  upstream.end();
}

// Translate frontend's Anthropic-shaped payload into an OpenAI chat/completions
// request. The frontend sends: { model, max_tokens, stream, system?, messages }.
// `system` is lifted into a leading {role:"system"} message; `model` is replaced
// with the server-configured OPENAI_MODEL; everything else passes through.
function buildOpenAIPayload(anthropicPayload) {
  const messages = [];
  if (anthropicPayload.system) {
    messages.push({ role: 'system', content: String(anthropicPayload.system) });
  }
  for (const m of (anthropicPayload.messages || [])) {
    // Anthropic content can be a string or an array of content blocks.
    let content = m.content;
    if (Array.isArray(content)) {
      content = content.map(b => (typeof b === 'string' ? b : (b.text || ''))).join('');
    }
    messages.push({ role: m.role, content: String(content || '') });
  }
  const out = {
    model: OPENAI_MODEL,
    messages,
    stream: !!anthropicPayload.stream,
  };
  if (anthropicPayload.max_tokens != null)  out.max_tokens  = anthropicPayload.max_tokens;
  if (anthropicPayload.temperature != null) out.temperature = anthropicPayload.temperature;
  if (anthropicPayload.top_p != null)       out.top_p       = anthropicPayload.top_p;
  return out;
}

// Frontend's non-streaming consumer reads `data.content[].text` (Anthropic shape).
// OpenAI returns choices[0].message.content; wrap it.
function openAINonStreamingToAnthropic(openAIResponse) {
  const text = openAIResponse?.choices?.[0]?.message?.content || '';
  const finish = openAIResponse?.choices?.[0]?.finish_reason || 'end_turn';
  return {
    id: openAIResponse?.id || '',
    type: 'message',
    role: 'assistant',
    model: openAIResponse?.model || OPENAI_MODEL,
    content: [{ type: 'text', text }],
    stop_reason: finish === 'stop' ? 'end_turn' : finish,
    usage: openAIResponse?.usage
      ? { input_tokens: openAIResponse.usage.prompt_tokens || 0,
          output_tokens: openAIResponse.usage.completion_tokens || 0 }
      : undefined,
  };
}

function proxyToOpenAI(req, res, payload) {
  const stream = !!payload.stream;
  const outPayload = buildOpenAIPayload(payload);
  const outBody = Buffer.from(JSON.stringify(outPayload));

  const isHttps = OPENAI_ORIGIN.protocol === 'https:';
  const transport = isHttps ? https : http;
  const opts = {
    hostname: OPENAI_ORIGIN.hostname,
    port:     OPENAI_ORIGIN.port ? parseInt(OPENAI_ORIGIN.port) : (isHttps ? 443 : 80),
    path:     OPENAI_ORIGIN.pathname.replace(/\/$/, '') + '/chat/completions',
    method:   'POST',
    headers: {
      'Content-Type':   'application/json',
      'Accept':         stream ? 'text/event-stream' : 'application/json',
      'Authorization':  `Bearer ${OPENAI_KEY}`,
      'Content-Length': outBody.length,
    },
  };

  const upstream = transport.request(opts, upRes => {
    // Non-2xx: forward the OpenAI error JSON unchanged. The frontend reads
    // `error.message`, which is also OpenAI's error shape.
    if (upRes.statusCode < 200 || upRes.statusCode >= 300) {
      res.writeHead(upRes.statusCode, {
        ...CORS,
        'Content-Type': upRes.headers['content-type'] || 'application/json',
      });
      upRes.pipe(res);
      return;
    }

    if (!stream) {
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const translated = openAINonStreamingToAnthropic(parsed);
          res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
          res.end(JSON.stringify(translated));
        } catch(e) {
          res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
          res.end(JSON.stringify({ error: { message: 'Failed to parse OpenAI response: ' + e.message } }));
        }
      });
      return;
    }

    // Streaming: translate OpenAI SSE chunks (data: {choices:[{delta:{content}}]})
    // into the minimal Anthropic SSE event the frontend consumes:
    //   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
    res.writeHead(200, {
      ...CORS,
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });

    let buf = '';
    upRes.setEncoding('utf8');
    upRes.on('data', chunk => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') { res.write('data: [DONE]\n\n'); continue; }
        try {
          const evt = JSON.parse(data);
          const text = evt?.choices?.[0]?.delta?.content;
          if (typeof text === 'string' && text.length > 0) {
            const translated = {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text },
            };
            res.write(`data: ${JSON.stringify(translated)}\n\n`);
          }
        } catch(_) { /* ignore non-JSON keepalives etc. */ }
      }
    });
    upRes.on('end', () => res.end());
    upRes.on('error', e => {
      console.error('[openai stream error]', e.message);
      if (!res.writableEnded) res.end();
    });
  });

  upstream.on('error', e => {
    console.error('[openai proxy error]', e.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: { message: e.message } }));
    }
  });
  upstream.write(outBody);
  upstream.end();
}

function proxyToAI(req, res, body) {
  if (!AI_PROVIDER) {
    res.writeHead(503, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: { message: 'No AI provider configured on server (set ANTHROPIC_API_KEY or OPENAI_API_KEY)' } }));
    return;
  }
  let payload;
  try { payload = JSON.parse((body || Buffer.alloc(0)).toString()); } catch(_) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }));
    return;
  }
  if (AI_PROVIDER === 'anthropic') return proxyToAnthropic(req, res, payload);
  if (AI_PROVIDER === 'openai')    return proxyToOpenAI(req, res, payload);
}

// ── REQUEST HANDLER ───────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  const parsed   = url.parse(req.url);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  if (pathname === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({
      portainerUrl: PORTAINER_URL,
      aiAvailable:  !!AI_PROVIDER,
      aiProvider:   AI_PROVIDER,
      aiModel:      ACTIVE_MODEL,
    }));
    return;
  }

  // Session cache endpoints
  if (pathname === '/cache') {
    handleCache(req, res);
    return;
  }

  if (pathname.startsWith('/portainer-api/')) {
    const body = await readBody(req);
    const upstreamPath = '/api/' + pathname.slice('/portainer-api/'.length) + (parsed.search || '');
    proxyToPortainer(req, res, upstreamPath, body);
    return;
  }

  if (pathname === '/ai/triage') {
    const body = await readBody(req);
    proxyToAI(req, res, body);
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'portainer-run.html');
    if (!fs.existsSync(htmlPath)) { res.writeHead(404); res.end('portainer-run.html not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(htmlPath).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

// ── START SERVERS ─────────────────────────────────────────────────────────────
const tlsOptions  = loadTlsOptions();
const httpsServer = https.createServer(tlsOptions, handleRequest);

httpsServer.listen(PORT, () => {
  let aiLine = '✗ not configured';
  if (AI_PROVIDER === 'anthropic') aiLine = `✓ anthropic (${ANTHROPIC_MODEL})`;
  if (AI_PROVIDER === 'openai')    aiLine = `✓ openai-compatible (${OPENAI_MODEL} @ ${OPENAI_BASE_URL})`;
  console.log('\n✅  Portainer Run started');
  console.log(`    UI:        https://localhost${PORT !== 443 ? ':' + PORT : ''}`);
  console.log(`    Portainer: ${PORTAINER_URL}`);
  console.log(`    AI triage: ${aiLine}`);
  console.log(`    TLS:       ${SSL_CERT_PATH ? 'provided certs' : 'self-signed (portainer-run.crt)'}`);
  console.log(`    Cache:     ${CACHE_FILE}`);
  console.log(`    HTTP ${HTTP_PORT} → redirecting to HTTPS\n`);
});

httpsServer.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`\n❌  Port ${PORT} already in use\n`);
  else console.error('\n❌ ', e.message, '\n');
  process.exit(1);
});

const httpServer = http.createServer((req, res) => {
  const host   = (req.headers.host || 'localhost').replace(/:\d+$/, '');
  const target = `https://${host}${PORT !== 443 ? ':' + PORT : ''}${req.url}`;
  res.writeHead(301, { Location: target });
  res.end();
});
httpServer.listen(HTTP_PORT);
httpServer.on('error', e => {
  console.warn(`⚠️   HTTP redirect on port ${HTTP_PORT} unavailable: ${e.message}`);
});
