import { invalid, unsupportedField } from './errors.js';

/** Explicit controls override variant defaults; never clamp adapter-owned effort ids. */
export function readReasoningEffort(body, route) {
  let nested;
  if (body.reasoning !== undefined) {
    const reasoning = body.reasoning;
    if (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning)) invalid('reasoning must be an object.');
    for (const key of Object.keys(reasoning)) {
      if (key !== 'effort') throw unsupportedField(`reasoning.${key}`, ['reasoning.effort']);
    }
    nested = reasoning.effort;
  }
  const flat = body.reasoning_effort;
  for (const [field, value] of [['reasoning_effort', flat], ['reasoning.effort', nested]]) {
    if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
      invalid(`${field} must be a non-empty string.`, { field });
    }
  }
  if (flat !== undefined && nested !== undefined && flat !== nested) {
    invalid('reasoning_effort and reasoning.effort must agree when both are supplied.');
  }
  const effort = flat ?? nested ?? route.reasoning_effort;
  if (effort !== undefined && Array.isArray(route.reasoning_efforts) && !route.reasoning_efforts.includes(effort)) {
    invalid(`Model "${route.id}" supports reasoning_effort: ${route.reasoning_efforts.join(', ') || '(none)'}.`, { field: 'reasoning_effort' });
  }
  return effort;
}
