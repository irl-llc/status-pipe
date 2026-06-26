/**
 * Filesystem-backed protocol ports (design/09): the planner's read/write access
 * to `.status-pipe/`. This is the seam where the extension becomes a protocol
 * *writer* — every write is an atomic whole-file rewrite (`<file>.tmp` then
 * rename, matching ackWriter.ts), so a concurrent reader never sees a torn file.
 *
 * Ticket writes MERGE: the planner models only its own fields (worker, history,
 * phase, …), but the on-disk ticket also carries agent-owned working memory
 * (`plan`, `deadEnds`, `notes`, `stalledPasses`). We overlay the modeled fields
 * onto the current file so stamping a worker never clobbers a worker's memory.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { parseAckFile, parseOrchestratorFile, parseTicketFile } from '../protocol/parse';
import { OrchestratorFile, TicketFile } from '../protocol/types';
import { byCodepoint } from '../utils/ordering';
import { writeFileAtomic } from './fsAtomic';
import { ProtocolReadPort, ProtocolWritePort, StoredAck } from './ports';

function ticketsDir(protocolDir: string): string {
	return path.join(protocolDir, 'tickets');
}

export function createProtocolReadPort(protocolDir: string): ProtocolReadPort {
	return {
		listTicketKeys: async () => (await listJsonFiles(ticketsDir(protocolDir))).map((f) => path.basename(f, '.json')),
		readTicket: (key) => readTicket(protocolDir, key),
		readOrchestrator: () => readOrchestrator(protocolDir),
		listAcks: () => listAcks(protocolDir),
	};
}

export function createProtocolWritePort(protocolDir: string): ProtocolWritePort {
	return {
		writeTicket: (key, ticket) => writeTicket(protocolDir, key, ticket),
		writeOrchestrator: (file) => writeJsonAtomic(path.join(protocolDir, 'orchestrator.json'), { ...file }),
		deleteAck: (target) => unlinkIfPresent(target),
	};
}

async function readTicket(protocolDir: string, key: string): Promise<TicketFile | null> {
	const raw = await readFileOrNull(path.join(ticketsDir(protocolDir), `${key}.json`));
	if (raw === null) return null;
	const parsed = parseTicketFile(raw, key);
	return parsed.ok ? parsed.value : null;
}

async function readOrchestrator(protocolDir: string): Promise<OrchestratorFile | null> {
	const raw = await readFileOrNull(path.join(protocolDir, 'orchestrator.json'));
	if (raw === null) return null;
	const parsed = parseOrchestratorFile(raw);
	return parsed.ok ? parsed.value : null;
}

async function listAcks(protocolDir: string): Promise<StoredAck[]> {
	const dirs = await listSubdirs(path.join(protocolDir, 'inbox'));
	const nested = await Promise.all(dirs.map(acksInDir));
	// Sort by path in CODEPOINT order (byCodepoint, not localeCompare): readdir
	// order is filesystem-dependent and locale collation is host-dependent, but
	// consumeAcks relies on a stable order for the history entries and report lists
	// it produces — the deterministic core, run on the operator's host, the CLI,
	// and the CI oracle alike.
	return nested.flat().sort((a, b) => byCodepoint(a.path, b.path));
}

async function acksInDir(ticketDir: string): Promise<StoredAck[]> {
	const files = (await listJsonFiles(ticketDir)).filter((f) => f.startsWith('ack-'));
	const acks = await Promise.all(files.map((f) => readAck(path.join(ticketDir, f))));
	return acks.filter((a): a is StoredAck => a !== null);
}

async function readAck(ackPath: string): Promise<StoredAck | null> {
	const raw = await readFileOrNull(ackPath);
	const parsed = raw !== null ? parseAckFile(raw) : null;
	return parsed?.ok ? { path: ackPath, ack: parsed.value } : null;
}

async function writeTicket(protocolDir: string, key: string, ticket: TicketFile): Promise<void> {
	const target = path.join(ticketsDir(protocolDir), `${key}.json`);
	// Overlay modeled fields onto the on-disk object so UN-modeled agent-owned
	// keys (plan, deadEnds, notes, stalledPasses) survive a stamp. (`history` is
	// modeled, so it IS overlaid — the core preserves it by reading and appending
	// the on-disk array before stamping.) readMergeBase refuses on a present file
	// that is corrupt OR unreadable: overlaying onto {} would silently wipe memory.
	const existing = await readMergeBase(target);
	await writeJsonAtomic(target, { ...existing, ...ticket });
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
	await writeFileAtomic(target, JSON.stringify(value, null, 2) + '\n');
}

async function unlinkIfPresent(target: string): Promise<void> {
	try {
		await fs.unlink(target);
	} catch (err) {
		if (!isErrno(err, 'ENOENT')) throw err;
	}
}

/**
 * Base object to overlay a stamped ticket onto. ONLY a truly-absent file (ENOENT)
 * yields {} (a fresh ticket). A present file that is unreadable (EACCES/EISDIR/EIO)
 * or corrupt THROWS: overlaying onto {} would permanently wipe the agent's
 * un-modeled working memory (plan/deadEnds/notes), which a transient read error
 * must never trigger — failing the pass is retried harmlessly next tick.
 */
async function readMergeBase(target: string): Promise<Record<string, unknown>> {
	let raw: string;
	try {
		raw = await fs.readFile(target, 'utf8');
	} catch (err) {
		if (isErrno(err, 'ENOENT')) return {}; // truly absent ⇒ fresh ticket
		throw err; // present but unreadable — do NOT overwrite with defaults
	}
	const obj = asJsonObject(raw);
	if (obj === null) {
		throw new Error(`refusing to stamp a corrupt ticket file (${path.basename(target)}) — fix or delete it`);
	}
	return obj;
}

function asJsonObject(raw: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

async function readFileOrNull(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, 'utf8');
	} catch {
		return null;
	}
}

async function listJsonFiles(dir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name);
	} catch {
		return [];
	}
}

async function listSubdirs(dir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
	} catch {
		return [];
	}
}

function isErrno(err: unknown, code: string): boolean {
	return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code;
}
