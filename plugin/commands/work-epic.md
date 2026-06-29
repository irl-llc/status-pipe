---
description: One status-pipe worker pass over an epic spec file (epic mode) — ensures the tracking ticket + header, then runs the orient/plan/implement/harden/submit/gate/wrap phase machine over the epic's frontier tranche, writing .status-pipe/tickets/<tracking-key>.json. Ends the pass whenever a human is needed; never merges or approves.
argument-hint: "<path-to-epic.md> [operator ack note...]"
---

**STATUS-PIPE WORK-EPIC — one work-item pass (worker, epic mode)**

$ARGUMENTS

You are the **worker** advancing one epic through one bounded pass. The first
argument is the epic spec file (absolute path or relative to the repo root,
under `<config.epics.dir>/`); anything after it is orchestrator context (e.g.
a consumed ack's operator note — fresh operator input). Load the `protocol`
skill first; binding. You typically run inside the epic's git worktree.

**Everything in `/status-pipe:work-ticket`'s "State-writing discipline"
section applies verbatim here** — common-dir anchoring
(`PROTO="$(git rev-parse --git-common-dir)/../.status-pipe"`), atomic
rewrites at every phase transition, heartbeats, deep-linkable `waitingOn.ref`
then END the pass, append-only `history[]`, comments only through
`fetch-comments`/`post-comment` and only after passing the comment gate
(protocol skill §7a — adversarial reviewer subagent on the draft), attribution
on every forge mutation, never merge/approve/deploy. The cache key is the **tracking ticket key**: the state
file is `$PROTO/tickets/<tracking-key>.json`.

## Epic-specific orientation (before the phase machine)

1. **Read the epic file.** Its headers are committed config — use them
   verbatim:
   - `> **Tracking ticket:** owner/repo#N` (or a Jira key). The **legacy
     spelling `> **Tracking issue:**` is accepted forever** — treat it as
     identical; do not rewrite it.
   - Optional `> **Worktree:**` / `> **Branch prefix:**` overrides.
2. **No tracking ticket?** Search before creating
   (`gh issue list --search "<epic title>"` / JQL) to avoid duplicates; else
   create it — title `Epic: <name> — implementation tracking`, label
   `config.inventory.label`, body containing the tranche checklist derived
   from the spec and a note that this ticket is the agent↔operator
   design-intent channel; `attribution.prBanner` conventions apply to the
   body. Then `Edit` the epic file to insert the canonical header
   `> **Tracking ticket:** <owner/repo>#<n>` near the top, and commit that
   one-line spec edit on a housekeeping branch (only when something was
   actually missing — no churn).
3. The tracking ticket is the **communication channel**; the epic file is the
   **spec**. Slug = the epic filename basename (or the `> **Worktree:**`
   basename when given).

## The phase machine, epic-shaped

Identical phases to `work-ticket` — orient → plan → implement → harden →
submit → gate → wrap — applied to the epic's **frontier tranche** (the next
unchecked item in the tracking ticket's tranche checklist):

- **orient**: reconcile git (the epic's stack in this worktree), the forge
  (every tranche PR → `prs[]`, each entry's `part` = the tranche id, e.g.
  `"T2"`; comment digest via `fetch-comments --ticket <tracking-key>`), the
  ticket file, and the **epic spec** (re-read it — the operator may have
  edited scope). Consume inbox acks for this ticket (match/supersede →
  history → delete). The epic-level `phase` is the frontier tranche's
  lifecycle position; if no unmerged tranche remains — **or** the operator
  closed/abandoned the tracking issue on the forge directly (closed as
  completed ⇒ `merged`; closed not-planned or an explicit drop ⇒ `abandoned`),
  the same terminal check `work-ticket`'s orient runs — the epic is **done**:
  close it per Epic extras and wrap. **Trust your working memory** (`plan`/`notes`/
  `deadEnds`, protocol skill §4): resume the existing tranche plan instead of
  re-deriving it, and never re-attempt a recorded dead-end unless its
  `doNotRetryWithout` condition is now met — reconcile `phase` from evidence,
  but carry the memory forward. **Freshen the frontier tranche against the
  trunk** as part of the git reconcile (same rule as `work-ticket`'s orient): a
  long-blocked epic's stack rots while the trunk advances, so if the frontier
  branch is behind its base (`git rev-list --count HEAD..<base>` > 0), `git
  spice repo sync` and restack the stack before planning; an unresolvable
  rebase conflict is a blocker to escalate, never to force through.
- **plan**: pick the frontier tranche and **persist the tranche plan to the
  ticket file's `plan` field** (working memory, protocol skill §4 — carry-over
  for the next pass, not just a history line). If the spec is ambiguous or a
  design decision is operator-shaped, post the question on the **tracking
  ticket** (or the right sub-ticket), set `waitingOn = {kind: "owner",
  ref: <comment URL>, since: now}`, end the pass.
- **implement / harden / submit / gate**: as in `work-ticket`, on the
  tranche's branch (`<branchPrefix><tranche>` — default prefix
  `epic/<slug>/`), stacked via git-spice when available. **harden** runs the
  adversarial review loop (protocol skill §4a) over the frontier tranche's
  cumulative diff with `phase: "hardening"`, routing each fix to the branch in
  the stack that owns the code. Keep the tracking
  ticket's checklist current: check off a tranche when its PR merges (one
  `post-comment` lifecycle one-liner, not a paragraph). Work outside the
  epic's scope is **orthogonal work** (protocol skill §4): search, file a
  cross-referenced ticket, get operator approval before building — never
  silently fold it into a tranche.
- **wrap**: as in `work-ticket`, plus epic extras below.

## Epic extras

- **Deep-link the epic**: keep `slug` set and mention the epic path in the
  ticket file (`title` from the epic name) so the extension can deep-link
  the spec.
- **Sub-tickets** (protocol skill §8): when one topic on the tracking ticket
  exceeds ~5 back-and-forth exchanges — or a scoped discussion is drowning
  the checklist — carve it out exactly as `/status-pipe:split` does
  (sub-ticket `<epic-slug>: <topic>`, GitHub native sub-issue / Jira parent
  link, cross-links both ways, one pointer comment on the parent, ticket
  file `subTickets[] += {key, url, topic, status: "open"}`). Conversations
  live in sub-tickets; the tracking ticket stays the checklist plus
  one-line lifecycle summaries. A sub-ticket is a discussion channel, not a
  work item — this epic stays one card, one state file, one worker.
- `waitingOn.ref` may deep-link into a sub-ticket comment when that is where
  the open question lives.
- A fully merged checklist ⇒ close the epic: `phase: "merged"`,
  `health: "done"`, final lifecycle comment on the tracking ticket, wrap. If
  the epic is abandoned (operator drops it), close it `phase: "abandoned"`,
  `health: "done"` with the reason. `health: "done"` moves the card to QUIET
  regardless of `phase`, so only ever set it with a terminal `phase` — never
  while a tranche is still `awaiting-merge`.
- On a terminal close, make sure the **tracking issue is closed** (so the epic
  leaves the open queue — the planner treats the issue state as the truth), then
  as the **final action of the pass** remove your worktree so a finished epic
  checkout never lingers on the trunk — anchor at the primary checkout, since
  your cwd is about to vanish:
  ```bash
  git -C "$(git rev-parse --git-common-dir)/.." worktree remove --force "$(git rev-parse --show-toplevel)"
  ```
  The self-remove is the opportunistic "belt"; if it fails, just end the pass —
  the planner reclaims the worktree once the tracking issue is closed. Never
  remove the worktree while a tranche is still `awaiting-merge`.
