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

- `agents[]` allows more than one loop per repo (rare; usually one).
- `command` + `args` + `stdin`: the process contract. `stdin` (string, may be
  empty) is written to the child's stdin then closed — supports backends that
  take their prompt on stdin rather than argv.
- `cwd` relative to the repo root; `env` merged over the inherited environment.
- `mode`:
  - **`tick`** — the process performs one orchestration pass and exits;
    the extension re-launches every `intervalMinutes`. Preferred: process exit
    is an unambiguous health signal (exit 0 = healthy pass), there is no
    long-lived process to leak, and the cadence is visible and adjustable.
  - **`daemon`** — long-running process (e.g. a loop that self-schedules);
    the extension restarts it if it dies.
- `timeoutMinutes` (tick mode): a pass still running after this is killed and
  recorded as a failure — a hung tick must not silently stop the cadence.

### Trust gating (this file executes commands)

A committed file that causes process execution is an attack surface, so:

- launches require VS Code **workspace trust**, and
- the **exact content** of the launch entry must be approved once by the user:
  on first launch (and again whenever the file's hash changes) the extension
  shows the full command line + stdin and asks for confirmation; approvals are
  stored per content-hash in `workspaceState`.
- nothing ever auto-starts unless `statusPipe.launch.autoStart` is enabled
  *and* the current hash was previously approved. Defaults: launching enabled,
  auto-start off.

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
  `.claude/settings.json` allowlists plus `--permission-mode acceptEdits`
  (or stronger, the repo owner's choice — it lives in the committed launch
  file, reviewable like any code).
- **`--resume <session-id>`** exists as a recovery path for daemon-style
  sessions, but tick mode mostly removes the need: each pass reconstructs from
  the durable state (git + forge + tracking issue), which the workflow already
  guarantees.

Other backends (a shell script, a different CLI agent) plug in by meeting the
same contract: run, write logs to stdout, exit nonzero on failure.

## Supervisor design (`agentSupervisor` module)

Per `(repo, agent.id)` a small state machine:

```
disabled → idle → scheduled(nextTickAt) → launching → running(pid, since, lastOutputAt)
                                   ↑          │
                                   │          ├─ exit 0 (tick)  → idle/scheduled
                                   │          ├─ exit ≠0 / timeout → backoff(n) ─ retries left ─→ scheduled
                                   └──────────┴─ backoff exhausted → failed
```

- Child processes via `child_process.spawn` (not the integrated terminal):
  stdout/stderr go to a per-agent **OutputChannel** ("Status Pipe: fleet-api ·
  tick"); "Open log" jumps there. A "Run in terminal" secondary action exists
  for interactive debugging.
- **Liveness**: `lastOutputAt` from stdout activity (stream-json makes this
  dense); a running tick with no output for `timeoutMinutes` is killed.
- **Backoff**: exponential (1m, 2m, 4m… cap 15m), `maxRestarts` (default 3
  consecutive failures) → `failed`.
- **`failed` surfaces in the queue**: a synthetic card in NEEDS YOU at top
  priority ("orchestrator launcher failing — exit 1 ×3 · open log · retry"),
  consistent with the simulation's rule that a dead orchestrator outranks
  everything (it silently stops all signal).
- Tick scheduling pauses when the window loses focus for > 30 min
  (`statusPipe.launch.pauseWhenIdle`, default on) — no point burning agent
  passes while the operator is away; resumes on focus with an immediate tick
  if one was missed. Off by default? No — **on** by default; fleet operators
  who want continuous operation turn it off. Note this is a presence
  heuristic only; the work-aware stop is **parking**, below.
- The supervisor never touches the protocol's agent-owned files — process health
  (supervisor-owned) and work-item health (`worker` block in ticket files,
  agent-owned) are deliberately separate layers; the UI shows both and labels
  them distinctly.

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
additive field to `orchestrator.json` when (a) no tranche/issue is dispatchable, (b)
every active item is waiting on the operator (`waitingOn.kind ∈ {owner,
review, merge}` or blocked), and (c) the inbox has no unconsumed acks:

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
  `agents: 2 running · 1 scheduled (3m) · 1 failed` — expanding to one row per
  (repo, agent): status icon, repo name, next/elapsed time, start/stop and
  open-log buttons on hover. In single-repo mode the collapsed row is just
  `agent: scheduled · next tick 3m`.
- Commands: `statusPipe.agents.startAll/stopAll/tickNow/openLog`, plus per-row
  buttons.
- All supervisor state changes render in the reserved activity/status areas —
  never as appearing/disappearing rows in the queue itself (no layout shift,
  see [05-ui.md](05-ui.md)).
