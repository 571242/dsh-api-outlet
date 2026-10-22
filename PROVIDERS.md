# Provider / model id rules

## Full id format

Every model is exposed as `<provider>/<model>`, assembled from
`llm.listProviders()[].id` + `llm.listModels(provider)[].id`. The full id is
authoritative and returned verbatim by `GET /v1/models`.

Example (illustrative; actual ids come from the cloud Host's registered
adapters, not this document):

```
deepseek/deepseek-v4-pro
codex-chatgpt/gpt-5
antigravity/gemini-2.5-pro
```

The `provider` segment is preserved even when two providers expose the same
model name, so routing never mixes channels.

## Capabilities

`GET /v1/models` returns, per model: `id`, `provider`, `model`, `name`,
optional `description`, and `input_modalities` (e.g. `["text","image"]`).
The outlet uses `input_modalities` to reject images against text-only models
explicitly (400) instead of degrading.

When `llm.resolveModelInfo(provider, model)` succeeds, the outlet also returns
`reasoning_efforts` (the adapter's exact effort ids; `[]` means no selectable
reasoning) and optional `default_reasoning_effort`. Failed/unavailable capability
lookups preserve the base model without claiming any reasoning capabilities.

Each advertised effort also gets a selectable `<provider>/<model>@<effort>`
variant for clients without a reasoning control. The variant carries
`base_model`, `reasoning_effort`, and an effort-specific
`default_reasoning_effort`; its `provider` and `model` still route to the real
upstream model. Canonical model ids always win over colliding variant ids.
Explicit request effort overrides the variant default. Base ids and their
upstream defaults are unchanged.

## Aliases

Optional `aliases` map in plugin config: `{ "gpt-5": "codex-chatgpt/gpt-5" }`.
Aliases resolve at request time to a full id. Aliases are convenience only; the
full id remains the canonical, collision-free form.

## prepareCall contract (locked to @deepseek-ai/dsh-llm@0.2.0-rc.2)

The outlet depends on these verified public behaviors (see
tests/outlet/contract.js, which exercises the real package):

- `llm.listProviders()` → `[{ id, name }]`
- `llm.listModels(provider)` → `[{ provider, id, name, description?, inputModalities? }]`
- `await llm.prepareCall(config, signal)` → frozen handle
  `{ config, retryPolicy, adapterDefaults, inputModalities?, systemPromptUpdate?, toolUpdate?, stream }`
  where `config = { provider, model, reasoningEffort?, temperature?, maxTokens?, stop?, messages, tools? }`
- `call.stream({ ...config, signal })` yields the chunk vocabulary
  `text-delta | reasoning-delta | block-start | block-end | tool-call-delta | usage | finish`
  and may be dispatched exactly once (second dispatch throws
  `INVALID_PREPARED_CALL`).

**Important:** the model catalog is advisory — `prepareCall` accepts any model
id and only `resolveModel` returns an identity echo. The outlet therefore
enforces model existence itself via `resolveRoute` (404 `model_not_found`)
before calling `prepareCall`; an unknown **provider** (no adapter) rejects at
`prepareCall` with `NO_ADAPTER`.

## Image admission contract (verified from dsh-attachment-local@0.2.0-rc.2)

`ctx.get('attachments')` is the `AttachmentStore` service. Its batch entry
`saveImages(inputs)` takes `[{ data: Uint8Array, mediaType, name? }]` and
returns one durable ref per input: `{ attachmentId: 'sha256:…', mediaType,
width, height, bytes, name?, originalDimensions? }`. The outlet calls
`saveImages` (not per-image `saveImage`) so the whole request's image batch is
committed atomically after full validation. `saveImage(input)` takes the same
single-input shape. The DSH visual block sent to a model is
`{ type: 'image', attachment: ref }` (see dsh-llm-deepseek prepareImages /
imageRefs, which require images only in user/tool messages and a model whose
`inputModalities` includes 'image').
