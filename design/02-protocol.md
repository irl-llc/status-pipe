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
    ├── tickets/                 # gitignored: one file per tracked ticket (worker-owned)
    │   ├── 853.json
    │   └── PROJ-123.json
    └── inbox/                   # gitignored: operator → orchestrator signals
        └── 853/
            └── ack-7f3a9c2e.json
```

```gitignore
.status-pipe/*
!.status-pipe/launch.json
!.status-pipe/config.json
```

A repo "participates" if `.status-pipe/` exists under a workspace folder root.
Repos without it are silently ignored. JSON Schemas ship in this repository
under `schemas/` and are vendored by both the extension and the plugin — they
are not copied per-repo.

## `tickets/<key>.json` (worker/orchestrator-owned)

Schema: `schemas/ticket.schema.json`, `schemaVersion: 1`. The filename is the
ticket key — `853` (GitHub issue) or `PROJ-123` (Jira). Fields and how the
extension interprets them:

| Field | Type | Interpretation |
|---|---|---|
| `schemaVersion` | `1` | Higher versions render as a degraded "unknown schema" card (title + link only) rather than being hidden — never silently drop work. |
| `repo` | `owner/name` | Cross-checked against the forge repository inferred from the git remote; mismatch shows a warning on hover. |
| `ticket` | string | Opaque ticket key; card identity is `(workspaceFolder, ticket)`. |
| `title`, `slug`, `url` | string | Card header; `url` deep-links the tracking ticket (GitHub or Jira). |
| `phase` | `planning \| implementation \| review \| fixing \| merging \| awaiting-merge \| merged \| blocked \| abandoned` | Phase as dim text. `merged`/`abandoned` move the card to QUIET. |
| `health` | `ok \| waiting \| blocked \| error \| done` | Card accent color and lane bucket ([05-ui.md](05-ui.md)). |
| `headline` | string | The agent's one-sentence "what just happened", verbatim; 2-line clamp, full on hover. |
| `waitingOn` | null or `{kind, ref, pr, since, detail}` | `kind ∈ {build, review, comment, owner, merge}`. owner/review/merge/comment ⇒ NEEDS YOU; build ⇒ WAITING. `ref` should deep-link the exact comment/run. `since` renders as a live duration. |
| `prs[]` | `{number, url, head, base, draft, state, ci, part}` | One PR row each; `head`/`base` drive the stack indicators (below). `ci ∈ {unknown, pending, passing, failing}` is the worker's cached view — superseded by live forge checks when enrichment succeeds. |
| `blockers[]` | string[] | Red text, verbatim; non-empty forces NEEDS YOU regardless of `health`. |
| `subTickets[]` | optional `{key, url, topic, status}` | Discussion channels carved out of an epic's tracking ticket ([07-claude-plugin.md](07-claude-plugin.md)); listed in the expanded card. Not work items — the epic stays one card. |
| `history[]` | `{at, phase, note, runId}` | Append-only log; the expanded card's timeline. `runId` is a deliberately generic run reference (CI run, workflow run). Ack consumption/supersession is recorded here. |
| `worker` | `{status: idle\|running\|error, taskId, startedAt, heartbeatAt}` | Worker liveness. `running` with `heartbeatAt` older than `staleWorkerMinutes` ⇒ stale-worker escalation (NEEDS YOU, top priority). |
| `updatedAt` | ISO-8601 | Relative timestamp; fair-scheduling sort key within lanes. |

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
  "note": "..."
}
```

- `staleWorkerMinutes` gates the stale-heartbeat computation (default 30 when
  the file is absent; `statusPipe.staleWorkerMinutesDefault`).
- `lastPassFinishedAt` renders on the repo header hover ("orchestrator last
  ran 12m ago").
- `parked` (optional): declares that no work is dispatchable and everything
  active waits on the operator; the supervisor suspends ticks until a wake
  event or `recheckAfter`. Full semantics in
  [09-launch-and-supervision.md](09-launch-and-supervision.md). Orchestrators
  that never write it are simply never parked.

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
  "ackId": "7f3a9c2e",
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
  **Naturally idempotent**: re-clicking the button for the same outstanding
  request computes the same id; the file already exists; the write is a no-op
  ("already sent"). A genuinely new request (new `since`) hashes to a new id.
- `target` snapshots the `waitingOn` being answered and `stateUpdatedAt` the
  ticket file's `updatedAt` at click time — together the supersession guard.
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
   ack 7f3a9c consumed: <note>", runId}`, then delete the file.
3. **Supersession**: target doesn't match current `waitingOn` (the
   orchestrator already saw the operator's forge activity and advanced) →
   delete the file, append `"ack 7f3a9c superseded (state advanced before
   pickup)"`. No error, no double-resume.
4. **UI state machine** (chip on the card):
   - *pending* — file exists, no matching `ackId` in `history[]`
   - *picked up* — file gone, `history[]` names the `ackId` (chip fades)
   - *superseded* — file gone, history says superseded (gray hover note)
   - *stale* — file exists past 2 × `staleWorkerMinutes` → the card re-enters
     **NEEDS YOU** near the top: the orchestrator itself is now the problem,
     and this failure mode (ack written, loop never runs) is the one most
     likely to silently eat a workday.
5. Orphaned inbox directories (ticket file deleted) older than 7 days are
   swept by the extension.

### Contract required of orchestrators

Exactly one addition: *at tick start, consume the inbox and record
consumption/supersession in `history[]` naming the `ackId`* (plus, ideally,
the `parked` declaration at wrap). The plugin in
[07-claude-plugin.md](07-claude-plugin.md) implements both; the prototypes
adopt them as part of the rename migration in [10-naming.md](10-naming.md).
