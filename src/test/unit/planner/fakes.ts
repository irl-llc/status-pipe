/**
 * In-memory fakes for the planner ports (src/planner/ports.ts), plus small
 * builders. Everything is deterministic: the clock is a fixed number and
 * `iso()` derives from it, so stamping/parking timestamps are exact.
 */

import { OrchestratorFile, TicketFile } from '../../../protocol/types';
import {
	EpicSpec,
	InventoryTicket,
	PlannerPorts,
	ProtocolReadPort,
	ProtocolWritePort,
	StoredAck,
	TicketState,
} from '../../../planner/ports';
import { PlannerConfig, PlannerInput } from '../../../planner/types';

export const NOW = Date.parse('2026-06-26T12:00:00Z');

export function minutesAgo(min: number): string {
	return new Date(NOW - min * 60_000).toISOString();
}

export function makeTicket(over: Partial<TicketFile> = {}): TicketFile {
	return {
		schemaVersion: 1,
		repo: 'acme/app',
		ticket: '1',
		title: 'Ticket 1',
		slug: null,
		url: null,
		phase: 'implementation',
		health: 'ok',
		headline: '',
		waitingOn: null,
		prs: [],
		blockers: [],
		subTickets: [],
		agentCommentIds: [],
		history: [],
		worker: null,
		updatedAt: minutesAgo(5),
		...over,
	};
}

export function makeInventoryTicket(over: Partial<InventoryTicket> & Pick<InventoryTicket, 'key'>): InventoryTicket {
	return { title: `Ticket ${over.key}`, url: null, author: 'ed', assignees: ['ed'], ...over };
}

export function makeConfig(over: Partial<PlannerConfig> = {}): PlannerConfig {
	return {
		epicsDir: 'epics',
		inventoryLabel: 'agent-queue',
		inventoryAssignees: [],
		trustMode: 'single-maintainer',
		trustOperators: ['ed'],
		staleWorkerMinutes: 30,
		...over,
	};
}

interface InputOver {
	repo?: string;
	config?: Partial<PlannerConfig>;
	maxConcurrent?: number;
	liveWorkerKeys?: string[];
}

export function makeInput(over: InputOver = {}): PlannerInput {
	return {
		repo: over.repo ?? 'acme/app',
		config: makeConfig(over.config),
		maxConcurrent: over.maxConcurrent ?? 3,
		liveWorkerKeys: over.liveWorkerKeys ?? [],
	};
}

/** A single class implementing every port over shared in-memory state. */
export class FakePorts implements PlannerPorts {
	nowMs = NOW;
	visibilityValue: 'public' | 'private' = 'private';
	visibilityThrows = false;
	viewer: string | null = 'ed';
	viewerThrows = false;
	labeled: InventoryTicket[] = [];
	/** Per-key forge state for getTicketStates (the lifecycle reconcile input). */
	ticketStates = new Map<string, TicketState>();
	ticketStatesThrows = false;
	existingTracking = new Map<string, InventoryTicket>();
	createdTickets: { title: string; label: string }[] = [];
	epicSpecs: EpicSpec[] = [];
	headerWrites: { path: string; key: string; url: string | null }[] = [];
	tickets = new Map<string, TicketFile>();
	orchestrator: OrchestratorFile | null = null;
	acks: StoredAck[] = [];
	ticketWrites: { key: string; ticket: TicketFile }[] = [];
	orchestratorWrites: OrchestratorFile[] = [];
	deletedAcks: string[] = [];
	worktreeSlugs: string[] = [];
	private trackingSeq = 0;

	clock = { now: () => this.nowMs, iso: () => new Date(this.nowMs).toISOString() };

	inventory = {
		visibility: async (): Promise<'public' | 'private'> => {
			if (this.visibilityThrows) throw new Error('visibility unavailable');
			return this.visibilityValue;
		},
		viewerLogin: async (): Promise<string | null> => {
			if (this.viewerThrows) throw new Error('viewer identity unavailable');
			return this.viewer;
		},
		listLabeledTickets: async (): Promise<InventoryTicket[]> => this.labeled,
		getTicketStates: async (keys: string[]): Promise<Map<string, TicketState>> => {
			if (this.ticketStatesThrows) throw new Error('issue-state lookup unavailable');
			return new Map(keys.flatMap((k) => (this.ticketStates.has(k) ? [[k, this.ticketStates.get(k)!]] : [])));
		},
		findTrackingTicket: async (title: string): Promise<InventoryTicket | null> =>
			this.existingTracking.get(title) ?? null,
		createTrackingTicket: async (title: string, label: string): Promise<InventoryTicket> => {
			this.createdTickets.push({ title, label });
			return makeInventoryTicket({ key: `epic-${++this.trackingSeq}`, title, url: `u/${this.trackingSeq}` });
		},
	};

	epics = {
		list: async (): Promise<EpicSpec[]> => this.epicSpecs,
		writeTrackingHeader: async (path: string, key: string, url: string | null): Promise<void> => {
			this.headerWrites.push({ path, key, url });
			const spec = this.epicSpecs.find((s) => s.path === path);
			if (spec) spec.trackingTicket = key;
		},
	};

	read: ProtocolReadPort = {
		listTicketKeys: async (): Promise<string[]> => [...this.tickets.keys()],
		readTicket: async (key: string): Promise<TicketFile | null> => this.tickets.get(key) ?? null,
		readOrchestrator: async (): Promise<OrchestratorFile | null> => this.orchestrator,
		listAcks: async (): Promise<StoredAck[]> => this.acks,
	};

	write: ProtocolWritePort = {
		writeTicket: async (key: string, ticket: TicketFile): Promise<void> => {
			this.tickets.set(key, ticket);
			this.ticketWrites.push({ key, ticket });
		},
		writeOrchestrator: async (file: OrchestratorFile): Promise<void> => {
			this.orchestrator = file;
			this.orchestratorWrites.push(file);
		},
		deleteAck: async (path: string): Promise<void> => {
			this.acks = this.acks.filter((a) => a.path !== path);
			this.deletedAcks.push(path);
		},
	};

	failWorktreeSlug: string | null = null;

	git = {
		ensureWorktree: async (slug: string): Promise<string> => {
			if (slug === this.failWorktreeSlug) throw new Error(`git worktree add failed for ${slug}`);
			this.worktreeSlugs.push(slug);
			return `/wt/${slug}`;
		},
	};
}
