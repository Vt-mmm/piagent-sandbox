import { redactSecrets } from './secret-patterns.mjs';

// Secrets leave tool output, previews and errors before the model or the log sees them. The shapes live in secret-patterns.mjs
// (the same file in every Piagent package).
export function redactedText(raw) {
  return redactSecrets(raw, '[redacted]');
}
