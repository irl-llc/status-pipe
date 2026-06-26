/**
 * Ports the planner depends on (design/09-launch-and-supervision.md). The
 * planner core is pure and vscode-free: every side effect — forge/ticket
 * inventory, protocol-file reads and writes, git worktrees, the clock — is an
 * injected interface so the same module runs in-process in the extension and,
 * later, in the standalone CLI, and is exercised under test with in-memory
 * fakes.
 *
 * This is the seam where the extension becomes a protocol-file *writer*
 * (stamping `worker.status`, consuming acks, writing `orchestrator.json`),
 * which design/09 previously reserved to the agent side. Every write is an
 * atomic whole-file rewrite, matching the plugin's discipline.
 */

import { AckFile, OrchestratorFile, TicketFile } from '../protocol/types';

/** A ticket discovered in the forge inventory (a labeled issue, or an epic's tracking ticket). */
export interface InventoryTicket {
	key: string;
	title: string;
	url: string | null;
	/** Issue author login; null when the forge doesn't report it. */
	author: string | null;
	/** Assignee logins (may be empty). */
	assignees: string[];
}

/** An epic spec on disk and the tracking ticket its header points at (null = none yet). */
export interface EpicSpec {
	slug: string;
	/** Absolute path to the spec file — also the worker's `work-epic` argument. */
	path: string;
	title: string;
	trackingTicket: string | null;
}

/** An ack file on disk, paired with the path so the planner can consume (delete) it. */
export interface StoredAck {
	path: string;
	ack: AckFile;
}

/**
 * The forge/ticketing inventory. Read-only except `createTrackingTicket`, the
 * one place the planner mints a forge artifact (an epic's tracking issue).
 */
export interface InventoryPort {
	/** Repo visibility for the trust gate. Failure is treated as `public` (fail closed). */
	visibility(): Promise<'public' | 'private'>;
	/** The authenticated operator login, for the private-repo single-maintainer default. */
	viewerLogin(): Promise<string | null>;
	/** Open tickets carrying the inventory label (ticket mode). */
	listLabeledTickets(label: string): Promise<InventoryTicket[]>;
	/** An existing tracking ticket whose title matches, or null. */
	findTrackingTicket(title: string): Promise<InventoryTicket | null>;
	/** Create a tracking ticket carrying the inventory label; returns its key/url. */
	createTrackingTicket(title: string, label: string): Promise<InventoryTicket>;
}

/** Epic specs on disk (epic mode). */
export interface EpicsPort {
	/** Specs under `epicsDir`, each with its current tracking-ticket header. */
	list(epicsDir: string): Promise<EpicSpec[]>;
	/** Write the `> **Tracking ticket:**` header back into a spec file. */
	writeTrackingHeader(path: string, key: string, url: string | null): Promise<void>;
}

/** Reads protocol state under `.status-pipe/`. */
export interface ProtocolReadPort {
	listTicketKeys(): Promise<string[]>;
	readTicket(key: string): Promise<TicketFile | null>;
	readOrchestrator(): Promise<OrchestratorFile | null>;
	listAcks(): Promise<StoredAck[]>;
}

/** Mutates protocol state. Every write is an atomic whole-file rewrite. */
export interface ProtocolWritePort {
	writeTicket(key: string, ticket: TicketFile): Promise<void>;
	writeOrchestrator(file: OrchestratorFile): Promise<void>;
	/** Delete a consumed ack file (history is appended to the ticket first). */
	deleteAck(path: string): Promise<void>;
}

/** Git worktree management for work items. */
export interface GitPort {
	/** Ensure a worktree for `slug` exists; returns its absolute path (its cwd). */
	ensureWorktree(slug: string): Promise<string>;
}

/** Injected clock so passes are deterministic under test. */
export interface Clock {
	now(): number;
	/** The same instant as an ISO-8601 string (`updatedAt`, history timestamps). */
	iso(): string;
}

/** Everything the planner needs to reach the outside world. */
export interface PlannerPorts {
	inventory: InventoryPort;
	epics: EpicsPort;
	read: ProtocolReadPort;
	write: ProtocolWritePort;
	git: GitPort;
	clock: Clock;
}
