/**
 * Operator-initiated removal of a settled ticket FILE (design/02-protocol.md
 * lifecycle). This is a deliberate exception to "the extension only writes
 * acks": the file is disposable working memory, and the operator may clear a
 * finished ticket from the queue. Durable state lives on the forge (the closed
 * issue) and in branches/PRs; the worktree is reclaimed by the planner GC.
 *
 * Idempotent: a missing file is reported as already-gone, never an error.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export type RemoveTicketResult = 'removed' | 'already-gone';

export function ticketFilePath(protocolDir: string, key: string): string {
	const ticketsDir = path.join(protocolDir, 'tickets');
	const file = path.join(ticketsDir, `${key}.json`);
	// The key is the ticket file's own `ticket` field (operator-readable, not forced to
	// equal the basename), so a hand-edited or hostile file could carry `../…` and aim
	// the unlink outside tickets/. Require a direct child, mirroring the worktree-slug
	// guard in gitWorktree.ts — a deletion must never escape the protocol dir.
	if (path.dirname(file) !== ticketsDir) {
		throw new Error(`unsafe ticket key ${JSON.stringify(key)}`);
	}
	return file;
}

export async function deleteTicketFile(protocolDir: string, key: string): Promise<RemoveTicketResult> {
	try {
		await fs.unlink(ticketFilePath(protocolDir, key));
		return 'removed';
	} catch (err) {
		if (isErrno(err, 'ENOENT')) return 'already-gone';
		throw err;
	}
}

function isErrno(err: unknown, code: string): boolean {
	return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code;
}
