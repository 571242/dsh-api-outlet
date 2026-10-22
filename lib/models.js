/**
 * Model route resolution. A full id is "provider/model" (kept verbatim); an
 * alias maps to a full id. The provider/model pair is preserved so different
 * providers exposing the same model name never collide.
 */
export function resolveRoute(fullId, modelList, aliases) {
  let id = fullId;
  if (typeof id !== 'string' || id.length === 0) return undefined;
  if (aliases && Object.hasOwn(aliases, id)) id = aliases[id];
  const model = (modelList ?? []).find(m => m.id === id);
  if (!model) return undefined;
  return model; // { id, provider, model, name, description?, input_modalities? }
}

export function supportsImage(route) {
  const mods = route?.input_modalities ?? route?.inputModalities;
  return Array.isArray(mods) && mods.includes('image');
}
