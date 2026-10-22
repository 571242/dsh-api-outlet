# Protocol support matrix

## Chat Completions `POST /v1/chat/completions`

| Field | Status | Notes |
| --- | --- | --- |
| `model` | required | Full `provider/model` id, or a configured alias |
| `messages` | required | roles: system/developer/user/assistant/tool |
| `stream` | bool | SSE; `[DONE]` terminated |
| `stream_options.include_usage` | bool | extra usage chunk before `[DONE]` |
| `temperature` | 0..2 | forwarded |
| `max_tokens` / `max_completion_tokens` | int >0 | forwarded |
| `reasoning_effort` | non-empty string | exact adapter-owned id from `/v1/models[].reasoning_efforts`; unsupported ids return 400 |
| `tools` | function[] | ≤128; returned to client, never executed |
| `tool_choice` | auto/none | |
| `store` | bool | `false` accepted as a no-op (pi-ai and other OpenAI-compatible clients send it by default; this outlet is stateless); `true` **rejected** 400 |
| `top_p` | default `1` / `null` accepted | No-op for OpenAI-compatible clients; DSH exposes no nucleus-sampling control. Non-default values are **rejected** 400 `unsupported_field`, never silently ignored. |
| `stop` | **rejected** (except empty) | 400 |
| `frequency_penalty` / `presence_penalty` | **rejected** (except 0) | 400 |
| `logprobs` / `logit_bias` / `response_format` / `functions` / `function_call` / `seed` / `service_tier` / `user` | **rejected** | 400 |
| `n` | only 1 | otherwise 400 |

Response: standard `chat.completion`, with `reasoning_content` on the message
and `tool_calls` (content `null` when only tool calls). Streaming deltas carry
`content`, `reasoning_content`, and `tool_calls`.

## Responses subset `POST /v1/responses`

| Field | Status |
| --- | --- |
| `model` | required (full id or alias) |
| `input` | string or input items |
| `instructions` | → system message |
| `temperature` / `max_output_tokens` | forwarded |
| `reasoning.effort` | standard Responses effort; exact adapter-owned id |
| `reasoning_effort` | legacy spelling; if both effort fields are sent they must agree |
| `tools` | function only |
| `tool_choice` | auto/none |
| `stream` | SSE |

Input items: `message` (user/assistant/system/developer), `function_call`,
`function_call_output`.

Explicitly **rejected** (400 `unsupported_field`): `previous_response_id`,
`store`, `metadata`, `service_tier`, `safety_identifier`, `user`,
`parallel_tool_calls`, `include`, reasoning fields other than `reasoning.effort`
(including summary controls and encrypted reasoning), hosted tools
(`code_interpreter` etc.).

Both protocols also accept advertised `<provider>/<model>@<effort>` model ids.
An explicit effort overrides the model variant's default. The unchanged base
id without an explicit effort preserves the upstream default. Effort values
are never normalized, clamped, or guessed; consult `reasoning_efforts` and
`default_reasoning_effort` in `GET /v1/models`.

## Image input (both protocols)

- `image_url.url` (chat) / `input_image.image_url` (responses) must be a
  base64 data URL: `data:image/{png,jpeg,webp,gif};base64,...`.
- Chat also accepts a direct `image_url` data-URL string for compatible clients.
  Responses message items may omit `type: "message"` when they provide `role`.
- The HTTPS edge must allow the full JSON request: use Nginx
  `client_max_body_size 20m;` in `location /v1/`, matching the default body budget.
  Base64 adds about one third to image size; Nginx's default 1 MiB is too small.
- ≤3 images per **request** (shared budget across all messages/input items), ≤5 MiB each, canonical base64 only.
- Pre-flight: count, model capability, URL scheme, MIME, base64 canonicality and
  per-image size are all validated BEFORE any save or prepareCall. The batch is
  committed atomically via `ctx.attachments.saveImages([...])` (the real
  dsh-attachment-local contract). No partial save precedes a later non-conforming image.
- Remote URLs → 400 `remote_image_url_rejected` (SSRF guard).
- Text-only model + image → 400 `image_unsupported` (both protocols).
- Decoded → DSH `{ type: 'image', attachment }` blocks.

## Streaming

Chat Completions stream uses `chat.completion.chunk` objects (content /
reasoning_content / tool_calls deltas), terminated by `data: [DONE]`.

Responses stream emits **OpenAI Responses SSE events** (not Chat chunks):

`response.created` → `response.in_progress` → `response.output_item.added` →
`response.content_part.added` → `response.output_text.delta` (text) /
`response.function_call_arguments.delta` + `response.function_call_arguments.done`
(function_call) → `response.output_item.done` → `response.completed`.

## Strict unknown-field rejection

Every top-level field not in the declared supported/rejected set is rejected
with 400 `unsupported_field`. No important semantic field is silently dropped.
Reasoning-delta and vision blocks follow the rc.2 chunk vocabulary exactly.

## Errors

| Code | HTTP |
| --- | --- |
| `invalid_api_key` | 401 |
| `invalid_request` / `unsupported_field` / `image_unsupported` / `remote_image_url_rejected` | 400 |
| `model_not_found` / `not_found` / `client_not_found` | 404 |
| `unsupported_media_type` | 415 |
| `request_too_large` / `image_too_large` / `too_many_images` | 413 |
| `rate_limit_exceeded` (Retry-After: 60) | 429 |
| `timeout` | 504 |
| `upstream_error` / `stream_incomplete` / `attachments_unavailable` | 502 |
| `local_only` / `invalid_admin_token` | 403/401 (admin) |

Upstream provider failure codes (RATE_LIMIT, QUOTA, ACCOUNT_QUOTA, TIMEOUT,
INVALID_REQUEST, UNSUPPORTED_*, CONTEXT_WINDOW_EXCEEDED, NO_ADAPTER) are mapped
to HTTP without leaking raw upstream messages or credentials.
