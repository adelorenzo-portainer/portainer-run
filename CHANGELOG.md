# Changelog

All notable changes to this fork of [portainer-run](https://github.com/portainer/portainer-run)
are documented here. Entries cover the delta from upstream `develop` at commit
`7966dce` onward.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Commit hashes are 7-char prefixes against this fork's `feat/openai-compatible-provider`
branch.

## [Unreleased]

### Added
- Secret and ConfigMap references for environment variables, in both forms.
  Each env-var row gains a Source dropdown — Value (inline, default), Secret
  (reveals secret-name + key, serialises to `valueFrom.secretKeyRef`), or
  ConfigMap (likewise to `valueFrom.configMapKeyRef`). Existing `valueFrom`
  entries are detected on Edit-tab load and pre-fill the matching mode. The
  chat assistant's deploy-config schema accepts three env shapes
  (`{name,value}`, `{name,secretRef:{name,key}}`, `{name,configMapRef:{name,key}}`)
  and is instructed to prefer secretRef whenever a value looks like a
  credential. The Compose translator emits inline values but warns on
  credential-shaped keys (`*_PASSWORD`, `*_TOKEN`, …). [`204a351`, `fc828f0`]
- Per-namespace resource quota indicator on the Deploy form. After selecting a
  namespace, a single-line summary appears below the dropdown showing CPU,
  memory, and pod usage vs. the binding hard limit (e.g.
  `Quota: CPU 1.2 / 4 · Mem 3Gi / 8Gi · Pods 12 / 30`). Aggregates correctly
  across multiple ResourceQuotas in a namespace (uses `min(hard)` and
  `max(used)` — the "worst case" view since Kubernetes admits only if every
  RQ passes). Turns amber when any dimension is past 80% capacity. Silent
  when the namespace has no quota or the token can't list ResourceQuotas.
- OpenAI-compatible AI provider support via `OPENAI_API_KEY`, `OPENAI_BASE_URL`,
  `OPENAI_MODEL`. Works with OpenAI, Azure OpenAI, OpenRouter, Together AI, vLLM,
  Ollama, LM Studio, and any endpoint that speaks the OpenAI `/chat/completions`
  shape. The frontend continues to send Anthropic-shaped requests; the proxy
  translates request and streaming response when OpenAI is active. [`8cf7b6c`]
- `AI_PROVIDER` env var to explicitly select the provider when both keys are set;
  auto-detected otherwise. [`8cf7b6c`]
- `+ New` button on the Deploy form's namespace field. Creates namespaces with
  DNS-1123 client-side validation, tagged `managed-by=portainer-run` for
  consistency with every Deployment/Service/PVC/Ingress the app creates.
  Inline error handling for 409/401/403/422 responses. [`e46c211`]
- Expanded markdown rendering in the AI Analyse and chat panels: `#` through
  `######` headers, GFM tables, blockquotes, italics (`*em*`), and horizontal
  rules. Previously only `#`/`##`/`###` (all collapsed to `<h3>`), bold, inline
  code, fenced code, and lists were rendered. [`06fbcb7`]
- Deployment recipes in the README for Ollama / OpenAI-compatible endpoints and
  for `docker compose` using a `.env` file. [`9238a39`]
- `.gitignore` for local runtime artifacts (`*.crt`, `*.key`, `.env`,
  `data/`). [`13523ad`]

### Changed
- `ANTHROPIC_MODEL` env var is now required when using the Anthropic provider;
  no default value. Symmetric with `OPENAI_MODEL`. [`bd61a2e`]
- Model selection is now fully server-side for both providers. The frontend no
  longer sends a hardcoded model identifier; whichever model reaches the
  upstream API and whichever string appears in the UI comes entirely from the
  server-side env config. [`bd61a2e`]
- `/config` endpoint now returns `aiProvider` and `aiModel` for both providers
  (previously only populated these for OpenAI). [`bd61a2e`]
- AI badge label is provider-aware: `Claude` for Anthropic, the configured model
  name for OpenAI-compatible providers, hidden when no provider is
  configured. [`4514c90`]
- Deploy form's namespace dropdown now refreshes on every tab visit instead of
  once at login; the current selection is preserved across refresh. Namespaces
  added on the cluster after login appear without reconnecting. [`e46c211`]
- System namespaces are filtered from the namespace picker. Uses Portainer's
  native endpoint (`IsSystem` flag) when available so any namespace flagged as
  system in Portainer's UI is honoured; falls back to a conventional blocklist
  (`kube-system`, `kube-public`, `kube-node-lease`, `portainer`,
  `portainer-agent`, `portainer-agent-system`) for older Portainer versions or
  namespace-scoped tokens. The "N accessible namespace(s)" count reflects the
  filtered list. [`e46c211`]
- Chat system prompt now spells out the required `deploy-config` fence and the
  schema, matching the strictness the Compose-paste path already had. Smaller
  models previously drifted to ```json``` or bare JSON and the "Open in Deploy
  form" button wouldn't appear. [`06fbcb7`]
- All "Claude" strings removed from the fork's source. Any Claude-brand text
  the user sees comes from their own env configuration (e.g. setting
  `ANTHROPIC_MODEL=claude-sonnet-4-...`). [`bd61a2e`]
- All three AI system prompts (chat assistant, Compose translator, AI Analyse)
  now instruct the model to reply in English using Latin characters only.
  Qwen-family models occasionally drift into Chinese tokens — especially on
  connector words or chain-of-thought output — and the directive stops it.
  Benign on Claude / GPT / other models which follow input language by
  default. [`0f28928`]

### Fixed
- "Open in Deploy form" button now appears reliably across models. New
  `extractDeployConfig` helper tolerates ```deploy-config``` (canonical), any
  fenced block whose JSON has `name` + `containers[]`, or bare JSON with the
  same shape. Both the chat handler and Compose-paste handler share the
  helper. [`06fbcb7`]
- Namespaces added on the cluster after login now appear in the Deploy form's
  dropdown without a full logout/login cycle. [`e46c211`]
- Markdown header regex no longer consumes a trailing newline. The previous
  `\s*$` pattern with `/gm` was greedy across the newline after the header
  text, causing the next paragraph to collapse onto the same line. Replaced
  with `[ \t]*$` in both header and blockquote patterns. [`06fbcb7`]
- Session cache (`cache.json`) is no longer at risk of corruption or lost
  updates. Writes now go via a `.tmp.<pid>` sibling + atomic rename, so a
  crash mid-write can't truncate the file. Concurrent read-modify-write
  operations are serialised through a single promise chain so two overlapping
  POSTs/DELETEs can't drop one another's update. [`03f53d0`]

### Security
- `esc()` is now safe to interpolate inside HTML attributes. Previously it
  only escaped `& < >`, so a Kubernetes value containing a literal `"` (image
  tag, env var value, label) could break out of `value="..."` / `title="..."`
  and inject arbitrary JavaScript. Now also escapes `"` and `'`. Used in
  roughly ten attribute-interpolation sites across the deployment list, edit
  form, and namespace/pod dropdowns. [`0f28928`]
- `/ai/triage` now requires a valid Portainer `X-API-Key`. Previously anyone
  reachable at the proxy could burn the server-configured Anthropic or
  OpenAI-compatible credits by hitting the endpoint directly, since no signal
  tied the caller to the authenticated session. Tokens are validated against
  Portainer's `/api/users/me`, with a 60-second positive cache keyed by
  sha256(token) so we don't round-trip per AI request; negative results are
  not cached so rotated/revoked tokens take effect on the next call. [`3118160`]
- Container now runs as non-root (`node`, uid 1000). `CAP_NET_BIND_SERVICE` is
  granted on the node binary via `setcap` at build time so binding 443/80
  still works. Closes a standard container-hardening gap — a compromise of
  the Node process no longer has uid 0 inside the container. [`11eb139`]
