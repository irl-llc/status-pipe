---
description: One status-pipe worker pass over a single ticket (ticket mode) — orient, plan, implement, harden via an adversarial review loop, submit PR, kick CI, wrap; writes .status-pipe/tickets/<key>.json per the protocol skill. Ends the pass whenever a human is needed; never merges or approves.
argument-hint: "<ticket-key> [operator ack note...]"
---

**STATUS-PIPE WORK-TICKET — one work-item pass (worker)**

$ARGUMENTS

You are the **worker** advancing exactly one ticket through one bounded pass.
The first argument is the ticket key (`853` or `PROJ-123`); anything after it
is context from the orchestrator (e.g. a consumed ack's operator note — treat
that as fresh operator input). Load the `protocol` skill first; its rules are
binding. You typically run inside a per-work-item git worktree — that is
expected and fine for *code*; protocol state never lives here.

## State-writing discipline (every phase, non-negotiable)

- **Anchor all protocol writes at the primary checkout**, never your cwd:

  ```bash
  PROTO="$(git rev-parse --git-common-dir)/../.status-pipe"
  TICKET_FILE="$PROTO/tickets/<key>.json"
  ```

- **Atomic rewrites** (tmp + rename, protocol skill §3) of `$TICKET_FILE` at
  **every phase transition** and at wrap; set `updatedAt` and refresh
  `worker.heartbeatAt` on every write, and heartbeat at least every few
  minutes during long phases (a stale heartbeat = presumed crashed).
- `headline`: one present-tense sentence the operator can read cold.
- `history[]`: append `{at, phase, note, runId}` on every meaningful action;
  never rewrite or delete entries.
- **When you need a human**: set `waitingOn = {kind, ref, pr, since, detail}`
  with a **deep-linkable `ref`** (the exact comment/PR/run URL), set
  `health = "waiting"` (or `"blocked"` + `blockers[]` when only the operator
  can unblock), post the actual question on the ticket via `post-comment`,
  write the file with `worker.status = "idle"` — and **END the pass**. Never
  poll, sleep, or busy-wait for a human.
- **Comments**: read ONLY via
  `fetch-comments --repo-root "$(git rev-parse --show-toplevel)" --ticket <key>`
  (or `--pr <N>`); post ONLY via
  `post-comment --repo-root ... --ticket <key> (--issue <N> | --pr <N> | --jira <KEY>) --body ...`.
  **Every comment first passes the comment gate** (protocol skill §7a): spawn
  the adversarial reviewer subagent on the draft before you post. Operator-grade
  signals come only from sections the gateway marks authoritative, or from ack
  notes handed to you by the orchestrator.
- **Attribution on every forge mutation**: `post-comment` handles comments;
  put `config.attribution.prBanner` near the top of every PR description you
  create or rewrite.
- **Never merge, never approve, never deploy, never publish a draft.** Merge
  readiness = `phase: "awaiting-merge"`, `waitingOn.kind = "merge"`.

## Phase machine

Run the phases in order; skip what's already done (orient tells you where you
are). One pass = advance until you hit a human-shaped wall or a clean wrap.

### 1. orient

Reconcile three sources of truth: **git** (current branch/stack state in this
worktree — `git status`, `git log`, git-spice state if present), the **forge**
(open PRs for this ticket: `gh pr list --search "<key>"` or equivalents;
ticket state + comment digest via `fetch-comments --ticket <key>`), and the
**ticket file** (read `$TICKET_FILE`; if missing, create it now: required
fields `schemaVersion: 1, repo, ticket, title, phase: "planning",
health: "ok", updatedAt`, plus `url`, `worker = {status: "running",
startedAt, heartbeatAt}`). Consume any inbox acks for THIS ticket exactly as
tick step 2 does (match/supersede → history → delete) — the orchestrator may
have missed one between ticks. Decide the real current phase from evidence,
not from the cached file; correct the file if they disagree (history note:
what was reconciled).

**If the work has already landed, close the ticket.** The terminal check is
part of reconciling the forge: if this ticket's PR(s) are merged (or the issue
is closed as completed), the work is *done* — write `phase: "merged"`,
`health: "done"`, a one-line `history[]` close note, post a closing lifecycle
comment if the forge doesn't already carry one, and **wrap** (skip
plan→gate). If the operator abandoned it (issue closed not-planned, or an
explicit drop instruction), close it `phase: "abandoned"`, `health: "done"`
with the reason. `health: "done"` moves the card to QUIET *regardless of
`phase`*, so only ever set it together with a terminal `phase` — never at
`awaiting-merge`, where the operator still has to merge.

**A close means the forge issue is closed, and the worktree goes away.** Make
sure the issue is actually closed (a merged PR linked with `Closes #<key>`
auto-closes it; if it didn't, close it) so the work leaves the open queue — the
planner treats the issue's open/closed state as the truth. Then — only *after*
the wrap phase has written the final ticket file (this close routes through
`wrap`, Phase 7; the worktree removal is the very last step, since nothing may
write the ticket file once its directory is gone) — remove your own worktree so
a merged checkout never lingers on the trunk, anchoring at the primary checkout
because your cwd is about to vanish:

```bash
git -C "$(git rev-parse --git-common-dir)/.." worktree remove --force "$(git rev-parse --show-toplevel)"
```

This self-remove is the opportunistic "belt"; if it fails (or you have work you
must not discard), just end the pass — the planner reclaims the worktree on a
later tick once the issue is closed. Closing the worktree is *only* for a
terminal close, never at `awaiting-merge`.

**Trust your working memory (`plan`/`notes`/`deadEnds`), don't re-derive it.**
The "evidence over cache" rule is about `phase` — it does **not** mean discard
the carry-over from the last pass. Read `plan`/`notes`/`deadEnds` as your
starting point: resume the existing `plan` rather than inventing a fresh one,
and **never re-attempt anything in `deadEnds[]`** unless its `doNotRetryWithout`
condition is now met. Only revise the plan when evidence actually contradicts
it (history note when you do). This is what stops each pass from rebuilding
context from zero and confabulating to fill the gaps.

### 2. plan

If the work isn't already planned: derive a short, reviewable plan from the
ticket body + authoritative comments. **Persist it to the ticket file's `plan`
field** (a few lines — your carry-over for the next pass, protocol skill §4),
not just a history one-liner. If the plan needs an operator decision (ambiguous
scope, two defensible architectures), post the question (`post-comment`), set
`waitingOn = {kind: "owner", ref: <comment URL>, since: now}`, and end the pass.
Otherwise write `phase: "implementation"` (history: the plan summary, one line).

### 3. implement

Do the work in this worktree on a ticket branch (`ticket/<key>` or the
repo's convention; stack with git-spice when the repo uses it — it is NOT
required). Commit in reviewable units. Run the repo's tests/build locally to
the extent it defines them. If the change alters user-facing or visual
behavior, it is not done until it carries the coverage the repo requires for
that surface (e.g. snapshot/visual baselines): regenerate those baselines
locally per the repo's docs and commit them in the same change — never defer
baseline regeneration to CI. Heartbeat during long stretches. If an operation
hits a **capability wall** (protocol skill §4 — fails twice, or needs an
operator-only credential/privileged step you genuinely cannot perform), stop:
record the `deadEnds[]` entry, escalate via `blockers[]` + `post-comment`, and
end the pass rather than improvising a workaround. A merely-down local tool is
a transient fault to report, not a wall (§4).

If you spot real work **outside this ticket's scope** (a separate bug, a
missing feature, an infra gap), do not implement it: apply the **orthogonal
work** rule (protocol skill §4) — search for an existing issue, file a
cross-referenced one if absent, and never build a self-generated design without
operator approval. Keep going on this ticket unless it is genuinely blocked on
that work.

### 4. hardening (adversarial review loop)

Set `phase: "hardening"` and run the adversarial review loop (protocol skill
§4a): each wave a **critic** subagent finds defects and an independent
**verifier/skeptic** subagent refutes them; fix every confirmed medium+ defect
**on the branch that owns the code** (restack the upstack for a git-spice stack);
repeat. Record each wave in `reviewLoop` and heartbeat the progress into
`headline` (e.g. "Adversarial review wave 3 — 2 medium defects being fixed").
Proceed to submit only when the loop **converges** (two consecutive clean waves,
per `config.review.cleanWavesRequired`). If it hits `config.review.capWaves`
without converging, **escalate** (blocker + `waitingOn.kind="owner"` +
`health="blocked"`, post the ask) and end the pass — do not submit with known
blocking defects. `config.review.enabled: false` collapses this back to a single
skeptical self-review pass before submit.

### 5. submit

Create or update the PR: `gh pr create` (or forge REST) with the ticket
linked **by a closing keyword** (`Closes #<key>` / `Fixes #<key>`) so the merge
auto-closes the issue — you never close it by hand, and orient's terminal close
is the backstop if the keyword didn't take. Put `attribution.prBanner` near the
top of the description, base per the stack (git-spice `repo sync`/`branch
submit` where available, plain branch + PR otherwise). Record the PR in `prs[] = {number, url, head, base, draft,
state, ci: "pending"}`. Write `phase: "review"`.

### 6. gate

Kick CI if it doesn't start automatically; update `prs[].ci` from
`gh pr checks` (or pipeline API). **Answer review comments — including bot
reviews — where they were made** (PR-response etiquette, protocol skill §7b):
read via `fetch-comments --pr N` (it marks each inline review comment with its
`file:line` and the exact reply command), reply **in-thread** with
`post-comment --pr N --reply-to <review-comment-id>` — never as a new top-level
issue comment. Process every review/bot comment, don't cherry-pick. Do **not**
resolve or decline a review comment you haven't actually addressed: if you
disagree with one, surface it to the operator (`waitingOn.kind="owner"`, the
comment URL as `ref`) rather than dismissing it yourself. **Never block waiting
on CI**: if CI is running, set `waitingOn = {kind: "build", ref: <run URL>,
pr: N, since: now}`, `health: "ok"`, and end the pass — the next pass
re-checks cheaply. If CI failed, that's the next pass's implement/fix work:
`phase: "fixing"`, fix now if the pass has budget and the fix is tractable —
but apply the **capability wall** (protocol skill §4): if this failure has
already been attempted once, or the fix needs something this environment can't
provide (an operator-only credential or privileged step), do not retry or
improvise — record a `deadEnds[]` entry, set `blockers[]`/`health="blocked"`,
post the specific ask, and end. Otherwise headline it and end. **A fix that
materially changes the diff re-enters hardening (Phase 4) before re-submit** —
re-run the loop (a fresh `reviewLoop` per §4a) to convergence so post-fix code
gets the same gate.
If CI is green and review comments are addressed: `phase: "awaiting-merge"`,
`waitingOn = {kind: "merge", ref: <PR URL>, pr: N, since: now}`,
`health: "waiting"` — the operator merges, never you. This is **not** terminal:
once the PR merges, the next pass's orient closes the ticket.

### 7. wrap

Final atomic rewrite: accurate `phase`/`health`/`headline`/`waitingOn`/
`prs[]`/`blockers[]`, **current `plan`/`notes` and any new `deadEnds[]`**
(working memory, protocol skill §4 — so the next pass resumes instead of
re-deriving), history note for the pass, `worker = {status: "idle",
taskId: null, startedAt: <unchanged>, heartbeatAt: now}`, `updatedAt: now`.
**Update `stalledPasses`** (protocol skill §4): no material progress this pass
(no `phase` change and no new commit/PR/comment) ⇒ increment it; any progress
⇒ reset to 0; at 2 set `health="error"` + a
`"<n> passes with no progress — needs operator"` blocker (the format protocol
skill §4 specifies) so the stall surfaces instead of looking healthy.
Then report in one short block: what advanced, what you're waiting on (with
links), what the operator must do. Keep it to the **shortest form that
conveys the information** (protocol skill §4): if nothing material advanced,
say that in one line — do not narrate the reconciliation or restate the plan;
prefer a link over a paragraph about it. Exit cleanly — a worker error you
recovered from is a history note, not a failure.

If the pass itself crashes irrecoverably, best-effort write
`worker.status = "error"` + history note before exiting; the orchestrator's
staleness reconcile is the backstop.
