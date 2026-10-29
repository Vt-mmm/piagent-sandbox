// Secrets leave tool output, previews and errors before the model or the log sees them.
const RULES = [
  [/(authorization\s*[:=]\s*)(bearer|basic|token)\s+[^\s'"]+/gi, '$1$2 [redacted]'],
  [/(--(?:token|password|api-key|secret)(?:=|\s+))[^\s'"]+/gi, '$1[redacted]'],
  [/\b((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]'],
  [/\b(?:sk|pk|ghp|gho|ghs|github_pat|xox[abp]|AKIA)[-_A-Za-z0-9]{16,}/g, '[redacted]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]'],
];

export function redactedText(raw) {
  return RULES.reduce((text, [rule, replacement]) => text.replace(rule, replacement), String(raw ?? ''));
}
