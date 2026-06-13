# Forge Integration

status-pipe enriches agent state with live forge data (CI status, review
state, comment/task counts). **It does not embed forge API clients and does not
authenticate to any forge.** Instead it *delegates* forge reads to a configured
**enrichment command** that owns the forge dialect and its own credentials. The
extension's job is the protocol + the queue UI; talking to a forge is somebody
else's command.

## Why delegation, not an embedded abstraction

The earlier design transliterated git-spice's Go forge interfaces into
TypeScript (`Forge` / `ForgeRepository`, per-forge GitHub/Bitbucket clients,
and an in-extension credential resolver). That was a **leaking abstraction**:

- **Forge knowledge lived in the extension.** A new forge meant new TypeScript
  and a new release; "forge-portable" was really "the two forges we compiled
  in." The protocol's claim to be the *only* agent↔extension coupling was
  undercut by the extension independently knowing how to talk to GitHub and
  Bitbucket.
- **Auth was reimplemented three times and drifted.** The extension carried its
  own copy of "the git-spice credential model" (`src/forge/gitCredential.ts`),
  and the reference plugin carried two more (`plugin/bin/post-comment`,
  `plugin/bin/fetch-comments`). All three resolved a forge token by hand
  (env → `git credential fill` → ambient `gh`). They could — and did — disagree:
  agent comments silently posted under the operator's personal account instead
  of the configured bot, because one copy's `git credential fill` answered with
  a keychain token before `gh`'s deliberately-selected identity was ever
  consulted. Three auth planes, guaranteed to diverge.

The fix is the same on both sides of the product (see
[07-claude-plugin.md](07-claude-plugin.md) for the writer side): **delegate to
the tool that already owns the behavior and the auth.** A command (`gh`, a
`glab` wrapper, a house script) authenticates however it authenticates; the
extension never sees a token. One auth model per command, declared once where
that command's config lives (`GH_CONFIG_DIR`, a profile, an env var). Forge
support becomes open-ended — a command, not a code change.

This is a *reduction* in concepts: it deletes the embedded clients and the
extension's credential copy, and it dissolves the cross-plane identity problem
rather than papering over it with precedence rules.

## The enrichment command contract

The extension treats forge enrichment as an **optional overlay** on the
authoritative ticket files. Per repo, on each refresh, it invokes one command
with the working set on stdin and reads an enrichment document on stdout.

### Invocation

```
<enrich-command> [configured args...]
```

- **cwd**: the repo's primary checkout (so the command can read git remotes,
  run `gh`, etc.).
- **stdin** (JSON): the batch — everything that needs enriching in one call, so
  the command can shape one efficient request (batching is the command's job,
  not lost to per-card spawning):

  ```json
  {
    "schemaVersion": 1,
    "repo": { "root": "/abs/path", "remoteUrl": "https://github.com/acme/x.git", "slug": "acme/x" },
    "prs": [855, 856, 860],
    "tickets": ["142", "PROJ-9"]
  }
  ```

- **stdout** (JSON): enrichment keyed by ref. The shapes below are the
  command's *output contract* (formerly internal TS interfaces); they ship as a
  JSON Schema under `schemas/` alongside the protocol schemas.

  ```json
  {
    "schemaVersion": 1,
    "viewerLogin": "ed-irl-codebot",
    "capabilities": { "tasks": false, "threadResolution": true, "ticketLinks": "native" },
    "prs": {
      "855": {
        "number": 855, "url": "...", "state": "open", "draft": false,
        "title": "...", "headBranch": "...", "baseBranch": "...",
        "comments": { "total": 7, "resolvable": 5, "unresolved": 2, "prLevelResolvable": false },
        "tasks": { "total": 0, "unresolved": 0 },
        "reviewDecision": "changes-requested",
        "checks": { "aggregate": "failing", "checks": [{ "name": "build", "status": "failing", "url": "..." }] },
        "linkedTickets": [{ "key": "142", "title": "...", "url": "..." }],
        "updatedAt": "2026-06-12T03:38:10Z"
      }
    },
    "tickets": { "142": { "key": "142", "title": "...", "url": "...", "status": "open" } }
  }
  ```

- **exit / degradation**: nonzero exit, malformed output, or timeout ⇒ the
  refresh degrades. The card renders from ticket-file data alone (the protocol
  already defines `prs[].ci` as "the worker's cached view — superseded by live
  forge checks when enrichment succeeds"). Stderr is surfaced in the reserved
  activity slot ([05-ui.md](05-ui.md)), never as per-card errors. **Enrichment
  failure never blocks and never drops a card.**

### Field semantics (the output schema)

```ts
interface PrEnrichment {
  number: number;
  url: string;
  state: 'open' | 'merged' | 'closed';
  draft: boolean;
  title: string;
  headBranch: string;
  baseBranch: string;
  comments: CommentCounts;
  tasks?: TaskCounts;                 // present only where the forge has tasks
  reviewDecision?: 'approved' | 'changes-requested' | 'review-required' | null;
  checks: ChecksInfo;
  linkedTickets: TicketRef[];
  updatedAt: string;
}
interface CommentCounts { total: number; resolvable: number; unresolved: number; prLevelResolvable: boolean; }
interface TaskCounts { total: number; unresolved: number; }
interface ChecksInfo {
  aggregate: 'passing' | 'failing' | 'pending' | 'none';
  checks: Array<{ name: string; status: 'passing' | 'failing' | 'pending' | 'skipped'; url?: string }>;
}
interface TicketRef { key: string; title?: string; url: string; }  // key is opaque text: "91" or "PROJ-91"
```

### Capability model

The command reports a `capabilities` descriptor; the UI renders what it allows
and omits the rest (a Bitbucket card shows a tasks badge, a GitHub card never
does — absent capability is not an error):

```ts
interface ForgeCapabilities {
  tasks: boolean;                              // Bitbucket: true, GitHub: false
  threadResolution: boolean;                   // GitHub review threads / Bitbucket comment resolution
  ticketLinks: 'native' | 'key-parsed' | 'none';
}
```

## Configuration and defaults

Resolution order for the enrichment command, most specific first:

1. **`config.json` `forge.enrich`** (committed, per-repo): an argv array, e.g.
   `["gh-enrich"]` or `["./.status-pipe/enrich.sh"]`. This is the protocol-level
   declaration — one committed truth shared by anyone opening the repo. Because
   it names a command the *extension* will execute, it is **gated by VS Code
   Workspace Trust** (below).
2. **`statusPipe.forge.enrichCommand`** (user/workspace setting): the same, as a
   machine-level override or for repos with no committed declaration.
3. **The bundled default command.** status-pipe ships a first-party enricher
   (the GitHub + Bitbucket implementations live here, behind the command
   boundary rather than wired into the extension host). Zero-config repos work
   out of the box: the default detects the forge from the git remote, batches
   one request per refresh, and resolves auth via `gh` (GitHub) / the git
   credential helper (Bitbucket) — the *single* remaining place that resolves
   forge auth, replacing the extension's deleted credential copy. Self-hosted
   base URLs and forge-type pinning are options of the default command, not
   extension settings.

No command, no match, command fails ⇒ file-only rendering with an "enrichment
off" note. Ticket files are always fully useful unenriched.

### Workspace Trust (new, load-bearing)

A committed `config.json` (or a `.status-pipe/enrich.sh`) that names a command
is **code that runs when someone opens the repo in VS Code**. This is the same
class of risk the agent side contains by reading config only from the primary
checkout and never from a PR branch ([07-claude-plugin.md](07-claude-plugin.md)).
In the extension:

- The **bundled default** command always runs (first-party, no operator code).
- An **operator-supplied** command (`config.json forge.enrich`, or a workspace
  setting from an untrusted workspace) runs **only in a trusted workspace**.
  Untrusted ⇒ fall back to the bundled default, or to file-only if the operator
  command was meant to replace it; surface the downgrade in the activity slot.
- The committed override is read from the **primary checkout's working tree**,
  never from a fetched ref or a linked worktree's branch — same anchoring rule
  as the rest of the protocol.

## Ticketing sources

A forge hosts PRs; a **ticketing source** hosts the tracking tickets agents
communicate on. This pairing is now expressed the same way — the enrichment
command returns `tickets[]` enrichment (title/status) for the keys it was
given, and `capabilities.ticketLinks` tells the UI whether links are native
(GitHub closing-refs), key-parsed (Jira keys in branch/title), or absent. The
committed `tickets.source` / `tickets.jira.*` in `config.json` (see
[07-claude-plugin.md](07-claude-plugin.md)) tell both the plugin and the
default enrichment command which source to use; nothing about the *forge* is
hard-coded in the extension.

- GitHub repos: source is `github-issues`; keys are integers.
- Bitbucket Cloud repos: source is **Jira Cloud**; the tracking-ticket key is a
  string (`PROJ-123`) — see the contract note in
  [02-protocol.md](02-protocol.md). The card's ticket deep link goes to Jira;
  PRs still deep-link to Bitbucket.
- Live ticket title/status is an enrichment field like any other; absent ⇒
  links render as plain keys (degraded, not broken).

## Caching, debouncing, and rate limits

Two responsibilities split cleanly across the command boundary:

- **The extension owns *when* to invoke the command** (cadence, caching the
  results, freezing terminal states). This is where the "a fleet idles at a few
  requests per minute, not per PR" budget is enforced — by calling the command
  rarely, not by shaping HTTP.
- **The command owns *how* to fetch** (request batching, ETags, per-forge rate
  budgeting, backoff). The bundled default keeps the GitHub
  one-aliased-GraphQL-query-per-refresh and Bitbucket ETag/concurrency behavior
  internally; a third-party command makes its own choices.

### Extension-side cache layers

1. **In-memory overlay cache**: `(repo, pr) → {data, fetchedAt}`. Every render
   reads from here; a command invocation only ever *updates* it.
2. **Persisted cache** (`workspaceState`): serialized overlay, so a window
   reload renders instantly from the last result (with a staleness tint) and
   refreshes in the background — reload never causes a command storm.
3. **Terminal-state freeze**: PRs whose last-known `state` is `merged`/`closed`
   are dropped from the stdin batch — fetched once, then never again. With
   long-running epics most of `prs[]` is merged tranches; this removes the bulk
   of steady-state invocations.

### Refresh triggers and debouncing

| Trigger | Behavior |
|---|---|
| Ticket-file change burst | coalesced 5s, then enrich only the PRs the changed files reference (a narrowed batch) |
| Periodic | every `refreshIntervalSeconds` (default 60s) **only while a status-pipe view is visible**; hidden views don't poll |
| Window focus regained | refresh if the overlay is older than the min interval |
| Manual refresh | bypasses min-interval and change-driven narrowing: enrich all open PRs in the clicked scope, still respecting an active backoff the command reports |

### Backoff and degradation

- The command signals throttling out-of-band (a documented nonzero exit code or
  a `{ "retryAfter": "..." }` field); the extension stretches the interval
  (×2, ×4 …) and says so in the activity tooltip ("throttled — retry 16:02").
  *How* rate budget is tracked (GitHub `X-RateLimit-*`, Bitbucket quotas) is the
  command's concern, not the extension's.
- All enrichment failures degrade, never block; detail (cause, retry) lives in
  the activity indicator, never per-card.

## Testing

The command boundary makes testing simpler and consistent with the plugin side:
the extension under test runs a **fake enrichment command** on PATH (a script
emitting fixture JSON), exactly as `binScripts.test.ts` already fakes `gh`/`git`
on PATH for the wrappers. No mocking of internal interfaces; the contract under
test is the stdin/stdout schema. The bundled default command keeps its own unit
tests for the GitHub/Bitbucket response → output-schema mappings, seeded from
recorded fixtures (the shamhub-style in-process server moves behind the default
command). See [06-testing-and-release.md](06-testing-and-release.md).
