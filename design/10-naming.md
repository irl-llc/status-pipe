# Naming

The prototypes used "autopilot" — helpful but overloaded (it names a Tesla
feature, a GitHub bot, and two different command sets in our own repos), and it
names neither the owner nor the protocol. This document is the terminology
decision record; every other design doc conforms to it.

## The brand and the protocol

Everything ships under **status-pipe**:

| Thing | Name |
|---|---|
| VS Code extension | **status-pipe** (publisher IRLAILLC) |
| The file contract | **the status-pipe protocol**, `schemaVersion: 1` |
| Protocol directory | **`.status-pipe/`** at each repo root |
| Claude Code plugin | **status-pipe** → commands `/status-pipe:<cmd>` |
| Settings namespace | `statusPipe.*` |

The protocol version starts fresh at 1: `.status-pipe/` is a new namespace, so
there is no ambiguity with legacy `.autopilot` files. "autopilot" survives only
as a historical reference to the prototypes.

## Role taxonomy

One word per role; no role shares a word:

| Role | Definition |
|---|---|
| **operator** | The human. The queue exists to spend their attention well. |
| **fleet** | All agents across the workspace. *Fleet mode* = multi-repo supervision; the UI's agents summary row is the *fleet strip*. |
| **supervisor** | Extension component owning orchestrator *processes*: launch, liveness, backoff, parking. Never touches protocol files except reading. |
| **orchestrator** | The per-repo scheduling loop. Executes **ticks** (one idempotent pass: reconcile → consume inbox → dispatch workers → write state). Owns `orchestrator.json`. |
| **worker** | The agent advancing one ticket (plan/implement/review/submit). Its liveness is the `worker` block in the ticket file. |
| **ticket** | A tracked work item — GitHub issue or Jira issue; the card unit; key is an opaque string (`"853"`, `"PROJ-123"`). |
| **epic** | An in-repo spec file (`epics/<slug>.md`) that a ticket tracks. |
| **ack** | An operator→orchestrator signal file in the inbox. |
| **forge** | PR host (GitHub, Bitbucket Cloud). |
| **ticketing source** | Ticket host (GitHub issues, Jira Cloud). |

Layered health, in these words: the **supervisor** watches the
**orchestrator** process; the **orchestrator** watches **worker** liveness;
the **operator** watches all three through the queue.

## File layout (protocol v1)

```
<repo>/
└── .status-pipe/
    ├── launch.json              # committed — how to launch this repo's orchestrator
    ├── orchestrator.json        # ignored — pass metadata: passCount, timestamps,
    │                            #   staleWorkerMinutes, parked
    ├── tickets/                 # ignored — one file per tracked ticket
    │   ├── 853.json
    │   └── PROJ-123.json
    └── inbox/                   # ignored — operator → orchestrator acks
        └── 853/ack-7f3a9c2e.json
```

Recommended ignore rules (everything runtime, only the launcher committed):

```gitignore
.status-pipe/*
!.status-pipe/launch.json
```

JSON Schemas are **not** copied per-repo: they ship once in this repository
under `schemas/` (`ticket.schema.json`, `ack.schema.json`, `launch.schema.json`,
`orchestrator.schema.json`) and are referenced by `$id`; the extension and the
plugin both vendor them.

## Renames from the prototype convention

The mapping for refactoring `irl-llc` and `git-spice-code-extension` (both
need the protocol updates — inbox, parking, launch — anyway):

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

Kept deliberately:

- `history[].runId` — a *generic* run reference (CI run, workflow run); both
  prototypes already use it loosely and the looseness is useful.
- `phase`, `health`, `headline`, `waitingOn`, `blockers`, `history`,
  `updatedAt` — unchanged semantics, unchanged names.
- Lane names **NEEDS YOU / WAITING ON WORLD / QUIET**; **epic**; **tranche**;
  **forge** (git-spice heritage — it is the right word).

## UI wording

- The card action for a crashed/stale worker is **Restart worker** (it
  triggers an orchestrator tick, which reconciles and relaunches).
- The fleet strip states: `running · scheduled <t> · parked · failed ·
  stopped`.
- Settings renamed to match: `statusPipe.protocolDir` (default
  `.status-pipe`), `statusPipe.staleWorkerMinutesDefault`.
