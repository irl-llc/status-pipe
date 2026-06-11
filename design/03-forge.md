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
  issueUrl(issueNumber: number): string;
}

/** The read surface status-pipe consumes. All methods may throw ForgeError. */
export interface ForgeRepository {
  readonly forge: Forge;
  readonly id: RepositoryId;

  /** Batch-fetch enrichment for the given PR numbers. */
  getPullRequests(numbers: number[]): Promise<PullRequestInfo[]>;

  /** Aggregate + per-check CI status for one PR head. */
  getChecks(prNumber: number): Promise<ChecksInfo>;

  /** Issues linked to a PR (closes #N, Bitbucket issue links). May be empty. */
  getLinkedIssues(prNumber: number): Promise<IssueRef[]>;
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

export interface IssueRef { number: number; title?: string; url: string; }
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
  /** Whether PR→issue links are first-class (GitHub closes-refs) or heuristic. */
  issueLinks: 'native' | 'heuristic' | 'none';
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
3. No match → card renders from state file alone with an "enrichment off:
   unrecognized forge" note. State files are still fully useful unenriched.

Base-URL overrides for self-hosted instances:
`statusPipe.forge.github.baseUrl`, `statusPipe.forge.github.apiUrl`,
`statusPipe.forge.bitbucket.baseUrl`, `statusPipe.forge.bitbucket.apiUrl`.

## Implementations

### GitHub (`forge/github/`)

- **API**: GraphQL v4 single batched query per repo per refresh — PRs by number
  with `comments.totalCount`, `reviewThreads(first:100){ isResolved }`,
  `reviewDecision`, `statusCheckRollup` + check runs, `closingIssuesReferences`.
  One round-trip per repo regardless of PR count (aliased nodes), which matters
  for rate limits with 30+ tracked PRs.
- **Counts**: `total = comments.totalCount + sum(reviewThreads.comments)`;
  `resolvable/unresolved` from review threads; `prLevelResolvable: false`.
- **Tasks**: capability off.
- **Issue links**: `closingIssuesReferences` (native).
- **Auth** (in order): `statusPipe.forge.github.token` setting →
  `GITHUB_TOKEN` env → `gh auth token` (if gh CLI on PATH) → VS Code's built-in
  GitHub authentication provider (`vscode.authentication.getSession`). The
  VS Code provider is the expected default for interactive use; `gh` keeps
  parity with the agents' own auth.

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
- **Tasks**: native — `TaskCounts` from the tasks endpoint.
- **Issue links**: heuristic — parse `#N` / Jira-key patterns from the PR
  description; capability reported as `heuristic`.
- **Build status**: commit statuses aggregated exactly like git-spice's
  bitbucket `aggregateStatuses` (empty ⇒ `none`, any FAILED/STOPPED ⇒ failing,
  any INPROGRESS ⇒ pending, else passing).
- **Auth**: `statusPipe.forge.bitbucket.token` setting (API token) →
  `BITBUCKET_TOKEN` env. Tokens entered interactively are stored via
  `vscode.SecretStorage`, never in settings.json plaintext.

## Error and rate-limit posture

- All forge calls are **enrichment** — failures degrade, never block. A card
  whose enrichment failed shows its state-file data plus a subdued
  "forge data unavailable (rate limited / offline / auth)" footer with a retry
  affordance.
- Per-repo enrichment refresh is debounced (default 60s min interval,
  `statusPipe.forge.refreshIntervalSeconds`), triggered by state-file changes
  and view focus, not a hot poll. 403/429 responses back off exponentially per
  repo and surface a single status-bar warning, not per-card spam.
- `ForgeError` carries `kind: 'auth' | 'rate-limit' | 'network' | 'not-found'`;
  `not-found` on a PR marks that row "deleted on forge" rather than failing the
  card.

## Testing

A third in-tree forge implementation, **`forge/fake/`** (the shamhub pattern):
an in-process HTTP server speaking just enough of both the GitHub GraphQL and
Bitbucket REST dialects for e2e tests, seeded from fixture JSON. Unit tests hit
the mapping layers (response → `PullRequestInfo`) with recorded fixtures; no
mocking of internal interfaces. See [06-testing-and-release.md](06-testing-and-release.md).
