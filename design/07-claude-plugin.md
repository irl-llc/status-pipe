# Claude Code Plugin: `status-pipe`

The second deliverable: a Claude Code plugin providing a **baseline,
repo-agnostic agent workflow** that emits the protocol from
[02-protocol.md](02-protocol.md) — usable in any repo as an alternative
to the bespoke `autopilot` command sets living in `irl-llc` and
`git-spice-code-extension` today. The extension is useless without something
writing the files; this plugin is the reference writer.

It lives in this repo under `plugin/` (a Claude Code plugin marketplace can
point at the repo; it can be split out later — surfaces over implementations:
the plugin's command names and file contract are the stable surface, its
location is not).

## Structure

```
plugin/
├── .claude-plugin/plugin.json     # name: status-pipe
├── commands/
│   ├── launch.md                  # /status-pipe:launch [interval] (planner loop)
│   ├── tick.md                    # /status-pipe:tick — planner: plan+stamp, write dispatch, exit
│   ├── work-ticket.md             # /status-pipe:work-ticket <ticket-key> (worker process)
│   ├── work-epic.md               # /status-pipe:work-epic <path-to-epic.md> (worker process)
│   ├── split.md                   # /status-pipe:split <ticket> <topic>  (sub-ticket carve-out)
│   └── ack-check.md               # /status-pipe:ack-check  (inbox consume, standalone)
├── bin/
│   ├── fetch-comments             # trust gateway: API-verified, operator-filtered
│   │                              #   comment digests (the only sanctioned read path)
│   └── post-comment               # posting wrapper: attribution marker + comment-id
│                                  #   ledger (the only sanctioned write path)
├── skills/
│   └── protocol/SKILL.md          # how to read/write the status-pipe protocol correctly,
│                                  #   incl. trust + attribution rules (binding)
└── README.md                      # migration guide for the prototype repos
                                   # (rename mapping + inbox/parked prompt paragraphs)
```

## Repo configuration: `.status-pipe/config.json`

Committed alongside `launch.json`; schema ships at `schemas/config.schema.json`.
Everything the plugin needs to know about *this repo's* conventions lives here
(the extension reads it too, but only for display hints):

```json
{
  "schemaVersion": 1,
  "epics": { "dir": "epics" },
  "inventory": { "label": "agent-queue", "assignees": ["octocat", "octocat-bot"] },
  "tickets": { "source": "github-issues" },
  "staleWorkerMinutes": 30,
  "review": { "enabled": true, "blockSeverity": "medium", "cleanWavesRequired": 2, "capWaves": 6 },
  "reviewGate": { "requireCiGreen": true, "waitForBots": ["gemini-code-assist[bot]"], "botWaitMaxMinutes": 30 },
  "trust": {
    "mode": "single-maintainer",
    "operators": ["octocat"],
    "minAssociation": null
  },
  "attribution": {
    "commentPrefix": "**CLAUDE COMMENT**",
    "prBanner": "This PR was authored by a coding agent (status-pipe worker) on behalf of @octocat.",
    "includeAgentId": false
  }
}
```

- `epics.dir` — the epic folder name (default `epics`); repos that call it
  `roadmap/`, `specs/`, or anything else just say so.
- `inventory.label` — the forge label selecting the agent's backlog
  (default `agent-queue`).
- `inventory.assignees` (optional) — a routing filter: when set, inventory
  keeps only tickets assigned to a listed identity. Lets a team share one repo
  — assign a ticket to a listed identity to hand it to the agent, assign it
  elsewhere (or leave it unassigned) to keep it human. Routing, **not** trust
  (see the trust section); array of usernames, or the per-channel object form
  on Bitbucket+Jira.
- `tickets.source` — `github-issues` or `jira-cloud` (+ `jira.siteUrl`,
  `jira.projectKey` when Jira).
- `staleWorkerMinutes` — committed source of truth for the worker-heartbeat
  threshold; the orchestrator echoes it into `orchestrator.json` for the
  extension ([02-protocol.md](02-protocol.md)).
- `review` (optional) — tunes the worker's pre-submit adversarial review loop
  (the `hardening` phase, protocol skill §4a). On by default; `enabled: false`
  reverts to a single self-review. `blockSeverity` (`medium` default) is the
  lowest defect severity that blocks; `cleanWavesRequired` (2) and `capWaves` (6)
  set convergence and the escalate-to-operator cap.
- `reviewGate` (optional) — the **pre-handoff** gate: what must hold before a
  worker reaches `awaiting-merge` (the two-layer gate below). `requireCiGreen`
  (default **true**) demands the PR head's checks actually ran and the live
  aggregate is `passing`; a repo with no CI sets it `false` (documented escape
  hatch). `waitForBots` (default **empty**) lists review-bot usernames that must
  review the *current head* before handoff — opt-in, since identities are
  repo-specific. `botWaitMaxMinutes` (default ~30) bounds the wait for a stranded
  bot before the worker escalates a NEEDS-YOU blocker. Like `inventory.assignees`,
  `waitForBots` is **routing, not trust** — a listed bot only delays the human
  handoff; its comments stay untrusted data and never drive the agent.
- On Bitbucket + Jira repos, `trust.operators` spans two identity namespaces;
  use the split form `operators: { "bitbucket": ["{uuid}"], "jira":
  ["<accountId>"] }` — entries are matched per channel by the forge's own
  stable id (Bitbucket account UUID, Jira account id), never display names.
- `trust`, `attribution` — below.

## The two supported work models

Mirrors the two real workflows:

1. **Ticket mode** (`work-ticket`) — pure ticket flow, the
   git-spice-code-extension style: a tracking ticket is the work spec and the
   communication channel. Cache key = ticket key. The **ticketing source**
   follows the forge: GitHub repos use GitHub issues (key = issue number);
   Bitbucket Cloud repos use **Jira Cloud** (key = `PROJ-123`; inventory via a
   JQL label query instead of `gh issue list`; design-intent comments go on
   the Jira ticket via its REST API; Jira site/project configured in the
   plugin's repo config).
2. **Epic mode** (`work-epic`) — the irl-llc style: an `<epics.dir>/<slug>.md`
   file is the spec (folder name per `config.epics.dir`). The canonical header
   is `> **Tracking ticket:** owner/repo#N` (or a Jira key); the legacy
   spelling `> **Tracking issue:**` is accepted forever so migrated prototype
   epics need no edits. The command creates the tracking ticket and inserts
   the header if missing. The tracking ticket is the agent↔human design-intent
   channel. Cache key = tracking ticket key.

Both modes write the identical `tickets/<key>.json`; status-pipe (the extension)
renders them identically. Epic-mode cards additionally deep-link the epic file.

### Sub-tickets: keeping epic tracking tickets readable

A long epic funnels everything — design Q&A, per-tranche review chatter,
incident follow-ups — into one tracking ticket, which becomes unreadable
exactly when the operator most needs the checklist. The fix is to carve
focused discussions out into **sub-tickets**:

- `/status-pipe:split <ticket> <topic>` creates a sub-ticket titled
  `<epic-slug>: <topic>`, cross-linked both ways (GitHub: native sub-issues;
  Jira: parent link), and replaces the in-flight discussion on the parent with
  one pointer comment. Workers may also split *proactively* when a single
  topic on the tracking ticket exceeds a handful of back-and-forth exchanges
  (the threshold lives in the `protocol` skill, not hard-coded).
- The parent tracking ticket converges on what it should be: the tranche
  checklist plus one-line lifecycle summaries. Conversations live in
  sub-tickets.
- **Protocol impact (additive)**: the epic's ticket file gains optional
  `subTickets: [{key, url, topic, status}]` so the extension can list them in
  the expanded card; `waitingOn.ref` already deep-links into whichever
  sub-ticket holds the open question. A sub-ticket is a *discussion channel*,
  not a work item — the epic stays one card, one state file, one worker.

## Trust model (`config.trust`)

Who is allowed to *drive* the agent through forge comments is safety-critical:
a public repo where anyone's issue comment can steer a code-writing,
PR-opening agent is an unacceptable failure mode, and even on private team
repos two operators' agents must not act on each other's tickets. Three
explicit modes; the plugin **refuses to tick a public repo whose config does
not declare a trust mode**. Visibility is checked at every tick start via the
forge API (GitHub `GET /repos/{owner}/{repo}` `.private` / Bitbucket `is_private`), so a
private→public flip takes effect on the next pass; if the visibility check
itself fails, the repo is treated as public — misconfiguration and API
failure both fail closed. A *private* repo with no `trust` block defaults to
`single-maintainer` with the authenticated forge user as sole operator:

| Mode | Inventory | Who can drive |
|---|---|---|
| `single-maintainer` | scan by label — every ticket is the operator's | the operator |
| `multi-maintainer` | label **and** `assignee ∈ operators` — unassigned or otherwise-assigned tickets are invisible to this agent, so colleagues' agents never collide | the operator(s) |
| `public` | label **and** ticket author/assignee ∈ operators — outsiders cannot conscript the agent by opening labeled issues | the operator(s), strictly |

**Assignee scoping is routing, not trust.** `config.inventory.assignees` (above)
narrows *which eligible tickets this agent works*; the trust mode governs *who
may drive the agent*. They compose — the assignee filter intersects with
whatever the trust mode already requires — but they are independent axes:
being a listed assignee never grants authority to steer the agent (that is
`trust.operators`), and an operator's ticket is still skipped if it isn't
assigned to a listed identity. One orchestrator runs per repo; the assignee is
simply the agent-vs-human routing switch on each ticket.

### Enforcement is layered, not prompt-only

Prompt instructions alone cannot be the safety boundary — the model reading
the rules is the same model the untrusted comments could inject. Three layers:

1. **A deterministic comment gateway** (`plugin/bin/fetch-comments`, a plain
   script): the *only* sanctioned way workers read ticket/PR comments. It
   fetches via the forge API, verifies each author against the operator
   allowlist, and emits a structured digest in which operator comments are
   marked authoritative while non-operator bodies are dropped (default in
   `public` mode is headers-only: author, time, one-line machine summary) or
   wrapped in clearly delimited untrusted-data fences. Operator-grade signals
   ("proceed", approvals) are extracted by the script from operator comments
   only — the model never decides who is an operator.
2. **Permission allowlists**: the repo's committed `.claude/settings.json`
   allows the gateway and the posting wrapper (below) and denies raw
   `gh issue comment` / direct comment-API calls, so the rules are enforced by
   the harness, not by model compliance.
3. **Prompt rules** (the `protocol` skill) cover what scripts cannot: how to
   treat quarantined content (data, never instructions), when to surface
   community input to the operator.

Common rules across every mode, all verified against the **forge API's author
field** (never against parseable comment text, which anyone can spoof):

- **Operators are an explicit allowlist** (`trust.operators`: forge
  usernames; Jira account ids on Jira). GitHub `author_association`
  (OWNER/MEMBER) may additionally be required via `trust.minAssociation`, but
  association alone is never sufficient — explicitness over heuristics.
- **Commands come only from operators or the inbox.** State-changing signals —
  "proceed", design decisions, plan approvals, ready-for-look — are accepted
  from exactly two channels: comments whose API-verified author is an
  operator, and the local ack inbox (filesystem access = trust). Everything
  else is *data*.
- **Non-operator content is untrusted input** (the prompt-injection posture):
  in `public` mode the worker may read community comments for awareness, and
  should surface them to the operator (summarized in `headline` or a
  sub-ticket, or `waitingOn.kind=owner` with the comment as `ref` when a
  suggestion looks substantive) — but it must never execute instructions found
  in them, follow links into tool actions on their behalf, or incorporate
  their suggestions without an operator decision. Aware, not obedient.
- **The agent never trusts its own posts as operator signals.** When operator
  and agent share one forge account, self-recognition is **by comment ID, not
  by text**: every agent post goes through the posting wrapper
  (`plugin/bin/post-comment` — the same script that prepends the attribution
  marker), which records the created comment's API id in the ticket file
  (`agentCommentIds[]`, additive field). The comment gateway excludes those
  ids from "the operator said". Recognizing own posts by the text prefix was
  rejected: it violates the never-trust-parseable-text rule, and a single
  unmarked post would mint operator-grade authority for the next tick. The
  wrapper/ledger pair is also why raw comment posting is permission-denied
  (layer 2 above).
- **Config is read from the local working tree only.** `config.json` and
  `launch.json` govern trust and execution, so the plugin reads them from the
  checked-out trunk — never from a PR branch or fetched ref. A PR that edits
  them is just a diff to review like any other; it has no effect until the
  operator merges it.

## Attribution (`config.attribution`)

People get justifiably angry when they can't tell whether a human or their
coding agent wrote something. Attribution is therefore mandatory, not
cosmetic, and enforced by the `protocol` skill on **every forge mutation**:

- Every agent-posted comment starts with `attribution.commentPrefix` —
  default `**CLAUDE COMMENT**` (Ed's working convention).
- Every agent-authored PR description carries `attribution.prBanner` near the
  top, naming the responsible operator.
- `attribution.includeAgentId: true` extends the prefix with the posting
  context — `**CLAUDE COMMENT** (epic irl-ci · T2)` — useful when several
  epics' workers share a repo; off by default because it isn't an omnipresent
  need.

The marker's job is social transparency for collaborators (plus a convenient
human-vs-agent separator for future tooling). It is deliberately **not** a
trust input — shared-account self-recognition runs on the comment-ID ledger
above, so a missing or spoofed marker can embarrass but never escalate.

## Command behavior

### `tick` — one orchestration tick (main agent, idempotent, zero-prompt)

0. **Worktree preflight**: refuse to orchestrate from a linked worktree —
   if `git rev-parse --git-dir` ≠ `--git-common-dir`, exit 0 with the message
   "worktree checkout of `<primary>`; run the tick there". Worktrees are where
   *workers* run, never orchestrators; without this guard a tick launched in a
   worktree would re-orchestrate the same backlog and create nested worktrees
   on every pass.
1. **Inventory**: epics under `<config.epics.dir>/*.md` (epic mode) and/or
   open tickets matching `config.inventory.label` (default `agent-queue`,
   ticket mode), **filtered per the trust mode** (assignee/author ∈ operators
   where required) **and then scoped by `config.inventory.assignees`** when
   set (keep only tickets assigned to a listed identity — routing, ticket mode
   only). Create missing tracking tickets.
2. **Consume the ack inbox** (`.status-pipe/inbox/*/ack-*.json`): match
   `target` against current `waitingOn` per
   [02-protocol.md](02-protocol.md#feedback-signal); consumed acks
   become highest-priority dispatch candidates this tick; record
   consumption/supersession in `history[]`; delete the files.
3. **Reconcile staleness**: `worker.status=running` with heartbeat older than
   `staleWorkerMinutes` ⇒ treat as crashed, mark `worker.status=error` with a
   history note (the card escalates in the extension), eligible for relaunch.
4. **Fair-schedule (plan, don't spawn)**: oldest `updatedAt` first, ack-consumers
   first, `--max-concurrent` cap; for each selected item create its worktree,
   stamp `worker.status=running`, and add a `work-ticket`/`work-epic` entry to
   the dispatch plan. The planner never spawns workers — the supervisor reads
   the plan and spawns one `claude -p` worker process per item
   ([09-launch-and-supervision.md](09-launch-and-supervision.md)).
5. **Write `orchestrator.json`** (passCount, timestamps, `dispatch` plan) and report: needs-you items,
   ready-to-merge PRs, in-flight work. If nothing was dispatchable and every
   active item is parked on the operator with an empty inbox, set
   `orchestrator.json.parked` (`{since, reason, recheckAfter}`) so the extension's
   supervisor stops the tick cadence until an ack or backlog change wakes it
   ([09-launch-and-supervision.md](09-launch-and-supervision.md)); clear it on
   any pass that finds work.

### `work-ticket` / `work-epic` — one work-item pass

Phase machine identical in shape to irl-llc's tranche loop, generalized:
**orient** (reconcile git + forge + ticket file; consume any inbox acks for this
ticket) → **plan** → **implement** → **review** (self-review the diff) →
**submit** (create/update PR; stacked PRs via git-spice when available, plain
branches otherwise — git-spice is *not* required) → **gate** (the pre-handoff
`reviewGate` below; never block waiting on CI) → **wrap**.

**The pre-handoff gate is two layers** (`config.reviewGate`):

1. **Worker gate (binding, prompt-side).** A worker reaches `awaiting-merge`
   only when the PR head's CI has *actually run and passed* (when
   `requireCiGreen`) **and** every `waitForBots` reviewer has a review on the
   *current head SHA* that the worker has read and addressed. Both halves are
   **head-anchored**: a check or bot review on a stale commit does not count, so
   "it passed" means "it passed on this commit." Checks still pending on head ⇒
   `waitingOn.kind=build` (WAITING, re-polled). A required bot missing on head ⇒
   `waitingOn.kind=review`. A bot still silent after `botWaitMaxMinutes` ⇒
   `health=blocked` + a blocker (NEEDS YOU) — never stranded, never skipped.
2. **Extension CI backstop (deterministic, CI-only).** The queue model already
   computes live CI (`effectiveCi` overrides the worker's cached `pr.ci` with the
   live `ChecksInfo.aggregate`). `assignLane` consults it: a card the worker
   marked merge-ready (`phase: awaiting-merge` / `waitingOn.kind: merge`) is
   **not** rendered as ready-to-merge while the merge PR's `effectiveCi` isn't
   `passing` — a failing PR surfaces as orphaned-CI, anything else falls to
   WAITING — so a worker that jumped the gate is visibly corrected regardless of
   what it wrote. This layer honors `requireCiGreen` (a no-CI repo opts out) and
   stays CI-only: "bot addressed" is judgment that lives with the worker;
   "checks passed" is deterministic and belongs in the extension.

State-writing discipline (enforced by the `protocol` skill):

- **all protocol writes anchor at the primary checkout**: the protocol dir is
  always `<git common dir>/../.status-pipe/` (`git rev-parse
  --git-common-dir`), never relative to the worker's cwd — a worker running
  inside a worktree heartbeats into the *main* repo's `.status-pipe/`, so
  nested protocol dirs can never come into existence
- rewrite `tickets/<key>.json` atomically at every phase transition and at wrap;
  heartbeat (`worker.heartbeatAt`) at least every few minutes while running
- `headline` is always one sentence, present tense, operator-readable
- when human input is needed: set `waitingOn` with a **deep-linkable `ref`**
  (the exact comment URL — the extension's highest-value click), set
  `health=waiting` or `blocked` + `blockers[]`, post the actual question on the
  tracking ticket/PR, then *end the pass* — never poll for the human
- append `history[]` on every meaningful action; never rewrite history
- every forge mutation carries the attribution marker; operator signals are
  authenticated per the trust model (both above)
- never merge, never approve; merge readiness is expressed as
  `waitingOn.kind=merge`

### `launch` — recurring wrapper

Runs `tick` on the chosen interval (default 10m). Implementation does not
assume any particular loop facility: where the host Claude Code has a loop
skill it uses that; otherwise it prints the equivalent shell loop
(`while true; do claude -p "/status-pipe:tick"; sleep 600; done`) ready to
paste, and points at the extension supervisor as the better answer (which
works in single-repo mode too). Same shape as irl-llc's
`launch-epic-iterator`. This is the
*interactive* way to run the loop (single-repo mode, Claude pane open); in
fleet mode the extension's supervisor launches `tick` directly as a headless
tick (`claude -p "/status-pipe:tick" --output-format stream-json`) per
[09-launch-and-supervision.md](09-launch-and-supervision.md). `tick` is
deliberately a one-pass, zero-prompt command so both paths share it. The
interactive loop honors parking the same way the supervisor does: each
iteration first checks `orchestrator.json.parked` and the inbox — parked with
an empty inbox ⇒ report the parked reason and skip the pass (cheap no-op
instead of a full reconcile). The plugin README ships a reference
`.status-pipe/launch.json` for Claude Code.

### `ack-check` — standalone inbox sweep

Steps 2–3 of `tick` only. Useful for fast hand-back latency between full
ticks, or for repos where a human drives agents manually but still wants the
extension's ack button to work.

## Migration path for the prototype repos

`irl-llc` and `git-spice-code-extension` migrate their bespoke `autopilot`
loops to the status-pipe protocol using the rename mapping in
[10-naming.md](10-naming.md) (`.autopilot` → `.status-pipe`, `issue` →
`ticket`, `run` → `worker`, …). The plugin README ships, alongside that
mapping, the two prompt paragraphs their existing commands
(`epic-iteration-fanout.md` etc.) need to splice in: inbox consumption
(consume `.status-pipe/inbox/`, record `ackId` in `history[]`, delete the
file) and the `parked` declaration at wrap. Repos can keep their bespoke
loops or replace them with `/status-pipe:tick` wholesale; the extension works
with either, since the protocol — not the command set — is the contract.

## Testing

The plugin's contract surface is tested from the extension repo: fixture ticket
files used in unit/Playwright tests are validated against
`schemas/ticket.schema.json` and `schemas/ack.schema.json`, and the schemas are
shared by both the plugin docs and the extension parser — one contract, two
consumers, validated in CI.
