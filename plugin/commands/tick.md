---
description: One status-pipe orchestration tick — worktree preflight, trust-filtered inventory, ack-inbox consumption, staleness reconcile, fair-schedule dispatch of work-ticket/work-epic workers, orchestrator.json wrap (incl. parked). Idempotent, zero-prompt; loop it with /status-pipe:launch or the extension supervisor.
argument-hint: "[--max-concurrent N] [--dry-run]"
---

**STATUS-PIPE TICK — one orchestration pass (runs in the MAIN agent)**

$ARGUMENTS

You are the orchestrator for ONE pass. You do NOT do work-item work yourself —
you reconcile state, consume operator signals, fan out workers, wait for them,
write `orchestrator.json`, report, and exit. Load the `protocol` skill first;
its rules are binding. This command is **idempotent and zero-prompt**: ask the
user nothing; surface everything in the report. Defaults: `--max-concurrent 3`.
`--dry-run` does everything EXCEPT creating tickets/worktrees, launching
workers, or consuming (deleting) acks — it reports what it *would* do.

Workers run INSIDE the tick: dispatch them as background tasks, then **wait
for all of them to finish before wrapping** — nothing outlives the tick
(design/09: the supervisor's process model and the single-writer invariant
depend on it). Worker failures are NOT tick failures: record them in the
ticket file and still exit cleanly; a nonzero exit is reserved for
orchestrator-level fatals (auth gone, crash).

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
now)`; take the first `freeSlots`. NEVER launch a second worker for a ticket
that already has a live one.

For each selected item, BEFORE launching (skip all of this under `--dry-run`):

1. **Stamp the ticket file** so a concurrent/next pass can't double-launch —
   atomic rewrite (create the file with required fields `schemaVersion: 1,
   repo, ticket, title, phase: "planning", health: "ok", updatedAt` if
   absent): `worker = {status: "running", taskId: null, startedAt: NOW,
   heartbeatAt: NOW}`, `updatedAt = NOW`.
2. **Ensure the work-item worktree**: `git worktree list`; if absent
   `git worktree add "$ROOT/.claude/worktrees/<slug>" <stack tip | main>`
   (slug = epic slug or `ticket-<key>`).
3. **Launch the worker as a background task** whose prompt is
   `/status-pipe:work-epic <abs-epic-path>` (epic) or
   `/status-pipe:work-ticket <key>` (ticket), run with cwd = the worktree.
   If an ack was consumed for it, append the operator's note to the prompt:
   `Operator ack note: "<note>"`.

Emit all launch calls in a SINGLE message so they run concurrently. Then
**wait for every launched worker to complete** before Step 5 (workers rewrite
their own ticket files, setting `worker.status` back to `idle` at wrap). Note
items deferred by the cap.

## Step 5 — Wrap: orchestrator.json + report

After all workers finish, atomic-rewrite `"$PROTO"/orchestrator.json`:
`schemaVersion: 1`, `repo`, `passCount` (previous + 1), `lastPassStartedAt =
NOW`, `lastPassFinishedAt = date -u` (fresh), `staleWorkerMinutes` (echoed
from config).

**Parked declaration** (protocol skill §9): if (a) nothing was dispatchable
this pass, (b) every active item has `waitingOn.kind ∈ {owner, review, merge}`
or is blocked, and (c) the inbox is empty — set
`parked = {since: <finish time>, reason: "<one line, e.g. '4 active items all
waiting on owner; no dispatchable work'>", recheckAfter: <finish time + 6h>}`.
An empty backlog parks too ("backlog empty — nothing tracked"). On any pass
that found work, set `parked = null`.

Then report, grouped so the operator can act (every PR/ticket number as a
markdown link):

- **Needs you (top)**: blocked items and `waitingOn.kind ∈ {owner, review,
  merge}` — the decision needed, deep link first.
- **Ready to merge**: PRs `draft: false, ci: "passing"` / phase
  `awaiting-merge`.
- **In flight / waiting**: per item `phase` + `headline` + `waitingOn`.
- **This pass**: acks consumed/superseded, stale workers reconciled, workers
  launched, deferred by cap, parked or not (and why).

Then stop. Do not loop, do not schedule anything — `/status-pipe:launch` or
the extension supervisor owns cadence.
