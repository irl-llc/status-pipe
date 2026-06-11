# State Directory Contract

status-pipe consumes the `.autopilot/` state directory convention already shared
by `irl-llc` and `git-spice-code-extension`. The contract is **read-only** for
status-pipe with one exception: the feedback-signal sidecar files described at
the end of this document, which status-pipe (and only status-pipe / the human)
writes and the agent loop consumes.

## Layout

```
<repo>/
├── .status-pipe-launch            # committed, optional: how to launch this repo's
│                                  # agent loop (see 09-launch-and-supervision.md)
└── .autopilot/
    ├── state.schema.json          # committed: JSON Schema for issue state files
    ├── README.md                  # committed: protocol docs
    ├── run/                       # gitignored: runtime state (agent/orchestrator-owned)
    │   ├── run.json               # orchestrator pass metadata
    │   ├── issue-853.json         # one file per tracked issue/epic
    │   └── ...
    └── inbox/                     # gitignored: operator → agent signals (status-pipe extension)
        └── issue-853/
            └── ack-7f3a9c2e.json  # one file per signal event
```

A repo "participates" in status-pipe if `.autopilot/run/` exists under any
workspace folder root. Repos without it are silently ignored.

## `issue-<N>.json` (agent-owned, schemaVersion 1)

Authoritative schema: `irl-llc/.autopilot/state.schema.json`. Fields status-pipe
consumes, and how it interprets them:

| Field | Type | status-pipe interpretation |
|---|---|---|
| `schemaVersion` | `1` | Files with a higher version render as a degraded "unknown schema" card (title + link only) rather than being hidden — never silently drop work. |
| `repo` | `owner/name` | Cross-checked against the forge repository inferred from the git remote; mismatch shows a warning badge. |
| `issue` | int *or string* | Cache key; card identity is `(workspaceFolder, issue)`. Schema v1 says integer (GitHub issue number); on Bitbucket + Jira repos the tracking ticket is a Jira key, so status-pipe and the plugin accept a string (`"PROJ-123"`, file `issue-PROJ-123.json`) as a forward-compatible relaxation — existing GitHub repos are unaffected. |
| `title`, `slug`, `url` | string | Card header; `url` is the tracking-issue deep link. |
| `phase` | enum `planning…abandoned` | Card phase chip. `merged`/`abandoned` move the card to the Done section. |
| `health` | enum `ok\|waiting\|blocked\|error\|done` | Drives card accent color and queue bucket (see [05-ui.md](05-ui.md)). |
| `headline` | string | The one-line "what just happened"; the card's primary text. Clamped to 3 lines with expand-on-click. |
| `waitingOn` | null or `{kind, ref, pr, since, detail}` | `kind ∈ {build, review, comment, owner, merge}`. `owner`/`review`/`merge`/`comment` put the card in the **Needs you** bucket; `build` is **Waiting on world**. `since` renders as a live "waiting 2h 14m" duration. |
| `prs[]` | `{number, url, head, base, draft, state, ci, part}` | One PR row per entry. `head`/`base` drive the stack indicators (see below). `ci ∈ {unknown, pending, passing, failing}` is the agent's cached view — superseded by live forge checks when enrichment succeeds. |
| `blockers[]` | string[] | Rendered as a prominent list on the card; non-empty forces the Needs-you bucket regardless of `health`. |
| `history[]` | `{at, phase, note, runId}` | Timeline in the expanded (editor-tab) card view; collapsed cards show only `updatedAt` relative time. |
| `run` | `{status, taskId, startedAt, heartbeatAt}` | Liveness. `status=running` with `heartbeatAt` older than `run.json.staleRunMinutes` renders a **stale-run** warning badge ("agent may have crashed"). |
| `updatedAt` | ISO-8601 | Relative timestamp on every card; also the fair-scheduling sort key within buckets. |

### Stack relationships (derived, not stored)

The schema stores per-PR `head` and `base` branch names. status-pipe derives the
stack topology *within a card* by matching one PR's `base` to another PR's
`head` across all PRs of all state files in the same repo:

- **upstream indicator** (small type, above the PR row): the PR's `base` branch.
  Rendered as plain text (`main`) when the base is the trunk, or as `↑ part/branch`
  when the base is another tracked PR's head.
- **downstream indicator** (small type, below the PR row): every tracked PR whose
  `base` equals this PR's `head`.

No transitive layout, no lanes — orientation only.

## `run.json` (orchestrator-owned)

```json
{
  "schemaVersion": 1,
  "repo": "irl-llc/irl-llc",
  "passCount": 1,
  "lastPassStartedAt": "2026-06-10T13:31:56Z",
  "lastPassFinishedAt": "2026-06-10T15:51:10Z",
  "staleRunMinutes": 30,
  "note": "..."
}
```

status-pipe uses `staleRunMinutes` for the stale-heartbeat computation and shows
`lastPassFinishedAt` in the repo section header ("orchestrator last ran 12m ago").
If `run.json` is missing, stale detection falls back to a 30-minute default.

## <a name="feedback-signal"></a>Schema extension: the ack inbox (operator-owned)

The one capability the existing contract lacks: when the agent asks for the
operator (`waitingOn.kind ∈ {owner, review, comment, merge}` or `blockers[]`),
the operator needs a way to say **"I did my part — take another look"** without
opening a terminal. This design came out of the operator-day simulation
([08-workflow-simulation.md](08-workflow-simulation.md), §3).

### Design: one file per signal event

```
.autopilot/inbox/issue-<N>/ack-<ackId>.json
```

status-pipe creates the file (write `*.tmp`, then `rename(2)`); the
agent/orchestrator consumes it by **deleting** it after recording consumption in
the issue's own `history[]`. Rationale:

- **No shared mutable file.** `issue-<N>.json` is rewritten wholesale by the
  agent at unpredictable times; any field status-pipe wrote there would
  eventually be clobbered. A mutable shared `feedback.json` was considered and
  rejected for the same reason in miniature: file-per-event means creation is
  atomic, consumption is `unlink`, and writer/consumer never edit the same bytes.
- **Same transport.** The signal rides the state directory the orchestrator
  already globs every tick — no daemon, no queue, no forge round-trip.
- **Evidence > state.** The durable record of consumption is the agent's
  append-only `history[]` entry naming the `ackId`; the inbox file is just the
  wire. No `consumed/` graveyard to garbage-collect.
- **Graceful degradation.** Loops that predate the protocol never consume the
  file; status-pipe shows "sent, not yet picked up" and escalates it as stale
  (see lifecycle) — which is honest.

### File schema

JSON Schema shipped in this repo at `schemas/ack.schema.json`:

```json
{
  "schemaVersion": 1,
  "kind": "ready-for-look",
  "issue": 142,
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

- `ackId` = first 8 hex chars of `sha256(issue + waitingKind + waitingSince)`.
  **Naturally idempotent**: re-clicking the button for the same outstanding
  request computes the same id; the file already exists; the write is a no-op
  ("already sent"). A genuinely new request (new `since`) hashes to a new id.
- `target` snapshots the `waitingOn` being answered and `stateUpdatedAt` the
  issue file's `updatedAt` at click time — together the supersession guard.
- `note`: optional one-line free text shown to the agent (often saves the agent
  a forge round-trip).
- `kind` is an enum from day one: `ready-for-look` now; `pause`, `abandon`,
  `priority-bump` are obvious future signals through the same pipe.

### Lifecycle

1. **Operator acks** (button on the card, optional note) → file created
   atomically. Card chip: "✓ sent · awaiting pickup"; card moves from
   *Needs you* to *Waiting*.
2. **Orchestrator/agent consumes** at pass start: scan `inbox/issue-*/`. If the
   ack's `target.waitingKind` + `target.waitingSince` match the current
   `waitingOn` → treat as fresh operator input (highest-priority context),
   append `history[]` `{at, phase, note: "owner ack 7f3a9c consumed: <note>",
   runId}`, then delete the file.
3. **Supersession**: target doesn't match current `waitingOn` (the agent
   already noticed the operator's forge activity and moved on) → delete the
   file, append `history` note `"ack 7f3a9c superseded (state advanced before
   pickup)"`. No error, no double-resume.
4. **UI state machine** (chip on the card):
   - *pending* — file exists, no matching `ackId` in `history[]`
   - *picked up* — file gone, `history[]` mentions the `ackId` (chip fades)
   - *superseded* — file gone, history says superseded (gray "agent had already
     moved on" note)
   - *stale* — file exists past 2 × `staleRunMinutes` → escalates the card back
     to **Needs you**, because the orchestrator itself is now the problem. This
     failure mode (ack written, loop never runs) is the one most likely to
     silently eat a workday.
5. Orphaned inbox directories (issue file deleted) older than 7 days are swept
   by the extension.

### Contract change required of agent loops

Exactly one: *at pass start, consume the inbox and record
consumption/supersession in `history[]` naming the `ackId`.* The plugin in
[07-claude-plugin.md](07-claude-plugin.md) implements this; the existing
`irl-llc` / `git-spice-code-extension` autopilot prompts can adopt it with a
one-paragraph addition (provided in the plugin README).
