# dsh-api-outlet (cloud)

Authenticated OpenAI-compatible API outlet over DSH's already-registered
providers, rebuilt as an independent cloud package. This is **not** the local
Windows plugin: it drops tunnels and per-machine Windows assumptions, keeps the
loopback API/admin split, and adds per-client keys, image input, and a
Responses subset.

- API (public, via Nginx `/v1` reverse proxy): `http://127.0.0.1:19388`
- Admin (loopback only): `http://127.0.0.1:19389`
- Reuses `ctx.llm.prepareCall` — no second OAuth, no CLIProxyAPI, no second Host.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/models` | client Bearer | Full `provider/model` ids + capabilities |
| POST | `/v1/chat/completions` | client Bearer | Chat Completions (stream + non-stream + tools) |
| POST | `/v1/responses` | client Bearer | Responses subset (text/image/function_call, stream) |

Admin (loopback, `x-outlet-admin` token from the 0600 state file):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | Liveness (no token) |
| GET | `/status` | Gateway counters (redacted) |
| GET | `/clients` | Client list (ids/labels/timestamps, no keys) |
| POST | `/clients` | Create client; returns plaintext key exactly once |
| POST | `/clients/rotate` | Rotate a client key |
| POST | `/clients/revoke` | Revoke a client key |
| GET | `/models` | Allowed model list |
| GET | `/catalog` | Full management catalog |
| GET/POST | `/settings` | Read/update provider and model allowlists |
| GET | `/usage` | Cumulative per-client token usage |

## Default limits

2 concurrent upstream calls · 60 req/min · 10 min timeout · 20 MiB body ·
≤3 images/request · ≤5 MiB/image · 1024 messages · 128 tools. A stricter
provider limit is always honored because the upstream adapter rejects first.

## Security model

- API and admin bind `127.0.0.1` only; the public edge terminates TLS and
  proxies `/v1` (never `19389`).
- Client keys: only a SHA-256 digest is stored. Plaintext is returned exactly
  once (create/rotate) to the loopback admin caller over the SSH management
  channel. Keys never enter logs, stdout, or test artifacts.
- Tool calls are returned to the client; the outlet never executes tools.
- Prompts and request bodies are not logged; only counters are kept.
- Remote image URLs are rejected (SSRF guard); only bounded base64 data URLs
  are accepted, decoded and admitted via `ctx.attachments.saveImages`.
- Admin token lives in the 0600 state file; it is never returned by any route.

## Install / run (on the cloud Host)

Install this package into the cloud profile as a bundle (see
`cordis.patch.yml`), with `DSH_PROFILE_DIR=/srv/oracle-ai/dsh-home/profiles/cloud`
exported. The patch mounts the plugin row; the host half reads `ctx.llm`.
This local revision is `1.1.3-local`; its host entry is `lib/host.js`.

For image uploads through Nginx, set `client_max_body_size 20m;` inside the
existing `location /v1/` block, validate with `nginx -t`, and reload Nginx.
Otherwise its default 1 MiB limit rejects ordinary base64 image requests with
HTTP 413 **before the outlet sees them**, despite the outlet's 20 MiB budget.
Keep the edge limit aligned if you change `bodyLimit`.

Chat image content accepts `image_url: { url: "data:image/png;base64,..." }`
and the compatible-client shorthand `image_url: "data:image/png;base64,..."`.
Responses accepts standard `{ role: "user", content: [...] }` input messages
without an explicit `type: "message"`. Use a model advertising `image` in
`input_modalities`; remote URLs remain rejected to prevent SSRF.
Build the browser half with `npm run build` before packaging. Install the
package normally so DSH discovers its `dsh.client` declaration. Keep the
profile entry named `@oracle-ai/dsh-api-outlet`: use an override, not another
`insert`, if the bundle already inserted it. The original installed `1.0.0`
package remains a rollback baseline. `SHA256SUMS` covers the release files.

## Official plugin configuration window

Open the official plugin manager, select `@oracle-ai/dsh-api-outlet`, and use
its configuration panel. It can select subscription providers and canonical
models, save changes without restarting the outlet, and filter token usage
by downstream client. Source and model selections are intersected; `null`
means unrestricted while `[]` means none. Model aliases and effort variants
cannot bypass a disabled provider or base model. New models remain closed
when an explicit model allowlist is saved.

The panel calls owner-only DSH Connection routes: GET
`/api/dsh-api-outlet/snapshot` and POST `/api/dsh-api-outlet/settings`.
They require the current DSH owner session, enforce same-origin writes, and
never return subscription credentials, downstream keys or the admin token.
Do not expose the loopback admin port to make the panel work.

Usage is persistent per downstream client, including revoked clients. Counts
start when this revision is enabled; old calls cannot be reconstructed.
Only upstream-reported token usage is counted, unknown usage is marked
separately, and no monetary charge or token estimate is inferred. Details
and the additional loopback admin routes are documented in `ADMIN.md`.

## Selecting reasoning effort

Refresh the downstream client's model list and choose an advertised
`<provider>/<model>@<effort>` variant if the client has no reasoning selector.
For example, `codex-chatgpt/gpt-5.6-luna@high` selects `high` without changing
the real upstream model. Only adapter-advertised levels are listed; do not
assume every model supports `low`, `high`, `max`, or turning thinking off.

Clients with parameter support may use the unchanged base model id and send
`"reasoning_effort": "high"` to Chat Completions, or
`"reasoning": { "effort": "high" }` to Responses. Responses also accepts the
legacy `reasoning_effort` field; if both fields are sent they must agree.
Explicit parameters override the variant's default. Omitting all controls on
a base model preserves the upstream default. Unsupported levels return 400.
Reasoning summaries and encrypted reasoning replay remain unsupported.

## Offline tests (no upstream, no real keys)

```
npm test
```

The bundled regression suite uses Node's built-in test runner and mock LLM
adapters with real loopback HTTP requests. It checks protocol conversion,
reasoning capabilities, variants, validation, authentication, and both
streaming and non-streaming responses. No dependency installation is needed.
The original deployment's separate `tests/outlet` suites are not bundled here.

## What this is NOT

- Not a full OpenAI/Anthropic server. Unsupported protocol fields are rejected
  explicitly (HTTP 400 `unsupported_field`), never silently dropped.
- Not official Responses/Codex CLI compatibility. `previous_response_id`,
  `store: true`, hosted tools, and encrypted reasoning are rejected. Chat
  Completions accepts `store: false` as a no-op because OpenAI-compatible
  clients (including pi-ai) send it by default; the outlet itself is stateless.
  Chat Completions also accepts the client default `top_p: 1` (or `null`) as
  a no-op. Non-default `top_p` stays rejected: DSH exposes no nucleus-sampling
  control, so the outlet cannot honestly apply it.
- Not a tunnel provider, not an OAuth gateway, not HA, not a second queue.

See PROTOCOL.md (support matrix), PROVIDERS.md (model id rules),
ADMIN.md (management operations).
