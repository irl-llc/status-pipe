/**
 * Fixture builders for queue-model unit tests (design/05-ui.md "Queue
 * semantics"). Everything is deterministic: time is anchored at NOW and
 * derived via minutesAgo/hoursAgo so staleness math never depends on the
 * wall clock.
 */

import { PullRequestInfo } from '../../../forge/types';
import { emptyActivity } from '../../../output/claudeStream';
import { buildAck } from '../../../protocol/ackId';
import { ConfigFile, LaunchFile, OrchestratorFile, TicketFile, TicketPr } from '../../../protocol/types';
import {
	AgentProcessState,
	KnownAck,
	PrEnrichment,
	QueueModelInput,
	RepoState,
	TicketEntry,
} from '../../../queue/queueInputs';

export const NOW = Date.parse('2026-06-11T12:00:00Z');

export function minutesAgo(minutes: number): string {
	return new Date(NOW - minutes * 60_000).toISOString();
}

export function hoursAgo(hours: number): string {
	return minutesAgo(hours * 60);
}

export function makeTicket(overrides: Partial<TicketFile> = {}): TicketFile {
	return {
		schemaVersion: 1,
		repo: 'acme/app',
		ticket: '853',
		title: 'Ticket 853',
		slug: null,
		url: null,
		phase: 'implementation',
		health: 'ok',
		headline: 'Working on it.',
		waitingOn: null,
		prs: [],
		blockers: [],
		subTickets: [],
		agentCommentIds: [],
		history: [],
		worker: null,
		updatedAt: minutesAgo(5),
		...overrides,
	};
}

export function makePr(overrides: Partial<TicketPr> & Pick<TicketPr, 'number'>): TicketPr {
	return {
		url: null,
		head: `feat-${overrides.number}`,
		base: 'main',
		draft: false,
		state: 'open',
		ci: 'unknown',
		part: null,
		...overrides,
	};
}

export function okEntry(ticket: TicketFile): TicketEntry {
	return { key: ticket.ticket, parsed: { ok: true, value: ticket } };
}

export function corruptEntry(key: string, reason: 'corrupt' | 'unknown-schema' = 'corrupt'): TicketEntry {
	return { key, parsed: { ok: false, reason, raw: '{not json', detail: 'unit fixture' } };
}

export function makeRepo(overrides: Partial<RepoState> = {}): RepoState {
	return {
		repoRoot: '/work/app',
		name: 'app',
		forgeId: 'github',
		capabilities: null,
		monitorOnly: false,
		issuesUrl: null,
		orchestrator: null,
		config: null,
		launch: null,
		tickets: [],
		acks: [],
		enrichment: null,
		...overrides,
	};
}

export function ticketRepo(tickets: TicketFile[], overrides: Partial<RepoState> = {}): RepoState {
	return makeRepo({ tickets: tickets.map(okEntry), ...overrides });
}

export function makeOrchestrator(overrides: Partial<OrchestratorFile> = {}): OrchestratorFile {
	return {
		schemaVersion: 1,
		repo: null,
		passCount: null,
		lastPassStartedAt: null,
		lastPassFinishedAt: null,
		staleWorkerMinutes: null,
		parked: null,
		note: null,
		...overrides,
	};
}

export function makeConfig(overrides: Partial<ConfigFile> = {}): ConfigFile {
	return {
		schemaVersion: 1,
		epicsDir: 'epics',
		inventoryLabel: 'agent-queue',
		ticketSource: null,
		jiraSiteUrl: null,
		jiraProjectKey: null,
		staleWorkerMinutes: null,
		trustMode: null,
		...overrides,
	};
}

export function makeLaunch(intervalMinutes = 10): LaunchFile {
	return {
		schemaVersion: 1,
		agents: [
			{
				id: 'orchestrator',
				title: 'Orchestrator',
				command: 'node',
				args: [],
				stdin: '',
				cwd: '.',
				env: {},
				mode: 'tick',
				intervalMinutes,
				timeoutMinutes: 45,
			},
		],
	};
}

export function makeAgent(overrides: Partial<AgentProcessState> = {}): AgentProcessState {
	return {
		repoRoot: '/work/app',
		agentId: 'orchestrator',
		title: 'Orchestrator',
		mode: 'tick',
		state: 'scheduled',
		nextTickAt: null,
		runningSince: null,
		lastOutputAt: null,
		consecutiveFailures: 0,
		lastExitCode: null,
		detail: null,
		activity: emptyActivity(),
		...overrides,
	};
}

export function makeInput(
	repos: RepoState[],
	agents: AgentProcessState[] = [],
	now: number = NOW,
	settings: Partial<QueueModelInput['settings']> = {},
): QueueModelInput {
	return {
		repos,
		agents,
		activity: { state: 'idle', detail: null, oldestDataAgeMs: null },
		now,
		settings: { staleWorkerMinutesDefault: 30, quietRetentionHours: 24, ...settings },
	};
}

/** A KnownAck whose target matches the ticket's current ackable state. */
export function ackFor(ticket: TicketFile, createdAt: string, onDisk = true): KnownAck {
	const ack = buildAck({ ticket, note: null, createdAt, createdBy: 'ed' });
	if (!ack) {
		throw new Error(`fixture ticket ${ticket.ticket} is not ackable`);
	}
	return { ack, onDisk };
}

export function makePrInfo(overrides: Partial<PullRequestInfo> & Pick<PullRequestInfo, 'number'>): PullRequestInfo {
	return {
		url: `https://github.com/acme/app/pull/${overrides.number}`,
		state: 'open',
		draft: false,
		title: `PR ${overrides.number}`,
		headBranch: `feat-${overrides.number}`,
		baseBranch: 'main',
		comments: { total: 0, resolvable: 0, unresolved: 0, prLevelResolvable: false },
		updatedAt: minutesAgo(10),
		...overrides,
	};
}

export function prEnrichment(overrides: Partial<PrEnrichment> = {}): PrEnrichment {
	return { info: null, checks: null, linkedTickets: [], fetchedAt: NOW, deletedOnForge: false, ...overrides };
}
