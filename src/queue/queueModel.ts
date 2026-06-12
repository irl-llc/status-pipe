/**
 * The queue model (design/04-architecture.md): pure derivation
 * (tickets, acks, enrichment, supervisor state, now) → DisplayState.
 * Unit-test target #1 — no I/O, no clocks, no vscode.
 */

import { emptyActivity } from '../output/claudeStream';
import { LaunchAgent, TicketFile } from '../protocol/types';
import { AckContext, deriveAckControl, hasFreshPendingAck, hasStaleAck } from './ackState';
import {
	AgentDisplay,
	CardDisplay,
	DisplayState,
	Lane,
	NeedsYouReason,
	RepoDisplay,
	WaitingDisplay,
	WorkerDisplay,
} from './displayTypes';
import { LaneContext, REASON_RANK, assignLane, isWorkerStale } from './lane';
import { buildPrRows } from './prRows';
import { AgentProcessState, QueueModelInput, RepoState, TicketEntry } from './queueInputs';

const LANE_ORDER: Record<Lane, number> = { 'needs-you': 0, waiting: 1, quiet: 2 };

export function buildDisplayState(input: QueueModelInput): DisplayState {
	const cards = sortCards([
		...input.repos.flatMap((repo) => repoCards(repo, input)),
		...input.agents.filter((a) => a.state === 'failed').map((a) => launcherCard(a, input)),
	]);
	return {
		generatedAt: input.now,
		multiRepo: input.repos.length > 1,
		repos: input.repos.map(repoDisplay),
		agents: input.repos.flatMap((repo) => repoLaunchers(repo, input.agents)),
		cards,
		counts: countLanes(cards),
		activity: input.activity,
	};
}

function repoCards(repo: RepoState, input: QueueModelInput): CardDisplay[] {
	const goodTickets = repo.tickets.flatMap((t) => (t.parsed.ok ? [t.parsed.value] : []));
	return repo.tickets.map((entry) =>
		entry.parsed.ok ? ticketCard(entry.parsed.value, repo, goodTickets, input) : degradedCard(entry, repo),
	);
}

function staleWorkerMinutes(repo: RepoState, input: QueueModelInput): number {
	return (
		repo.orchestrator?.staleWorkerMinutes ?? repo.config?.staleWorkerMinutes ?? input.settings.staleWorkerMinutesDefault
	);
}

/**
 * The empty/default shape every card variant overrides. DisplayState is
 * immutable by contract (it crosses postMessage), so the shared empty
 * arrays here are safe.
 */
const CARD_DEFAULTS: Omit<CardDisplay, 'id' | 'repoRoot' | 'repoName'> = {
	kind: 'ticket',
	ticket: null,
	title: '',
	url: null,
	phase: null,
	health: 'error',
	headline: '',
	lane: 'needs-you',
	reason: null,
	priorityRank: REASON_RANK.degraded,
	waiting: null,
	blockers: [],
	prs: [],
	subTickets: [],
	history: [],
	ackControl: { actionable: false, chip: null },
	worker: null,
	degraded: null,
	rawJson: null,
	epicSlug: null,
	updatedAt: '',
	hiddenByDefault: false,
};

function cardDefaults(id: string, repo: { repoRoot: string; name: string }): CardDisplay {
	return { ...CARD_DEFAULTS, id, repoRoot: repo.repoRoot, repoName: repo.name };
}

interface TicketDerivation {
	ackCtx: AckContext;
	laneCtx: LaneContext;
	lane: Lane;
	reason: NeedsYouReason | null;
	ticketAcks: RepoState['acks'];
}

function ackContextFor(repo: RepoState, input: QueueModelInput): AckContext {
	return {
		orchestrator: repo.orchestrator,
		launch: repo.launch,
		staleWorkerMinutes: staleWorkerMinutes(repo, input),
		now: input.now,
	};
}

function deriveTicket(
	ticket: TicketFile,
	repo: RepoState,
	repoTickets: TicketFile[],
	input: QueueModelInput,
): TicketDerivation {
	const ackCtx = ackContextFor(repo, input);
	const ticketAcks = repo.acks.filter((k) => k.ack.ticket === ticket.ticket);
	const laneCtx: LaneContext = {
		staleWorkerMinutes: ackCtx.staleWorkerMinutes,
		now: input.now,
		enrichment: repo.enrichment,
		freshAckPending: hasFreshPendingAck(ticket, ticketAcks, ackCtx),
		staleAck: hasStaleAck(ticket, ticketAcks, ackCtx),
		prRows: buildPrRows(ticket, repoTickets, repo.enrichment),
	};
	const { lane, reason } = assignLane(ticket, laneCtx);
	return { ackCtx, laneCtx, lane, reason, ticketAcks };
}

function rankFor(d: TicketDerivation): number {
	if (d.reason) return REASON_RANK[d.reason];
	return d.lane === 'waiting' ? 50 : 90;
}

function ticketCard(
	ticket: TicketFile,
	repo: RepoState,
	repoTickets: TicketFile[],
	input: QueueModelInput,
): CardDisplay {
	const d = deriveTicket(ticket, repo, repoTickets, input);
	return {
		...cardDefaults(`${repo.repoRoot}::${ticket.ticket}`, { repoRoot: repo.repoRoot, name: repo.name }),
		...ticketIdentity(ticket),
		lane: d.lane,
		reason: d.reason,
		priorityRank: rankFor(d),
		waiting: waitingDisplay(ticket, input.now),
		prs: d.laneCtx.prRows,
		ackControl: deriveAckControl(ticket, d.ticketAcks, d.ackCtx),
		worker: workerDisplay(ticket, d.laneCtx),
		hiddenByDefault: d.lane === 'quiet' && isPastRetention(ticket.updatedAt, input),
	};
}

type TicketIdentityFields = Pick<
	CardDisplay,
	| 'ticket'
	| 'title'
	| 'url'
	| 'phase'
	| 'health'
	| 'headline'
	| 'blockers'
	| 'subTickets'
	| 'history'
	| 'epicSlug'
	| 'updatedAt'
>;

function ticketIdentity(ticket: TicketFile): TicketIdentityFields {
	return {
		ticket: ticket.ticket,
		title: ticket.title,
		url: ticket.url,
		phase: ticket.phase,
		health: ticket.health,
		headline: ticket.headline,
		blockers: ticket.blockers,
		subTickets: ticket.subTickets,
		history: ticket.history,
		epicSlug: ticket.slug,
		updatedAt: ticket.updatedAt,
	};
}

function waitingDisplay(ticket: TicketFile, now: number): WaitingDisplay | null {
	const w = ticket.waitingOn;
	if (!w) return null;
	const sinceMs = Date.parse(w.since);
	return {
		kind: w.kind,
		ref: w.ref,
		pr: w.pr,
		since: w.since,
		durationMs: Number.isNaN(sinceMs) ? 0 : Math.max(0, now - sinceMs),
		detail: w.detail,
	};
}

function workerDisplay(ticket: TicketFile, ctx: LaneContext): WorkerDisplay | null {
	const w = ticket.worker;
	if (!w) return null;
	const beatMs = w.heartbeatAt ? Date.parse(w.heartbeatAt) : NaN;
	return {
		status: w.status,
		heartbeatAt: w.heartbeatAt,
		heartbeatAgeMs: Number.isNaN(beatMs) ? null : Math.max(0, ctx.now - beatMs),
		stale: isWorkerStale(w, ctx.staleWorkerMinutes, ctx.now),
	};
}

function isPastRetention(updatedAt: string, input: QueueModelInput): boolean {
	const updated = Date.parse(updatedAt);
	if (Number.isNaN(updated)) return false;
	return input.now - updated > input.settings.quietRetentionHours * 3_600_000;
}

/**
 * Corrupt / unknown-schema files degrade to a renderable card in NEEDS YOU
 * (lowest priority class) — only the operator can fix them, and hiding work
 * is the one forbidden failure (design/02-protocol.md).
 */
function degradedCard(entry: TicketEntry, repo: RepoState): CardDisplay {
	const failed = entry.parsed.ok ? null : entry.parsed;
	return {
		...cardDefaults(`${repo.repoRoot}::${entry.key}`, { repoRoot: repo.repoRoot, name: repo.name }),
		ticket: entry.key,
		title: entry.key,
		headline:
			failed?.reason === 'unknown-schema' ? 'Unknown schema version — update status-pipe.' : 'Ticket file is corrupt.',
		reason: 'degraded',
		degraded: failed ? { reason: failed.reason, detail: failed.detail } : null,
		rawJson: failed?.raw ?? null,
	};
}

function launcherCard(agent: AgentProcessState, input: QueueModelInput): CardDisplay {
	const repoName = input.repos.find((r) => r.repoRoot === agent.repoRoot)?.name ?? agent.repoRoot;
	return {
		...cardDefaults(`${agent.repoRoot}::launcher::${agent.agentId}`, { repoRoot: agent.repoRoot, name: repoName }),
		kind: 'launcher-failed',
		title: `${agent.title} launcher failing`,
		headline: agent.detail ?? `exit ${agent.lastExitCode ?? '?'} ×${agent.consecutiveFailures}`,
		reason: 'launcher-failed',
		priorityRank: REASON_RANK['launcher-failed'],
	};
}

/** Age key: oldest waitingOn.since first (the long tail is where throughput dies). */
function ageKey(card: CardDisplay): number {
	const since = card.waiting?.since ?? card.updatedAt;
	const ms = Date.parse(since);
	if (Number.isNaN(ms)) return Number.MAX_SAFE_INTEGER;
	// QUIET shows the most recently completed first.
	return card.lane === 'quiet' ? -ms : ms;
}

// Codepoint comparison, not localeCompare: tie-breaks must be identical on
// every machine regardless of locale (design/05 demands full determinism).
function byCodepoint(a: string, b: string): number {
	if (a < b) return -1;
	return a > b ? 1 : 0;
}

function sortCards(cards: CardDisplay[]): CardDisplay[] {
	return [...cards].sort(
		(a, b) =>
			LANE_ORDER[a.lane] - LANE_ORDER[b.lane] ||
			a.priorityRank - b.priorityRank ||
			ageKey(a) - ageKey(b) ||
			byCodepoint(a.repoName, b.repoName) ||
			byCodepoint(a.ticket ?? '', b.ticket ?? ''),
	);
}

function countLanes(cards: CardDisplay[]): DisplayState['counts'] {
	return {
		needsYou: cards.filter((c) => c.lane === 'needs-you').length,
		waiting: cards.filter((c) => c.lane === 'waiting').length,
		quiet: cards.filter((c) => c.lane === 'quiet' && !c.hiddenByDefault).length,
	};
}

function repoDisplay(repo: RepoState): RepoDisplay {
	return {
		repoRoot: repo.repoRoot,
		name: repo.name,
		forgeId: repo.forgeId,
		capabilities: repo.capabilities,
		lastPassFinishedAt: repo.orchestrator?.lastPassFinishedAt ?? null,
		parked: repo.orchestrator?.parked ?? null,
		monitorOnlyNote: repo.monitorOnly ? `worktree of ${repo.name} — supervision disabled` : null,
		ticketCount: repo.tickets.length,
		inventoryLabel: repo.config?.inventoryLabel ?? 'agent-queue',
		issuesUrl: repo.issuesUrl,
	};
}

/**
 * One launcher row per declared launch config, joined with live supervisor
 * state; plus any live runner whose config was removed from launch.json
 * (kept until it stops so a running agent never silently vanishes).
 */
function repoLaunchers(repo: RepoState, allLive: AgentProcessState[]): AgentDisplay[] {
	// A worktree opened without its primary is monitor-only — supervision is
	// disabled, so offering Run/Stop controls there would be a lie.
	if (repo.monitorOnly) return [];
	const live = allLive.filter((a) => a.repoRoot === repo.repoRoot);
	const declared = repo.launch?.agents ?? [];
	const declaredIds = new Set(declared.map((d) => d.id));
	const fromDeclared = declared.map((d) => launcherDisplay(repo, d, live.find((a) => a.agentId === d.id) ?? null));
	const orphans = live.filter((a) => !declaredIds.has(a.agentId)).map((a) => orphanLauncher(repo, a));
	return [...fromDeclared, ...orphans];
}

type RuntimeFields = Pick<
	AgentDisplay,
	'installed' | 'state' | 'nextTickAt' | 'runningSince' | 'lastOutputAt' | 'consecutiveFailures' | 'detail' | 'activity'
>;

/** Runtime fields from the live runner, or the stopped/not-installed defaults. */
function runtimeFields(live: AgentProcessState | null): RuntimeFields {
	if (!live) {
		return {
			installed: false,
			state: 'stopped',
			nextTickAt: null,
			runningSince: null,
			lastOutputAt: null,
			consecutiveFailures: 0,
			detail: null,
			activity: emptyActivity(),
		};
	}
	const { state, nextTickAt, runningSince, lastOutputAt, consecutiveFailures, detail, activity } = live;
	return { installed: true, state, nextTickAt, runningSince, lastOutputAt, consecutiveFailures, detail, activity };
}

function launcherDisplay(repo: RepoState, declared: LaunchAgent, live: AgentProcessState | null): AgentDisplay {
	return {
		repoRoot: repo.repoRoot,
		repoName: repo.name,
		agentId: declared.id,
		title: declared.title,
		mode: declared.mode,
		intervalMinutes: declared.mode === 'tick' ? declared.intervalMinutes : null,
		...runtimeFields(live),
	};
}

function orphanLauncher(repo: RepoState, live: AgentProcessState): AgentDisplay {
	return {
		repoRoot: repo.repoRoot,
		repoName: repo.name,
		agentId: live.agentId,
		title: live.title,
		mode: live.mode,
		intervalMinutes: null,
		...runtimeFields(live),
	};
}
