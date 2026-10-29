# Agent instructions: piagent-sandbox

Sandboxed tools for Piagent company mode: Seatbelt/bubblewrap tool boundary, package proxy, approval tools, /undo.

## Rules
- Node >= 22.19, ESM only, lockfile committed, no `postinstall` scripts, pin every dependency.
- `npm test` must run offline against a simulated Studio. Never call a real Studio or model from tests.
- This repo is PUBLIC. Never commit tokens, API keys, `.env`, `auth.json`, session files, `.pi/memory/*`, internal addresses, customer names or real data. Use synthetic values only.
- Run `git diff --cached` and check it before every commit.
- The three packages (provider, sandbox, harness) talk only through the Pi event bus, following the versioned contract in piagent-bundle/docs/package-contract.md. Never import another package's code.
- Only the owner tags releases or publishes. Work on a branch and open a PR.

## Checks
- `npm test`
