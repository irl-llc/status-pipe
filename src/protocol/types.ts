/**
 * Types for the status-pipe protocol (design/02-protocol.md).
 *
 * These mirror schemas/*.schema.json — one contract, two consumers
 * (the plugin writes, the extension reads). The extension treats every
 * field defensively: files are written by external agents.
 */

export type Phase =
	| 'planning'
	| 'implementation'
	| 'review'
	| 'fixing'
	| 'merging'
	| 'awaiting-merge'
	| 'merged'
	| 'blocked'
	| 'abandoned';

export type Health = 'ok' | 'waiting' | 'blocked' | 'error' | 'done';

export type WaitingKind = 'build' | 'review' | 'comment' | 'owner' | 'merge';

/** WaitingKind plus the synthetic 'blockers' used only in ack targets. */
export type AckWaitingKind = WaitingKind | 'blockers';

export type CiState = 'unknown' | 'pending' | 'passing' | 'failing';

export type PrState = 'open' | 'merged' | 'closed';

export interface WaitingOn {
	kind: WaitingKind;
	ref: string | null;
	pr: number | null;
	since: string;
	detail: string | null;
}

export interface TicketPr {
	number: number;
	url: string | null;
	head: string;
	base: string;
	draft: boolean;
	state: PrState;
	ci: CiState;
	part: string | null;
}

export interface SubTicket {
	key: string;
	url: string | null;
	topic: string;
	status: string | null;
}

export interface HistoryEntry {
	at: string;
	phase: string | null;
	note: string;
	runId: string | null;
}

export type WorkerStatus = 'idle' | 'running' | 'error';

export interface WorkerState {
	status: WorkerStatus;
	taskId: string | null;
	startedAt: string | null;
	heartbeatAt: string | null;
}

export interface TicketFile {
	schemaVersion: number;
	repo: string;
	ticket: string;
	title: string;
	slug: string | null;
	url: string | null;
	phase: Phase;
	health: Health;
	headline: string;
	waitingOn: WaitingOn | null;
	prs: TicketPr[];
	blockers: string[];
	subTickets: SubTicket[];
	agentCommentIds: string[];
	history: HistoryEntry[];
	worker: WorkerState | null;
	updatedAt: string;
}

export interface ParkedState {
	since: string;
	reason: string;
	recheckAfter: string | null;
}

export interface OrchestratorFile {
	schemaVersion: number;
	repo: string | null;
	passCount: number | null;
	lastPassStartedAt: string | null;
	lastPassFinishedAt: string | null;
	staleWorkerMinutes: number | null;
	parked: ParkedState | null;
	note: string | null;
}

export interface AckTarget {
	waitingKind: AckWaitingKind;
	waitingSince: string;
	ref: string | null;
	pr: number | null;
}

export interface AckFile {
	schemaVersion: number;
	kind: 'ready-for-look';
	ticket: string;
	ackId: string;
	target: AckTarget;
	stateUpdatedAt: string;
	note: string | null;
	createdAt: string;
	createdBy: string;
}

export type AgentMode = 'tick' | 'daemon';

export interface LaunchAgent {
	id: string;
	title: string;
	command: string;
	args: string[];
	stdin: string;
	cwd: string;
	env: Record<string, string>;
	mode: AgentMode;
	intervalMinutes: number;
	timeoutMinutes: number;
}

export interface LaunchFile {
	schemaVersion: number;
	agents: LaunchAgent[];
}

export type TrustMode = 'single-maintainer' | 'multi-maintainer' | 'public';

export interface ConfigFile {
	schemaVersion: number;
	epicsDir: string;
	inventoryLabel: string;
	ticketSource: 'github-issues' | 'jira-cloud' | null;
	jiraSiteUrl: string | null;
	jiraProjectKey: string | null;
	staleWorkerMinutes: number | null;
	trustMode: TrustMode | null;
}

/**
 * A parse outcome that never throws: corrupt or unknown-schema files become
 * degraded values so cards render instead of disappearing (never silently
 * drop work — design/02-protocol.md).
 */
export type ParseResult<T> =
	| { ok: true; value: T }
	| { ok: false; reason: 'corrupt' | 'unknown-schema'; raw: string; detail: string };
