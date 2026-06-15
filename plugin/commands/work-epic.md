---
description: One status-pipe worker pass over an epic spec file (epic mode) — ensures the tracking ticket + header, then runs the orient/plan/implement/review/submit/gate/wrap phase machine over the epic's frontier tranche, writing .status-pipe/tickets/<tracking-key>.json. Ends the pass whenever a human is needed; never merges or approves.
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

Identical phases to `work-ticket` — orient → plan → implement → review →
submit → gate → wrap — applied to the epic's **frontier tranche** (the next
unchecked item in the tracking ticket's tranche checklist):

- **orient**: reconcile git (the epic's stack in this worktree), the forge
  (every tranche PR → `prs[]`, each entry's `part` = the tranche id, e.g.
  `"T2"`; comment digest via `fetch-comments --ticket <tracking-key>`), the
  ticket file, and the **epic spec** (re-read it — the operator may have
  edited scope). Consume inbox acks for this ticket (match/supersede →
  history → delete). The epic-level `phase` is the frontier tranche's
  lifecycle position. **Trust your working memory** (`plan`/`notes`/
  `deadEnds`, protocol skill §4): resume the existing tranche plan instead of
  re-deriving it, and never re-attempt a recorded dead-end unless its
  `doNotRetryWithout` condition is now met — reconcile `phase` from evidence,
  but carry the memory forward.
- **plan**: pick the frontier tranche and **persist the tranche plan to the
  ticket file's `plan` field** (working memory, protocol skill §4 — carry-over
  for the next pass, not just a history line). If the spec is ambiguous or a
  design decision is operator-shaped, post the question on the **tracking
  ticket** (or the right sub-ticket), set `waitingOn = {kind: "owner",
  ref: <comment URL>, since: now}`, end the pass.
- **implement / review / submit / gate**: as in `work-ticket`, on the
  tranche's branch (`<branchPrefix><tranche>` — default prefix
  `epic/<slug>/`), stacked via git-spice when available. Keep the tracking
  ticket's checklist current: check off a tranche when its PR merges (one
  `post-comment` lifecycle one-liner, not a paragraph).
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
- A fully merged checklist ⇒ `phase: "merged"`, `health: "done"`, final
  lifecycle comment on the tracking ticket, wrap.
