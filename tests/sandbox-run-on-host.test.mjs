import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { MEMBER_ONLY, credentialReason, memberOnlyReason, runHostCommand } from '../src/host-command.mjs';
import { attempt, makeWorld, openBoundary } from './helpers/world.mjs';

// run_on_host (parity F024, F025): what the member must do themselves is refused before anyone is asked; what reaches credentials is
// flagged; the command itself runs on the machine in a login shell with none of the runtime's environment.
test('commands that need the member\'s password or an interactive sign-in are refused', () => {
  for (const command of ['sudo ls', 'echo x && sudo rm y', '(sudo ls)', 'env X=1 sudo ls', 'su root', 'installer -pkg a.pkg -target /', 'gh auth login',
    'npm login', 'docker login ghcr.io', 'aws sso login'])
    assert.ok(memberOnlyReason(command), command);
  for (const command of ['brew install openjdk@21', 'git pull', 'docker login --password-stdin ghcr.io < token.txt', 'echo sudo', 'npm test'])
    assert.equal(memberOnlyReason(command), null, command);
  assert.match(MEMBER_ONLY('sudo needs the member\'s password'), /managed-host-member-only/);
});

test('commands that name credentials are flagged', () => {
  for (const command of ['cat ~/.ssh/id_rsa', 'tar -C ~ -c .ssh', 'cat $HOME/.aws/credentials', 'cat /Users/me/.pi/agent/auth.json', 'cp .env /tmp',
    'security find-generic-password -s x', 'printenv', 'env | sort'])
    assert.ok(credentialReason(command), command);
  for (const command of ['brew install node@22', 'git pull --rebase', 'npm ci', 'ls -la']) assert.equal(credentialReason(command), null, command);
});

test('a command runs on the machine as the member, without the runtime\'s environment', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-')));
  process.env.PIAGENT_TEST_SECRET = 'must-not-leak';
  try {
    const updates = [];
    const command = 'pwd; echo "visible=[$PIAGENT_TEST_SECRET]"; echo "token=abcdef0123456789abcdef"';
    const result = await runHostCommand({ command, cwd: dir, userHome: dir, onUpdate: update => updates.push(update) });
    const out = result.content[0].text;
    assert.ok(out.includes(dir));
    assert.match(out, /visible=\[\]/);
    assert.ok(!out.includes('abcdef0123456789abcdef'), 'redacted');
    assert.equal(result.details.exitCode, 0);
  } finally { delete process.env.PIAGENT_TEST_SECRET; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failing command reports its code; a prompt for a password ends it and says the member must do it', async () => {
  await assert.rejects(runHostCommand({ command: 'echo oops; exit 7', cwd: os.tmpdir() }), /oops[\s\S]*Command exited with code 7/);
  await assert.rejects(runHostCommand({ command: 'echo "sudo: a password is required" >&2; exit 1', cwd: os.tmpdir() }), /managed-host-member-only/);
});

test('timeout and abort stop the command and its children', async () => {
  const started = Date.now();
  await assert.rejects(runHostCommand({ command: 'sleep 30', cwd: os.tmpdir(), timeout: 1 }), /timed out after 1 seconds/);
  assert.ok(Date.now() - started < 8000);
  const controller = new AbortController();
  const pending = runHostCommand({ command: 'sleep 30', cwd: os.tmpdir(), signal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(pending, /Command aborted/);
  await assert.rejects(runHostCommand({ command: 'true', cwd: os.tmpdir(), signal: AbortSignal.abort() }), /Command aborted/);
});

const world = makeWorld();
let tools;
after(async () => { await tools?.boundary.dispose(); world.dispose(); });

test('a missing toolchain in the sandbox names run_on_host', async () => {
  tools = openBoundary(world);
  const result = await attempt(tools.call('bash', { command: 'piagent-tool-that-is-not-installed --version' }));
  assert.equal(result.ok, false);
  assert.match(result.out, /managed-toolchain-missing/);
  assert.match(result.out, /run_on_host/);
});
