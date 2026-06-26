# Operating Modes, Agent Launch & Supervision

## Two operating modes

status-pipe must serve both ways Ed actually works:

1. **Single-repo mode** — open one repo, open the status-pipe tray and a Claude
   Code pane, launch the agentic loop at the start of the day. The extension is
   a passive monitor; the human drives the agent interactively. Launch support
   is *available* here but optional — a Claude Code pane is a perfectly good
   launcher for one repo.
2. **Fleet mode** — a multi-root workspace with several participating repos.
   One Claude pane per repo doesn't scale, so the extension itself supervises
   the per-repo orchestrator processes: launch, schedule, health-track,
   restart, surface failures in the queue.

There is no mode switch: the same machinery runs in both; the UI adapts. With
one participating repo: repo badges and group-by-repo disappear, and the agents
strip collapses to a single row. With several: badges on, agents strip lists
every repo. Everything in this document is additive — a repo with no launch
file is simply monitor-only, exactly the original design.

## `.status-pipe/launch.json` — the launcher contract

A committed JSON file at the repo root describing how to launch that repo's
agent loop. Backend-agnostic by construction: it describes a *process* (name,
arg vector, stdin payload), not a Claude invocation. JSON Schema ships at
`schemas/launch.schema.json`.

```json
{
  "schemaVersion": 1,
  "agents": [
    {
      "id": "tick",
      "title": "Planner loop",
      "type": "built-in",
      "intervalMinutes": 10,
      "timeoutMinutes": 45
    },
    {
      "id": "worker",
      "title": "Work-item worker",
      "type": "claude",
      "cwd": "%worktree%",
      "timeoutMinutes": 45
    }
  ]
}
```

A launch entry has three orthogonal fields — `id` (role), `type` (mechanism),
`lifetime` (supervision style) — that were formerly conflated in a single
`mode`.

- **`id` — role / lookup key.** Unique within the file; supervisor state is
  keyed `(repo, id)`. Two ids are **reserved**: `tick` (the planner) and
  `worker` (the dispatch template). Any other id is a generic supervised agent.
  `agents[]` allows more than one entry per repo (rare; usually just these two).
- **The `worker` entry is a *template*, not a scheduled loop.** The supervisor
  never ticks it; instead it instantiates the template once per item the planner
  writes to `orchestrator.json.dispatch`, resolving two worker-only tokens:
  `%prompt%` (the worker's `claude -p` argument — e.g.
  `/status-pipe:work-ticket 19`, ack note already appended) and `%worktree%`
  (the worker's cwd). This gives each worker the SAME auth/env/permission posture
  as the planner while running as its own full `claude` process — own context,
  skills, and the ability to spawn its own subagents (the comment-gate reviewer
  the protocol requires). A repo with no `worker` entry plans but never
  dispatches: the supervisor logs the gap and spawns nothing.
- **`type` — process mechanism.**
  - **`claude`** — the process is `claude`; `command` defaults to `claude` and
    `args` default to the canonical invocation for the reserved role (the
    `worker` gets `-p %prompt%`, the `tick` gets `-p /status-pipe:tick
    --max-concurrent 3`, both plus the stream-json / verbose /
    `--permission-mode auto` flags). Override
    `args` to customize. This is the ergonomic default — a worker entry is just
    `id` + `type` + `cwd` + `env`.
  - **`exec`** — an explicit `command` + `args` + `stdin`: the backend-agnostic
    process contract. `stdin` (string, may be empty) is written to the child's
    stdin then closed — supports backends that take their prompt on stdin rather
    than argv. A missing `type` on a committed entry that carries a `command`
    reads as `exec` (legacy compatibility).
  - **`built-in`** — the deterministic planner runs *in-process*, with no
    external process and no `command`/`args`. Valid only on the reserved `tick`
    id. It is the **default** for `tick`: the ~95%-deterministic reconciliation
    the LLM tick did (trust filter, inventory, ack consumption, staleness
    reconcile, fair-schedule, `orchestrator.json`) is plain code, shared with the
    standalone CLI, skipping a cold-start `claude` boot every interval. It rides
    the same supervised-runner machinery as a process — it presents as a one-shot
    "process" that streams a report and exits — so lifetime, parking, and backoff
    are identical. One difference is invisible to the runner: an in-process pass
    is **not preemptible** (no child to signal), so a timeout/stop settles the
    runner immediately while the orphaned in-flight pass runs to completion.
    Writes are atomic and idempotent on a serial re-run, so a normal kill is
    harmless; the residual caveat is a pass hung past its backoff, where the
    relaunch can briefly overlap the orphan — atomic per-file writes keep the
    files from tearing, but the two can race last-writer-wins. The external
    `claude` tick stays available as an escape hatch.
- `cwd` relative to the repo root; `env` merged over the inherited environment.
- **`%home%` substitution**: the token `%home%` in `command`, `args`, `cwd`, and
  `env` values expands to the user's home directory at spawn time, so a
  committed file need not bake in a machine-specific absolute path (e.g.
  `"GH_CONFIG_DIR": "%home%/.config/claude-gh"`). It is the *only* substitution
  and is deliberately **not** shell-style `${...}` — a bare `%home%` can't be
  mistaken for shell expansion, so no one expects `${VAR}`, `${VAR:-default}`, or
  command substitution. `%home%` resolution happens **after** trust approval —
  the hash covers the committed form with `%home%` still a literal token — so an
  approval stays valid across machines regardless of whose home it resolves to.
- **`lifetime` — how a single supervised process is managed.** Applies to any
  scheduled agent regardless of mechanism; the `worker` template ignores it
  (on-demand by role). Default `scheduled`.
  - **`scheduled`** — the process performs one pass and exits; the extension
    re-launches `intervalMinutes` **after the previous pass exits** (no overlap,
    ever — at most one planner process per repo, the invariant the ticket-file
    write-ownership model in [02-protocol.md](02-protocol.md) depends on).
    Preferred for the planner: process exit is an unambiguous health signal
    (exit 0 = healthy pass), there is no long-lived process to leak, and the
    cadence is visible and adjustable.
  - **`daemon`** — long-running process (e.g. a loop that self-schedules);
    the extension restarts it if it dies.
- `timeoutMinutes`: a hard wall-clock cap — for a `scheduled` planner pass, and
  (separately, per process) for each worker the supervisor spawns. A pass or
  worker still running after its cap is killed and recorded as a failure; a hung
  process must not silently stop the cadence. (Output-silence is surfaced as a
  liveness *display*, not a kill rule.)

### Tick anatomy: the planner plans, the supervisor executes

A tick is a **planner** pass, not the whole unit of work. The planner
reconciles state, consumes acks, reconciles staleness, decides which workers
should run (trust filter, fairness, `max-concurrent`, ack-priority), creates
each worker's worktree, stamps `worker.status=running` in its ticket file, and
writes a **dispatch plan** to `orchestrator.json` —
`dispatch: {maxConcurrent, items: [{kind, key, prompt, worktree}]}` — then
exits. It spawns no workers and waits for none. **Writing the plan IS the
dispatch.**

The **supervisor** reads `dispatch` and spawns one real `claude -p` worker
process per item (substituting `prompt`/`worktree` into the `worker`
template), supervising each like any process: liveness, `timeoutMinutes`,
reap-on-exit. This is the load-bearing change from the earlier "workers run
inside the tick" model — workers are full agents (own context window, skills,
and *their own* subagents, which a Task-tool subagent cannot have), instead of
subagents stuck inside the orchestrator's process and context.

The invariants the old model got from "nothing outlives the tick" still hold,
relocated:

- **One writer per ticket file.** The planner only plans tickets with no live
  worker, and stamps before the worker starts; the supervisor guarantees ≤1
  live worker per `key`. Planner passes never overlap (still one planner process
  per repo, `intervalMinutes` from exit). So a ticket file has at most one
  writing process tree at a time — planner *then* worker, never both at once.
- **No orphans.** Workers are supervised processes with explicit lifecycle, not
  background children of an exited `claude -p`.
- **Recovery.** A ticket stamped `running` whose worker the supervisor never
  spawned (extension down, crash between stamp and spawn) is reclaimed by the
  next planner pass's staleness reconcile (heartbeat stale ⇒ `error`, eligible
  for relaunch).

**Worker failures are not planner failures**: a worker that errors records it
in its own ticket file (`worker.status=error`, history note); the planner pass
still exits 0. A nonzero planner exit is reserved for planner-level fatals (auth
gone, crash), which is what the supervisor's backoff/`failed` escalation covers.

### Trust gating (this file executes commands)

A committed file that causes process execution is an attack surface, so:

- launches require VS Code **workspace trust**, and
- the **exact content** of the launch entry must be approved once by the user:
  on first launch (and again whenever the file's hash changes) the extension
  shows the **complete resolved entry — `id`, `type`, command, args, stdin,
  `cwd`, `env`, and `lifetime`** — and asks for confirmation; approvals are
  stored per content-hash in `workspaceState`. Showing only the command line
  would let an `env` override (`NODE_OPTIONS`, `PATH`) — or an `id` change that
  flips a worker template into a scheduled planner — ride through review unseen;
  the dialog displays everything the hash covers. `claude`-type defaults are
  resolved into command/args before hashing, so the operator sees the actual
  invocation.
- nothing ever auto-starts unless `statusPipe.launch.autoStart` is enabled
  *and* the current hash was previously approved. Defaults: launching enabled,
  auto-start off.
- **never in a worktree**: the supervisor refuses to launch from a checkout
  whose `.git` is a `gitdir:` pointer file — worktrees carry the committed
  `launch.json` but supervising one would re-orchestrate the primary's backlog
  and create nested worktrees every tick (full guard set:
  [02-protocol.md](02-protocol.md), [04-architecture.md](04-architecture.md),
  [07-claude-plugin.md](07-claude-plugin.md)).

## Why tick mode fits Claude Code well

The launcher is generic, but it is designed around what `claude` headless mode
gives us for free:

- **`claude -p "<prompt>"`** runs one non-interactive turn and exits — a
  natural tick. Slash commands work as the prompt, so the plugin's
  `/status-pipe:tick` (or any repo-local `.claude/commands/` command,
  including the existing bespoke autopilot commands) is directly launchable.
- **`--output-format stream-json --verbose`** emits NDJSON events on stdout
  (init, assistant turns, tool calls, final result with cost/duration). The
  supervisor parses this for *process-level* liveness — output events are a
  heartbeat at the transport layer, independent of the agent remembering to
  write `worker.heartbeatAt` — and for a structured final result line.
- **Exit codes** distinguish clean passes from fatal errors (auth, crash),
  feeding health directly.
- **Unattended permissions** come from the repo's committed
  `.claude/settings.json` allowlists plus `--permission-mode auto`
  (or another mode, the repo owner's choice — it lives in the committed launch
  file, reviewable like any code).
- **`--resume <session-id>`** exists as a recovery path for daemon-style
  sessions, but tick mode mostly removes the need: each pass reconstructs from
  the durable state (git + forge + tracking ticket), which the workflow already
  guarantees.

Other backends (a shell script, a different CLI agent) plug in by meeting the
same contract: run, write logs to stdout, exit nonzero on failure.

## Supervisor design (`agentSupervisor` module)

The supervisor runs two kinds of process. **Scheduled agents** (`lifetime`
`scheduled`/`daemon`) each get a per-`(repo, launch-entry)` state machine
(`SupervisedRunner`):

```
disabled → idle → scheduled(nextTickAt) → launching → running(pid, since, lastOutputAt)
                                   ↑          │
                                   │          ├─ exit 0 (tick)  → idle/scheduled
                                   │          ├─ exit ≠0 / timeout → backoff(n) ─ retries left ─→ scheduled
                                   └──────────┴─ backoff exhausted → failed
```

**Workers** are different: not scheduled, not retried. When a repo's
`orchestrator.json.dispatch` changes, the supervisor reconciles a per-repo
worker pool (keyed by item `key`) — spawning a one-shot `WorkerRunner` per new
item from the `worker` template (`%prompt%`/`%worktree%` resolved),
capped at the plan's `maxConcurrent`, deduplicated against live workers. A
worker runs one pass and exits; the supervisor reaps it (no backoff, no
relaunch) and the *next* planner pass decides whether to re-dispatch. A worker
that exceeds `timeoutMinutes` is killed. The worker pool does not gate or
escalate the planner's `failed` state — worker outcomes live in ticket files.

- Child processes via `child_process.spawn` (not the integrated terminal):
  stdout/stderr go to a per-agent **OutputChannel** ("Status Pipe: fleet-api ·
  tick"); "Open log" jumps there. A "Run in terminal" secondary action exists
  for interactive debugging.
- **Liveness**: `lastOutputAt` from stdout activity (stream-json makes this
  dense) feeds the fleet-strip display; the only kill rule is the
  `timeoutMinutes` wall-clock cap. **Daemons** get a staleness check too: a
  daemon whose repo shows no `orchestrator.json.lastPassFinishedAt` progress
  for 2 × its expected interval is treated as wedged — killed and restarted
  through the same backoff path (a hung daemon emits no exit and would
  otherwise be invisible, and a dead orchestrator is the system's worst
  failure).
- **Backoff**: exponential (1m, 2m, 4m… cap 15m), `maxRestarts` (default 3
  consecutive failures) → `failed`.
- **`failed` surfaces in the queue**: a synthetic card in NEEDS YOU at top
  priority ("orchestrator launcher failing — exit 1 ×3 · open log · retry"),
  consistent with the simulation's rule that a dead orchestrator outranks
  everything (it silently stops all signal).
- `statusPipe.launch.pauseWhenIdle` (default **off**) pauses tick scheduling
  after 30 min without window focus. It is off by default because it directly
  conflicts with the core overnight scenario — agents grinding through the
  backlog until everything parks on the operator — and **parking** (below) is
  the work-aware stop that makes a presence heuristic mostly redundant. Turn
  it on for battery-constrained laptops where "I'm away" should mean "stop
  spending", accepting that overnight runs stop too.
- The supervisor's *supervision* layer never touches the protocol's agent-owned
  files — process health (supervisor-owned) and work-item health (`worker` block
  in ticket files, agent-owned) are deliberately separate layers; the UI shows
  both and labels them distinctly. The one exception is by **role, not layer**:
  the default `tick` entry is now `type:"built-in"`, the deterministic planner
  running *in-process* in the extension. The planner's writes — stamping `worker`
  at dispatch, consuming acks, staleness reconcile, `orchestrator.json` — happen
  inside the extension, exactly the writes the external `claude -p
  /status-pipe:tick` made, with the same atomic temp-then-rename discipline and
  the same one-writer-per-ticket invariant (planner stamps *before* the worker
  starts). The planner is not the supervisor; it is the work the `tick` entry
  schedules, and the external `claude` tick stays available as an escape hatch.

### Parking: when everything is blocked on the operator

A productive overnight run ends in a predictable state: every work item is
parked on the operator (owner questions, reviews, merges) and nothing is
dispatchable. Without a stop condition the tick loop would relaunch every
`intervalMinutes` forever, reconciling, finding nothing, and exiting — burned
passes all night. `pauseWhenIdle` doesn't fix this (wrong predicate: it
measures the operator's presence, not the existence of work).

The extension cannot decide this itself — it only sees ticket files, so it
can't tell whether an epic still has un-started tranches the orchestrator
could dispatch. The orchestrator knows exactly this at wrap time. So the
responsibility splits along the existing ownership line:

**The orchestrator declares.** The tick wrap step writes an optional,
additive field to `orchestrator.json` when (a) no tranche or ticket is dispatchable, (b)
every active item is waiting on the operator (`waitingOn.kind ∈ {owner,
review, merge, comment}` — the NEEDS-YOU kinds per [02-protocol.md](02-protocol.md) —
or blocked), and (c) the inbox has no unconsumed acks. An item waiting on the
world (`build`/CI) is *not* operator-blocked, so the loop keeps ticking to catch
the out-of-band flip rather than parking:

```json
"parked": {
  "since": "2026-06-12T03:40:00Z",
  "reason": "4 active items all waiting on owner; no dispatchable tranches",
  "recheckAfter": "2026-06-12T09:40:00Z"
}
```

Cleared (set null / omitted) on any pass that finds work. An empty backlog
("everything merged, nothing tracked") parks the same way with its own reason.

**The supervisor honors it.** While `parked` is set, scheduled ticks are
skipped. Wake triggers, any of which clears the pause and ticks immediately:

1. **An ack file appears** — the "Ready for another look" click *is* the
   resume button. (Ack-triggered immediate ticks apply even when not parked:
   they cut hand-back latency from "next interval" to seconds; the running
   pass consumes the ack, or a new tick fires on exit if one remains.)
2. An epic file or inbox change on disk (operator edited the backlog).
3. Manual tick-now / start.
4. `recheckAfter` elapses — a slow safety/discovery tick (orchestrator picks
   the horizon, default a few hours) that catches out-of-band new work (a
   freshly labeled issue on the forge, a CI flip on stale info). Parking can
   therefore never strand the loop; worst case it degrades to a very slow
   poll.

Daemon mode: a daemon that declares `parked` is stopped by the supervisor and
relaunched on the same wake triggers.

**The UI says so.** Agents strip: `parked — all work waiting on you` (distinct
from `scheduled`/`stopped`); and when NEEDS YOU is non-empty with nothing in
flight, the summary line reads "Parked — 4 items need you, nothing in flight."
Loops that predate the field simply never park — behavior is unchanged for
them.

### Relationship to the "Restart worker" action

The simulation's per-card "Restart worker" becomes, when a launch file exists,
"trigger a tick now" on that repo's supervisor (no terminal involved). Without
a launch file it falls back to the original behavior: run
`statusPipe.resumeCommand` in the integrated terminal.

## UI

- **Agents strip** at the top of the tray: one collapsed summary row —
  `1 launch config: 1 scheduled (3m) · 2 workers running` — expanding to one row
  per declared launch config (status icon, repo name, next/elapsed time,
  start/stop and open-log buttons) **plus one row per live worker** beneath
  them. Worker rows are read-only (indented, no Run/Stop — a worker's lifecycle
  belongs to the planner that dispatched it): they show the ticket key and, from
  the worker's stream-json, what it's doing right now (`running · Edit: lane.ts`).
  They appear while the worker runs and vanish on exit; the operator acts on the
  ticket card, not the worker row. In single-repo mode the collapsed row is just
  `agent: scheduled · next tick 3m`.
- Commands: `statusPipe.agents.startAll/stopAll/tickNow/openLog`, plus per-row
  buttons.
- All supervisor state changes render in the reserved activity/status areas —
  never as appearing/disappearing rows in the queue itself (no layout shift,
  see [05-ui.md](05-ui.md)).
