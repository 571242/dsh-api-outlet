/** Outlet HTTP API errors: stable machine code + optional detail. */
export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function invalid(message, extra = {}) {
  throw new ApiError(400, 'invalid_request', message, extra);
}

/** Explicit rejection of a request field the outlet does not implement. */
export function unsupportedField(field, supported) {
  return new ApiError(400, 'unsupported_field',
    `Field "${field}" is not supported by this outlet. Supported: ${supported.join(', ')}.`,
    { field, supported });
}

/** Map an upstream LlmError / finish failure into a redacted API error. */
export function upstreamFailure(code) {
  const status =
    ['RATE_LIMIT', 'QUOTA', 'ACCOUNT_QUOTA'].includes(code) ? 429
    : ['INVALID_REQUEST', 'UNSUPPORTED_OPTION', 'UNSUPPORTED_REASONING_EFFORT', 'UNSUPPORTED_CONTENT', 'CONTEXT_WINDOW_EXCEEDED'].includes(code) ? 400
    : code === 'TIMEOUT' ? 504
    : code === 'NO_ADAPTER' ? 404
    : 502;
  // Never forward raw upstream messages: they can carry credentials or private paths.
  return new ApiError(status, code, `DSH provider returned ${code}. Check the selected model and provider on the host.`);
}
