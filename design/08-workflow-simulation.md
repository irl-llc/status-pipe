# Operator-Day Simulation

A step-by-step simulation of one operator day, used to derive the queue
semantics in [05-ui.md](05-ui.md) and the ack-inbox design in
[02-protocol.md](02-protocol.md). Produced during the design phase by a
dedicated role-play agent; kept verbatim-in-substance as the rationale record.

## Cast

Two workspace roots: `fleet-api` and `fleet-ui`. Six epics:

| ID | Repo | Ticket | State at 08:30 |
|----|------|-------|----------------|
| E1 | fleet-api | #142 "Auth token rotation" | `phase=planning, health=blocked`; agent posted a design question on the tracking issue; `waitingOn={kind:owner, ref:<comment url>, since:07:55}` |
| E2 | fleet-api | #155 "Rate limiter" | `phase=review`, PR #512 (T1a) + #513 (T1b) stacked; `waitingOn={kind:review, pr:512, since:yesterday 18:40}` |
| E3 | fleet-api | #161 "Audit log export" | `phase=implementation, worker.status=running`, heartbeat 40s old, CI pending |
| E4 | fleet-ui | #88 "Theme tokens" | PR #203 `ci=failing`, but `phase=fixing, worker.status=running` — agent is on it |
| E5 | fleet-ui | #91 "Login redirect" | `phase=awaiting-merge`, CI passing, branch protection requires a human merge; `waitingOn={kind:merge, pr:198}` |
| E6 | fleet-ui | #95 "i18n extraction" | `worker.status=running` but `heartbeatAt` 47 minutes old; `orchestrator.json` `staleWorkerMinutes=15` → crashed run |

## The day

**08:30 — open VS Code.** Activity-bar badge shows **4** (needs-me count;
running/waiting items deliberately don't badge). Tray lanes:
NEEDS YOU (4): E6 (crashed worker — red), E1 (blocked question — red), E2 (review,
waiting 14h — amber), E5 (merge, 2h — amber). WAITING (2): E3, E4. QUIET (0).

**08:35 — E6, the crashed worker, sorts first.** A dead worker silently stalls
everything downstream and nothing else recovers it. Expanded view: history
timeline ends mid-implementation; banner "last heartbeat 47m ago (threshold
15m)". Ed clicks **Restart worker** → the extension executes the per-repo
user-configured resume command in the integrated terminal (the extension does
not manage agent processes itself; orchestration ownership stays with the
orchestrator — *note: superseded by the supervisor design in
[09-launch-and-supervision.md](09-launch-and-supervision.md); with a launch
file this action is a supervisor tick-now, and the extension does manage
orchestrator processes in fleet mode. Kept as written because it drove the
"process health is a separate layer" split*). Within a minute the heartbeat
refreshes, the watcher fires, E6 drops to WAITING. The extension wrote
nothing.

**08:45 — E1, the design question.** Clicking the waiting banner opens
`waitingOn.ref` — the exact issue comment — in the browser. Ed replies ("option
B, keep the rotation window configurable"), returns, clicks **Ready for another
look**, types a note. The extension atomically writes
`.status-pipe/inbox/142/ack-7f3a9c2e.json`. Chip: "✓ sent · awaiting
pickup"; card → WAITING. At ~09:00 the orchestrator pass consumes the ack
(target matches current `waitingOn`), resumes the agent, appends `history[]`
`"owner ack 7f3a9c2e consumed: answered — option B"`, deletes the file. Chip
flips to "picked up 09:01", then the card is an ordinary running card.

**09:15 — E2, reviewing the stack.** Card shows PR #512 (T1a, `↑ main`,
`↓ T1b #513`). PR row opens the browser (review tooling there is strictly
better, and the agent reads forge state anyway). Ed leaves four inline
comments, one blocking, no approval. Back in the tray: **Ready for another
look** — the canonical use: "my feedback is posted; agent, re-check the forge
now rather than on your next slow poll." E2 → WAITING. Next pass the headline
becomes "Addressing 4 review comments on #512."

**10:00 — E5, the merge.** Primary action reads **Open PR to merge**. Ed merges
on GitHub. Reconciliation window: forge says merged, ticket file still says
`awaiting-merge` until the next pass. The extension trusts the forge for PR
facts and the file for agent facts: the card shows "merged on forge — agent
catching up" and sits in WAITING, *not* NEEDS YOU (re-surfacing would be a
false positive). Next pass: `phase=merged, health=done` → QUIET.

**10:30 — E4 resolves itself.** The agent pushes a fix; CI failing → pending →
passing. The card never left WAITING and Ed never touched it. Load-bearing
lesson: **failing CI alone is not actionable — failing CI with an idle or
errored agent is.**

**11:30 — E2 bounces back, with a conflict.** The agent resolved 3 of 4 threads
and asked a clarification on the fourth: `waitingOn={kind:owner, ref:<thread>,
since:11:28}`. Toast: "fleet-api #155 — agent needs your input." Ed answers on
the forge and acks. Conflict case: suppose the 11:58 orchestrator pass had
already noticed his forge reply at 11:56 and moved on before pickup — the ack's
`target.waitingSince` (11:28) no longer matches current `waitingOn`, so the
orchestrator discards it as superseded, appending `"ack 9b21d4ee superseded
(state advanced before pickup)"`. UI: gray "your nudge arrived after the agent
moved on — no action needed." No error, no double-resume.

**13:00 — post-lunch.** E3 opened PR #530, flipped draft→ready,
`waitingOn={kind:review, pr:530}`. The badge ticked up while Ed was away; he
reviews, approves, acks "LGTM, proceed."

**15:30 — forge rate limit.** Six epics × ~2 PRs across two repos; GitHub
throttles. Tray header chip: "live forge data paused (rate limit) — retrying
16:02." File-driven state keeps flowing (the watcher needs no network); forge
badges render from cache with a staleness tint. Nothing blocks.

**16:30 — wrap.** E2's stack merges; E1 and E3 still running. NEEDS YOU is
empty; the badge clears; the tray shows the inbox-zero state: **"All quiet —
3 agents running, 2 done today."** That sentence is the product.

## Edge cases catalogued

- **Ticket file deleted mid-session** → tombstone card "state removed" ~60s,
  then drop; orphaned inbox dirs swept after 7 days. The file is the membership
  criterion — never resurrect from forge data.
- **Schema version above known** → degraded card (title + headline + "update
  status-pipe"); per-file try/catch so one bad file never breaks the tree.
- **No `.status-pipe/`** → folder silently excluded; listed in the collapsed
  "inactive roots" footer.
- **Multi-root 3+** → one merged queue, per-repo badges; group-by-repo is a
  toggle, not the default — cross-repo severity ordering is the point.
- **Rate limits / offline** → ETags, one batched GraphQL query per repo per
  poll, 60–120s with jitter, exponential backoff; always render from cache with
  staleness tint.
- **PR deleted on forge** → "missing on forge" badge, informational; amber
  anomaly note if it was the `waitingOn.pr`.
- **Two agents writing one file** → detect `updatedAt` regression or
  interleaved `runId`s in recent history; red "concurrent writers?" badge.
  Making it visible is the extension's job; fixing it is the orchestrator's.
- **Clock skew** → durations render `max(0, now − since)` ("just now" +
  tooltip). Heartbeat staleness compares two timestamps written by the same
  machine, so it is immune to cross-machine skew.
- **Long headlines** → 2-line clamp + tooltip in tray; full text in editor tab.
- **30+ epics** → virtualization, QUIET collapsed, lane counts, text filter;
  badge stays needs-me-only so it remains meaningful at scale.
- **Ack written, orchestrator never runs** → the stale-ack escalation. The
  failure mode most likely to silently eat a workday; it must re-badge.

## The two anchors

1. The lane predicate **"agent parked AND parked on *me*"** is the entire
   product; every queue rule is a refinement of it.
2. The **ack inbox** (file-per-event, atomic create/unlink, consumption
   recorded in the agent's own `history[]`) is the only schema-adjacent change
   needed — and it doubles as the transport for every future operator→agent
   signal.
