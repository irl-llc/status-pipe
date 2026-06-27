# The status-pipe Protocol

The file contract under `.status-pipe/` at each repo root — the only coupling
between agents and the extension. Naming and roles per
[10-naming.md](10-naming.md). The contract is **read-only** for the extension
with one exception: ack files in `inbox/`, which the extension (the operator)
writes and the orchestrator consumes.

The protocol is the direct descendant of the `.autopilot` convention shared by
the `irl-llc` and `git-spice-code-extension` prototypes; the rename mapping for
migrating those repos is in [10-naming.md](10-naming.md).

## Layout

```
<repo>/
└── .status-pipe/
    ├── launch.json              # committed: how to launch this repo's orchestrator
    │                            #   (schema + semantics in 09-launch-and-supervision.md)
    ├── config.json              # committed: repo conventions — epic dir, inventory
    │                            #   label, ticketing source, trust mode, attribution
    │                            #   (schema + semantics in 07-claude-plugin.md)
    ├── orchestrator.json        # gitignored: orchestrator pass metadata
    ├── tickets/                 # gitignored: one file per tracked ticket (agent-side-owned)
    │   ├── 853.json
    │   └── PROJ-123.json
    └── inbox/                   # gitignored: operator → orchestrator signals
        └── 853/
            └── ack-bcd313df.json
```

```gitignore
.status-pipe/*
!.status-pipe/launch.json
!.status-pipe/config.json
```

A repo "participates" if `.status-pipe/` exists at a workspace folder root or
one directory level below it (the same root-plus-one-level rule
[04-architecture.md](04-architecture.md)'s discovery implements, covering
meta-workspaces that contain several repos). Repos without it are silently
ignored. JSON Schemas ship in this repository
under `schemas/` and are vendored by both the extension and the plugin — they
are not copied per-repo.

**One protocol dir per repository, at the primary checkout.** Linked worktrees
are full checkouts and therefore carry the committed `launch.json` /
`config.json`, but they never host a live protocol dir: agents anchor every
protocol write at `git rev-parse --git-common-dir`/../`.status-pipe/`, the
extension never supervises or separately lists a worktree (it resolves the
worktree's `gitdir:` pointer back to the primary), and the orchestrator
refuses to tick from a worktree. Three independent guards against the
recursion where supervising a worktree would re-orchestrate the same backlog
and mint nested worktrees each pass — details in
[04-architecture.md](04-architecture.md) and
[07-claude-plugin.md](07-claude-plugin.md).

## `tickets/<key>.json` (agent-side–owned)

Schema: `schemas/ticket.schema.json`, `schemaVersion: 1`. The filename is the
ticket key — `853` (GitHub issue) or `PROJ-123` (Jira). **Write ownership**:
exactly one agent-side process per repo writes ticket files at a time — the
orchestrator runs workers *within* a tick and writes between/around them
([09-launch-and-supervision.md](09-launch-and-supervision.md) specifies the
single-process invariant). The extension never writes them. Fields and how the
extension interprets them:

| Field | Type | Interpretation |
|---|---|---|
| `schemaVersion` | `1` | Higher versions render as a degraded "unknown schema" card — title, clamped `headline`, ticket link, "update status-pipe" notice, raw-JSON peek — rather than being hidden; never silently drop work. |
| `repo` | `owner/name` | Cross-checked against the forge repository inferred from the git remote; mismatch shows a warning on hover. |
| `ticket` | string | Opaque ticket key; card identity is `(workspaceFolder, ticket)`. |
| `title`, `slug`, `url` | string | Card header; `url` deep-links the tracking ticket (GitHub or Jira). |
| `phase` | `planning \| implementation \| review \| fixing \| merging \| awaiting-merge \| merged \| blocked \| abandoned` | Phase as dim text. `merged`/`abandoned` move the card to QUIET. |
| `health` | `ok \| waiting \| blocked \| error \| done` | Card accent color and lane bucket ([05-ui.md](05-ui.md)). |
| `headline` | string | The agent's one-sentence "what just happened", verbatim; 2-line clamp, full on hover. |
| `waitingOn` | null or `{kind, ref, pr, since, detail}` | `kind ∈ {build, review, comment, owner, merge}`. owner/review/merge/comment ⇒ NEEDS YOU; build ⇒ WAITING. `ref` should deep-link the exact comment/run. `since` renders as a live duration. |
| `prs[]` | `{number, url, head, base, draft, state, ci, part}` | One PR row each; `head`/`base` drive the stack indicators (below). `ci ∈ {unknown, pending, passing, failing}` is the worker's cached view — superseded by live forge checks when enrichment succeeds. |
| `blockers[]` | string[] | Red text, verbatim; non-empty forces NEEDS YOU regardless of `health`. |
| `plan` | optional string | Agent working memory: the current plan, carried across passes (rewritten as it evolves). Not rendered today; surfaced in the raw-JSON peek. |
| `deadEnds[]` | optional `{at, tried, failedBecause, doNotRetryWithout}` | Agent working memory: append-only log of approaches that failed, so a later pass does not repeat them. Not rendered today; raw-JSON peek only. |
| `notes` | optional string | Agent working memory: free-form scratchpad carried across passes. Not rendered. |
| `subTickets[]` | optional `{key, url, topic, status}` | Discussion channels carved out of an epic's tracking ticket ([07-claude-plugin.md](07-claude-plugin.md)); listed in the expanded card. Not work items — the epic stays one card. |
| `agentCommentIds[]` | optional string[] | API ids of comments the agent itself posted (written by the plugin's posting wrapper); the trust gateway excludes them from operator-signal detection on shared accounts ([07-claude-plugin.md](07-claude-plugin.md)). Not rendered. |
| `history[]` | `{at, phase, note, runId}` | Append-only log; the expanded card's timeline. `runId` is a deliberately generic run reference (CI run, workflow run). Ack consumption/supersession is recorded here. |
| `worker` | `{status: idle\|running\|error, taskId, startedAt, heartbeatAt}` | Worker liveness. `running` with `heartbeatAt` older than `staleWorkerMinutes` ⇒ stale-worker escalation (NEEDS YOU, top priority). `taskId` is diagnostic only — surfaced in the raw-JSON peek, not rendered. |
| `stalledPasses` | optional integer | Consecutive worker passes that ended with no material progress; reset to 0 on any advancing pass. At the worker's threshold it escalates (`health="error"` + a blocker) so a spinning worker surfaces in NEEDS YOU instead of looking healthy. Absent = 0; not rendered directly (the escalation is). |
| `updatedAt` | ISO-8601 | Relative timestamp; fair-scheduling sort key within lanes. |

### Operator-facing prose: the brevity contract

`headline`, `blockers[]`, `waitingOn.detail`, and each `history[].note` are the
only free prose the operator reads at a glance. They are a triage signal, not a
log — the display's whole value is beating the raw ticket file at "what needs
me, and the shortest path to act." Verbose fields defeat that, so brevity here
is a protocol rule, not a style note:

- **`headline`** — one clause, present tense, fits one rendered line: *what just
  happened*. "Operator must restore the worktree git allowlist for ticket-72."
  Not three sentences, not the reasoning chain, not a recap of the pass.
- **`blockers[]`** — each entry is one terse imperative naming the thing **only
  the operator can do** ("Grant `docker` to the ticket-72 worktree"). One
  blocker per array entry; no entry is a paragraph.
- **`waitingOn.detail`** — one short phrase that labels the wait; the
  deep-linkable `ref` carries the rest.
- **Action, not justification.** The operator-facing field states the *action*;
  the *why* — context, reasoning, what was tried — goes in a `history[]` note
  (the operator-facing record) or in `plan`/`notes` (agent working memory),
  never crammed into `headline` or `blockers`. The common failure mode is
  defensive over-explanation when blocked: a wall of permission/trust prose
  belongs in history, and the blocker stays one line.

The renderer enforces the ceiling (headline 2-line clamp, full text on hover),
but a field that *needs* the clamp is already too long. Write to the glance.

### Agent working memory (`plan`, `deadEnds[]`, `notes`)

Workers run as fresh, memory-less passes (`claude -p`); the durable state above
is all that survives between them. `plan`/`deadEnds[]`/`notes` are the worker's
*own* carry-over — distinct from `headline`/`history[]`, which are the
operator-facing record. A pass writes them so the next pass resumes from a known
plan and a known set of dead-ends instead of re-deriving from zero (the
re-derivation that produces confabulation and repeated impossible attempts).
They are agent-owned and not rendered as card UI today (raw-JSON peek only); the
extension must tolerate their presence and absence equally.

### Stack relationships (derived, not stored)

Per-PR `head`/`base` branch names are matched across all PRs of all ticket
files in the same repo:

- **upstream indicator** (small/dim, above the PR row): the PR's `base` —
  plain `main` when trunk, `↑ T1a #855` when the base is another tracked PR's
  head.
- **downstream indicator** (below): every tracked PR whose `base` equals this
  PR's `head`.

Orientation only — no transitive layout; stack visualization belongs to the
git-spice extension.

## `orchestrator.json` (orchestrator-owned)

```json
{
  "schemaVersion": 1,
  "repo": "irl-llc/irl-llc",
  "passCount": 31,
  "lastPassStartedAt": "2026-06-12T03:38:10Z",
  "lastPassFinishedAt": "2026-06-12T03:40:00Z",
  "staleWorkerMinutes": 30,
  "parked": {
    "since": "2026-06-12T03:40:00Z",
    "reason": "4 active tickets all waiting on owner; no dispatchable tranches",
    "recheckAfter": "2026-06-12T09:40:00Z"
  },
  "dispatch": {
    "maxConcurrent": 3,
    "items": [
      { "kind": "ticket", "key": "19", "prompt": "/status-pipe:work-ticket 19", "worktree": "/repo/.claude/worktrees/ticket-19" }
    ]
  },
  "note": "..."
}
```

- `staleWorkerMinutes` gates the stale-heartbeat computation. Its committed
  source of truth is `config.json` (`staleWorkerMinutes`, default 30) — the
  orchestrator reads it there and echoes it here so the extension sees the
  live value; `statusPipe.staleWorkerMinutesDefault` is the fallback when
  neither file has it.
- `lastPassFinishedAt` renders on the repo header hover ("orchestrator last
  ran 12m ago").
- `parked` (optional): declares that no work is dispatchable and everything
  active waits on the operator; the supervisor suspends ticks until a wake
  event or `recheckAfter`. Full semantics in
  [09-launch-and-supervision.md](09-launch-and-supervision.md). Orchestrators
  that never write it are simply never parked.
- `dispatch` (optional): the **planner→supervisor handoff** — the workers the
  planner stamped this pass for the supervisor to spawn, each
  `{kind, key, prompt, worktree}`, capped at `maxConcurrent`; `null`/omitted
  when none. The planner writes the plan and exits without spawning anything;
  the supervisor reads it and launches one `claude -p` worker process per item
  (one per `key`). This is why the tick is a *planner*, not the whole unit of
  work — full semantics in
  [09-launch-and-supervision.md](09-launch-and-supervision.md).

## <a name="lifecycle"></a>Ticket lifecycle: the forge issue is the truth

The **forge issue's open/closed state is the source of truth** for whether a
ticket is live; the ticket file's `phase` (terminal at `merged`/`abandoned`) is
a cache the planner reconciles against it every pass. This makes completion and
re-opening work without a worker running:

- **Close.** When a ticket's issue has closed (a merged PR's `Closes #<key>`, or
  an operator close) it drops out of the open-labeled inventory. The planner
  looks up such drifted tickets and writes the terminal state — `merged`, or
  `abandoned` when the issue was closed as not-planned — so completed work goes
  QUIET instead of lingering at `awaiting-merge`. The worker also closes on a
  merge it observes (the fast path), but after "merge then walk away" no worker
  runs, so the planner is the guarantee. A forge-lookup failure closes nothing
  (a hiccup must never abandon live work).
- **Re-open.** A terminal ticket whose issue the forge reports **reopened** is
  revived to `planning` and re-dispatched, resuming from its preserved
  `plan`/`deadEnds`/`history` rather than starting over. The reopened check (not
  merely "terminal but still labeled") is what stops a merged ticket whose PR
  never auto-closed its issue from flip-flopping closed↔open every pass.
- **Operator remove.** A settled (QUIET) ticket card carries a **Remove** action
  that deletes the ticket file — the *second* write the extension makes to a
  protocol dir (the ack inbox is the first), and only ever for a terminal
  ticket. Nothing durable is lost: the issue stays the record, and re-opening it
  later re-creates the ticket fresh (no file ⇒ the planner mints one on
  dispatch). A kept file instead resumes its memory.
- **Worktrees are a disposable cache.** Created per dispatch under
  `.claude/worktrees/<slug>` and reclaimed when they back no live work — the
  worker self-removes when a ticket reaches a terminal phase (belt), and the planner GCs any that
  remain (suspenders), so a finished checkout never lingers on the trunk. Code
  lives on branches/PRs and memory in the ticket file, so removal is free and a
  re-opened ticket simply re-provisions its worktree (reattaching the branch).

## <a name="feedback-signal"></a>The ack inbox (operator-owned)

When the worker asks for the operator (`waitingOn.kind ∈ {owner, review,
comment, merge}` or `blockers[]`), the operator answers on the forge/ticket,
then says **"I did my part — take another look"** without opening a terminal.
This is the one write the extension performs, and the design came out of the
operator-day simulation ([08-workflow-simulation.md](08-workflow-simulation.md)).

### Design: one file per signal event

```
.status-pipe/inbox/<ticket>/ack-<ackId>.json
```

The extension creates the file (write `*.tmp`, then `rename(2)`); the
orchestrator consumes it by **deleting** it after recording consumption in the
ticket's `history[]`. Rationale:

- **No shared mutable file.** Ticket files are rewritten wholesale by the
  worker at unpredictable times; any field the extension wrote there would
  eventually be clobbered. File-per-event means creation is atomic,
  consumption is `unlink`, and writer/consumer never edit the same bytes.
- **Same transport.** The signal rides the protocol directory the orchestrator
  already globs every tick — no daemon, no queue, no forge round-trip.
- **Evidence > state.** The durable record of consumption is the `history[]`
  entry naming the `ackId`; the inbox file is just the wire. No `consumed/`
  graveyard to garbage-collect.
- **Graceful degradation.** Orchestrators that predate the protocol never
  consume the file; the extension shows "sent, not yet picked up" and
  escalates it as stale — which is honest.

### File schema (`schemas/ack.schema.json`)

```json
{
  "schemaVersion": 1,
  "kind": "ready-for-look",
  "ticket": "142",
  "ackId": "bcd313df",
  "target": {
    "waitingKind": "owner",
    "waitingSince": "2026-06-11T07:55:22Z",
    "ref": "https://github.com/org/fleet-api/issues/142#issuecomment-9981",
    "pr": null
  },
  "stateUpdatedAt": "2026-06-11T08:01:13Z",
  "note": "Answered — go with option B, rotation window configurable",
  "createdAt": "2026-06-11T08:46:40Z",
  "createdBy": "status-pipe-vscode@0.1.0"
}
```

- `ackId` = first 8 hex chars of `sha256(ticket + waitingKind + waitingSince)`.
  Always 8 chars, everywhere — history notes name it verbatim (`"ack bcd313df
  consumed"`) and the chip state machine matches the exact 8-char id, so
  truncation is a protocol violation, not a style choice. **Naturally
  idempotent**: re-clicking the button for the same outstanding request
  computes the same id; the file already exists; the write is a no-op
  ("already sent"). A genuinely new request (new `since`) hashes to a new id.
- `target` snapshots the `waitingOn` being answered and `stateUpdatedAt` the
  ticket file's `updatedAt` at click time — together the supersession guard.
- **Blockers-only acks** (`blockers[]` non-empty, `waitingOn` null): the hash
  inputs are `waitingKind = "blockers"` and `waitingSince = updatedAt` of the
  ticket file at click time; the target matches while `blockers[]` is
  non-empty and `updatedAt` is unchanged, and is superseded otherwise.
- `note`: optional one-liner shown to the orchestrator (often saves a forge
  round-trip).
- `kind` is an enum from day one: `ready-for-look` now; `pause`, `abandon`,
  `priority-bump` are obvious future signals through the same pipe.

### Lifecycle

1. **Operator acks** (button on the card, optional note) → file created
   atomically. Card chip: mail glyph + "sent 14:02"; card moves NEEDS YOU →
   WAITING. Creation also wakes the orchestrator immediately
   ([09-launch-and-supervision.md](09-launch-and-supervision.md)).
2. **Orchestrator consumes** at tick start: scan `inbox/*/`. If the ack's
   `target` matches the current `waitingOn` → treat as fresh operator input
   (highest-priority context), append `history[]` `{at, phase, note: "owner
   ack bcd313df consumed: <note>", runId}`, then delete the file.
3. **Supersession**: target doesn't match current `waitingOn` (the
   orchestrator already saw the operator's forge activity and advanced) →
   delete the file, append `"ack bcd313df superseded (state advanced before
   pickup)"`. No error, no double-resume.
4. **UI state machine** (chip on the card):
   - *pending* — file exists, no matching `ackId` in `history[]`
   - *picked up* — file gone, `history[]` names the `ackId` (chip fades).
     File **present** with the `ackId` already in history (crash between the
     history append and the unlink) also renders *picked up*; the orphan file
     is deleted on the next tick (unlink is idempotent).
   - *superseded* — file gone, history says superseded (gray hover note)
   - *pickup unconfirmed* — file gone, no matching `ackId` in history (e.g. a
     history write lost to a crash). Rendered as a gray "sent · pickup
     unconfirmed" note, never as an error; it resolves on the next history
     update or the operator re-acks (same idempotent id if the request is
     unchanged).
   - *moved on* — the file still exists but the ticket's outstanding
     request no longer matches the ack's `target` (a new `waitingOn`
     arrived before the orchestrator consumed the old ack). Rendered as a
     gray leftover with withdraw offered; the orchestrator will supersede
     it on its next pass.
   - *stale* — the file still exists although **an orchestrator pass completed
     after the ack was created** (a tick ran and didn't consume it), or — when
     no pass has run at all — after 2 × the expected tick interval
     (`launch.json`'s `intervalMinutes` when known, else
     `staleWorkerMinutes`). Either way the card re-enters **NEEDS YOU** near
     the top: the orchestrator itself is now the problem, and this failure
     mode (ack written, loop never runs) is the one most likely to silently
     eat a workday. The threshold deliberately keys on pass activity, not
     worker heartbeats — a slow-but-healthy tick cadence must not page the
     operator on every ack.
5. **Withdraw** races pickup: after unlinking, the extension re-checks
   `history[]`; if a consumption entry for the `ackId` appeared in the window,
   the chip shows "picked up before withdrawal" instead of pretending the
   withdrawal won.
6. Orphaned inbox directories (ticket file deleted) older than 7 days are
   swept by the extension; an *empty* orphaned directory holds no signal and
   is swept immediately regardless of age.

### Contract required of orchestrators

Two additions: *at tick start, consume the inbox and record
consumption/supersession in `history[]` naming the `ackId`* (required for the
ack button to function), and *declare `parked` at wrap* (recommended; without
it the loop simply never parks). The plugin in
[07-claude-plugin.md](07-claude-plugin.md) implements both; the prototypes
adopt them as part of the rename migration in [10-naming.md](10-naming.md).
