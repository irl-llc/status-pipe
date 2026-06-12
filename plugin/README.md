# status-pipe — Claude Code plugin

A baseline, repo-agnostic agent workflow that **emits the status-pipe
protocol** (`.status-pipe/` at the repo root): orchestration ticks, per-ticket
and per-epic workers, ack-inbox consumption, parking, and a deterministic,
trust-gated comment gateway. The status-pipe VS Code extension renders what
these commands write; this plugin is the reference writer. Authoritative
design: `design/07-claude-plugin.md`, file contract: `design/02-protocol.md`,
schemas: `schemas/*.schema.json` (all in this repository).

## What's in the box

| Path | What |
|---|---|
| `commands/tick.md` | `/status-pipe:tick [--max-concurrent N] [--dry-run]` — one idempotent, zero-prompt orchestration pass |
| `commands/launch.md` | `/status-pipe:launch [interval]` — interactive recurring wrapper around `tick` (honors `parked` + the inbox) |
| `commands/work-ticket.md` | `/status-pipe:work-ticket <key>` — one worker pass, ticket mode |
| `commands/work-epic.md` | `/status-pipe:work-epic <path-to-epic.md>` — one worker pass, epic mode |
| `commands/split.md` | `/status-pipe:split <ticket> <topic>` — carve a discussion into a cross-linked sub-ticket |
| `commands/ack-check.md` | `/status-pipe:ack-check` — inbox consume + staleness reconcile only |
| `bin/fetch-comments` | the **trust gateway**: API-verified, operator-filtered comment digests — the only sanctioned comment *read* path |
| `bin/post-comment` | the **posting wrapper**: attribution marker + `agentCommentIds[]` ledger — the only sanctioned comment *write* path |
| `skills/protocol/SKILL.md` | the binding protocol rules (anchoring, atomic writes, trust, attribution, acks, parking) |

## Install

The plugin lives in this repo under `plugin/`. Point a Claude Code plugin
marketplace at the repository, or for local development:

```bash
claude --plugin-dir /path/to/status-pipe/plugin   # then /status-pipe:tick etc.
```

`bin/fetch-comments` and `bin/post-comment` are plain Node (≥18) scripts with
no npm dependencies; nothing to build. They talk to the forges over direct
REST — the `gh` CLI is **not** required. Auth follows the git-spice
credential model, first match wins:

| Forge | Order |
|---|---|
| GitHub | `GITHUB_TOKEN` / `GH_TOKEN` env → `git credential fill` for the remote's host (git-credential-manager, osxkeychain, gh's helper, …) → `gh auth token` if gh happens to be installed |
| Bitbucket | `BITBUCKET_TOKEN` env (Bearer) → `git credential fill` for bitbucket.org (username+password ⇒ Basic — the app-password / Atlassian API token form) |
| Jira | `JIRA_EMAIL` + `JIRA_API_TOKEN` env |

The credential-helper lookup runs with `GIT_TERMINAL_PROMPT=0` — it answers
from storage or fails; it never prompts mid-run.

## Per-repo setup

1. Create `.status-pipe/` at the repo root with the two **committed** files
   below, and gitignore the runtime rest:

   ```gitignore
   .status-pipe/*
   !.status-pipe/launch.json
   !.status-pipe/config.json
   ```

2. Reference `.status-pipe/config.json` (schema `schemas/config.schema.json`):

   ```json
   {
     "schemaVersion": 1,
     "epics": { "dir": "epics" },
     "inventory": { "label": "agent-queue" },
     "tickets": { "source": "github-issues" },
     "staleWorkerMinutes": 30,
     "trust": {
       "mode": "single-maintainer",
       "operators": ["octocat"],
       "minAssociation": null
     },
     "attribution": {
       "commentPrefix": "**CLAUDE COMMENT**",
       "prBanner": "This PR was authored by a coding agent (status-pipe worker) on behalf of @octocat.",
       "includeAgentId": false
     }
   }
   ```

   Jira/Bitbucket repos: `"tickets": {"source": "jira-cloud", "jira":
   {"siteUrl": "https://yoursite.atlassian.net", "projectKey": "PROJ"}}` and
   the split operator form `"operators": {"bitbucket": ["{account-uuid}"],
   "jira": ["<accountId>"]}` (stable ids, never display names).

   **Trust is mandatory on public repos** — the plugin refuses to tick a
   public repo whose config declares no `trust.mode`, and a failed
   visibility check is treated as public (fail closed). A private repo
   without a `trust` block defaults to single-maintainer with the
   authenticated forge user.

3. Reference `.status-pipe/launch.json` for Claude Code (schema
   `schemas/launch.schema.json`; semantics in
   `design/09-launch-and-supervision.md` — tick mode relaunches
   `intervalMinutes` after the previous tick *exits*, capped by
   `timeoutMinutes`):

   ```json
   {
     "schemaVersion": 1,
     "agents": [
       {
         "id": "tick",
         "title": "Orchestrator loop",
         "command": "claude",
         "args": [
           "-p", "/status-pipe:tick --max-concurrent 3",
           "--output-format", "stream-json", "--verbose",
           "--permission-mode", "acceptEdits"
         ],
         "stdin": "",
         "cwd": ".",
         "env": {},
         "mode": "tick",
         "intervalMinutes": 10,
         "timeoutMinutes": 45
       }
     ]
   }
   ```

4. **Permission allowlists** (trust layer 2): in the repo's committed
   `.claude/settings.json`, allow the two `bin/` scripts and deny raw comment
   posting (`gh issue comment`, direct comment-API `gh api` calls), so the
   comment read/write rules are enforced by the harness, not by model
   compliance.

## Use

- One manual pass: `/status-pipe:tick` (add `--dry-run` to see what it would
  do). Interactive loop: `/status-pipe:launch 10m`. Fleet mode: let the
  status-pipe extension's supervisor launch ticks per `launch.json`.
- The orchestrator never merges, approves, deploys, or publishes — ready PRs
  and operator questions land in the tick report and the extension's
  NEEDS YOU lane; the ack button ("I did my part — take another look")
  writes an inbox file the next tick consumes.

## Migration guide: the prototype repos

`irl-llc` and `git-spice-code-extension` run bespoke `.autopilot` loops.
They migrate by renaming the state convention and splicing two paragraphs
into their existing command prompts — or by replacing their loops with
`/status-pipe:tick` wholesale. **The protocol, not the command set, is the
contract**: the extension works with either.

### Rename mapping (from `design/10-naming.md`)

| Prototype (`.autopilot`) | status-pipe protocol v1 | Note |
|---|---|---|
| `.autopilot/` | `.status-pipe/` | ownership |
| `.autopilot/run/issue-853.json` | `.status-pipe/tickets/853.json` | dir is the type; no `issue-` prefix |
| `.autopilot/run/run.json` | `.status-pipe/orchestrator.json` | "run" was doing four jobs |
| field `issue: 853` (int) | `ticket: "853"` (string) | opaque key; Jira-ready |
| block `run: {…}` | `worker: {…}` | worker liveness, distinct from orchestrator passes |
| `staleRunMinutes` | `staleWorkerMinutes` | gates worker heartbeats |
| `.status-pipe-launch` (earlier draft) | `.status-pipe/launch.json` | one root entry, not two |
| inbox `issue-<N>/` | `<ticket>/` | |
| `/epic-iteration-fanout`, `/autopilot` | `/status-pipe:tick` | one tick |
| `/launch-epic-iterator` | `/status-pipe:launch` | interactive loop wrapper |
| (new) per-issue worker commands | `/status-pipe:work-ticket`, `/status-pipe:work-epic` | ticket mode / epic mode |
| state schema in-repo | `schemas/ticket.schema.json` here | single source |

Kept deliberately: `history[].runId` (generic run reference); `phase`,
`health`, `headline`, `waitingOn`, `blockers`, `history`, `updatedAt`
(unchanged names and semantics); lane names NEEDS YOU / WAITING ON WORLD /
QUIET; "epic", "tranche", "forge". Epic specs keep their legacy
`> **Tracking issue:**` headers — the plugin accepts that spelling forever.

### The two paragraphs to splice into bespoke commands

Repos keeping their own loops (`epic-iteration-fanout.md` and friends) must
add exactly two behaviors for the extension's ack button and parking to work.
Paste these into the command prompts, adjusting only the step numbering.

**1. Inbox consumption (add as an early orchestration step, before
scheduling):**

> **Consume the ack inbox.** Scan `.status-pipe/inbox/*/ack-*.json`. For each
> ack file, read `{ticket, ackId, target: {waitingKind, waitingSince}, note}`
> and compare against that ticket's current state file: if
> `target.waitingKind`/`target.waitingSince` equal the current
> `waitingOn.kind`/`waitingOn.since` (or, for `waitingKind: "blockers"`,
> `blockers[]` is still non-empty and `updatedAt` still equals
> `target.waitingSince`), treat the ack as fresh operator input — make that
> ticket a highest-priority dispatch candidate this pass, carry its `note` to
> the worker, and append to the ticket's `history[]` an entry
> `{at, phase, note: "owner ack <ackId> consumed: <note>", runId: null}` via
> an atomic rewrite (write `*.tmp`, then rename). If the target does not
> match the current state, append `"ack <ackId> superseded (state advanced
> before pickup)"` instead. In both cases, **delete the ack file after the
> history append** — history first, unlink second, so a crash between the two
> reads as "picked up" and the orphan is swept next pass.

**2. Parked declaration (add to the wrap/report step):**

> **Declare parking at wrap.** After writing pass metadata to
> `.status-pipe/orchestrator.json`, decide whether the loop is parked: if
> (a) nothing was dispatchable this pass, (b) every active ticket is waiting
> on the operator (`waitingOn.kind ∈ {owner, review, merge}` or non-empty
> `blockers[]`), and (c) the inbox holds no unconsumed acks, set
> `orchestrator.json.parked = {since: <now>, reason: "<one line>",
> recheckAfter: <now + a few hours>}` (an empty backlog parks the same way
> with its own reason). On any pass that finds dispatchable work, set
> `parked` to null. The extension's supervisor skips scheduled ticks while
> `parked` is set and wakes the loop when an ack file appears, the backlog
> changes on disk, or `recheckAfter` elapses — so declare it honestly and
> never poll for the operator yourself.

### Migration checklist

1. `git mv`/rewrite state writers: `.autopilot/run/issue-<N>.json` →
   `.status-pipe/tickets/<N>.json`, `run.json` → `orchestrator.json`; rename
   the fields per the table (`issue` → `ticket` as a *string*, `run:` block →
   `worker:`, `staleRunMinutes` → `staleWorkerMinutes`).
2. Add the committed `.status-pipe/config.json` + `launch.json` (references
   above) and the gitignore stanza.
3. Splice the two paragraphs above into the bespoke orchestrator command.
4. Route comment reads/writes through `bin/fetch-comments` /
   `bin/post-comment` and add the settings.json allow/deny entries.
5. Validate one emitted ticket file against `schemas/ticket.schema.json`
   (the extension's fixtures validate against the same schemas in CI).
