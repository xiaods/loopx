# LoopX Pi goal mode

The Pi host adapter for LoopX. Pi is a terminal coding agent whose extensions
register commands, tools, and event handlers; this adapter turns a Pi session
into a LoopX-governed visible goal loop.

## Surface

- **`/loopx`** — with no arguments, runs `loopx bootstrap-command-pack --project .`
  and shows the packet as a widget plus a transcript entry. With a goal text
  argument, runs `loopx start-goal --guided --project . --goal-text "<text>"
  --host-surface pi` and places the returned packet in the editor for review.
  `/loopx resume` re-arms auto-continuation after a user-driven pause.
- **`loopx_goal_activate`** — agent-callable tool. Binds the current session to
  a LoopX goal (`goalId`, heartbeat `objective`/task_body, optional `agentId`,
  `registryPath`, `availableCapabilities`), then starts the quota-gated loop.
- **Goal loop** — on every `agent_settled`, the extension probes
  `loopx quota should-run --runtime-profile generic_cli` for the bound goal.
  LoopX decides whether to continue (the heartbeat task_body is injected as a
  follow-up), wait with scheduler-hint backoff (unchanged-poll limits apply), or
  stop at a validated terminal no-follow-up. Probe failures fail closed with a
  bounded retry; the extension never self-declares closure.

## Install / uninstall

```bash
loopx slash-commands --install --surface pi --project .
loopx slash-commands --uninstall --surface pi --project .
```

Installs the self-contained extension to `.pi/extensions/loopx-goal.ts` in the
project (loaded after project trust). Pi's extension loader aliases `typebox`
and the `@earendil-works/*` packages, so no local `node_modules` are required.

## State

Bindings persist under `<project>/.loopx/pi/` (gitignored), keyed by session.
Override with `LOOPX_PI_STATE_DIR`. Invoke the CLI binary via `LOOPX_BIN`.

## Boundary

The extension reads only LoopX public-safe state and never copies raw
transcripts, credentials, or local session paths. Continuation is governed by
LoopX quota; user prompts pause auto-resume; `/loopx resume` or re-activation
re-arms it. No external writes happen without the active LoopX state or owner
authorization.
