/**
 * Unit tests for the ack file writer (src/protocol/ackWriter.ts) against a
 * real filesystem in a temp dir — atomic create, idempotent re-send,
 * withdraw, and the orphaned-inbox sweep with explicit clocks and mtimes.
 */

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { buildAck } from '../../../protocol/ackId';
import { ackFilePath, sweepOrphanedInboxDirs, withdrawAckFile, writeAckFile } from '../../../protocol/ackWriter';
import { AckFile } from '../../../protocol/types';
import { makeTicket } from '../queue/fixtures';

function fixtureAck(ticket = '853'): AckFile {
	const t = makeTicket({
		ticket,
		waitingOn: { kind: 'owner', ref: null, pr: null, since: '2026-06-11T07:55:22Z', detail: null },
	});
	const ack = buildAck({ ticket: t, note: 'answered', createdAt: '2026-06-11T08:00:00Z', createdBy: 'ed' });
	assert.ok(ack);
	return ack;
}

async function exists(p: string): Promise<boolean> {
	return fs.access(p).then(
		() => true,
		() => false,
	);
}

async function writeAged(filePath: string, mtime: Date): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, '{}\n', 'utf8');
	await fs.utimes(filePath, mtime, mtime);
}

describe('protocol/ackWriter', () => {
	let protocolDir: string;
	const created: string[] = [];

	beforeEach(async () => {
		protocolDir = await fs.mkdtemp(path.join(os.tmpdir(), 'status-pipe-ack-'));
		created.push(protocolDir);
	});

	after(async () => {
		await Promise.all(created.map((dir) => fs.rm(dir, { recursive: true, force: true })));
	});

	describe('writeAckFile', () => {
		it('atomically creates inbox/<ticket>/ack-<id>.json with no .tmp left behind', async () => {
			const ack = fixtureAck();
			assert.strictEqual(await writeAckFile(protocolDir, ack), 'created');

			const target = ackFilePath(protocolDir, ack.ticket, ack.ackId);
			assert.strictEqual(target, path.join(protocolDir, 'inbox', '853', `ack-${ack.ackId}.json`));
			assert.deepStrictEqual(JSON.parse(await fs.readFile(target, 'utf8')), ack);

			const siblings = await fs.readdir(path.dirname(target));
			assert.deepStrictEqual(siblings, [`ack-${ack.ackId}.json`]);
		});

		it('returns already-sent when the idempotent id already exists', async () => {
			const ack = fixtureAck();
			assert.strictEqual(await writeAckFile(protocolDir, ack), 'created');
			assert.strictEqual(await writeAckFile(protocolDir, ack), 'already-sent');
		});
	});

	describe('withdrawAckFile', () => {
		it('removes a previously written ack', async () => {
			const ack = fixtureAck();
			await writeAckFile(protocolDir, ack);
			assert.strictEqual(await withdrawAckFile(protocolDir, ack.ticket, ack.ackId), 'withdrawn');
			assert.strictEqual(await exists(ackFilePath(protocolDir, ack.ticket, ack.ackId)), false);
		});

		it('returns already-gone when the file no longer exists (consumed in the race window)', async () => {
			assert.strictEqual(await withdrawAckFile(protocolDir, '853', 'deadbeef'), 'already-gone');
		});
	});

	describe('sweepOrphanedInboxDirs', () => {
		const NOW = Date.parse('2026-06-11T12:00:00Z');
		const EIGHT_DAYS_AGO = new Date(NOW - 8 * 24 * 60 * 60 * 1000);
		const ONE_DAY_AGO = new Date(NOW - 24 * 60 * 60 * 1000);

		it('removes only orphaned dirs whose newest entry is older than the cutoff', async () => {
			await fs.mkdir(path.join(protocolDir, 'tickets'), { recursive: true });
			await fs.writeFile(path.join(protocolDir, 'tickets', 'keep.json'), '{}\n', 'utf8');
			await writeAged(path.join(protocolDir, 'inbox', 'keep', 'ack-aaaaaaaa.json'), EIGHT_DAYS_AGO);
			await writeAged(path.join(protocolDir, 'inbox', 'orphan-old', 'ack-bbbbbbbb.json'), EIGHT_DAYS_AGO);
			await writeAged(path.join(protocolDir, 'inbox', 'orphan-fresh', 'ack-cccccccc.json'), ONE_DAY_AGO);

			const swept = await sweepOrphanedInboxDirs(protocolDir, NOW);

			assert.deepStrictEqual(swept.sort(), ['orphan-old']);
			assert.strictEqual(await exists(path.join(protocolDir, 'inbox', 'keep')), true);
			assert.strictEqual(await exists(path.join(protocolDir, 'inbox', 'orphan-old')), false);
			assert.strictEqual(await exists(path.join(protocolDir, 'inbox', 'orphan-fresh')), true);
		});

		it('keeps a dir whose ticket file exists even when its entries are ancient', async () => {
			await fs.mkdir(path.join(protocolDir, 'tickets'), { recursive: true });
			await fs.writeFile(path.join(protocolDir, 'tickets', '853.json'), '{}\n', 'utf8');
			await writeAged(path.join(protocolDir, 'inbox', '853', 'ack-aaaaaaaa.json'), EIGHT_DAYS_AGO);

			assert.deepStrictEqual(await sweepOrphanedInboxDirs(protocolDir, NOW), []);
			assert.strictEqual(await exists(path.join(protocolDir, 'inbox', '853')), true);
		});

		it('treats an empty orphaned dir as sweepable', async () => {
			await fs.mkdir(path.join(protocolDir, 'inbox', 'orphan-empty'), { recursive: true });

			assert.deepStrictEqual(await sweepOrphanedInboxDirs(protocolDir, NOW), ['orphan-empty']);
			assert.strictEqual(await exists(path.join(protocolDir, 'inbox', 'orphan-empty')), false);
		});

		it('honors an explicit orphanMaxAgeMs cutoff', async () => {
			await writeAged(path.join(protocolDir, 'inbox', 'orphan-fresh', 'ack-cccccccc.json'), ONE_DAY_AGO);

			const swept = await sweepOrphanedInboxDirs(protocolDir, NOW, 60 * 60 * 1000);
			assert.deepStrictEqual(swept, ['orphan-fresh']);
		});

		it('returns empty when there is no inbox dir at all', async () => {
			assert.deepStrictEqual(await sweepOrphanedInboxDirs(protocolDir, NOW), []);
		});
	});
});
