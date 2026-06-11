# Claude Code Plugin: `status-pipe-agent`

The second deliverable: a Claude Code plugin providing a **baseline,
repo-agnostic agent workflow** that emits the state contract from
[02-state-schema.md](02-state-schema.md) — usable in any repo as an alternative
to the bespoke `autopilot` command sets living in `irl-llc` and
`git-spice-code-extension` today. The extension is useless without something
writing the files; this plugin is the reference writer.

It lives in this repo under `plugin/` (a Claude Code plugin marketplace can
point at the repo; it can be split out later — surfaces over implementations:
the plugin's command names and file contract are the stable surface, its
location is not).

## Structure

```
plugin/
├── .claude-plugin/plugin.json     # name: status-pipe-agent
├── commands/
│   ├── launch.md                  # /status-pipe-agent:launch [interval]
│   ├── fanout.md                  # /status-pipe-agent:fanout [--max-concurrent N] [--dry-run]
│   ├── work-issue.md              # /status-pipe-agent:work-issue <issue-number>
│   ├── work-epic.md               # /status-pipe-agent:work-epic <epics/file.md>
│   └── ack-check.md               # /status-pipe-agent:ack-check  (inbox consume, standalone)
├── skills/
│   └── state-contract/SKILL.md    # how to read/write .autopilot files correctly
└── README.md                      # adoption guide, incl. the one-paragraph
                                   # inbox patch for existing autopilot repos
```

## The two supported work models

Mirrors the two real workflows:

1. **Issue mode** (`work-issue`) — pure ticket flow, the
   git-spice-code-extension style: a tracking ticket is the work spec and the
   communication channel. Cache key = ticket key. The **ticketing source**
   follows the forge: GitHub repos use GitHub issues (key = issue number);
   Bitbucket Cloud repos use **Jira Cloud** (key = `PROJ-123`; inventory via a
   JQL label query instead of `gh issue list`; design-intent comments go on
   the Jira ticket via its REST API; Jira site/project configured in the
   plugin's repo config).
2. **Epic mode** (`work-epic`) — the irl-llc style: an `epics/<slug>.md` file
   is the spec (with `> **Tracking issue:** owner/repo#N` — or `PROJ-123` on
   Jira-tracked repos — in the header; the command creates the tracking ticket
   and inserts the header if missing). The tracking ticket is the agent↔human
   design-intent channel. Cache key = tracking ticket key.

Both modes write the identical `issue-<N>.json`; status-pipe (the extension)
renders them identically. Epic-mode cards additionally deep-link the epic file.

## Command behavior

### `fanout` — one orchestration tick (main agent, idempotent, zero-prompt)

1. **Inventory**: epics under `epics/*.md` (epic mode) and/or open issues with
   the configured label, default `agent-queue` (issue mode). Create missing
   tracking issues.
2. **Consume the ack inbox** (`.autopilot/inbox/issue-*/ack-*.json`): match
   `target` against current `waitingOn` per
   [02-state-schema.md](02-state-schema.md#feedback-signal); consumed acks
   become highest-priority dispatch candidates this tick; record
   consumption/supersession in `history[]`; delete the files.
3. **Reconcile staleness**: `run.status=running` with heartbeat older than
   `staleRunMinutes` ⇒ treat as crashed, mark `run.status=error` with a
   history note (the card escalates in the extension), eligible for relaunch.
4. **Fair-schedule**: oldest `updatedAt` first, ack-consumers first,
   `--max-concurrent` cap; dispatch `work-issue`/`work-epic` loops as
   background tasks in per-work-item git worktrees.
5. **Write `run.json`** (passCount, timestamps) and report: needs-you items,
   ready-to-merge PRs, in-flight work. If nothing was dispatchable and every
   active item is parked on the operator with an empty inbox, set
   `run.json.parked` (`{since, reason, recheckAfter}`) so the extension's
   supervisor stops the tick cadence until an ack or backlog change wakes it
   ([09-launch-and-supervision.md](09-launch-and-supervision.md)); clear it on
   any pass that finds work.

### `work-issue` / `work-epic` — one work-item pass

Phase machine identical in shape to irl-llc's tranche loop, generalized:
**orient** (reconcile git + forge + state file; consume any inbox acks for this
issue) → **plan** → **implement** → **review** (self-review the diff) →
**submit** (create/update PR; stacked PRs via git-spice when available, plain
branches otherwise — git-spice is *not* required) → **gate** (CI kicked off,
bot comments answered; never block waiting on CI) → **wrap**.

State-writing discipline (enforced by the `state-contract` skill):

- rewrite `issue-<N>.json` atomically at every phase transition and at wrap;
  heartbeat (`run.heartbeatAt`) at least every few minutes while running
- `headline` is always one sentence, present tense, operator-readable
- when human input is needed: set `waitingOn` with a **deep-linkable `ref`**
  (the exact comment URL — the extension's highest-value click), set
  `health=waiting` or `blocked` + `blockers[]`, post the actual question on the
  tracking issue/PR, then *end the pass* — never poll for the human
- append `history[]` on every meaningful action; never rewrite history
- never merge, never approve; merge readiness is expressed as
  `waitingOn.kind=merge`

### `launch` — recurring wrapper

Invokes the `/loop` skill with the chosen interval (default 10m) running
`fanout`. Same shape as irl-llc's `launch-epic-iterator`. This is the
*interactive* way to run the loop (single-repo mode, Claude pane open); in
fleet mode the extension's supervisor launches `fanout` directly as a headless
tick (`claude -p "/status-pipe-agent:fanout" --output-format stream-json`) per
[09-launch-and-supervision.md](09-launch-and-supervision.md). `fanout` is
deliberately a one-pass, zero-prompt command so both paths share it. The plugin
README ships a reference `.status-pipe-launch` for Claude Code.

### `ack-check` — standalone inbox sweep

Steps 2–3 of `fanout` only. Useful for fast hand-back latency between full
ticks, or for repos where a human drives agents manually but still wants the
extension's ack button to work.

## Adoption path for existing autopilot repos

The README ships the one-paragraph prompt addition (consume
`.autopilot/inbox/`, record `ackId` in history, delete file) to splice into
`epic-iteration-fanout.md` / the existing autopilot command — existing loops
keep their bespoke behavior and gain ack support; the extension works with
both from day one.

## Testing

The plugin's contract surface is tested from the extension repo: fixture state
files used in unit/Playwright tests are validated against
`schemas/state.schema.json` and `schemas/ack.schema.json`, and the schemas are
shared by both the plugin docs and the extension parser — one contract, two
consumers, validated in CI.
