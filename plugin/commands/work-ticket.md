---
description: One status-pipe worker pass over a single ticket (ticket mode) — orient, plan, implement, self-review, submit PR, kick CI, wrap; writes .status-pipe/tickets/<key>.json per the protocol skill. Ends the pass whenever a human is needed; never merges or approves.
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
  `${CLAUDE_PLUGIN_ROOT}/bin/fetch-comments --repo-root "$(git rev-parse --show-toplevel)" --ticket <key>`
  (or `--pr <N>`); post ONLY via
  `${CLAUDE_PLUGIN_ROOT}/bin/post-comment --repo-root ... --ticket <key> (--issue <N> | --pr <N> | --jira <KEY>) --body ...`.
  Operator-grade signals come only from sections the gateway marks
  authoritative, or from ack notes handed to you by the orchestrator.
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

### 2. plan

If the work isn't already planned: derive a short, reviewable plan from the
ticket body + authoritative comments. If the plan needs an operator decision
(ambiguous scope, two defensible architectures), post the question
(`post-comment`), set `waitingOn = {kind: "owner", ref: <comment URL>,
since: now}`, and end the pass. Otherwise write `phase: "implementation"`
(history: the plan summary, one line).

### 3. implement

Do the work in this worktree on a ticket branch (`ticket/<key>` or the
repo's convention; stack with git-spice when the repo uses it — it is NOT
required). Commit in reviewable units. Run the repo's tests/build locally to
the extent it defines them. Heartbeat during long stretches.

### 4. review (self-review)

Review your own diff as a skeptical colleague: correctness, tests, scope
creep, debug leftovers, repo conventions. Fix what you find. Only then
proceed (history note: review done, what changed).

### 5. submit

Create or update the PR: `gh pr create` (or forge REST) with the ticket
linked, `attribution.prBanner` near the top of the description, base per the
stack (git-spice `repo sync`/`branch submit` where available, plain branch +
PR otherwise). Record the PR in `prs[] = {number, url, head, base, draft,
state, ci: "pending"}`. Write `phase: "review"`.

### 6. gate

Kick CI if it doesn't start automatically; update `prs[].ci` from
`gh pr checks` (or pipeline API). Answer review-bot comments (read via
`fetch-comments --pr N`, reply via `post-comment`). **Never block waiting on
CI**: if CI is running, set `waitingOn = {kind: "build", ref: <run URL>,
pr: N, since: now}`, `health: "ok"`, and end the pass — the next pass
re-checks cheaply. If CI failed, that's the next pass's implement/fix work:
`phase: "fixing"`, fix now if the pass has budget, else headline it and end.
If CI is green and review comments are addressed: `phase: "awaiting-merge"`,
`waitingOn = {kind: "merge", ref: <PR URL>, pr: N, since: now}`,
`health: "waiting"` — the operator merges, never you.

### 7. wrap

Final atomic rewrite: accurate `phase`/`health`/`headline`/`waitingOn`/
`prs[]`/`blockers[]`, history note for the pass, `worker = {status: "idle",
taskId: null, startedAt: <unchanged>, heartbeatAt: now}`, `updatedAt: now`.
Then report in one short block: what advanced, what you're waiting on (with
links), what the operator must do. Exit cleanly — a worker error you
recovered from is a history note, not a failure.

If the pass itself crashes irrecoverably, best-effort write
`worker.status = "error"` + history note before exiting; the orchestrator's
staleness reconcile is the backstop.
