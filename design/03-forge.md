# Forge Abstraction

status-pipe enriches agent state with live forge data. The abstraction is a
TypeScript transliteration of git-spice's Go design
(`git-spice/internal/forge/forge.go`): a small **core interface** every forge
implements, plus **optional capability interfaces** for features that don't
exist everywhere. git-spice is *not* a dependency; only the design is borrowed.

## What status-pipe needs from a forge (and git-spice's forge doesn't model)

status-pipe is read-mostly and queue-oriented. Per PR it needs:

1. comment counts — total (including PR-level, non-inline) and, where the forge
   has thread resolution, unresolved counts
2. task counts (Bitbucket-only concept): total and unresolved
3. build/check statuses — aggregate plus per-check detail (name, status, URL)
4. PR ↔ issue associations
5. PR metadata freshness: state, draft, review decision, mergeability

It never merges, comments, or edits — so the interface is far smaller than
git-spice's.

## Core interfaces

```ts
/** A forge kind. Registered in a ForgeRegistry; first match wins. */
export interface Forge {
  /** Unique id, e.g. "github" | "bitbucket". Used in config and logs. */
  readonly id: string;

  /** Web base URL (overridable for GHE / self-hosted), e.g. https://github.com */
  readonly baseUrl: string;

  /**
   * Cheap, offline match of a git remote URL to this forge.
   * Returns a RepositoryId or null. Host matching tolerates ssh subdomains
   * (ssh.github.com ⊂ github.com), mirroring git-spice's FromRemoteURL.
   */
  matchRemoteUrl(remoteUrl: string): RepositoryId | null;

  /** Open an authenticated repository handle. */
  openRepository(id: RepositoryId, auth: ForgeAuth): ForgeRepository;
}

/** Identifies a repo on a forge without network I/O. */
export interface RepositoryId {
  readonly forgeId: string;
  /** "owner/name" (GitHub) or "workspace/name" (Bitbucket). */
  readonly slug: string;
  prUrl(prNumber: number): string;
  // Ticket URLs are owned by the TicketSource, not the forge — see
  // "Ticketing sources" below.
}

/** The read surface status-pipe consumes. All methods may throw ForgeError. */
export interface ForgeRepository {
  readonly forge: Forge;
  readonly id: RepositoryId;

  /** Batch-fetch enrichment for the given PR numbers. */
  getPullRequests(numbers: number[]): Promise<PullRequestInfo[]>;

  /** Aggregate + per-check CI status for one PR head. */
  getChecks(prNumber: number): Promise<ChecksInfo>;

  /** Tickets linked to a PR (closes #N, Jira keys). May be empty. */
  getLinkedTickets(prNumber: number): Promise<TicketRef[]>;
}

export interface PullRequestInfo {
  number: number;
  url: string;
  state: 'open' | 'merged' | 'closed';
  draft: boolean;
  title: string;
  headBranch: string;
  baseBranch: string;
  comments: CommentCounts;
  /** Present only when the forge implements tasks (Bitbucket). */
  tasks?: TaskCounts;
  reviewDecision?: 'approved' | 'changes-requested' | 'review-required' | null;
  updatedAt: string;
}

export interface CommentCounts {
  /** Every comment: inline review threads + PR-level conversation. */
  total: number;
  /** Threads that carry a resolved/unresolved bit. */
  resolvable: number;
  unresolved: number;
  /**
   * Whether PR-level (non-inline) comments are resolvable on this forge.
   * GitHub: false (only review threads resolve). Bitbucket: false as well —
   * surfaced so the UI can caption counts honestly ("3 of 7 resolvable").
   */
  prLevelResolvable: boolean;
}

export interface TaskCounts { total: number; unresolved: number; }

export interface ChecksInfo {
  aggregate: 'passing' | 'failing' | 'pending' | 'none';
  checks: Array<{ name: string; status: 'passing' | 'failing' | 'pending' | 'skipped'; url?: string }>;
}

/** key is "91" (GitHub issue) or "PROJ-91" (Jira) — always treated as opaque text. */
export interface TicketRef { key: string; title?: string; url: string; }
```

### Capability model

git-spice models optional features as optional Go interfaces
(`WithInlineComments`, `WithThreadResolution`). The TypeScript equivalent is a
capabilities descriptor — easier to consume from UI code than `instanceof`
probing:

```ts
export interface ForgeCapabilities {
  /** Bitbucket: true. GitHub: false. Drives the tasks badge. */
  tasks: boolean;
  /** GitHub review threads: true. Bitbucket comment resolution: true. */
  threadResolution: boolean;
  /** Whether PR→ticket links are first-class (GitHub closes-refs) or key-parsed (Jira). */
  ticketLinks: 'native' | 'key-parsed' | 'none';
}
export interface Forge { /* … */ readonly capabilities: ForgeCapabilities; }
```

The UI renders what the capabilities allow and omits the rest — a Bitbucket card
shows a tasks badge, a GitHub card never does; absent capability is not an
error state.

## Detection and configuration

Resolution order per repo (mirrors "url-based guess with explicit override"):

1. `statusPipe.forge.type` setting (`"auto" | "github" | "bitbucket"`,
   default `auto`; resource-scoped so multi-root workspaces can differ per folder).
   When set, that forge is used unconditionally and `matchRemoteUrl` is only
   used to parse the slug.
2. Otherwise iterate the registry calling `matchRemoteUrl(remote)` for the
   repo's `origin` (then first remote) URL.
3. No match → card renders from the ticket file alone with an "enrichment off:
   unrecognized forge" note. Ticket files are still fully useful unenriched.

Base-URL overrides for self-hosted instances:
`statusPipe.forge.github.baseUrl`, `statusPipe.forge.github.apiUrl`,
`statusPipe.forge.bitbucket.baseUrl`, `statusPipe.forge.bitbucket.apiUrl`.

## Implementations

### GitHub (`forge/github/`)

- **API**: GraphQL v4 single batched query per repo per refresh — PRs by number
  with `comments.totalCount`,
  `reviewThreads(first:100){ isResolved, comments { totalCount } }`,
  `reviewDecision`, `reviewRequests` (reviewer logins — needed for the
  review-demotion queue rule), `statusCheckRollup` + check runs, and
  `closingIssuesReferences`; plus `viewer { login }` once per session (the
  local identity the demotion rule compares against). One round-trip per repo
  regardless of PR count (aliased nodes), which matters for rate limits with
  30+ tracked PRs. Repos with more than 100 review threads on one PR are
  undercounted; the count is then captioned `100+` rather than paginated —
  a deliberate budget choice.
- **Counts**: `total = comments.totalCount + Σ thread.comments.totalCount`;
  `resolvable/unresolved` from review threads; `prLevelResolvable: false`.
- **Tasks**: capability off.
- **Ticket links**: `closingIssuesReferences` (native); GitHub issues are the
  ticketing source.
- **Auth** (in order): `statusPipe.forge.github.token` setting →
  `GITHUB_TOKEN` env → VS Code's built-in GitHub authentication provider
  (`vscode.authentication.getSession`) → `gh auth token` (if gh CLI on PATH)
  → `git credential fill` for the GitHub host (the git-spice credential
  model: whatever helper the local git is configured with —
  git-credential-manager, osxkeychain, gh's helper — answers; never
  interactive, `GIT_TERMINAL_PROMPT=0`). The VS Code provider is the
  expected interactive default and is therefore tried before `gh`, which
  remains as parity with the agents' own auth.

### Bitbucket Cloud (`forge/bitbucket/`)

- **API**: REST 2.0. Per PR: `GET pullrequests/{id}` (state, draft, task counts
  come from `GET pullrequests/{id}/tasks`), `GET pullrequests/{id}/comments`
  (paged, `pagelen=100`) for counts + `resolved` flags on inline comments,
  `GET pullrequests/{id}/statuses` for builds. N+1 per PR is unavoidable on
  REST; requests run through a small concurrency-limited fetch pool (4-way)
  with ETag caching.
- **Counts**: inline comments carry resolution (`resolvable = inline count`);
  PR-level comments don't (`prLevelResolvable: false` — this is the "some
  forges don't have overall-comment resolution" case the UI captions).
- **Spike before freezing**: two Bitbucket Cloud behaviors this design leans
  on are under-documented — ETag/304 handling across the PR endpoints (the
  N+1 cost ceiling) and per-comment `resolved` flags (the resolvable counts).
  Both get verified against the live API before the `CommentCounts` semantics
  and the Bitbucket budget are frozen; the fallbacks are time-based caching
  and `resolvable: 0` captioning respectively.
- **Tasks**: native — `TaskCounts` from the tasks endpoint.
- **Ticket links**: **Jira Cloud is the ticketing source** for Bitbucket Cloud
  repos (see "Ticketing sources" below). Jira keys are parsed from branch
  name / PR title / description — the same convention Bitbucket's own Jira
  integration uses — capability reported as `key-parsed`.
- **Build status**: commit statuses aggregated exactly like git-spice's
  bitbucket `aggregateStatuses` (empty ⇒ `none`, any FAILED/STOPPED ⇒ failing,
  any INPROGRESS ⇒ pending, else passing).
- **Auth**: `statusPipe.forge.bitbucket.token` setting (API token, with
  `statusPipe.forge.bitbucket.username` for the Basic app-password form) →
  `BITBUCKET_TOKEN` env → `git credential fill` for the Bitbucket host
  (username+password from the helper ⇒ Basic; bare token ⇒ Bearer) →
  `vscode.SecretStorage`. Tokens entered interactively are stored via
  SecretStorage, never in settings.json plaintext.

## Ticketing sources

A forge hosts PRs; a **ticketing source** hosts the tracking tickets agents
communicate on. GitHub plays both roles; Bitbucket Cloud pairs with **Jira
Cloud**. Modeled as a sibling abstraction so the pairing is explicit rather
than smeared into the forge:

```ts
export interface TicketSource {
  readonly id: 'github-issues' | 'jira-cloud';
  ticketUrl(key: string): string;
  /** Title/status for display; cached aggressively (tickets change slowly). */
  getTicket(key: string): Promise<TicketRef & { status?: string }>;
}
```

- **Resolution**: GitHub forge → `github-issues` automatically. Bitbucket forge
  → `jira-cloud`, requiring a Jira site URL (`https://<site>.atlassian.net`).
  The site/project come from the repo's committed `.status-pipe/config.json`
  (`tickets.jira.*`, see [07-claude-plugin.md](07-claude-plugin.md)) when
  present — one committed truth shared with the plugin — with
  `statusPipe.tickets.jira.siteUrl` as the user-level fallback; neither set ⇒
  ticket links render as plain text keys (degraded, not broken).
- **Ticket-file impact**: on Jira-tracked repos the tracking ticket key is a
  string (`PROJ-123`), not an integer — see the contract note in
  [02-protocol.md](02-protocol.md). The card's ticket deep link goes to
  Jira; PRs still deep-link to Bitbucket.
- **Implementation status (2026-06-11)**: the deep-link half (ticketUrl via
  jiraSiteUrl / parsed keys) is implemented and wired. `getTicket`
  title/status enrichment is **deferred**: the source classes exist
  (`src/forge/ticketSources.ts`) but nothing in the UI renders live ticket
  titles/status yet, so the enricher does not call them and no Jira auth
  surface is exposed (the previously documented
  `statusPipe.tickets.jira.email` setting was removed as dead config). When
  a view consumes ticket status, wire the sources through the cache
  machinery below with a long TTL (15 min — ticket titles rarely change)
  and Jira auth = Atlassian email + API token via `JIRA_API_TOKEN` env or
  SecretStorage.

## Caching, debouncing, and rate limits

Rate limits — GitHub's especially — are a first-class design constraint, not an
error case. The budget mindset: a fleet of 30 tracked PRs across 3 repos must
idle at **a few requests per minute total**, not per PR.

### Cache layers

1. **In-memory enrichment cache**: `(repo, pr) → {data, fetchedAt, etag}`.
   Every render reads from here; network only ever *updates* it.
2. **Persisted cache** (`workspaceState`): the same map, serialized. On window
   reload the view renders instantly from yesterday's data (with staleness
   tint) and refreshes in the background — reload never causes a request storm.
3. **Terminal-state freeze**: PRs whose state is `merged`/`closed` are
   immutable for our purposes — fetched once, then never re-fetched. With
   long-running epics most of `prs[]` is merged tranches; this alone removes
   the majority of steady-state traffic.

### Request shaping

- **GitHub**: one aliased GraphQL query per repo per refresh covering every
  open tracked PR (metadata + threads + checks + linked tickets). Cost scales
  with refreshes, not PR count.
- **Bitbucket**: REST is N+1 by nature, so every GET sends `If-None-Match`;
  304s don't consume the (already generous) Bitbucket quota meaningfully and
  skip response processing. 4-way concurrency cap.
- **Change-driven fetching**: a ticket-file change triggers enrichment only for
  the PRs *referenced by the changed file* (plus any PR whose row is missing
  data). The periodic refresh covers drift on the rest.

### Refresh triggers and debouncing

| Trigger | Behavior |
|---|---|
| Ticket-file change burst | coalesced 5s, then change-driven fetch (only affected PRs) |
| Periodic | every `refreshIntervalSeconds` (default 60s) **only while a status-pipe view is visible**; hidden views don't poll |
| Window focus regained | refresh if cache older than the min interval |
| Manual refresh button | bypasses min-interval and change-driven narrowing: refetches all open PRs in the clicked scope (per-view button = everything; per-repo on the repo header) — but still uses ETags and still respects an active rate-limit backoff rather than burning the remaining budget |

### Budgeting and backoff

- Track `X-RateLimit-Remaining`/`Reset` (GitHub) on every response; below a
  threshold (default 10% remaining) the refresh interval stretches
  automatically (×2, ×4 …) until the reset time passes. The UI's staleness
  tooltip says so ("throttled to protect rate budget — resets 16:02").
- 403/429: exponential backoff per repo honoring `Retry-After`; one indicator
  in the reserved activity slot (see [05-ui.md](05-ui.md)) — never per-card
  spam, never a toast.
- All forge calls are **enrichment** — failures degrade, never block. A card
  whose enrichment failed renders from ticket-file data with a staleness tint;
  detail (cause, retry time, retry-now) lives in the activity indicator's
  tooltip/click, not in the cards.
- `ForgeError` carries `kind: 'auth' | 'rate-limit' | 'network' | 'not-found'`;
  `not-found` on a PR marks that row "deleted on forge" (hover detail) rather
  than failing the card.

## Testing

A third in-tree forge implementation, **`forge/fake/`** (the shamhub pattern):
an in-process HTTP server speaking just enough of both the GitHub GraphQL and
Bitbucket REST dialects for e2e tests, seeded from fixture JSON. Unit tests hit
the mapping layers (response → `PullRequestInfo`) with recorded fixtures; no
mocking of internal interfaces. See [06-testing-and-release.md](06-testing-and-release.md).
