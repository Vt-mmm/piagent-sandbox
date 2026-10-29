// The secret shapes every Piagent package redacts. THIS FILE IS IDENTICAL in piagent-provider, piagent-harness and piagent-sandbox
// (src/secret-patterns.mjs); each package's redact.mjs applies it with its own marker. Change all three together: the
// security-fixes test of each package runs the same corpus. Patterns replace the whole secret except where a prefix is kept (`$1`).
export const SECRET_PATTERNS = Object.freeze([
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, null],
  [/\b((?:x-api-key|x-auth-token|x-amz-security-token|proxy-authorization|authorization|cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, '$1'],
  [/\b((?:bearer|basic|token)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1'],
  [/(--(?:token|password|api-key|secret|auth)(?:=|\s+))[^\s'"]+/gi, '$1'],
  [/\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, null],
  [/\bas_(?:live|run|device)_[A-Za-z0-9_-]{8,}/g, null],
  [/\b(?:sk|pk|rk)[-_](?:live_|test_|proj-|ant-)?[A-Za-z0-9_-]{12,}/g, null],
  [/\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{16,}/g, null],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, null],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, null],
  [/\bnpm_[A-Za-z0-9]{30,}/g, null],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, null],
]);

// Replaces each match: `null` → the whole match becomes `marker`; `$1` → the captured prefix stays, then the marker.
export function redactSecrets(text, marker = '[REDACTED_SECRET]') {
  return SECRET_PATTERNS.reduce((out, [pattern, keep]) => out.replace(pattern, keep ? `${keep}${marker}` : marker), String(text ?? ''));
}
