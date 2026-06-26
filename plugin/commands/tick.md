---
description: One status-pipe orchestration tick — worktree preflight, trust-filtered inventory, ack-inbox consumption, staleness reconcile, fair-schedule dispatch of work-ticket/work-epic workers, orchestrator.json wrap (incl. parked). Idempotent, zero-prompt; loop it with /status-pipe:launch or the extension supervisor.
argument-hint: '[--max-concurrent N] [--dry-run]'
---

**STATUS-PIPE TICK — one orchestration pass (runs in the MAIN agent)**

$ARGUMENTS

You are the **planner** for ONE pass. You do NOT do work-item work and you do
NOT spawn workers yourself — you reconcile state, consume operator signals,
decide which workers should run, stamp + worktree them, **write a dispatch plan
to `orchestrator.json`**, report, and exit. The supervisor (the status-pipe
extension) reads the plan and spawns one real `claude -p` worker process per
item — each a full agent with its own context, skills, and the ability to spawn
its own subagents. Load the `protocol` skill first; its rules are binding. This
command is **idempotent and zero-prompt**: ask the user nothing; surface
everything in the report. Defaults: `--max-concurrent 3`. `--dry-run` does
everything EXCEPT creating tickets/worktrees, writing the dispatch plan, or
consuming (deleting) acks — it reports what it _would_ do.

You **plan**, the supervisor **executes** (design/09): you never spawn a worker
and never wait for one — the pass ends as soon as the plan is written. A ticket
you stamp but the supervisor hasn't spawned yet is recovered by the next pass's
staleness reconcile. Worker failures are NOT planner failures: a worker records
its own failure in its ticket file; a nonzero exit here is reserved for
planner-level fatals (auth gone, crash).

## Step 0 — Worktree preflight (refuse to orchestrate from a worktree)

```bash
GIT_DIR_A="$(git rev-parse --git-dir)"; GIT_DIR_B="$(git rev-parse --git-common-dir)"
```

If they differ, this is a linked worktree. Print exactly:
`worktree checkout of <primary>; run the tick there` (where `<primary>` is
`$(cd "$GIT_DIR_B/.." && pwd)`) and **stop — exit the pass successfully with
no other action**. Worktrees are where workers run, never orchestrators;
ticking here would re-orchestrate the same backlog and mint nested worktrees
every pass.

Then resolve once:

```bash
ROOT="$(git rev-parse --show-toplevel)"        # primary checkout
PROTO="$ROOT/.status-pipe"
mkdir -p "$PROTO/tickets" "$PROTO/inbox"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"           # lastPassStartedAt
CONFIG="$PROTO/config.json"                    # committed; local working tree only
```

Read `config.json` (missing file = all defaults): `epics.dir` (default
`epics`), `inventory.label` (default `agent-queue`), `tickets.source`
(default `github-issues`), `staleWorkerMinutes` (default 30), `trust`,
`attribution`. `repo` = `gh repo view --json nameWithOwner -q .nameWithOwner`
(Jira/Bitbucket: derive `workspace/slug` from the origin remote).

**Trust gate (fail closed)**: check visibility now —
`gh repo view --json visibility -q .visibility` (Bitbucket: `is_private` via
API). If the check fails, treat the repo as **public**. Public (or
treated-as-public) with no declared `trust.mode` ⇒ print the refusal
("public repo without a declared trust mode — declare trust.mode and
trust.operators in .status-pipe/config.json") and stop. Private with no
`trust` block ⇒ `single-maintainer`, operator = `gh api user -q .login`.

## Step 1 — Inventory (filtered per trust mode)

Two sources, per config:

- **Epic mode**: `Glob` `<epics.dir>/*.md`. Read each spec's
  `> **Tracking ticket:**` header (accept legacy `> **Tracking issue:**`).
  An epic with no tracking ticket: search for an existing one
  (`gh issue list --search "<title>"` / JQL) before creating
  (`gh issue create` titled `Epic: <name> — implementation tracking`, labeled
  `<inventory.label>`), then add the header to the spec file. Skip creation
  under `--dry-run`.
- **Ticket mode**: open tickets carrying `inventory.label` —
  `gh issue list --label "<label>" --state open --json number,title,url,assignees,author`
  (Jira: JQL `labels = "<label>" AND statusCategory != Done` via the REST
  search API).

**Filter per trust mode** (protocol skill §6):

- `single-maintainer`: label match is enough.
- `multi-maintainer`: keep only tickets whose **assignee ∈ trust.operators**;
  unassigned or otherwise-assigned tickets are invisible to this agent.
- `public`: keep only tickets whose **author or assignee ∈ trust.operators**
  — outsiders cannot conscript the agent by opening labeled issues.

**Then scope by assignee** (routing, orthogonal to trust): if
`config.inventory.assignees` is present and non-empty (array of usernames, or
the per-channel object form — flatten its values), keep only tickets with an
assignee in that set, **in addition to** the trust filter above. This is how a
shared repo routes work — assign a ticket to a listed identity to hand it to
the agent, assign it elsewhere (or leave it unassigned) to keep it human.
Absent/empty ⇒ no assignee scoping (today's behavior). Ticket mode only; epics
are selected by file, so epic tracking tickets are never dropped by this
filter.

The candidate universe = epics' tracking tickets + filtered labeled tickets,
deduplicated by ticket key (an epic's tracking ticket is the epic, not a
second work item).

## Step 2 — Consume the ack inbox

Scan `"$PROTO"/inbox/*/ack-*.json` (sorted, deterministic). For each ack file
read `{ticket, ackId, target:{waitingKind, waitingSince}, note}` and the
ticket file `"$PROTO/tickets/<ticket>.json"`:

- **Match** — `target.waitingKind == waitingOn.kind && target.waitingSince ==
waitingOn.since`, or (blockers ack: `waitingKind == "blockers"`)
  `blockers[]` still non-empty and `updatedAt == target.waitingSince`:
  append to `history[]` `{at: NOW, phase: <current>, note: "owner ack <ackId>
consumed: <note or 'ready-for-look'>", runId: null}` via atomic rewrite,
  **then** delete the ack file. This ticket becomes a **highest-priority
  dispatch candidate** this tick, with the operator's `note` passed to the
  worker as fresh operator input.
- **Superseded** (no match): append `"ack <ackId> superseded (state advanced
before pickup)"`, delete the file. No error.
- Ack for a ticket with no ticket file: delete the orphan, note it in the
  report.

History append before unlink, always (crash-safe ordering). Under `--dry-run`,
report matches/supersessions but write and delete nothing.

## Step 3 — Reconcile staleness

For every `"$PROTO"/tickets/*.json` with `worker.status == "running"` and
`worker.heartbeatAt` older than `staleWorkerMinutes` minutes ago: the worker
crashed. Atomic rewrite: `worker.status = "error"`, append history
`{at: NOW, note: "worker presumed crashed (heartbeat stale > <N>m); eligible for relaunch"}`,
set `updatedAt`. The card escalates in the extension; the ticket is eligible
for relaunch this very tick.

## Step 4 — Fair-schedule and dispatch

**Candidate set** = inventory items whose ticket file `phase` is not terminal
(`merged`/`abandoned`), that are not waiting on the operator with nothing to
do (skip `health == "waiting"|"blocked"` items UNLESS step 2 consumed an ack
for them), and that have no **live** worker (`worker.status == "running"`
with a fresh heartbeat). No ticket file yet = `planning`, oldest.

Order: **ack-consumers first**, then oldest `updatedAt` first (missing file =
oldest) so nothing starves. Free slots = `max-concurrent − (live workers
now)`; take the first `freeSlots`. NEVER plan a second worker for a ticket that
already has a live one — the supervisor also dedups by `key`, but the planner is
the first guard.

For each selected item, BEFORE adding it to the plan (skip all of this under
`--dry-run`):

1. **Stamp the ticket file** so a concurrent/next pass can't double-dispatch —
   atomic rewrite (create the file with required fields `schemaVersion: 1,
repo, ticket, title, phase: "planning", health: "ok", updatedAt` if
   absent): `worker = {status: "running", taskId: null, startedAt: NOW,
heartbeatAt: NOW}`, `updatedAt = NOW`.
2. **Ensure the work-item worktree**: `git worktree list`; if absent
   `git worktree add "$ROOT/.claude/worktrees/<slug>" <stack tip | main>`
   (slug = epic slug or `ticket-<key>`).
3. **Add the worker to the dispatch plan** (you do NOT spawn it). Its entry:
   - `kind`: `"ticket"` or `"epic"`.
   - `key`: the ticket key — for an epic, its **tracking-ticket** key, not the
     slug (the dispatch identity; one writer per key, matching design/09).
   - `prompt`: `/status-pipe:work-ticket <key>` (ticket) or
     `/status-pipe:work-epic <abs-epic-path>` (epic). If an ack was consumed for
     it, append ` Operator ack note: "<note>"`.
   - `worktree`: the **absolute** worktree path from step 2.

Collect the selected items into the dispatch plan written in Step 5:
`{maxConcurrent: <the cap you used>, items: [...]}`. Do NOT spawn workers and do
NOT wait — the supervisor reads the plan and spawns one `claude -p` worker
process per item, deduplicated by `key`. Note items deferred by the cap.

## Step 5 — Wrap: orchestrator.json + report

Atomic-rewrite `"$PROTO"/orchestrator.json`: `schemaVersion: 1`, `repo`,
`passCount` (previous + 1), `lastPassStartedAt = NOW`, `lastPassFinishedAt =
date -u` (fresh), `staleWorkerMinutes` (echoed from config), and **`dispatch`**
— the plan from Step 4 (`{maxConcurrent, items: [{kind, key, prompt,
worktree}]}`) when any worker was scheduled this pass, else `null`. This is the
planner→supervisor handoff: writing the plan IS the dispatch; the supervisor
spawns one worker process per item. (Under `--dry-run`, report the plan but
write nothing.)

**Parked declaration** (protocol skill §9): if (a) nothing was dispatchable
this pass, (b) every active item has `waitingOn.kind ∈ {owner, review, merge,
comment}` or is blocked, and (c) the inbox is empty — set
`parked = {since: <finish time>, reason: "<one line, e.g. '4 active items all
waiting on you; no dispatchable work'>", recheckAfter: <finish time + 6h>}`.
An item waiting on the world (`waitingOn.kind == "build"`, i.e. CI) is NOT
operator-blocked — it keeps ticking, so it does not satisfy (b). An empty
backlog parks too ("backlog empty — nothing tracked"). On any pass that found
work, set `parked = null`.

Then report, grouped so the operator can act (every PR/ticket number as a
markdown link):

- **Needs you (top)**: blocked items and `waitingOn.kind ∈ {owner, review,
merge, comment}` — the decision needed, deep link first.
- **Ready to merge**: PRs `draft: false, ci: "passing"` / phase
  `awaiting-merge`.
- **In flight / waiting**: per item `phase` + `headline` + `waitingOn`.
- **This pass**: acks consumed/superseded, stale workers reconciled, workers
  dispatched (planned for the supervisor to spawn), deferred by cap, parked or
  not (and why).

Then stop. Do not loop, do not schedule anything — `/status-pipe:launch` or
the extension supervisor owns cadence.
