/**
 * Assembles the planner's real ports and runs one pass. This is the seam the
 * extension (in-process, via the built-in launch entry) and the future
 * standalone CLI share: both hand in a forge inventory + protocol dir + repo
 * root + config, and get back the same PlanResult plan() produces under test.
 * vscode-free — the host resolves forge auth and hands in the ForgeInventory.
 */

import * as path from 'path';

import { ForgeInventory } from '../forge/types';
import { ConfigFile } from '../protocol/types';
import { createEpicsPort } from './epicsIo';
import { forgeInventoryPort } from './forgeInventory';
import { createGitPort } from './gitWorktree';
import { plan } from './plan';
import { Clock, PlannerPorts } from './ports';
import { createProtocolReadPort, createProtocolWritePort } from './protocolIo';
import { PlanResult, PlannerConfig, PlannerInput } from './types';

/** Matches the old `claude -p /status-pipe:tick --max-concurrent 3` default. */
export const DEFAULT_MAX_CONCURRENT = 3;

export interface PlannerPassArgs {
	/** Repo identity (`owner/name`) stamped into freshly-minted ticket files. */
	repo: string;
	/** Absolute primary checkout — worktrees and the epics dir resolve against it. */
	repoRoot: string;
	/** Absolute `.status-pipe/` directory. */
	protocolDir: string;
	inventory: ForgeInventory;
	config: ConfigFile | null;
	liveWorkerKeys: string[];
	maxConcurrent?: number;
	/** Injectable for deterministic tests; defaults to the system clock. */
	clock?: Clock;
}

const DEFAULT_STALE_WORKER_MINUTES = 30;

/** Map the committed config (or defaults) onto the planner's config, paths resolved. */
export function plannerConfigFromFile(config: ConfigFile | null, repoRoot: string): PlannerConfig {
	// A non-null ConfigFile already carries parse-applied defaults for every
	// field except staleWorkerMinutes (which is nullable on disk).
	if (!config) {
		return {
			epicsDir: path.resolve(repoRoot, 'epics'),
			inventoryLabel: 'agent-queue',
			inventoryAssignees: [],
			trustMode: null,
			trustOperators: [],
			staleWorkerMinutes: DEFAULT_STALE_WORKER_MINUTES,
		};
	}
	return {
		epicsDir: path.resolve(repoRoot, config.epicsDir),
		inventoryLabel: config.inventoryLabel,
		inventoryAssignees: config.inventoryAssignees,
		trustMode: config.trustMode,
		trustOperators: config.trustOperators,
		staleWorkerMinutes: config.staleWorkerMinutes ?? DEFAULT_STALE_WORKER_MINUTES,
	};
}

export function buildPlannerPorts(args: PlannerPassArgs): PlannerPorts {
	return {
		inventory: forgeInventoryPort(args.inventory),
		epics: createEpicsPort(),
		read: createProtocolReadPort(args.protocolDir),
		write: createProtocolWritePort(args.protocolDir),
		git: createGitPort(args.repoRoot),
		clock: args.clock ?? systemClock(),
	};
}

export function runPlannerPass(args: PlannerPassArgs): Promise<PlanResult> {
	const input: PlannerInput = {
		repo: args.repo,
		config: plannerConfigFromFile(args.config, args.repoRoot),
		maxConcurrent: args.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
		liveWorkerKeys: args.liveWorkerKeys,
	};
	return plan(input, buildPlannerPorts(args));
}

/** A concise, operator-readable digest of what the pass did, for the run log. */
export function formatPlanReport(result: PlanResult): string {
	const r = result.report;
	if (r.refusedReason) return `[planner] refused: ${r.refusedReason}\n`;
	const parts = [
		`dispatched ${r.dispatched.length}`,
		`deferred ${r.deferred.length}`,
		`acks consumed ${r.consumedAcks.length}`,
		`stale reconciled ${r.staleReconciled.length}`,
		`tracking tickets created ${r.createdTrackingTickets.length}`,
	];
	// Surface dropped acks only when there are any — the operator sent these and
	// has no other view of them, but a clean pass shouldn't carry the noise.
	if (r.supersededAcks.length > 0) parts.push(`acks superseded ${r.supersededAcks.length}`);
	if (r.orphanedAcks.length > 0) parts.push(`acks orphaned ${r.orphanedAcks.length}`);
	const parked = r.parked ? ` — parked: ${r.parked.reason}` : '';
	return `[planner] ${parts.join(', ')}${parked}\n`;
}

function systemClock(): Clock {
	return { now: () => Date.now(), iso: () => new Date().toISOString() };
}
