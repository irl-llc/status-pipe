/**
 * removeSettledTicket (src/host/controllerHelpers.ts): the operator's Remove action,
 * end to end against a REAL protocol dir — it re-reads from disk, QUIET-gates, and
 * unlinks inside tickets/, and must NEVER reject (every failure is a status). The
 * controller is a thin adapter over this, so the branches are pinned here.
 */

import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { RepoContext } from '../../../discovery/repoScan';
import { removeSettledTicket } from '../../../host/controllerHelpers';
import { ticketFilePath } from '../../../protocol/ticketRemover';
import { TicketFile } from '../../../protocol/types';
import { makeTicket } from '../queue/fixtures';

describe('host/controllerHelpers removeSettledTicket', () => {
	let repoRoot: string;
	let protocolDir: string;

	beforeEach(async () => {
		repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'status-pipe-rm-'));
		protocolDir = path.join(repoRoot, '.status-pipe');
		await fs.mkdir(path.join(protocolDir, 'tickets'), { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(repoRoot, { recursive: true, force: true });
	});

	const context = (): RepoContext => ({
		folder: repoRoot,
		repoRoot,
		protocolDir,
		remoteUrl: null,
		role: 'primary',
		worktreeRoot: null,
	});

	// Write a ticket file on disk so loadRepoProtocol reads it back; `fileName` lets a
	// hostile case name the file something benign while its `ticket` field escapes.
	const writeTicket = async (over: Partial<TicketFile>, fileName?: string): Promise<TicketFile> => {
		const ticket = makeTicket(over);
		const file = path.join(protocolDir, 'tickets', `${fileName ?? ticket.ticket}.json`);
		await fs.writeFile(file, JSON.stringify(ticket), 'utf8');
		return ticket;
	};

	const exists = (key: string): Promise<boolean> =>
		fs.access(ticketFilePath(protocolDir, key)).then(
			() => true,
			() => false,
		);

	it('removes a settled (QUIET) ticket', async () => {
		await writeTicket({ ticket: '19', phase: 'merged' });
		assert.equal(await removeSettledTicket(context(), '19'), 'removed');
		assert.equal(await exists('19'), false);
	});

	it('refuses an active (non-QUIET) ticket as not-allowed and leaves the file', async () => {
		await writeTicket({ ticket: '19', phase: 'implementation', health: 'ok' });
		assert.equal(await removeSettledTicket(context(), '19'), 'not-allowed');
		assert.equal(await exists('19'), true);
	});

	it('returns error for a key that names no known ticket', async () => {
		assert.equal(await removeSettledTicket(context(), 'nope'), 'error');
	});

	it('returns error (never a rejection) when the ticket key would escape tickets/', async () => {
		// The `ticket` field is operator-readable and not forced to the basename, so a
		// hostile file (benign name, traversal key) is a real input; the unlink guard
		// turns that into a clean 'error' instead of deleting outside tickets/.
		await writeTicket({ ticket: '../../evil', phase: 'merged' }, 'sneaky');
		assert.equal(await removeSettledTicket(context(), '../../evil'), 'error');
		assert.equal(await exists('sneaky'), true); // the real file is untouched
	});
});
