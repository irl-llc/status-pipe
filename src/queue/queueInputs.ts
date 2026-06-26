/**
 * Inputs to the queue model (design/04-architecture.md): protocol state,
 * forge enrichment overlay, supervisor state, and a `now` parameter so
 * durations and staleness are deterministic under test.
 */

import { ChecksInfo, ForgeCapabilities, PullRequestInfo, TicketRef } from '../forge/types';
import { AgentActivity } from '../output/claudeStream';
import {
	AckFile,
	AgentLifetime,
	ConfigFile,
	LaunchFile,
	OrchestratorFile,
	ParseResult,
	TicketFile,
} from '../protocol/types';
import { ActivityDisplay, AgentRunState } from './displayTypes';

export interface TicketEntry {
	/** Filename stem — the ticket key. */
	key: string;
	parsed: ParseResult<TicketFile>;
}

export interface KnownAck {
	ack: AckFile;
	/** False for acks we wrote whose file has since disappeared (consumed/withdrawn). */
	onDisk: boolean;
}

/** Enrichment for one PR — an overlay; a card always renders without it. */
export interface PrEnrichment {
	info: PullRequestInfo | null;
	checks: ChecksInfo | null;
	linkedTickets: TicketRef[];
	fetchedAt: number;
	deletedOnForge: boolean;
}

export interface RepoEnrichment {
	prs: Record<number, PrEnrichment>;
	/** The authenticated forge identity, for the review-demotion rule. */
	viewerLogin: string | null;
}

export interface RepoState {
	repoRoot: string;
	/** Short display name (basename of the repo root). */
	name: string;
	forgeId: string | null;
	capabilities: ForgeCapabilities | null;
	/** Set when only a worktree of this repo is open (supervision disabled). */
	monitorOnly: boolean;
	/** The forge's issues page (`<base>/<slug>/issues`), for the empty-inventory prompt. */
	issuesUrl: string | null;
	orchestrator: OrchestratorFile | null;
	config: ConfigFile | null;
	launch: LaunchFile | null;
	tickets: TicketEntry[];
	/** Union of on-disk inbox files and recently-written acks remembered by the host. */
	acks: KnownAck[];
	enrichment: RepoEnrichment | null;
}

export interface AgentProcessState {
	repoRoot: string;
	agentId: string;
	title: string;
	lifetime: AgentLifetime;
	state: AgentRunState;
	nextTickAt: number | null;
	runningSince: number | null;
	lastOutputAt: number | null;
	consecutiveFailures: number;
	lastExitCode: number | null;
	detail: string | null;
	/** Parsed from the launcher's stream-json stdout; empty (phase null) when none. */
	activity: AgentActivity;
}

/** One live worker process the supervisor spawned from the dispatch plan. */
export interface WorkerProcessState {
	repoRoot: string;
	/** Dispatch item key — the ticket key (an epic's tracking-ticket key) the worker is advancing. */
	key: string;
	runningSince: number | null;
	lastOutputAt: number | null;
	/** Parsed from the worker's stream-json stdout; what it's doing right now. */
	activity: AgentActivity;
}

export interface QueueModelInput {
	repos: RepoState[];
	agents: AgentProcessState[];
	/** Live workers across all repos (supervisor-spawned, dispatch-driven). */
	workers: WorkerProcessState[];
	activity: ActivityDisplay;
	/** Epoch ms — injected for deterministic tests. */
	now: number;
	settings: {
		staleWorkerMinutesDefault: number;
		quietRetentionHours: number;
	};
}
