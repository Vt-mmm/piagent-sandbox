// Synthetic secrets (none is real). THE SAME FILE in piagent-provider, piagent-harness and piagent-sandbox (tests/fixtures/secret-corpus.mjs).
const join = (...parts) => parts.join('');
export const SECRETS = [
  join('xoxb-', '1234567890-abcdefghijkl'), join('sk_live_', 'abcdefghijklmnop1234'), join('npm_', 'a'.repeat(36)), join('AIza', 'S'.repeat(35)),
  join('eyJ', 'hbGciOiJIUzI1NiJ9', '.eyJ', 'zdWIiOiIxMjM0NTY3ODkw', '.', 'abcdefghijkl123456'), 'postgres://user:hunter2pw@db.example.invalid:5432/app',
  '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----',
  'password=correct-horse-battery', 'X-Api-Key: abcdef0123456789abcdef', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', join('ghp_', 'a'.repeat(30)), join('AKIA', 'ABCDEFGHIJKLMNOP'),
  'Bearer abcdefghijklmnop12345678', join('github_pat_', 'a'.repeat(30)), join('as_run_', '12345678-1234-4234-8234-123456789abc_abcdefghijklmnopqrstuvwx'),
];
// The value that must not survive in the output for each entry above.
export const NEEDLES = ['1234567890-abcdefghijkl', 'abcdefghijklmnop1234', 'a'.repeat(36), 'S'.repeat(35), 'abcdefghijkl123456', 'hunter2pw', 'MIIBOgIBAAJBAKj34Gkx',
  'correct-horse-battery', 'abcdef0123456789abcdef', 'dXNlcjpwYXNzd29yZA', 'a'.repeat(30), 'ABCDEFGHIJKLMNOP', 'abcdefghijklmnop12345678', 'a'.repeat(30), '12345678-1234-4234'];
