# status-pipe — Design Overview

## What this is

status-pipe is a VS Code extension that gives a human operator a **review/response
queue** over a fleet of autonomous coding agents. Agents (Claude Code epic/issue
loops) publish their state as JSON files in a per-repo state directory
(`.autopilot/run/issue-<N>.json`). status-pipe watches those files across every
repo in the workspace, enriches them with live forge data (GitHub or Bitbucket),
and renders a prioritized queue of "what needs *me*" — blockers, review requests,
design questions, ready-to-merge PRs — alongside everything that is quietly
in flight.

The companion deliverable is a **Claude Code plugin** (`plugin/`) providing a
baseline multi-agent workflow (slash commands + workflow script) that writes the
same state contract, usable in any repo instead of the bespoke `autopilot`
command set that exists in `irl-llc` and `git-spice-code-extension` today.

## Goals

1. **Single pane of glass** across N repos / M concurrent agent loops: side-tray
   view for ambient awareness, full editor tab for triage sessions. Two
   operating modes, same machinery: **single-repo** (one repo, the operator
   drives the agent from a Claude Code pane; the extension monitors) and
   **fleet** (multi-root workspace; the extension also launches and supervises
   each repo's orchestrator via a committed `.status-pipe-launch` file). See
   [09-launch-and-supervision.md](09-launch-and-supervision.md).
2. **Queue, not dashboard**: ordering and grouping is by *what the operator
   should do next*, not by repo or recency. Blocked > review-ready > waiting >
   running > done.
3. **Close the loop**: a "ready for another look" action per feedback request,
   so the operator can hand work back to the agent without touching a terminal.
   This is the one schema extension status-pipe introduces (see
   [02-state-schema.md](02-state-schema.md#feedback-signal)).
4. **Forge-portable**: GitHub and Bitbucket Cloud both supported through an
   internal forge abstraction (modeled on git-spice's), selected by remote-URL
   inference with a `statusPipe.forge.type` override. Ticketing follows the
   forge: GitHub issues on GitHub; **Jira Cloud** on Bitbucket Cloud.
5. **Stack-aware, minimally**: PR rows show their upstream (base) branch above
   and downstream (dependent) branches below in small type. status-pipe is not
   a stack visualizer — git-spice's extension owns that — it just keeps the
   operator oriented while reviewing.
6. **Production engineering parity** with git-spice-code-extension: unit tests,
   Playwright snapshot e2e tests against a real VS Code, Docker-reproducible
   snapshots, changie-driven scheduled auto-release publishing to the VS Code
   Marketplace and Open VSX.

## Non-goals

- Driving agent *work* (what to do next, retries, scheduling of work items).
  The orchestrator loop owns that. status-pipe only launches/supervises the
  orchestrator *process* (opt-in, fleet mode) and writes ack signal files —
  it never writes agent state.
- Replacing the forge's review UI. Reviewing happens on GitHub/Bitbucket;
  status-pipe deep-links there.
- Git operations of any kind. status-pipe never runs git; everything it knows
  comes from state files + forge APIs.
- GitLab support (the abstraction leaves room; not in scope now).
- Requiring git-spice. The *concept* of the forge abstraction is borrowed; the
  binary is not a dependency.

## Source material

| Concern | Borrowed from | Reference |
|---|---|---|
| State file contract | `irl-llc/.autopilot/state.schema.json` (schemaVersion 1) | [02-state-schema.md](02-state-schema.md) |
| Forge abstraction shape | `git-spice/internal/forge/forge.go` (core interface + optional capability interfaces) | [03-forge.md](03-forge.md) |
| Extension architecture | `git-spice-code-extension` (dual webpack bundle, typed message router, webview React UI) | [04-architecture.md](04-architecture.md) |
| CI / release | `git-spice-code-extension` branch `ci-auto-release-publish` (changie + scheduled auto-release + reusable publish), `ci/playwright-snapshot-artifacts` | [06-testing-and-release.md](06-testing-and-release.md) |
| Agent workflow | `irl-llc/.claude/commands/epic-*` + `.claude/workflows/epic-tranche-loop.js` | [07-claude-plugin.md](07-claude-plugin.md) |

## Document map

- [01-overview.md](01-overview.md) — this file
- [02-state-schema.md](02-state-schema.md) — the state directory contract status-pipe consumes, plus the feedback-signal extension it introduces
- [03-forge.md](03-forge.md) — TypeScript forge abstraction (GitHub/Bitbucket), capability model, auth, configuration
- [04-architecture.md](04-architecture.md) — extension internals: discovery, watching, enrichment pipeline, webview messaging
- [05-ui.md](05-ui.md) — queue semantics, card anatomy, side-tray vs editor layouts; SVG wireframes in [wireframes/](wireframes/)
- [06-testing-and-release.md](06-testing-and-release.md) — test layers and release automation
- [07-claude-plugin.md](07-claude-plugin.md) — the baseline Claude Code plugin (slash commands + workflow) that emits this contract
- [08-workflow-simulation.md](08-workflow-simulation.md) — the step-by-step operator-day simulation that drove the queue semantics and feedback-signal design
- [09-launch-and-supervision.md](09-launch-and-supervision.md) — single-repo vs fleet operating modes, the `.status-pipe-launch` contract, agent-process supervision and health
