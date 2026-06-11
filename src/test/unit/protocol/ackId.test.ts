/**
 * Unit tests for ack identity derivation (src/protocol/ackId.ts).
 *
 * ackId = first 8 hex of sha256(ticket + waitingKind + waitingSince), plain
 * UTF-8 concatenation — verified here against node:crypto directly so a
 * silent change to the recipe (separator, truncation length, encoding) fails
 * loudly: history notes and the chip state machine match the verbatim id.
 */

import * as assert from 'assert';
import { createHash } from 'crypto';

import { ackMatchesTicket, ackTargetFor, buildAck, deriveAckId } from '../../../protocol/ackId';
import { TicketFile, WaitingOn } from '../../../protocol/types';
import { makeTicket } from '../queue/fixtures';

function sha256Prefix(input: string): string {
	return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 8);
}

function waiting(overrides: Partial<WaitingOn> = {}): WaitingOn {
	return { kind: 'owner', ref: null, pr: null, since: '2026-06-11T07:55:22Z', detail: null, ...overrides };
}

describe('protocol/ackId', () => {
	describe('deriveAckId', () => {
		it('is the first 8 hex chars of sha256 over the plain concatenation', () => {
			const expected = sha256Prefix('853owner2026-06-11T07:55:22Z');
			assert.strictEqual(deriveAckId('853', 'owner', '2026-06-11T07:55:22Z'), expected);
		});

		it('matches the protocol known-answer vectors byte-for-byte', () => {
			// Literal vectors, NOT derived in-test: these are the only thing
			// that byte-pins this implementation to the plugin's independent
			// derivation (plugin/skills/protocol/SKILL.md) and to the worked
			// example in design/02-protocol.md without sharing code.
			assert.strictEqual(deriveAckId('142', 'owner', '2026-06-11T07:55:22Z'), 'bcd313df');
			assert.strictEqual(deriveAckId('853', 'owner', '2026-06-10T22:14:03Z'), 'ac2cc979');
		});

		it('is always exactly 8 lowercase hex chars', () => {
			const id = deriveAckId('PROJ-123', 'blockers', '2026-06-11T07:55:22Z');
			assert.match(id, /^[0-9a-f]{8}$/);
		});

		it('is idempotent for identical inputs and distinct otherwise', () => {
			const a = deriveAckId('853', 'review', '2026-06-11T07:55:22Z');
			assert.strictEqual(deriveAckId('853', 'review', '2026-06-11T07:55:22Z'), a);
			assert.notStrictEqual(deriveAckId('853', 'review', '2026-06-11T07:55:23Z'), a);
			assert.notStrictEqual(deriveAckId('853', 'owner', '2026-06-11T07:55:22Z'), a);
		});
	});

	describe('ackTargetFor', () => {
		it('mirrors waitingOn when present', () => {
			const ticket = makeTicket({
				waitingOn: waiting({ kind: 'review', ref: 'https://x/pull/855', pr: 855 }),
			});
			assert.deepStrictEqual(ackTargetFor(ticket), {
				waitingKind: 'review',
				waitingSince: '2026-06-11T07:55:22Z',
				ref: 'https://x/pull/855',
				pr: 855,
			});
		});

		it('uses the synthetic blockers kind with waitingSince = updatedAt for blockers-only tickets', () => {
			const ticket = makeTicket({ blockers: ['decision needed'], updatedAt: '2026-06-11T09:00:00Z' });
			assert.deepStrictEqual(ackTargetFor(ticket), {
				waitingKind: 'blockers',
				waitingSince: '2026-06-11T09:00:00Z',
				ref: null,
				pr: null,
			});
		});

		it('prefers waitingOn over blockers when both are present', () => {
			const ticket = makeTicket({ waitingOn: waiting(), blockers: ['also blocked'] });
			assert.strictEqual(ackTargetFor(ticket)?.waitingKind, 'owner');
		});

		it('returns null when there is nothing to ack', () => {
			assert.strictEqual(ackTargetFor(makeTicket()), null);
		});
	});

	describe('buildAck', () => {
		it('builds the complete payload with the derived id', () => {
			const ticket = makeTicket({ ticket: '853', waitingOn: waiting(), updatedAt: '2026-06-11T08:00:00Z' });
			const ack = buildAck({ ticket, note: 'answered', createdAt: '2026-06-11T08:05:00Z', createdBy: 'ed' });
			assert.deepStrictEqual(ack, {
				schemaVersion: 1,
				kind: 'ready-for-look',
				ticket: '853',
				ackId: sha256Prefix('853owner2026-06-11T07:55:22Z'),
				target: { waitingKind: 'owner', waitingSince: '2026-06-11T07:55:22Z', ref: null, pr: null },
				stateUpdatedAt: '2026-06-11T08:00:00Z',
				note: 'answered',
				createdAt: '2026-06-11T08:05:00Z',
				createdBy: 'ed',
			});
		});

		it('returns null for a ticket with nothing to ack', () => {
			const ack = buildAck({ ticket: makeTicket(), note: null, createdAt: '2026-06-11T08:05:00Z', createdBy: 'ed' });
			assert.strictEqual(ack, null);
		});
	});

	describe('ackMatchesTicket', () => {
		function ackOn(ticket: TicketFile): NonNullable<ReturnType<typeof buildAck>> {
			const ack = buildAck({ ticket, note: null, createdAt: '2026-06-11T08:05:00Z', createdBy: 'ed' });
			assert.ok(ack);
			return ack;
		}

		it('matches while the ticket still carries the same outstanding request', () => {
			const ticket = makeTicket({ waitingOn: waiting() });
			assert.strictEqual(ackMatchesTicket(ackOn(ticket), ticket), true);
		});

		it('is superseded when waitingOn.since changes', () => {
			const ack = ackOn(makeTicket({ waitingOn: waiting() }));
			const moved = makeTicket({ waitingOn: waiting({ since: '2026-06-11T10:00:00Z' }) });
			assert.strictEqual(ackMatchesTicket(ack, moved), false);
		});

		it('is superseded when the waiting kind changes', () => {
			const ack = ackOn(makeTicket({ waitingOn: waiting({ kind: 'owner' }) }));
			const moved = makeTicket({ waitingOn: waiting({ kind: 'review' }) });
			assert.strictEqual(ackMatchesTicket(ack, moved), false);
		});

		it('does not match a ticket that is no longer ackable', () => {
			const ack = ackOn(makeTicket({ waitingOn: waiting() }));
			assert.strictEqual(ackMatchesTicket(ack, makeTicket()), false);
		});
	});
});
