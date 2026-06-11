# Claude Code Plugin: `status-pipe`

The second deliverable: a Claude Code plugin providing a **baseline,
repo-agnostic agent workflow** that emits the protocol from
[02-protocol.md](02-protocol.md) — usable in any repo as an alternative
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
├── .claude-plugin/plugin.json     # name: status-pipe
├── commands/
│   ├── launch.md                  # /status-pipe:launch [interval]
│   ├── tick.md                  # /status-pipe:tick [--max-concurrent N] [--dry-run]
│   ├── work-ticket.md              # /status-pipe:work-ticket <ticket-key>
│   ├── work-epic.md               # /status-pipe:work-epic <epics/file.md>
│   └── ack-check.md               # /status-pipe:ack-check  (inbox consume, standalone)
├── skills/
│   └── protocol/SKILL.md           # how to read/write the status-pipe protocol correctly
└── README.md                      # migration guide for the prototype repos
                                   # (rename mapping + inbox/parked prompt paragraphs)
```

## The two supported work models

Mirrors the two real workflows:

1. **Ticket mode** (`work-ticket`) — pure ticket flow, the
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

Both modes write the identical `tickets/<key>.json`; status-pipe (the extension)
renders them identically. Epic-mode cards additionally deep-link the epic file.

## Command behavior

### `tick` — one orchestration tick (main agent, idempotent, zero-prompt)

1. **Inventory**: epics under `epics/*.md` (epic mode) and/or open tickets with
   the configured label, default `agent-queue` (ticket mode). Create missing
   tracking tickets.
2. **Consume the ack inbox** (`.status-pipe/inbox/*/ack-*.json`): match
   `target` against current `waitingOn` per
   [02-protocol.md](02-protocol.md#feedback-signal); consumed acks
   become highest-priority dispatch candidates this tick; record
   consumption/supersession in `history[]`; delete the files.
3. **Reconcile staleness**: `worker.status=running` with heartbeat older than
   `staleWorkerMinutes` ⇒ treat as crashed, mark `worker.status=error` with a
   history note (the card escalates in the extension), eligible for relaunch.
4. **Fair-schedule**: oldest `updatedAt` first, ack-consumers first,
   `--max-concurrent` cap; dispatch `work-ticket`/`work-epic` loops as
   background tasks in per-work-item git worktrees.
5. **Write `orchestrator.json`** (passCount, timestamps) and report: needs-you items,
   ready-to-merge PRs, in-flight work. If nothing was dispatchable and every
   active item is parked on the operator with an empty inbox, set
   `orchestrator.json.parked` (`{since, reason, recheckAfter}`) so the extension's
   supervisor stops the tick cadence until an ack or backlog change wakes it
   ([09-launch-and-supervision.md](09-launch-and-supervision.md)); clear it on
   any pass that finds work.

### `work-ticket` / `work-epic` — one work-item pass

Phase machine identical in shape to irl-llc's tranche loop, generalized:
**orient** (reconcile git + forge + ticket file; consume any inbox acks for this
ticket) → **plan** → **implement** → **review** (self-review the diff) →
**submit** (create/update PR; stacked PRs via git-spice when available, plain
branches otherwise — git-spice is *not* required) → **gate** (CI kicked off,
bot comments answered; never block waiting on CI) → **wrap**.

State-writing discipline (enforced by the `protocol` skill):

- rewrite `tickets/<key>.json` atomically at every phase transition and at wrap;
  heartbeat (`worker.heartbeatAt`) at least every few minutes while running
- `headline` is always one sentence, present tense, operator-readable
- when human input is needed: set `waitingOn` with a **deep-linkable `ref`**
  (the exact comment URL — the extension's highest-value click), set
  `health=waiting` or `blocked` + `blockers[]`, post the actual question on the
  tracking ticket/PR, then *end the pass* — never poll for the human
- append `history[]` on every meaningful action; never rewrite history
- never merge, never approve; merge readiness is expressed as
  `waitingOn.kind=merge`

### `launch` — recurring wrapper

Invokes the `/loop` skill with the chosen interval (default 10m) running
`tick`. Same shape as irl-llc's `launch-epic-iterator`. This is the
*interactive* way to run the loop (single-repo mode, Claude pane open); in
fleet mode the extension's supervisor launches `tick` directly as a headless
tick (`claude -p "/status-pipe:tick" --output-format stream-json`) per
[09-launch-and-supervision.md](09-launch-and-supervision.md). `tick` is
deliberately a one-pass, zero-prompt command so both paths share it. The plugin
README ships a reference `.status-pipe/launch.json` for Claude Code.

### `ack-check` — standalone inbox sweep

Steps 2–3 of `tick` only. Useful for fast hand-back latency between full
ticks, or for repos where a human drives agents manually but still wants the
extension's ack button to work.

## Migration path for the prototype repos

`irl-llc` and `git-spice-code-extension` migrate their bespoke `autopilot`
loops to the status-pipe protocol using the rename mapping in
[10-naming.md](10-naming.md) (`.autopilot` → `.status-pipe`, `issue` →
`ticket`, `run` → `worker`, …). The plugin README ships, alongside that
mapping, the two prompt paragraphs their existing commands
(`epic-iteration-fanout.md` etc.) need to splice in: inbox consumption
(consume `.status-pipe/inbox/`, record `ackId` in `history[]`, delete the
file) and the `parked` declaration at wrap. Repos can keep their bespoke
loops or replace them with `/status-pipe:tick` wholesale; the extension works
with either, since the protocol — not the command set — is the contract.

## Testing

The plugin's contract surface is tested from the extension repo: fixture ticket
files used in unit/Playwright tests are validated against
`schemas/ticket.schema.json` and `schemas/ack.schema.json`, and the schemas are
shared by both the plugin docs and the extension parser — one contract, two
consumers, validated in CI.
