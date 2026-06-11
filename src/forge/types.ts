/**
 * Forge abstraction core interfaces (design/03-forge.md) — a TypeScript
 * transliteration of git-spice's Go forge design: a small core interface
 * every forge implements, plus a capabilities descriptor for features that
 * don't exist everywhere. status-pipe is read-mostly: it never merges,
 * comments, or edits through this surface.
 */

export interface ForgeCapabilities {
	/** Bitbucket: true. GitHub: false. Drives the tasks badge. */
	tasks: boolean;
	/** Whether some comment threads carry a resolved/unresolved bit. */
	threadResolution: boolean;
	/** Whether PR→ticket links are first-class (GitHub closes-refs) or key-parsed (Jira). */
	ticketLinks: 'native' | 'key-parsed' | 'none';
}

/** Identifies a repo on a forge without network I/O. */
export interface RepositoryId {
	readonly forgeId: string;
	/** "owner/name" (GitHub) or "workspace/name" (Bitbucket). */
	readonly slug: string;
	prUrl(prNumber: number): string;
}

export interface ForgeAuth {
	token: string;
	/** Bitbucket app passwords / Jira API tokens pair with a username/email. */
	username?: string;
}

/** A forge kind. Registered in a ForgeRegistry; first match wins. */
export interface Forge {
	/** Unique id, e.g. "github" | "bitbucket". Used in config and logs. */
	readonly id: string;
	/** Web base URL (overridable for GHE / self-hosted). */
	readonly baseUrl: string;
	readonly capabilities: ForgeCapabilities;
	/**
	 * Cheap, offline match of a git remote URL to this forge. Host matching
	 * tolerates ssh subdomains (ssh.github.com ⊂ github.com).
	 */
	matchRemoteUrl(remoteUrl: string): RepositoryId | null;
	/** Open an authenticated repository handle. */
	openRepository(id: RepositoryId, auth: ForgeAuth): ForgeRepository;
}

export interface CommentCounts {
	/** Every comment: inline review threads + PR-level conversation. */
	total: number;
	/** Threads that carry a resolved/unresolved bit. */
	resolvable: number;
	unresolved: number;
	/**
	 * Whether PR-level (non-inline) comments are resolvable on this forge.
	 * False on both GitHub and Bitbucket — surfaced so the UI can caption
	 * counts honestly ("3 of 7 resolvable").
	 */
	prLevelResolvable: boolean;
	/** True when a 100-thread fetch cap was hit; counts render as "100+". */
	capped?: boolean;
}

export interface TaskCounts {
	total: number;
	unresolved: number;
}

export type ReviewDecision = 'approved' | 'changes-requested' | 'review-required' | null;

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
	reviewDecision?: ReviewDecision;
	/** Logins/ids of currently requested reviewers — the review-demotion queue rule input. */
	reviewRequests?: string[];
	updatedAt: string;
}

export type CheckStatus = 'passing' | 'failing' | 'pending' | 'skipped';

export interface ChecksInfo {
	aggregate: 'passing' | 'failing' | 'pending' | 'none';
	checks: Array<{ name: string; status: CheckStatus; url?: string }>;
}

/** key is "91" (GitHub issue) or "PROJ-91" (Jira) — always opaque text. */
export interface TicketRef {
	key: string;
	title?: string;
	url: string;
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
	/** The authenticated identity (the review-demotion rule compares against it). */
	getViewerLogin(): Promise<string | null>;
}

export type ForgeErrorKind = 'auth' | 'rate-limit' | 'network' | 'not-found';

export class ForgeError extends Error {
	constructor(
		public readonly kind: ForgeErrorKind,
		message: string,
		/** Epoch ms after which a retry is allowed (rate-limit kind). */
		public readonly retryAfter: number | null = null,
	) {
		super(message);
		this.name = 'ForgeError';
	}
}

/**
 * A ticketing source hosts tracking tickets; a forge hosts PRs. GitHub plays
 * both roles; Bitbucket Cloud pairs with Jira Cloud.
 */
export interface TicketSource {
	readonly id: 'github-issues' | 'jira-cloud';
	ticketUrl(key: string): string;
	/** Title/status for display; cached aggressively (tickets change slowly). */
	getTicket(key: string): Promise<TicketRef & { status?: string }>;
}
