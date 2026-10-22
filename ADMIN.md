# Management & operations

## State layout

- State dir (config `stateDir`, default `<DSH_PROFILE_DIR>/.api-outlet`):
  `state.json` (0600) holds the admin token, client ledger (id/label/digest/
  timestamps), provider/model allowlists and cumulative per-client usage.
  No plaintext client keys are persisted. `stateFile` sets an
  explicit state file path and overrides `stateDir`.
- On first start the admin token is generated and written to `state.json`.
  Read it there for the SSH management channel; never log or commit it.

## Official plugin configuration window

In the official plugin manager, select `@oracle-ai/dsh-api-outlet` and open
its embedded configuration panel. No admin token entry or SSH tunnel is
needed for the panel. It uses these authenticated owner-only Connection
Fetch routes on the existing DSH origin:

- GET `/api/dsh-api-outlet/snapshot`: redacted settings, full catalog and usage.
- POST `/api/dsh-api-outlet/settings`: save provider/model selection and return
  a fresh snapshot. Only JSON from the current GUI authority is accepted.

The existing DSH Host/Origin fence, browser authentication and owner checks
run before these routes. A downstream Bearer key cannot manage the plugin.
No subscriber credentials, admin token or key digests are sent to the panel.

Selections are `{allowedProviders: null | string[], allowedModels: null |
string[]}`. `null` opens all current and future entries; `[]` closes all.
An explicit model allowlist contains canonical `provider/model` ids only;
variants and aliases inherit their underlying model's admission. Source
and model allowlists are intersected on every list and request. Saving is
immediate and does not restart the gateway or change existing keys.

The loopback admin additionally provides GET `/catalog` (unfiltered
inventory), GET/POST `/settings`, and GET `/usage`, all requiring the same
admin authentication as existing management routes.

## Token accounting

Persistent counts begin when this revision is enabled. The panel can show
all clients or one downstream client; revoked clients retain their history.
Metrics include input, output, cache-read, cache-write and total tokens,
requests, failed requests and requests with unknown usage. Only actual
upstream usage is counted; missing usage is unknown, not free consumption.
There are no billing estimates, no prompt logging, and no reconstructed
historical usage. In-memory concurrency/rate counters remain distinct from
these cumulative counts.

## Accessing the loopback admin

The admin server listens on `127.0.0.1:19389` only. Reach it over SSH:

```
ssh -L 19389:127.0.0.1:19389 ubuntu@150.230.220.176
```

Then, from the local machine, call it with the admin token from `state.json`:

```
curl -H "x-outlet-admin: <admin-token>" http://127.0.0.1:19389/status
```

## Client key lifecycle

Create (returns the key exactly once):

```
curl -X POST -H "x-outlet-admin: <token>" -H "content-type: application/json" \
  -d '{"label":"phone"}' http://127.0.0.1:19389/clients
```

Rotate:

```
curl -X POST -H "x-outlet-admin: <token>" -H "content-type: application/json" \
  -d '{"id":"<client-id>"}' http://127.0.0.1:19389/clients/rotate
```

Revoke:

```
curl -X POST -H "x-outlet-admin: <token>" -H "content-type: application/json" \
  -d '{"id":"<client-id>"}' http://127.0.0.1:19389/clients/revoke
```

## Rollback

The package is a stateless-computation bundle + one 0600 state file. Rollback is
a package revert (pin the previous tarball) — client keys live only in the
state file and are untouched by a code revert. To fully reset API access,
revoke all clients or replace `state.json` (this also rotates the admin
token). The package contains no provider credentials, prompts, or account
state; those belong to the cloud profile and the subscription plugin, managed
by Agent D.

## Known limitations

- Single instance; no HA, no cross-restart in-flight stream resume.
- Rate limiter is a fixed window (60 s), not a token bucket; burst boundaries
  are approximate.
- The fixed-window request counter is in-memory and resets on restart.
- No official OpenAI Responses/Codex CLI compatibility (see PROTOCOL.md).
- Images are accepted only as bounded base64 data URLs, never remote URLs.
