---
description: Standalone status-pipe inbox sweep — consume ack files and reconcile stale workers (tick steps 2–3 only), without inventory or dispatch. Fast hand-back latency between full ticks, or for manually driven repos that still want the extension's ack button to work.
argument-hint: ""
---

**STATUS-PIPE ACK-CHECK — inbox consume + staleness reconcile (no dispatch)**

$ARGUMENTS

Run steps 2–3 of `/status-pipe:tick` and nothing else: no inventory, no
ticket creation, no worker dispatch, no `orchestrator.json` write. Load the
`protocol` skill first (§5 governs). Idempotent, zero-prompt.

## Setup

Anchor at the primary checkout (this command MAY run anywhere in the repo,
including a worktree — it only consumes signals):

```bash
PROTO="$(git rev-parse --git-common-dir)/../.status-pipe"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STALE_MIN="$(jq -r '.staleWorkerMinutes // 30' "$PROTO/config.json" 2>/dev/null || echo 30)"
```

## Step 1 — Consume the ack inbox (tick step 2, verbatim semantics)

Scan `"$PROTO"/inbox/*/ack-*.json`. For each ack `{ticket, ackId,
target:{waitingKind, waitingSince}, note}` against
`"$PROTO/tickets/<ticket>.json"`:

- **Match** — `target.waitingKind == waitingOn.kind && target.waitingSince ==
  waitingOn.since`, or for blockers acks (`waitingKind == "blockers"`):
  `blockers[]` still non-empty and ticket `updatedAt == target.waitingSince`
  ⇒ append `history[] += {at: NOW, phase: <current>, note: "owner ack
  <ackId> consumed: <note or 'ready-for-look'>", runId: null}` (atomic
  rewrite, bump `updatedAt`), **then** delete the ack file.
- **Superseded** (target doesn't match current state) ⇒ append
  `"ack <ackId> superseded (state advanced before pickup)"`, delete the file.
- **Orphan** (no ticket file) ⇒ delete, note in the report.

Always history-append before unlink (crash-safe: a file that survives with
its ackId already in history reads as "picked up" and is swept next pass).

## Step 2 — Reconcile staleness (tick step 3, verbatim semantics)

For every `"$PROTO"/tickets/*.json` with `worker.status == "running"` and
`worker.heartbeatAt` older than `STALE_MIN` minutes: atomic rewrite —
`worker.status = "error"`, `history[] += {at: NOW, note: "worker presumed
crashed (heartbeat stale > ${STALE_MIN}m); eligible for relaunch"}`,
`updatedAt = NOW`.

## Step 3 — Report and stop

One short block: acks consumed (ticket, ackId, note — these tickets are now
prime dispatch candidates for the next tick), acks superseded, orphans swept,
workers marked stale. **Do not dispatch anything** — that is the tick's job;
suggest `/status-pipe:tick` if consumed acks are waiting on a dispatch.
