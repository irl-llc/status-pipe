/**
 * Protocol-dir loader (design/04-architecture.md): reads one repo's
 * .status-pipe/ into memory with the tolerant parsers. JSON parse errors
 * retry once after 200ms (a file caught mid-rename), then surface as a
 * degraded entry rather than throwing. vscode-free; the host's watcher
 * decides when to reload.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { RepoContext } from '../discovery/repoScan';
import {
	parseAckFile,
	parseConfigFile,
	parseLaunchFile,
	parseOrchestratorFile,
	parseTicketFile,
} from '../protocol/parse';
import { AckFile, ConfigFile, LaunchFile, OrchestratorFile, ParseResult } from '../protocol/types';
import { TicketEntry } from '../queue/queueInputs';

export interface RepoProtocolState {
	context: RepoContext;
	orchestrator: OrchestratorFile | null;
	config: ConfigFile | null;
	launch: LaunchFile | null;
	/** Raw launch.json text — the content the approval hash covers. */
	launchRaw: string | null;
	tickets: TicketEntry[];
	acksOnDisk: AckFile[];
}

const RETRY_DELAY_MS = 200;

/** PR numbers whose ticket's `updatedAt` advanced between two loads — the enricher's refresh set. */
export function changedPrNumbers(prev: RepoProtocolState | null, next: RepoProtocolState): number[] {
	const prevByKey = new Map(prev?.tickets.map((t) => [t.key, t]) ?? []);
	const changed: number[] = [];
	for (const entry of next.tickets) {
		if (!entry.parsed.ok) continue;
		const before = prevByKey.get(entry.key);
		const beforeUpdated = before?.parsed.ok ? before.parsed.value.updatedAt : null;
		if (beforeUpdated !== entry.parsed.value.updatedAt) {
			changed.push(...entry.parsed.value.prs.map((pr) => pr.number));
		}
	}
	return [...new Set(changed)];
}

export async function loadRepoProtocol(context: RepoContext): Promise<RepoProtocolState> {
	const dir = context.protocolDir;
	const [orchestrator, config, launchRaw, tickets, acksOnDisk] = await Promise.all([
		loadOptional(path.join(dir, 'orchestrator.json'), parseOrchestratorFile),
		loadOptional(path.join(dir, 'config.json'), parseConfigFile),
		readFileOrNull(path.join(dir, 'launch.json')),
		loadTickets(dir),
		loadAcks(dir),
	]);
	const launch = launchRaw ? okOrNull(parseLaunchFile(launchRaw)) : null;
	return { context, orchestrator, config, launch, launchRaw, tickets, acksOnDisk };
}

async function loadTickets(dir: string): Promise<TicketEntry[]> {
	const ticketsDir = path.join(dir, 'tickets');
	const files = await listJsonFiles(ticketsDir);
	const entries = await Promise.all(
		files.map(async (file): Promise<TicketEntry | null> => {
			const key = path.basename(file, '.json');
			const parsed = await parseWithRetry(path.join(ticketsDir, file), (raw) => parseTicketFile(raw, key));
			return parsed ? { key, parsed } : null;
		}),
	);
	return entries.filter((e): e is TicketEntry => e !== null).sort((a, b) => a.key.localeCompare(b.key));
}

async function loadAcks(dir: string): Promise<AckFile[]> {
	const inbox = path.join(dir, 'inbox');
	const ticketDirs = await listSubdirs(inbox);
	const all = await Promise.all(
		ticketDirs.map(async (ticketDir) => {
			const files = await listJsonFiles(ticketDir);
			const acks = await Promise.all(
				files.filter((f) => f.startsWith('ack-')).map((f) => loadOptional(path.join(ticketDir, f), parseAckFile)),
			);
			return acks.filter((a): a is AckFile => a !== null);
		}),
	);
	return all.flat();
}

/**
 * Parse with one mid-write retry. Returns null only when the file vanished
 * (deleted between listing and reading) — parse failures surface degraded.
 */
async function parseWithRetry<T>(
	filePath: string,
	parse: (raw: string) => ParseResult<T>,
): Promise<ParseResult<T> | null> {
	const raw = await readFileOrNull(filePath);
	if (raw === null) return null;
	const first = parse(raw);
	if (first.ok || first.reason !== 'corrupt') return first;
	await delay(RETRY_DELAY_MS);
	const raw2 = await readFileOrNull(filePath);
	if (raw2 === null) return null;
	return parse(raw2);
}

async function loadOptional<T>(filePath: string, parse: (raw: string) => ParseResult<T>): Promise<T | null> {
	const result = await parseWithRetry(filePath, parse);
	return result ? okOrNull(result) : null;
}

function okOrNull<T>(result: ParseResult<T>): T | null {
	return result.ok ? result.value : null;
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

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
