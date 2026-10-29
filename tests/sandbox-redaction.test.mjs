import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactedText } from '../src/redact.mjs';

test('secrets are hidden in tool output, previews and errors', () => {
  const samples = ['Authorization: Bearer abcDEF123456', '--token=ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'npm publish --password hunter2', 'password: "correct horse battery"',
    'API_KEY=sk-live-abcdefghijklmnop1234', '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----'];
  for (const sample of samples) {
    const out = redactedText(sample);
    assert.ok(!/hunter2|correct horse|abcDEF123456|ghp_abcdef|sk-live|AAAA/.test(out), `${sample} -> ${out}`);
    assert.match(out, /redacted/);
  }
  assert.equal(redactedText('plain text with 123 numbers'), 'plain text with 123 numbers');
  assert.equal(redactedText(undefined), '');
});
