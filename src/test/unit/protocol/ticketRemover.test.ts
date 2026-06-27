/**
 * deleteTicketFile (src/protocol/ticketRemover.ts): the operator's settled-ticket
 * removal against a real temp protocol dir — it deletes the right file and is
 * idempotent (a missing file is already-gone, never an error).
 */

import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { deleteTicketFile, ticketFilePath } from '../../../protocol/ticketRemover';

describe('protocol/ticketRemover', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'status-pipe-rm-'));
		await fs.mkdir(path.join(dir, 'tickets'), { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('resolves the ticket file path under tickets/', () => {
		assert.equal(ticketFilePath('/proto', '19'), path.join('/proto', 'tickets', '19.json'));
	});

	it('removes an existing ticket file', async () => {
		const file = ticketFilePath(dir, '19');
		await fs.writeFile(file, '{}', 'utf8');
		assert.equal(await deleteTicketFile(dir, '19'), 'removed');
		assert.equal(
			await fs.access(file).then(
				() => true,
				() => false,
			),
			false,
		);
	});

	it('is idempotent — a missing file is already-gone, not an error', async () => {
		assert.equal(await deleteTicketFile(dir, 'never-made'), 'already-gone');
		const file = ticketFilePath(dir, '19');
		await fs.writeFile(file, '{}', 'utf8');
		assert.equal(await deleteTicketFile(dir, '19'), 'removed');
		assert.equal(await deleteTicketFile(dir, '19'), 'already-gone'); // second remove
	});

	it('refuses a key that would escape tickets/ (the field is not forced to the basename)', async () => {
		// A ticket file's `ticket` field can diverge from its filename, so a hostile/edited
		// file could carry `../…`; the guard must reject it rather than unlink outside tickets/.
		assert.throws(() => ticketFilePath(dir, '../../etc/passwd'), /unsafe ticket key/);
		assert.throws(() => ticketFilePath(dir, 'nested/key'), /unsafe ticket key/);
		await assert.rejects(deleteTicketFile(dir, '../../evil'), /unsafe ticket key/);
	});
});
