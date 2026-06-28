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
	| 'hardening'
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

/**
 * One worker the planner has stamped and wants the supervisor to spawn this
 * pass. `prompt` is the fully-formed `claude -p` argument the planner built
 * (e.g. `/status-pipe:work-ticket 19`, ack note already appended); `worktree`
 * is the worker's cwd. The supervisor substitutes these into the `worker`
 * launch template (the entry with id `worker`) and never constructs them
 * itself (design/09).
 */
export interface DispatchItem {
	key: string;
	kind: 'ticket' | 'epic';
	prompt: string;
	worktree: string;
}

/**
 * The planner's dispatch declaration, written to orchestrator.json each pass
 * and consumed by the supervisor (or any executor) to spawn worker processes.
 * `maxConcurrent` is the planner's declared ceiling; the executor treats it as
 * a defensive cap on top of the already-capped item list.
 */
export interface DispatchPlan {
	maxConcurrent: number;
	items: DispatchItem[];
}

export interface OrchestratorFile {
	schemaVersion: number;
	repo: string | null;
	passCount: number | null;
	lastPassStartedAt: string | null;
	lastPassFinishedAt: string | null;
	staleWorkerMinutes: number | null;
	parked: ParkedState | null;
	/** Workers the planner stamped this pass; the supervisor spawns them. */
	dispatch: DispatchPlan | null;
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

/**
 * The launch entry's three orthogonal concerns, each its own field (they were
 * formerly conflated in a single `mode`):
 *
 * - **`id`** — role / lookup key. Two ids are reserved: `tick` (the planner)
 *   and `worker` (the dispatch template the supervisor instantiates per
 *   `orchestrator.json.dispatch` item, resolving `%prompt%`/`%worktree%`).
 *   Any other id is a generic supervised agent.
 * - **`type`** — how the work is produced: `claude` (the CLI with default
 *   prompt/args supplied), `exec` (an explicit command/args), or `built-in`
 *   (the in-process deterministic planner — no external process; valid only on
 *   the reserved `tick` id, carrying no command/args).
 * - **`lifetime`** — how a single supervised process is managed: `scheduled`
 *   (run → exit → relaunch after `intervalMinutes`) or `daemon` (long-running,
 *   restarted on death). The `worker` template ignores it (on-demand by role).
 */
export type AgentType = 'claude' | 'exec' | 'built-in';
export type AgentLifetime = 'scheduled' | 'daemon';

/** Reserved launch ids the supervisor maps to specific roles. */
export const PLANNER_ID = 'tick';
export const WORKER_ID = 'worker';

export interface LaunchAgent {
	id: string;
	title: string;
	type: AgentType;
	command: string;
	args: string[];
	stdin: string;
	cwd: string;
	env: Record<string, string>;
	lifetime: AgentLifetime;
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
	inventoryAssignees: string[];
	ticketSource: 'github-issues' | 'jira-cloud' | null;
	jiraSiteUrl: string | null;
	jiraProjectKey: string | null;
	staleWorkerMinutes: number | null;
	trustMode: TrustMode | null;
	/** Identities allowed to drive the agent (flattened from trust.operators). */
	trustOperators: string[];
	/**
	 * Pre-handoff review gate (`config.reviewGate`, flattened). Governs when a
	 * worker may reach `awaiting-merge`: head CI must have actually run+passed and
	 * every configured review bot must have reviewed the current head. The plugin
	 * (Layer 1) is the binding consumer; the extension's deterministic CI backstop
	 * (Layer 2) reads only `reviewGateRequireCiGreen`. Bots listed here are
	 * routing, never trust — they delay the human handoff, they never drive the
	 * agent (same independence as inventory.assignees vs trust.operators).
	 */
	reviewGateRequireCiGreen: boolean;
	reviewGateWaitForBots: string[];
	reviewGateBotWaitMaxMinutes: number;
}

/**
 * A parse outcome that never throws: corrupt or unknown-schema files become
 * degraded values so cards render instead of disappearing (never silently
 * drop work — design/02-protocol.md).
 */
export type ParseResult<T> =
	| { ok: true; value: T }
	| { ok: false; reason: 'corrupt' | 'unknown-schema'; raw: string; detail: string };
