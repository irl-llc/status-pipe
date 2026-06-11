/**
 * DisplayState — the host → webview snapshot (design/04, 05).
 *
 * JSON-serializable (postMessage), shared by the extension host and the
 * React webview. The queue model derives it; the webview only renders it.
 */

import { CheckStatus, ForgeCapabilities } from '../forge/types';
import {
	Health,
	HistoryEntry,
	ParkedState,
	Phase,
	PrState,
	SubTicket,
	WaitingKind,
	WorkerStatus,
} from '../protocol/types';

export type Lane = 'needs-you' | 'waiting' | 'quiet';

/** Priority classes within NEEDS YOU (design/05-ui.md), low rank = first. */
export type NeedsYouReason =
	| 'launcher-failed'
	| 'worker-crashed'
	| 'stale-ack'
	| 'blocked'
	| 'owner'
	| 'review'
	| 'merge'
	| 'orphaned-ci'
	| 'degraded';

export type AckChipState = 'pending' | 'picked-up' | 'superseded' | 'pickup-unconfirmed' | 'stale' | 'moved-on';

export interface AckChipDisplay {
	state: AckChipState;
	ackId: string;
	createdAt: string;
	note: string | null;
}

export interface AckControlDisplay {
	/** Whether "Ready for another look" applies to the ticket's current state. */
	actionable: boolean;
	chip: AckChipDisplay | null;
}

export interface WaitingDisplay {
	kind: WaitingKind;
	ref: string | null;
	pr: number | null;
	since: string;
	durationMs: number;
	detail: string | null;
}

export interface WorkerDisplay {
	status: WorkerStatus;
	heartbeatAt: string | null;
	heartbeatAgeMs: number | null;
	stale: boolean;
}

export interface CommentBadge {
	unresolved: number;
	total: number;
	resolvable: number;
	prLevelResolvable: boolean;
	capped: boolean;
}

export interface PrRowDisplay {
	number: number;
	url: string | null;
	part: string | null;
	head: string;
	state: PrState;
	draft: boolean;
	/** Effective CI: live forge checks when enriched, the worker's cached view otherwise. */
	ci: 'unknown' | 'pending' | 'passing' | 'failing' | 'none';
	ciChecks: Array<{ name: string; status: CheckStatus; url: string | null }>;
	/** Click target for the CI badge: first failing check's URL. */
	ciUrl: string | null;
	comments: CommentBadge | null;
	tasks: { unresolved: number; total: number } | null;
	reviewDecision: 'approved' | 'changes-requested' | null;
	linkedTickets: Array<{ key: string; url: string | null }>;
	/** "main" or "T1a #855" — the base, resolved against tracked PRs. */
	upstream: string;
	/** Tracked PRs based on this head: ["T2 #861", …]. */
	downstream: string[];
	enriched: boolean;
	deletedOnForge: boolean;
}

export interface DegradedInfo {
	reason: 'corrupt' | 'unknown-schema';
	detail: string;
}

export interface CardDisplay {
	/** Stable identity: `${repoRoot}::${ticket}` or `${repoRoot}::launcher::${agentId}`. */
	id: string;
	kind: 'ticket' | 'launcher-failed';
	repoRoot: string;
	repoName: string;
	ticket: string | null;
	title: string;
	url: string | null;
	phase: Phase | null;
	health: Health;
	headline: string;
	lane: Lane;
	reason: NeedsYouReason | null;
	/** (class rank, age) — deterministic, auditable ordering; exposed for tests. */
	priorityRank: number;
	waiting: WaitingDisplay | null;
	blockers: string[];
	prs: PrRowDisplay[];
	subTickets: SubTicket[];
	history: HistoryEntry[];
	ackControl: AckControlDisplay;
	worker: WorkerDisplay | null;
	degraded: DegradedInfo | null;
	rawJson: string | null;
	epicSlug: string | null;
	updatedAt: string;
	/** QUIET items past the retention window hide behind the "show done" filter. */
	hiddenByDefault: boolean;
}

export type AgentRunState =
	| 'disabled'
	| 'stopped'
	| 'scheduled'
	| 'launching'
	| 'running'
	| 'backoff'
	| 'failed'
	| 'parked';

export interface AgentDisplay {
	repoRoot: string;
	repoName: string;
	agentId: string;
	title: string;
	mode: 'tick' | 'daemon';
	state: AgentRunState;
	nextTickAt: number | null;
	runningSince: number | null;
	lastOutputAt: number | null;
	consecutiveFailures: number;
	detail: string | null;
}

export interface RepoDisplay {
	repoRoot: string;
	name: string;
	forgeId: string | null;
	capabilities: ForgeCapabilities | null;
	lastPassFinishedAt: string | null;
	parked: ParkedState | null;
	/** Set when only a worktree of this repo is open — supervision disabled. */
	monitorOnlyNote: string | null;
	ticketCount: number;
}

export type ActivityState = 'idle' | 'refreshing' | 'degraded';

/** Contents of the reserved activity slot — the only global network status. */
export interface ActivityDisplay {
	state: ActivityState;
	/** Tooltip: cause, data age, retry time. */
	detail: string | null;
	oldestDataAgeMs: number | null;
}

export interface DisplayState {
	generatedAt: number;
	multiRepo: boolean;
	repos: RepoDisplay[];
	agents: AgentDisplay[];
	/** Sorted: lane, then priority rank, then age/repo/ticket. */
	cards: CardDisplay[];
	counts: { needsYou: number; waiting: number; quiet: number };
	activity: ActivityDisplay;
}
