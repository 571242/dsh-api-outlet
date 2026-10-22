/** Default runtime limits. All can be overridden via plugin config. */
export const DEFAULTS = Object.freeze({
  apiPort: 19388,
  adminPort: 19389,
  maxConcurrent: 2,           // max simultaneous upstream calls
  requestsPerMinute: 60,      // sliding-window request budget
  timeoutMs: 600000,          // 10 min upstream timeout
  bodyLimit: 20971520,        // 20 MiB total request body
  maxImagesPerRequest: 3,     // bounded image count per request
  maxImageBytes: 5242880,     // 5 MiB per single image
  maxMessages: 1024,
  maxTools: 128,
  maxTokens: 131072,
  modelCacheMs: 10000,
  aliases: Object.create(null),   // alias -> full "provider/model" id
  stateDir: undefined,            // directory holding state.json
  stateFile: undefined,           // explicit state file path (overrides stateDir)
});

export function normalizeConfig(input = {}) {
  const c = { ...DEFAULTS, ...input };
  for (const k of ['apiPort', 'adminPort', 'maxConcurrent', 'requestsPerMinute', 'timeoutMs', 'bodyLimit', 'maxImagesPerRequest', 'maxImageBytes', 'maxMessages', 'maxTools', 'maxTokens', 'modelCacheMs']) {
    if (!Number.isSafeInteger(c[k]) || c[k] <= 0) throw new Error(`outlet config "${k}" must be a positive integer`);
  }
  if (c.aliases === null || typeof c.aliases !== 'object' || Array.isArray(c.aliases)) throw new Error('outlet config "aliases" must be an object');
  for (const k of ['stateDir', 'stateFile']) {
    if (c[k] !== undefined && (typeof c[k] !== 'string' || c[k].length === 0)) throw new Error(`outlet config "${k}" must be a non-empty string`);
  }
  return c;
}
