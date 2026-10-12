# goal-opencode

[![CI](https://github.com/tarcisiomiranda/goal-opencode/actions/workflows/ci.yml/badge.svg)](https://github.com/tarcisiomiranda/goal-opencode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Codex-style long-running goal mode for [OpenCode 2](https://opencode.ai), with a sidebar widget that surfaces the active goal in the terminal UI.

This is the OpenCode 2 port of [martsallan/goal-opencode](https://github.com/martsallan/goal-opencode). OpenCode 1.x users should keep using `@martsallan/goal-opencode@0.3.1`.

## Features

- `/goal <objective>` starts a goal-bound session. The plugin keeps the model working until the goal is achieved, paused, or cleared.
- Every model request carries the objective and the completion protocol as system context while the goal is active.
- Auto-continuation: when an execution ends and the goal is still active, a short synthetic message resumes the session.
- Completion: the model calls `update_goal({ status: "complete" })` after auditing the objective; emitting `::GOAL_DONE::` afterwards clears the goal.
- Interrupt-aware: stopping the model pauses the goal as interrupted; your next message resumes it.
- Stagnation guard: 3 consecutive continuations without any tool call pause the goal.
- Compaction-aware: the objective and protocol are added to the compaction request.
- Sidebar widget with objective, status and elapsed time; `Goal` in the command palette opens a dialog.
- State lives in the session metadata, so it survives restarts and works with remote servers.

## Install

Requires OpenCode **>= 2.0.26**.

Add the Git package to `plugins` in `~/.config/opencode/opencode.json` (global) or `opencode.json` (project):

```jsonc
{
  "plugins": ["goal-opencode@git+https://github.com/tarcisiomiranda/goal-opencode.git#v1.0.0"]
}
```

Or install it with the CLI:

```bash
opencode plugin add "goal-opencode@git+https://github.com/tarcisiomiranda/goal-opencode.git#v1.0.0"
```

The package exports a server entry (`.`) and a TUI entry (`./tui`); OpenCode loads both from the single `plugins` entry. No `cli.json` entry is needed.

Restart the background server after changing the config:

```bash
opencode service restart
```

### Local development

OpenCode resolves a local directory entry to `<dir>/index.*` and `<dir>/tui.*`, so point it at `src/`:

```jsonc
{
  "plugins": ["/path/to/goal-opencode/src"]
}
```

Local plugins hot-reload on save. Set `GOAL_OPENCODE_DEBUG=1` in the server environment to print decision traces to its stderr (run `opencode serve` or `opencode --standalone --print-logs` to see them).

## Commands

| Command | Effect |
| --- | --- |
| `/goal <objective>` | Set or replace the goal and start working on it. |
| `/goal append <text>` | Append context to the current goal and continue. |
| `/goal pause` | Pause manually. Stays paused until `/goal resume`. |
| `/goal resume` | Resume a paused goal. |
| `/goal clear` | Drop the goal. |
| `/goal` | Show the goal summary as a toast. |

Slash commands run through the TUI or the API (`session.command`). `opencode run "/goal ..."` sends the text as a plain prompt and does not set a goal.

## Tool exposed to the model

- `update_goal({ status: "complete" })` marks the goal complete. It is only offered to the model while a goal is active.

## Behaviour cheatsheet

| Situation | Result |
| --- | --- |
| Stop/interrupt while the model is working | Goal becomes `paused (interrupted)`. Next user message resumes it. |
| Execution fails (provider error, etc.) | Goal becomes `paused (interrupted)` with an error toast. |
| Server process restarts with a goal `active` | Demoted to `paused (interrupted)`; same resume rule. |
| Plugin hot reload | Running goals stay active. |
| `/goal pause` | Goal becomes `paused (manual)`; requires `/goal resume`. |
| 3 continuations in a row without tool calls | Goal paused as manual with a `Goal stalled` toast. |
| Plan agent selected | Continuation is skipped. |
| `update_goal` succeeds | Goal becomes `complete`; continuation stops. |
| `::GOAL_DONE::` after `update_goal` | Goal cleared. |

## State

Goal state is stored in the session metadata under the `goal-opencode` key:

```jsonc
{
  "goal-opencode": {
    "goal": { "objective": "...", "status": "active", "createdAt": 0, "updatedAt": 0, "activeStartedAt": 0, "timeUsedSeconds": 0 },
    "notice": { "id": "...", "message": "Goal active", "variant": "info" }
  }
}
```

`notice` carries the latest server message; the TUI shows each new notice once as a toast.

## Development

Tooling is pinned with [mise](https://mise.jdx.dev):

```bash
mise run install
mise run check
```

## License

MIT. Original work by mirsella (`@martsallan/goal-opencode`); OpenCode 2 port by Tarcisio Miranda.
