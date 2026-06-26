/**
 * The planner: one deterministic orchestration pass (plugin/commands/tick.md).
 * Pure and vscode-free — all I/O is through PlannerPorts — so the same logic
 * runs in-process in the extension and, later, in the standalone CLI, and is
 * unit-tested end-to-end with in-memory fakes.
 *
 * Sequence: trust gate → inventory → consume acks → reconcile staleness →
 * fair-schedule + dispatch → parked + orchestrator wrap.
 */

import { DispatchPlan, TicketFile, TrustMode } from '../protocol/types';
import { consumeAcks } from './acks';
import { Candidate, dedupeCandidates, discoverEpics, discoverTickets } from './inventory';
import { PlannerPorts } from './ports';
import { computeParked, PassState, reconcileStaleness, selectAndDispatch, writeOrchestrator } from './schedule';
import { resolveTrust } from './trust';
import { PlannerInput, PlanReport, PlanResult, TrustResolution } from './types';

function emptyReport(): PlanReport {
	return {
		refusedReason: null,
		consumedAcks: [],
		supersededAcks: [],
		orphanedAcks: [],
		staleReconciled: [],
		createdTrackingTickets: [],
		dispatched: [],
		deferred: [],
		parked: null,
	};
}

async function safeVisibility(ports: PlannerPorts): Promise<'public' | 'private'> {
	try {
		return await ports.inventory.visibility();
	} catch {
		return 'public'; // fail closed
	}
}

async function safeViewerLogin(ports: PlannerPorts): Promise<string | null> {
	try {
		return await ports.inventory.viewerLogin();
	} catch {
		return null; // resolveTrust turns null into a clean 'no resolvable operator' refusal
	}
}

async function resolveTrustGate(input: PlannerInput, ports: PlannerPorts): Promise<TrustResolution> {
	const visibility = await safeVisibility(ports);
	const { trustMode, trustOperators } = input.config;
	// viewerLogin is consulted ONLY for the private-repo/no-mode default and is a
	// network read like visibility — fetch it lazily, and fail soft so a forge
	// hiccup becomes a clean refusal in resolveTrust rather than a crashed pass.
	const viewerLogin = !trustMode && visibility === 'private' ? await safeViewerLogin(ports) : null;
	return resolveTrust({ visibility, viewerLogin, trustMode, trustOperators });
}

async function buildCandidates(
	input: PlannerInput,
	ports: PlannerPorts,
	trust: { mode: TrustMode; operators: string[] },
	report: PlanReport,
): Promise<Candidate[]> {
	const { epicsDir, inventoryLabel, inventoryAssignees } = input.config;
	const epics = await discoverEpics(ports, epicsDir, inventoryLabel, report);
	const tickets = await discoverTickets(ports, inventoryLabel, trust, inventoryAssignees);
	return dedupeCandidates(epics, tickets);
}

async function loadTickets(ports: PlannerPorts): Promise<Map<string, TicketFile>> {
	// Reads are independent — load them concurrently, not one round-trip at a
	// time. Order is irrelevant (a Map), so no determinism concern here.
	const keys = await ports.read.listTicketKeys();
	const tickets = await Promise.all(keys.map((key) => ports.read.readTicket(key)));
	const map = new Map<string, TicketFile>();
	for (let i = 0; i < keys.length; i++) {
		const ticket = tickets[i];
		if (ticket) map.set(keys[i], ticket);
	}
	return map;
}

async function wrapPass(
	state: PassState,
	candidates: Candidate[],
	dispatch: DispatchPlan | null,
	startedAt: string,
): Promise<void> {
	state.report.parked = computeParked(state, candidates);
	await writeOrchestrator(state.ports, {
		prev: await state.ports.read.readOrchestrator(),
		repo: state.input.repo,
		dispatch,
		parked: state.report.parked,
		staleWorkerMinutes: state.input.config.staleWorkerMinutes,
		startedAt,
	});
}

export async function plan(input: PlannerInput, ports: PlannerPorts): Promise<PlanResult> {
	const startedAt = ports.clock.iso(); // captured first — the pass START, not its wrap time
	const report = emptyReport();
	const trust = await resolveTrustGate(input, ports);
	if (!trust.ok) {
		report.refusedReason = trust.reason;
		return { dispatch: null, report };
	}
	const candidates = await buildCandidates(input, ports, trust, report);
	const consumed = await consumeAcks(ports, report);
	const state: PassState = { ports, input, tickets: await loadTickets(ports), consumed, report };
	await reconcileStaleness(state);
	const dispatch = await selectAndDispatch(state, candidates);
	await wrapPass(state, candidates, dispatch, startedAt);
	return { dispatch, report };
}
