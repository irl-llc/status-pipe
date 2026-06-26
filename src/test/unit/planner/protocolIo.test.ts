/**
 * Filesystem protocol ports (src/planner/protocolIo.ts) against a real temp
 * dir: ticket/orchestrator round-trips, ack listing/deletion, atomic writes
 * (no .tmp residue), and — the load-bearing one — that stamping a ticket
 * MERGES, preserving agent-owned working memory the planner doesn't model.
 */

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { createProtocolReadPort, createProtocolWritePort } from '../../../planner/protocolIo';
import { OrchestratorFile } from '../../../protocol/types';
import { makeTicket } from './fakes';

async function readJson(p: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(p, 'utf8'));
}

function orchestrator(over: Partial<OrchestratorFile> = {}): OrchestratorFile {
	return {
		schemaVersion: 1,
		repo: 'acme/app',
		passCount: 3,
		lastPassStartedAt: '2026-06-26T12:00:00Z',
		lastPassFinishedAt: '2026-06-26T12:00:01Z',
		staleWorkerMinutes: 30,
		parked: null,
		dispatch: null,
		note: null,
		...over,
	};
}

describe('planner/protocolIo', () => {
	let dir: string;
	let read: ReturnType<typeof createProtocolReadPort>;
	let write: ReturnType<typeof createProtocolWritePort>;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'status-pipe-proto-'));
		read = createProtocolReadPort(dir);
		write = createProtocolWritePort(dir);
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	describe('tickets', () => {
		it('round-trips a ticket and lists its key', async () => {
			await write.writeTicket('19', makeTicket({ ticket: '19', title: 'Wire it', phase: 'review' }));
			assert.deepEqual(await read.listTicketKeys(), ['19']);
			const back = await read.readTicket('19');
			assert.equal(back?.title, 'Wire it');
			assert.equal(back?.phase, 'review');
		});

		it('merges modeled fields over the on-disk file, preserving agent-owned memory', async () => {
			const target = path.join(dir, 'tickets', '19.json');
			await fs.mkdir(path.dirname(target), { recursive: true });
			const onDisk = {
				...makeTicket({ ticket: '19', phase: 'planning' }),
				plan: 'do the thing',
				deadEnds: [{ at: 'x', tried: 'a', failedBecause: 'b', doNotRetryWithout: null }],
				notes: 'scratch',
				stalledPasses: 2,
			};
			await fs.writeFile(target, JSON.stringify(onDisk, null, 2), 'utf8');

			// Planner stamps a running worker; it never saw plan/deadEnds/notes.
			const stamped = makeTicket({
				ticket: '19',
				phase: 'implementation',
				worker: { status: 'running', taskId: null, startedAt: 'now', heartbeatAt: 'now' },
			});
			await write.writeTicket('19', stamped);

			const merged = await readJson(target);
			// Modeled fields advanced…
			assert.equal(merged.phase, 'implementation');
			assert.equal((merged.worker as Record<string, unknown>).status, 'running');
			// …agent-owned keys survived untouched.
			assert.equal(merged.plan, 'do the thing');
			assert.equal(merged.notes, 'scratch');
			assert.equal(merged.stalledPasses, 2);
			assert.deepEqual(merged.deadEnds, onDisk.deadEnds);
		});

		it('reads a missing ticket as null', async () => {
			assert.equal(await read.readTicket('nope'), null);
			assert.deepEqual(await read.listTicketKeys(), []);
		});

		it('refuses to stamp a corrupt ticket file rather than wiping agent memory', async () => {
			const target = path.join(dir, 'tickets', '19.json');
			await fs.mkdir(path.dirname(target), { recursive: true });
			const corrupt = '{ "plan": "do the thing", this is broken json';
			await fs.writeFile(target, corrupt, 'utf8'); // present but unparseable
			await assert.rejects(write.writeTicket('19', makeTicket({ ticket: '19' })), /corrupt ticket file/);
			// The bytes are left intact — NOT overwritten with modeled defaults.
			assert.equal(await fs.readFile(target, 'utf8'), corrupt);
		});

		it('refuses to stamp when the existing ticket is present but unreadable (not ENOENT)', async () => {
			const target = path.join(dir, 'tickets', '19.json');
			// A directory at the ticket path makes fs.readFile throw EISDIR — a
			// present-but-unreadable file, distinct from a truly absent one.
			await fs.mkdir(target, { recursive: true });
			await assert.rejects(write.writeTicket('19', makeTicket({ ticket: '19' })));
			assert.ok((await fs.stat(target)).isDirectory()); // untouched, not replaced with a fresh ticket
		});

		it('reads a present-but-corrupt ticket as null (tolerant reader degrades, does not throw)', async () => {
			// The READ side degrades a corrupt file to null — the reconcile core treats
			// it as ABSENT, not an error. (The WRITE side above instead refuses, to
			// protect the unparseable agent memory; the two halves are intentionally asymmetric.)
			const target = path.join(dir, 'tickets', '19.json');
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.writeFile(target, '{ "plan": "x", broken json', 'utf8');
			assert.equal(await read.readTicket('19'), null);
		});
	});

	describe('orchestrator', () => {
		it('round-trips and increments are visible on re-read', async () => {
			await write.writeOrchestrator(orchestrator({ passCount: 7 }));
			const back = await read.readOrchestrator();
			assert.equal(back?.passCount, 7);
			assert.equal(back?.repo, 'acme/app');
		});

		it('reads a missing orchestrator as null', async () => {
			assert.equal(await read.readOrchestrator(), null);
		});

		it('reads a present-but-corrupt orchestrator as null', async () => {
			await fs.writeFile(path.join(dir, 'orchestrator.json'), 'not json at all', 'utf8');
			assert.equal(await read.readOrchestrator(), null);
		});
	});

	describe('acks', () => {
		const ackPath = (ticket: string, id: string): string => path.join(dir, 'inbox', ticket, `ack-${id}.json`);

		async function seedAck(ticket: string, id: string): Promise<string> {
			const target = ackPath(ticket, id);
			await fs.mkdir(path.dirname(target), { recursive: true });
			const ack = {
				schemaVersion: 1,
				kind: 'ready-for-look',
				ticket,
				ackId: id,
				target: { waitingKind: 'owner', waitingSince: '2026-06-26T11:00:00Z', ref: null, pr: null },
				stateUpdatedAt: '2026-06-26T11:00:00Z',
				note: 'go',
				createdAt: '2026-06-26T11:30:00Z',
				createdBy: 'ed',
			};
			await fs.writeFile(target, JSON.stringify(ack), 'utf8');
			return target;
		}

		it('lists acks with their path and parsed contents', async () => {
			const p = await seedAck('19', 'abcdef01');
			const acks = await read.listAcks();
			assert.equal(acks.length, 1);
			assert.equal(acks[0].path, p);
			assert.equal(acks[0].ack.ackId, 'abcdef01');
			assert.equal(acks[0].ack.note, 'go');
		});

		it('skips a corrupt ack but keeps valid ones alongside it (a lost signal, not a thrown pass)', async () => {
			const good = await seedAck('19', 'abcdef01'); // creates inbox/19 too
			await fs.writeFile(ackPath('19', 'ffffffff'), '{ broken ack', 'utf8'); // present but unparseable
			const acks = await read.listAcks();
			assert.deepEqual(
				acks.map((a) => a.path),
				[good], // the corrupt ack is silently dropped, not surfaced and not fatal
			);
		});

		it('deletes a consumed ack and tolerates a re-delete', async () => {
			const p = await seedAck('19', 'abcdef01');
			await write.deleteAck(p);
			assert.deepEqual(await read.listAcks(), []);
			await write.deleteAck(p); // already gone — must not throw
		});

		it('lists acks in a deterministic path-sorted order, not filesystem order', async () => {
			// Seed out of order across tickets/ids; consumeAcks needs a stable order.
			const pc = await seedAck('19', 'cccccccc');
			const pa = await seedAck('19', 'aaaaaaaa');
			const pb = await seedAck('5', 'bbbbbbbb');
			const paths = (await read.listAcks()).map((a) => a.path);
			assert.deepEqual(paths, [pa, pc, pb]); // 19/aaaa < 19/cccc < 5/bbbb
		});
	});

	it('leaves no .tmp residue after writes', async () => {
		await write.writeTicket('19', makeTicket({ ticket: '19' }));
		await write.writeOrchestrator(orchestrator());
		const ticketFiles = await fs.readdir(path.join(dir, 'tickets'));
		const rootFiles = await fs.readdir(dir);
		assert.ok(!ticketFiles.some((f) => f.endsWith('.tmp')), ticketFiles.join(','));
		assert.ok(!rootFiles.some((f) => f.endsWith('.tmp')), rootFiles.join(','));
	});
});
