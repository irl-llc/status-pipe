---
description: Start the recurring status-pipe orchestrator loop — runs /status-pipe:tick on an interval (default 10m), honoring orchestrator.json.parked and the ack inbox before each pass. Interactive single-repo alternative to the extension supervisor.
argument-hint: "[interval, default 10m]"
---

**STATUS-PIPE LAUNCH — recurring tick wrapper (interactive loop)**

$ARGUMENTS

Start the autonomous driver: run `/status-pipe:tick` repeatedly so the
backlog keeps advancing with no per-tick interaction. This is the
*interactive* way to run the loop (one repo, Claude pane open). In fleet
mode prefer the status-pipe VS Code extension's supervisor, which launches
headless ticks (`claude -p "/status-pipe:tick" --output-format stream-json`)
per `.status-pipe/launch.json` — it also works in single-repo mode and adds
liveness tracking, backoff, and park/wake handling. Mention this to the user.

## What to do

1. **Interval** = the first argument if given (e.g. `15m`, `30m`), else
   **`10m`**. The cadence is "N minutes of quiet AFTER the previous tick
   finishes", never overlapping passes — at most one orchestrator per repo.
2. **Pick a loop facility — no hard dependency on any particular one:**
   - If this Claude Code session has a loop/scheduling skill available
     (e.g. `/loop`), invoke it as `<interval> /status-pipe:tick` and confirm
     to the user.
   - Otherwise print the equivalent shell loop, ready to paste into a
     terminal at the repo root, and tell the user the extension supervisor
     is the better long-term answer:

     ```bash
     while true; do claude -p "/status-pipe:tick"; sleep 600; done
     ```

3. **Each iteration honors parking the same way the supervisor does** —
   before running the tick, check cheaply:

   ```bash
   PROTO="$(git rev-parse --git-common-dir)/../.status-pipe"
   jq -r '.parked.reason // empty' "$PROTO/orchestrator.json" 2>/dev/null
   ls "$PROTO"/inbox/*/ack-*.json 2>/dev/null
   ```

   If `parked` is set AND the inbox is empty AND `parked.recheckAfter` has
   not elapsed: report the parked reason ("parked since <since>: <reason>")
   and **skip the pass** — a cheap no-op instead of a full reconcile. Run
   the tick when any of these holds: an ack file exists (the operator's
   "take another look" is the resume button), `parked` is clear, or
   `recheckAfter` has elapsed (slow safety/discovery tick). When using the
   shell loop, the tick itself still applies these semantics on entry, so
   the loop stays correct either way — the check just saves passes.

4. Confirm briefly: the interval; that ticks are idempotent and zero-prompt;
   that each pass reports needs-you items, ready-to-merge PRs, and in-flight
   work; that the loop parks itself when everything waits on the operator
   and wakes on an ack; and that it will **never deploy, approve, publish,
   or merge** — those stay with the human. Tuning (`--max-concurrent`,
   `--dry-run`) is set on `/status-pipe:tick`; suggest one manual tick first
   if the user wants to see a pass before committing to the loop.
