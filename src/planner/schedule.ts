/**
 * Staleness reconcile (Step 3), fair-schedule + stamp + worktree + dispatch
 * (Step 4), and the parked declaration + orchestrator wrap (Step 5) from
 * plugin/commands/tick.md. All deterministic given the loaded ticket map and
 * the supervisor's live-worker set.
 */

import {
	DispatchItem,
	DispatchPlan,
	OrchestratorFile,
	ParkedState,
	Phase,
	TicketFile,
	WaitingKind,
	WorkerState,
} from '../protocol/types';
import { isWorkerStale } from '../protocol/worker';
import { ConsumedAcks } from './acks';
import { Candidate } from './inventory';
import { PlannerPorts } from './ports';
import { PlannerInput, PlanReport } from './types';

const SIX_HOURS_MS = 6 * 60 * 60_000;
const TERMINAL: Phase[] = ['merged', 'abandoned'];

/** Everything one pass threads through the schedule steps. */
export interface PassState {
	ports: PlannerPorts;
	input: PlannerInput;
	tickets: Map<string, TicketFile>;
	consumed: ConsumedAcks;
	report: PlanReport;
}

// --- Step 3: staleness reconcile -------------------------------------------

function asReconciled(ticket: TicketFile, iso: string, staleMinutes: number): TicketFile {
	const note = `worker presumed crashed (heartbeat stale > ${staleMinutes}m); eligible for relaunch`;
	return {
		...ticket,
		worker: { ...(ticket.worker as WorkerState), status: 'error' },
		history: [...ticket.history, { at: iso, phase: ticket.phase, note, runId: null }],
		updatedAt: iso,
	};
}

export async function reconcileStaleness(state: PassState): Promise<void> {
	const now = state.ports.clock.now();
	const iso = state.ports.clock.iso();
	const stale = state.input.config.staleWorkerMinutes;
	// Staleness recovery is ONLY for a ticket the supervisor is NOT running (a
	// crash between stamp and spawn, or the extension down) — design/09. A worker
	// the supervisor reports live but whose on-disk heartbeat has aged (a long
	// build/review wait) is alive: marking it crashed would lie on the card and
	// race the worker's own writes (the one-writer-per-ticket invariant).
	const live = new Set(state.input.liveWorkerKeys);
	for (const [key, ticket] of state.tickets) {
		if (live.has(key)) continue;
		// Shared predicate (src/protocol/worker.ts) — the planner and the card MUST
		// agree on what "crashed" means, including a running worker with no heartbeat.
		if (!isWorkerStale(ticket.worker, stale, now)) continue;
		const updated = asReconciled(ticket, iso, stale);
		state.tickets.set(key, updated);
		await state.ports.write.writeTicket(key, updated);
		state.report.staleReconciled.push(key);
	}
}

// --- Step 4: fair-schedule + dispatch --------------------------------------

interface Selectable {
	candidate: Candidate;
	ticket: TicketFile | undefined;
	ackConsumed: boolean;
}

function eligible(ticket: TicketFile | undefined, ackConsumed: boolean): boolean {
	if (!ticket) return true; // no file yet ⇒ planning, eligible
	if (TERMINAL.includes(ticket.phase)) return false;
	// The operator gate (tick.md Step 4): a waiting/blocked ticket is NOT
	// dispatched unless an ack was consumed for it — even right after staleness
	// reconcile flips its crashed worker to 'error'. So a worker that crashed
	// while the ticket was waiting on the operator escalates on the card (status
	// error) but is deliberately NOT auto-relaunched until the operator acks.
	const idle = ticket.health === 'waiting' || ticket.health === 'blocked';
	return !idle || ackConsumed;
}

function updatedAtMs(ticket: TicketFile | undefined): number {
	const ms = ticket ? Date.parse(ticket.updatedAt) : 0;
	return Number.isNaN(ms) ? 0 : ms; // missing/unparseable ⇒ oldest
}

function selectable(state: PassState, candidates: Candidate[]): Selectable[] {
	const live = new Set(state.input.liveWorkerKeys);
	return candidates
		.filter((c) => !live.has(c.key))
		.map((c) => ({ candidate: c, ticket: state.tickets.get(c.key), ackConsumed: state.consumed.has(c.key) }))
		.filter((s) => eligible(s.ticket, s.ackConsumed));
}

function ordered(items: Selectable[]): Selectable[] {
	return [...items].sort((a, b) => {
		const ack = Number(b.ackConsumed) - Number(a.ackConsumed); // ack-consumers first
		return ack !== 0 ? ack : updatedAtMs(a.ticket) - updatedAtMs(b.ticket);
	});
}

/** Fresh empties so two minted tickets never alias the same array. */
function blankTicketFields(): Omit<TicketFile, 'repo' | 'ticket' | 'title' | 'url' | 'updatedAt'> {
	return {
		schemaVersion: 1,
		slug: null,
		phase: 'planning',
		health: 'ok',
		headline: '',
		waitingOn: null,
		prs: [],
		blockers: [],
		subTickets: [],
		agentCommentIds: [],
		history: [],
		worker: null,
	};
}

function newTicket(candidate: Candidate, repo: string, iso: string): TicketFile {
	return {
		...blankTicketFields(),
		repo,
		ticket: candidate.key,
		title: candidate.title,
		url: candidate.url,
		updatedAt: iso,
	};
}

function stamped(existing: TicketFile | undefined, candidate: Candidate, repo: string, iso: string): TicketFile {
	const base = existing ?? newTicket(candidate, repo, iso);
	return { ...base, worker: { status: 'running', taskId: null, startedAt: iso, heartbeatAt: iso }, updatedAt: iso };
}

function promptFor(candidate: Candidate, ackNote: string | null): string {
	const base =
		candidate.kind === 'epic'
			? `/status-pipe:work-epic ${candidate.epicPath}`
			: `/status-pipe:work-ticket ${candidate.key}`;
	return ackNote ? `${base} Operator ack note: "${ackNote}"` : base;
}

async function dispatchOne(state: PassState, s: Selectable): Promise<DispatchItem> {
	const iso = state.ports.clock.iso();
	// Provision the worktree BEFORE marking the ticket running. If git fails the
	// other way round, the ticket is left stamped 'running' with no worker — a
	// zombie that blocks the key until staleness reconcile. (selectAndDispatch
	// also catches a whole-item failure so it can't strand the rest of the batch.)
	const worktree = await state.ports.git.ensureWorktree(s.candidate.slug);
	await state.ports.write.writeTicket(s.candidate.key, stamped(s.ticket, s.candidate, state.input.repo, iso));
	const ackNote = state.consumed.get(s.candidate.key) ?? null;
	return { key: s.candidate.key, kind: s.candidate.kind, prompt: promptFor(s.candidate, ackNote), worktree };
}

export async function selectAndDispatch(state: PassState, candidates: Candidate[]): Promise<DispatchPlan | null> {
	const free = Math.max(0, state.input.maxConcurrent - state.input.liveWorkerKeys.length);
	const ranked = ordered(selectable(state, candidates));
	state.report.deferred.push(...ranked.slice(free).map((s) => s.candidate.key));
	const items: DispatchItem[] = [];
	for (const s of ranked.slice(0, free)) {
		// One item's git/IO failure must NOT abort the pass: that would skip the
		// orchestrator wrap and strand the items already stamped this pass with no
		// dispatch plan written. Defer the failed key (it stays a candidate, retried
		// next pass) and keep going so the rest still reach the supervisor.
		try {
			items.push(await dispatchOne(state, s));
		} catch {
			state.report.deferred.push(s.candidate.key);
		}
	}
	state.report.dispatched.push(...items);
	return items.length > 0 ? { maxConcurrent: state.input.maxConcurrent, items } : null;
}

// --- Step 5: parked + orchestrator wrap ------------------------------------

function park(now: number, iso: string, reason: string): ParkedState {
	return { since: iso, reason, recheckAfter: new Date(now + SIX_HOURS_MS).toISOString() };
}

/** Park only when nothing ran, nothing is queued, and nothing is in flight. */
export function computeParked(state: PassState, candidates: Candidate[]): ParkedState | null {
	const r = state.report;
	if (r.dispatched.length > 0 || r.deferred.length > 0 || r.consumedAcks.length > 0) return null;
	if (state.input.liveWorkerKeys.length > 0) return null; // work in flight
	const now = state.ports.clock.now();
	const iso = state.ports.clock.iso();
	if (candidates.length === 0) return park(now, iso, 'backlog empty — nothing tracked');
	// A merged/abandoned ticket still labeled on the forge stays a candidate but
	// is not active; drop those first.
	const active = candidates.filter((c) => !isTerminal(state.tickets.get(c.key)));
	if (active.length === 0) return park(now, iso, 'all tracked work is complete — nothing to do');
	// design/09 condition (b): park only when EVERY active item needs the operator
	// (owner/review/merge/comment per design/02, or blocked). If any is waiting on
	// the world (e.g. a `build`/CI flip), keep ticking so the loop catches it —
	// parking would freeze the loop for ~6h and falsely claim "waiting on you".
	if (!active.every((c) => operatorWaiting(state.tickets.get(c.key)))) return null;
	return park(now, iso, `${active.length} active items all waiting on you; no dispatchable work`);
}

function isTerminal(ticket: TicketFile | undefined): boolean {
	return ticket !== undefined && TERMINAL.includes(ticket.phase);
}

const OPERATOR_WAITS: WaitingKind[] = ['owner', 'review', 'merge', 'comment'];

/** True when the ticket needs the OPERATOR (vs the world, e.g. CI) — the parking predicate. */
function operatorWaiting(ticket: TicketFile | undefined): boolean {
	if (!ticket) return false; // no file ⇒ planning ⇒ would have dispatched, not parked
	if (ticket.blockers.length > 0 || ticket.phase === 'blocked') return true;
	return ticket.waitingOn !== null && OPERATOR_WAITS.includes(ticket.waitingOn.kind);
}

export interface OrchestratorArgs {
	prev: OrchestratorFile | null;
	repo: string;
	dispatch: DispatchPlan | null;
	parked: ParkedState | null;
	staleWorkerMinutes: number;
	/** ISO time the pass began (captured at plan() entry), distinct from finish. */
	startedAt: string;
}

export async function writeOrchestrator(ports: PlannerPorts, args: OrchestratorArgs): Promise<void> {
	const iso = ports.clock.iso(); // wrap = finish time
	await ports.write.writeOrchestrator({
		schemaVersion: 1,
		repo: args.repo,
		passCount: (args.prev?.passCount ?? 0) + 1,
		lastPassStartedAt: args.startedAt,
		lastPassFinishedAt: iso,
		staleWorkerMinutes: args.staleWorkerMinutes,
		parked: args.parked,
		dispatch: args.dispatch,
		note: null,
	});
}
