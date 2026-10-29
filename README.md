# piagent-sandbox

Sandboxed tools for Piagent company mode: Seatbelt/bubblewrap tool boundary, package proxy, approval tools, /undo.

Part of the Piagent company-mode bundle for stock [Pi](https://github.com/earendil-works) (pinned: `@earendil-works/pi-coding-agent` 1.3.0). See `piagent-bundle/docs` for the plan, contracts and runbook.

Status: phase 2.2, in review. Not released.

## What it does

Load it with `pi --no-extensions -e <path-to-this-package>`. It registers:

| Tools | Behaviour |
|---|---|
| `bash`, `read`, `edit`, `write`, `grep`, `find`, `ls` | Pi's own tool definitions under the same names, so they replace the built-ins. Each call runs in a fresh worker: Seatbelt (macOS) or bubblewrap (Linux, WSL2). The project is writable, everything else is read-only, credentials read as empty or fail, no network. |
| `run_with_network`, `run_with_docker`, `start_docker`, `run_on_host`, `run_on_simulator`, `fetch_origin` | Ask the member through Pi's own prompt (`ctx.ui.confirm`) according to the access mode. |
| `start_process`, `process_output`, `stop_process` | Up to 4 background processes in the same sandbox, kept across turns, stopped at the end of the conversation or after 4 hours. macOS only. |
| `/undo` | Puts back the files the previous turn changed. `/undo` again goes back one more turn. |
| `/bypass on, full, off, status` | Access mode. `on` needs the Harness to allow Bypass. |

Without approval, commands reach the package registries only (npm, PyPI, Go, crates.io, Maven, Gradle, NuGet, RubyGems, Packagist, pub.dev, public GitHub downloads, plus hosts listed one per line in `sandbox-domains` in the agent dir or `PIAGENT_SANDBOX_DOMAINS`) through a local proxy that refuses IP literals, private addresses and DNS rebinding. Any other host fails with `managed-domain-blocked` and names `run_with_network`.

### Access modes

| | Ask first | Full access | Bypass |
|---|---|---|---|
| `run_with_network`, `run_with_docker`, `run_on_host` | ask | ask | ask |
| `run_on_simulator` | ask | run `simctl`/`adb`/`emulator`; ask when the command runs project code (`xcodebuild`, `gradlew`, `pod`, `flutter`, `npx`, `./tool`) | same as Full access |
| `start_docker`, `fetch_origin` | ask | run | run |
| push, PR, publish, deploy, remote and cloud tools, uploads | ask | ask | ask |

### Event bus (see `piagent-bundle/docs/package-contract.md`)

- emits `piagent:tools.attest` `{ v, tools: [{ name, source }] }` and `piagent:permission.mode` `{ v, mode }`;
- reads `piagent:run.state` `{ harness: { bypassMode } }` to know whether Bypass is allowed.

It imports no code from the other packages.

## Known limits

- A command can reach any server listening on this machine's loopback or own addresses (tests need their own servers). It cannot reach the internet, private networks or other machines.
- `start_process` and TypeScript diagnostics after an edit are macOS only.
- Windows through WSL2 uses the Linux sandbox. It has not been run on a real WSL2 machine yet. Native Windows is not supported; Pi's `powershell` tool is not replaced.
- There is no scoped GitHub tool apart from `fetch_origin`; private npm registries, `gh` and an SSH agent have no sandboxed path (use `run_on_host`).

## Development

```bash
npm ci
npm test
```

`npm test` runs offline. Sandbox tests use a throwaway fake `HOME` and a temporary project, fake registries on 127.0.0.1 and no model. On Linux they need `bubblewrap` and unprivileged user namespaces (see `.github/workflows/ci.yml`).

## Security

See [SECURITY.md](SECURITY.md). Report vulnerabilities privately.

### Limits of the checks

The handoff reader (`handoff-policy.mjs`) and the simulator command reader are text checks that help the card say why; they are not the boundary and a determined command can spell around them. That is why network, Docker and host commands ask every time. Git files that make git run a program (`.git/config`, `.git/hooks`, `.git/info/attributes`, `.gitmodules`, `.gitattributes`) are read-only for the sandbox, and git on the host runs with `src/safe-git.mjs` (no fsmonitor, hooks, textconv or external diff).
