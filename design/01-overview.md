# status-pipe — Design Overview

## What this is

status-pipe is **two deliverables coupled only by a file protocol**:

1. A **VS Code extension** that gives a human operator a **review/response
   queue** over a fleet of autonomous coding agents. Agents publish their state
   as JSON files in a per-repo protocol directory
   (`.status-pipe/tickets/<key>.json`); the extension watches those files across
   every repo in the workspace, overlays live forge data (CI, review state,
   comment counts), and renders a prioritized queue of "what needs *me*" —
   blockers, review requests, design questions, ready-to-merge PRs — alongside
   everything quietly in flight. It **delegates** the forge read to a configured
   *enrichment command* and never embeds forge clients or authenticates itself
   ([03-forge.md](03-forge.md)).
2. A **Claude Code plugin** (`plugin/`) — one *opinionated reference
   implementation* of the writer side (slash commands + workflow) that emits the
   protocol, usable instead of the bespoke `autopilot` command set in `irl-llc`
   and `git-spice-code-extension` today (which migrate per
   [10-naming.md](10-naming.md)). It is explicitly built on `gh` + `git` +
   git-spice; other toolchains are other plugins sharing the protocol substrate
   ([07-claude-plugin.md](07-claude-plugin.md)).

The contract between the two is **only** the `.status-pipe/` file protocol
([02-protocol.md](02-protocol.md)). Neither assumes the other's
forge, tools, or update mechanism. Forge and tool integration is delegated, on
both sides, to commands that own their own behavior and credentials — so a new
forge is a new command, not a code change in either deliverable.

## Goals

1. **Single pane of glass** across N repos / M concurrent agent loops: side-tray
   view for ambient awareness, full editor tab for triage sessions. Two
   operating modes, same machinery: **single-repo** (one repo, the operator
   drives the agent from a Claude Code pane; the extension monitors) and
   **fleet** (multi-root workspace; the extension also launches and supervises
   each repo's orchestrator via a committed `.status-pipe/launch.json` file). See
   [09-launch-and-supervision.md](09-launch-and-supervision.md).
2. **Queue, not dashboard**: ordering and grouping is by *what the operator
   should do next*, not by repo or recency. Blocked > review-ready > waiting >
   running > done.
3. **Close the loop**: a "ready for another look" action per feedback request,
   so the operator can hand work back to the agent without touching a terminal.
   This is the key protocol addition status-pipe introduces (see
   [02-protocol.md](02-protocol.md#feedback-signal)).
4. **Forge-agnostic by delegation**: the extension never speaks a forge dialect
   or holds a credential. Live data comes from a configured **enrichment
   command** (batch-in / batch-out, with a defined JSON schema) that owns the
   forge and its own auth; a first-party default command (GitHub + Bitbucket)
   ships for zero-config repos, and any other forge is just another command.
   Ticketing follows the forge: GitHub issues on GitHub; **Jira Cloud** on
   Bitbucket Cloud — also resolved by the command, not compiled in.
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
- **Embedding forge API clients or authenticating to forges.** The extension
  delegates forge reads to a command and holds no tokens. (It may *invoke*
  commands that run `gh`/`git`, gated by Workspace Trust, but it embeds no forge
  dialect and no credential resolver of its own — see [03-forge.md](03-forge.md).)
- Driving git itself. status-pipe's own logic knows only protocol files; any git
  or forge work happens inside delegated commands.
- A built-in GitLab/Gitea/etc. forge. None is needed: support is an enrichment
  command, addable without an extension release.
- Requiring git-spice *in the extension*. The reference plugin is opinionated
  about it; the extension is not.

## Source material

| Concern | Borrowed from | Reference |
|---|---|---|
| Protocol (renamed per [10-naming.md](10-naming.md)) | `irl-llc/.autopilot/state.schema.json` (prototype convention) | [02-protocol.md](02-protocol.md) |
| Enrichment output shapes (PR/checks/comment counts, capability model) — used by the *default* command, behind the delegation boundary | `git-spice/internal/forge/forge.go` | [03-forge.md](03-forge.md) |
| Extension architecture | `git-spice-code-extension` (dual webpack bundle, typed message router, webview React UI) | [04-architecture.md](04-architecture.md) |
| CI / release | `git-spice-code-extension` branch `ci-auto-release-publish` (changie + scheduled auto-release + reusable publish), `ci/playwright-snapshot-artifacts` | [06-testing-and-release.md](06-testing-and-release.md) |
| Agent workflow | `irl-llc/.claude/commands/epic-*` + `.claude/workflows/epic-tranche-loop.js` | [07-claude-plugin.md](07-claude-plugin.md) |

## Document map

- [01-overview.md](01-overview.md) — this file
- [02-protocol.md](02-protocol.md) — the status-pipe protocol: directory layout, ticket files, orchestrator metadata, the ack inbox
- [03-forge.md](03-forge.md) — forge integration by delegation: the enrichment-command contract, default command, capability model, Workspace Trust, caching
- [04-architecture.md](04-architecture.md) — extension internals: discovery, watching, enrichment pipeline, webview messaging
- [05-ui.md](05-ui.md) — queue semantics, card anatomy, side-tray vs editor layouts; SVG wireframes in [wireframes/](wireframes/)
- [06-testing-and-release.md](06-testing-and-release.md) — test layers and release automation
- [07-claude-plugin.md](07-claude-plugin.md) — the baseline Claude Code plugin (slash commands + workflow) that emits this contract
- [08-workflow-simulation.md](08-workflow-simulation.md) — the step-by-step operator-day simulation that drove the queue semantics and feedback-signal design
- [09-launch-and-supervision.md](09-launch-and-supervision.md) — single-repo vs fleet operating modes, the `.status-pipe/launch.json` contract, agent-process supervision and health
- [10-naming.md](10-naming.md) — terminology decision record: role taxonomy, protocol file names, migration mapping from the prototype `.autopilot` convention
