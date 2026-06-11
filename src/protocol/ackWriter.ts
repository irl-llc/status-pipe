/**
 * The one write the extension performs against a protocol dir:
 * ack files in inbox/ (design/02-protocol.md).
 *
 * Creation is atomic (write `<file>.tmp`, then rename) so the orchestrator's
 * inbox glob never sees a half-written file. Consumption is the
 * orchestrator's job (unlink + history entry); withdrawal is ours.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { AckFile } from './types';

export function ackFilePath(protocolDir: string, ticket: string, ackId: string): string {
	return path.join(protocolDir, 'inbox', ticket, `ack-${ackId}.json`);
}

export type WriteAckResult = 'created' | 'already-sent';

/**
 * Atomically creates the ack file. Returns 'already-sent' when the
 * idempotent id already exists on disk (re-click of the same request).
 */
export async function writeAckFile(protocolDir: string, ack: AckFile): Promise<WriteAckResult> {
	const target = ackFilePath(protocolDir, ack.ticket, ack.ackId);
	if (await fileExists(target)) return 'already-sent';
	await fs.mkdir(path.dirname(target), { recursive: true });
	const tmp = `${target}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(ack, null, 2) + '\n', 'utf8');
	await fs.rename(tmp, target);
	return 'created';
}

export type WithdrawResult = 'withdrawn' | 'already-gone';

/**
 * Unlinks an ack we authored. The caller must re-check the ticket's
 * history[] afterwards: if a consumption entry for the ackId appeared in the
 * race window, the pickup won and the UI must say so (design/02-protocol.md
 * lifecycle step 5).
 */
export async function withdrawAckFile(protocolDir: string, ticket: string, ackId: string): Promise<WithdrawResult> {
	try {
		await fs.unlink(ackFilePath(protocolDir, ticket, ackId));
		return 'withdrawn';
	} catch (err) {
		if (isErrno(err, 'ENOENT')) return 'already-gone';
		throw err;
	}
}

/**
 * Sweeps inbox directories whose ticket file no longer exists and whose
 * newest entry is older than `orphanMaxAgeMs` (default 7 days).
 */
export async function sweepOrphanedInboxDirs(
	protocolDir: string,
	now: number,
	orphanMaxAgeMs = 7 * 24 * 60 * 60 * 1000,
): Promise<string[]> {
	const inbox = path.join(protocolDir, 'inbox');
	const entries = await listDirNames(inbox);
	const swept: string[] = [];
	for (const ticket of entries) {
		if (await fileExists(path.join(protocolDir, 'tickets', `${ticket}.json`))) continue;
		const dir = path.join(inbox, ticket);
		if (await dirOlderThan(dir, now - orphanMaxAgeMs)) {
			await fs.rm(dir, { recursive: true, force: true });
			swept.push(ticket);
		}
	}
	return swept;
}

async function listDirNames(dir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries.filter((e) => e.isDirectory()).map((e) => e.name);
	} catch (err) {
		if (isErrno(err, 'ENOENT')) return [];
		throw err;
	}
}

async function dirOlderThan(dir: string, cutoffMs: number): Promise<boolean> {
	const files = await fs.readdir(dir).catch(() => [] as string[]);
	if (files.length === 0) return true;
	const mtimes = await Promise.all(
		files.map(async (f) => {
			const stat = await fs.stat(path.join(dir, f)).catch(() => null);
			return stat ? stat.mtimeMs : 0;
		}),
	);
	return Math.max(...mtimes) < cutoffMs;
}

async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

function isErrno(err: unknown, code: string): boolean {
	return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code;
}
