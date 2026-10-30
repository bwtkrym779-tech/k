/**
 * Secret redaction. Used for logs, audit records, model prompts and tool output.
 * Field-name based redaction catches structured secrets; pattern based catches
 * secrets embedded in free text (tokens, bearer headers, connection strings).
 */

export const REDACTED = '[REDACTED]';

const SECRET_FIELD = /(^|[_.-])(pass(word|wd)?|secret|token|api[_-]?key|apikey|authorization|auth|cookie|session[_-]?id|credential|private[_-]?key)($|[_.-])/i;
const SENSITIVE_TEXT_FIELDS = /^(text|content|value|typed|input)$/i;

const PATTERNS = [
  /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
  /((?:mongodb|postgres|mysql|redis|amqp):\/\/[^\s:@]+:)[^\s@]+(@)/gi,
];

export function redactText(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, (match, p1, p2) => {
    if (p2 !== undefined) return `${p1}${REDACTED}`;
    if (p1 && p1.endsWith('://')) return `${p1}${REDACTED}@`;
    return p1 ? `${p1} ${REDACTED}` : REDACTED;
  });
  return out;
}

/** Deep redaction of an arbitrary JSON value. */
export function redact(value, { keyHint = '', depth = 0 } = {}) {
  if (depth > 12) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (SECRET_FIELD.test(keyHint)) return REDACTED;
    if (value.length > 4000) {
      const head = redactText(value.slice(0, 2000));
      return `${head}…[truncated ${value.length - 2000} chars]`;
    }
    return redactText(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, { keyHint, depth: depth + 1 }));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^(password|passwd|token|apiKey|api_key|authorization|cookie)$/i.test(k)) {
        out[k] = REDACTED;
      } else if (SENSITIVE_TEXT_FIELDS.test(k) && typeof v === 'string' && SECRET_FIELD.test(keyHint)) {
        out[k] = REDACTED;
      } else {
        out[k] = redact(v, { keyHint: k, depth: depth + 1 });
      }
    }
    return out;
  }
  return '[unserializable]';
}

/** Hash used to bind an approval to the exact tool arguments. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function argsFingerprint(toolName, args) {
  // The approval token itself is not part of the approved operation; excluding
  // it lets a granted token be presented with the same arguments it approved.
  const clean = { ...(args ?? {}) };
  delete clean.approval_id;
  const text = `${toolName}:${stableStringify(clean)}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
