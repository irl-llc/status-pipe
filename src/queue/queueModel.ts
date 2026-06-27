/**
 * The queue model (design/04-architecture.md): pure derivation
 * (tickets, acks, enrichment, supervisor state, now) → DisplayState.
 * Unit-test target #1 — no I/O, no clocks, no vscode.
 */

import { emptyActivity } from '../output/claudeStream';
import { LaunchAgent, TicketFile, WORKER_ID } from '../protocol/types';
import { byCodepoint } from '../utils/ordering';
import { AckContext, deriveAckControl, hasAckedCurrentRequest, hasStaleAck, isAcked } from './ackState';
import {
	AgentDisplay,
	CardDisplay,
	DisplayState,
	Lane,
	NeedsYouReason,
	RepoDisplay,
	WaitingDisplay,
	WorkerDisplay,
	WorkerProcessDisplay,
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
		workers: workerDisplays(input),
		cards,
		counts: countLanes(cards),
		activity: input.activity,
	};
}

/** Live workers joined with repo names; worktree-only repos are monitor-only. */
function workerDisplays(input: QueueModelInput): WorkerProcessDisplay[] {
	const names = new Map(input.repos.map((r) => [r.repoRoot, r.name]));
	return input.workers
		.filter((w) => names.has(w.repoRoot))
		.map((w) => ({
			repoRoot: w.repoRoot,
			repoName: names.get(w.repoRoot) ?? w.repoRoot,
			key: w.key,
			runningSince: w.runningSince,
			lastOutputAt: w.lastOutputAt,
			activity: w.activity,
		}));
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
	acked: false,
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
	acked: boolean;
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
		requestAcked: hasAckedCurrentRequest(ticket, ticketAcks, ackCtx),
		staleAck: hasStaleAck(ticket, ticketAcks, ackCtx),
		prRows: buildPrRows(ticket, repoTickets, repo.enrichment),
	};
	const { lane, reason } = assignLane(ticket, laneCtx);
	// "Acked" is the calm WAITING state: a pending or still-matching picked-up ack
	// moved the card out of NEEDS YOU — the operator handed it back and it's the
	// agent's turn (#57). NEEDS YOU keeps its alarm (the ack didn't park it);
	// QUIET keeps its own done/abandoned treatment (issue #10).
	const acked = lane === 'waiting' && isAcked(ticket, ticketAcks, ackCtx);
	return { ackCtx, laneCtx, lane, reason, acked, ticketAcks };
}

/**
 * Within WAITING, an ack'd card (operator handed it back, awaiting pickup)
 * sinks below un-ack'd waiting work: the operator has already done their part,
 * so it should not sit at the top reading as a fresh call to action (issue #10).
 */
const WAITING_RANK = 50;
const ACKED_WAITING_RANK = 60;

function rankFor(d: TicketDerivation): number {
	if (d.reason) return REASON_RANK[d.reason];
	if (d.lane === 'quiet') return 90;
	return d.acked ? ACKED_WAITING_RANK : WAITING_RANK;
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
		...derivedCardFields(ticket, d, input),
	};
}

/** The fields driven by lane/ack derivation (kept separate to keep ticketCard small). */
function derivedCardFields(
	ticket: TicketFile,
	d: TicketDerivation,
	input: QueueModelInput,
): Pick<
	CardDisplay,
	'lane' | 'reason' | 'priorityRank' | 'waiting' | 'prs' | 'ackControl' | 'acked' | 'worker' | 'hiddenByDefault'
> {
	return {
		lane: d.lane,
		reason: d.reason,
		priorityRank: rankFor(d),
		waiting: waitingDisplay(ticket, input.now),
		prs: d.laneCtx.prRows,
		ackControl: deriveAckControl(ticket, d.ticketAcks, d.ackCtx),
		acked: d.acked,
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
		inventoryAssignees: repo.config?.inventoryAssignees ?? [],
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
	// Worker entries are templates, not runnable rows — the supervisor
	// instantiates them per dispatch item (design/09); they never get a strip row.
	const declared = (repo.launch?.agents ?? []).filter((d) => d.id !== WORKER_ID);
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
		lifetime: declared.lifetime,
		intervalMinutes: declared.lifetime === 'scheduled' ? declared.intervalMinutes : null,
		...runtimeFields(live),
	};
}

function orphanLauncher(repo: RepoState, live: AgentProcessState): AgentDisplay {
	return {
		repoRoot: repo.repoRoot,
		repoName: repo.name,
		agentId: live.agentId,
		title: live.title,
		lifetime: live.lifetime,
		intervalMinutes: null,
		...runtimeFields(live),
	};
}
