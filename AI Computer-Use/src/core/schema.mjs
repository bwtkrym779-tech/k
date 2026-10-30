/**
 * Small JSON-Schema (draft-07 subset) validator used to validate every tool
 * call before execution. We deliberately do not trust model output.
 *
 * Supported keywords: type, properties, required, additionalProperties, items,
 * enum, const, minimum, maximum, minLength, maxLength, pattern, minItems,
 * maxItems, oneOf, anyOf, allOf, not.
 */

const TYPE_CHECKS = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
};

export function validateSchema(schema, value, path = '$') {
  const errors = [];
  validateNode(schema ?? {}, value, path, errors);
  return { valid: errors.length === 0, errors };
}

function validateNode(schema, value, path, errors) {
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    errors.push(`${path}: value is not allowed`);
    return;
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = types.some((t) => TYPE_CHECKS[t]?.(value));
    if (!ok) {
      errors.push(`${path}: expected ${types.join('|')}, received ${describe(value)}`);
      return;
    }
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((s) => validateSchema(s, value, path).valid).length;
    if (matches !== 1) errors.push(`${path}: must match exactly one oneOf branch (matched ${matches})`);
  }
  if (schema.anyOf) {
    if (!schema.anyOf.some((s) => validateSchema(s, value, path).valid)) errors.push(`${path}: must match at least one anyOf branch`);
  }
  if (schema.allOf) {
    for (const s of schema.allOf) validateNode(s, value, path, errors);
  }
  if (schema.not && validateSchema(schema.not, value, path).valid) {
    errors.push(`${path}: must not match the 'not' schema`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: length < ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: length > ${schema.maxLength}`);
    if (schema.pattern !== undefined) {
      let re;
      try { re = new RegExp(schema.pattern); } catch { errors.push(`${path}: schema has invalid pattern`); return; }
      if (!re.test(value)) errors.push(`${path}: does not match /${schema.pattern}/`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: needs >= ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: needs <= ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => validateNode(schema.items, item, `${path}[${i}]`, errors));
  }
  if (TYPE_CHECKS.object(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key}: required`);
    }
    const props = schema.properties ?? {};
    for (const [key, v] of Object.entries(value)) {
      if (props[key]) {
        validateNode(props[key], v, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key}: unknown property (additionalProperties=false)`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateNode(schema.additionalProperties, v, `${path}.${key}`, errors);
      }
    }
  }
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Coerce JSON-ish model output into an object (handles double-encoded JSON strings). */
export function parseJsonLoose(input) {
  if (typeof input !== 'string') return input;
  let text = input.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  try { return JSON.parse(text); } catch { /* continue */ }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const slice = text.slice(first, last + 1);
    try { return JSON.parse(slice); } catch { /* continue */ }
  }
  return null;
}
