/**
 * Unit tests for the tolerant protocol readers (src/protocol/parse.ts).
 *
 * The contract under test (design/02-protocol.md): files written by external
 * agents must degrade, never throw — corrupt JSON and unknown schema versions
 * become ParseResult failures, garbled fields coerce to defaults.
 */

import * as assert from 'assert';

import {
	parseAckFile,
	parseConfigFile,
	parseLaunchFile,
	parseOrchestratorFile,
	parseTicketFile,
} from '../../../protocol/parse';
import { ParseResult, TicketFile } from '../../../protocol/types';

function ok<T>(result: ParseResult<T>): T {
	if (!result.ok) {
		throw new assert.AssertionError({ message: `expected ok parse, got ${result.reason}: ${result.detail}` });
	}
	return result.value;
}

function failure<T>(result: ParseResult<T>): { reason: 'corrupt' | 'unknown-schema'; raw: string; detail: string } {
	if (result.ok) {
		throw new assert.AssertionError({ message: 'expected a parse failure, got ok' });
	}
	return result;
}

/** A fully-populated v1 ticket per the field table in design/02-protocol.md. */
const FULL_TICKET: TicketFile = {
	schemaVersion: 1,
	repo: 'acme/status-pipe',
	ticket: '853',
	title: 'Queue model derivation',
	slug: 'queue-model',
	url: 'https://github.com/acme/status-pipe/issues/853',
	phase: 'review',
	health: 'waiting',
	headline: 'Opened PR #855 and requested review.',
	waitingOn: {
		kind: 'review',
		ref: 'https://github.com/acme/status-pipe/pull/855',
		pr: 855,
		since: '2026-06-11T07:55:22Z',
		detail: 'review requested from ed',
	},
	prs: [
		{
			number: 855,
			url: 'https://github.com/acme/status-pipe/pull/855',
			head: 'feat/queue-1a',
			base: 'main',
			draft: false,
			state: 'open',
			ci: 'passing',
			part: 'T1a',
		},
	],
	blockers: ['Needs a decision on the retention default'],
	subTickets: [
		{
			key: '854',
			url: 'https://github.com/acme/status-pipe/issues/854',
			topic: 'retention window',
			status: 'open',
		},
	],
	agentCommentIds: ['IC_kwDOAbc123'],
	history: [{ at: '2026-06-11T07:55:22Z', phase: 'review', note: 'opened PR #855', runId: 'run-42' }],
	worker: {
		status: 'idle',
		taskId: 'task-9',
		startedAt: '2026-06-11T07:00:00Z',
		heartbeatAt: '2026-06-11T07:54:00Z',
	},
	updatedAt: '2026-06-11T07:55:22Z',
};

describe('protocol/parse', () => {
	describe('parseTicketFile', () => {
		it('round-trips a fully-populated valid v1 ticket file', () => {
			const result = parseTicketFile(JSON.stringify(FULL_TICKET), '853');
			assert.deepStrictEqual(ok(result), FULL_TICKET);
		});

		it('applies defaults for a minimal ticket (only schemaVersion)', () => {
			const value = ok(parseTicketFile('{"schemaVersion": 1}', 'PROJ-12'));
			assert.deepStrictEqual(value, {
				schemaVersion: 1,
				repo: '',
				ticket: 'PROJ-12',
				title: 'PROJ-12',
				slug: null,
				url: null,
				phase: 'planning',
				health: 'ok',
				headline: '',
				waitingOn: null,
				prs: [],
				blockers: [],
				subTickets: [],
				agentCommentIds: [],
				history: [],
				worker: null,
				updatedAt: '',
			});
		});

		it('uses the filename stem as the fallback key only when `ticket` is missing', () => {
			const fromFile = ok(parseTicketFile('{"schemaVersion": 1, "ticket": "853"}', 'other'));
			assert.strictEqual(fromFile.ticket, '853');
			const garbled = ok(parseTicketFile('{"schemaVersion": 1, "ticket": 853}', '853'));
			assert.strictEqual(garbled.ticket, '853');
		});

		it('reports corrupt JSON as a corrupt parse with the raw text preserved', () => {
			const raw = '{"schemaVersion": 1, "ticket": ';
			const result = failure(parseTicketFile(raw, '853'));
			assert.strictEqual(result.reason, 'corrupt');
			assert.strictEqual(result.raw, raw);
			assert.ok(result.detail.length > 0);
		});

		it('reports non-object JSON (string, array, null) as corrupt', () => {
			for (const raw of ['"hello"', '[1, 2]', 'null', '42']) {
				const result = failure(parseTicketFile(raw, '853'));
				assert.strictEqual(result.reason, 'corrupt');
				assert.strictEqual(result.detail, 'not a JSON object');
			}
		});

		it('reports schemaVersion 2 as unknown-schema', () => {
			const result = failure(parseTicketFile('{"schemaVersion": 2, "ticket": "853"}', '853'));
			assert.strictEqual(result.reason, 'unknown-schema');
			assert.strictEqual(result.detail, 'schemaVersion 2');
		});

		it('reports a missing schemaVersion as unknown-schema', () => {
			const result = failure(parseTicketFile('{"ticket": "853"}', '853'));
			assert.strictEqual(result.reason, 'unknown-schema');
		});

		it('coerces garbled enum values to defaults instead of dropping the file', () => {
			const raw = JSON.stringify({
				schemaVersion: 1,
				phase: 'shipping',
				health: 'great',
				prs: [{ number: 855, head: 'feat', base: 'main', state: 'reopened', ci: 'red', draft: 'yes' }],
			});
			const value = ok(parseTicketFile(raw, '853'));
			assert.strictEqual(value.phase, 'planning');
			assert.strictEqual(value.health, 'ok');
			assert.deepStrictEqual(value.prs, [
				{ number: 855, url: null, head: 'feat', base: 'main', draft: false, state: 'open', ci: 'unknown', part: null },
			]);
		});

		it('nulls waitingOn when its kind is not a known waiting kind', () => {
			const raw = JSON.stringify({
				schemaVersion: 1,
				waitingOn: { kind: 'nap', since: '2026-06-11T07:55:22Z' },
			});
			assert.strictEqual(ok(parseTicketFile(raw, '853')).waitingOn, null);
		});

		it('nulls waitingOn when since is missing', () => {
			const raw = JSON.stringify({ schemaVersion: 1, waitingOn: { kind: 'review' } });
			assert.strictEqual(ok(parseTicketFile(raw, '853')).waitingOn, null);
		});

		it('drops malformed prs/history entries and a garbled worker', () => {
			const raw = JSON.stringify({
				schemaVersion: 1,
				prs: [{ number: 855, head: 'feat' }, 'junk', { number: 856, head: 'feat-2', base: 'main' }],
				history: [{ at: '2026-06-11T07:55:22Z' }, { at: '2026-06-11T08:00:00Z', note: 'ok' }],
				worker: { status: 'sleeping' },
			});
			const value = ok(parseTicketFile(raw, '853'));
			assert.deepStrictEqual(
				value.prs.map((p) => p.number),
				[856],
			);
			assert.deepStrictEqual(
				value.history.map((h) => h.note),
				['ok'],
			);
			assert.strictEqual(value.worker, null);
		});
	});

	describe('parseOrchestratorFile', () => {
		it('parses a fully-populated orchestrator file', () => {
			const raw = JSON.stringify({
				schemaVersion: 1,
				repo: 'acme/status-pipe',
				passCount: 31,
				lastPassStartedAt: '2026-06-12T03:38:10Z',
				lastPassFinishedAt: '2026-06-12T03:40:00Z',
				staleWorkerMinutes: 30,
				parked: {
					since: '2026-06-12T03:40:00Z',
					reason: '4 active tickets all waiting on owner',
					recheckAfter: '2026-06-12T09:40:00Z',
				},
				note: 'all quiet',
			});
			assert.deepStrictEqual(ok(parseOrchestratorFile(raw)), {
				schemaVersion: 1,
				repo: 'acme/status-pipe',
				passCount: 31,
				lastPassStartedAt: '2026-06-12T03:38:10Z',
				lastPassFinishedAt: '2026-06-12T03:40:00Z',
				staleWorkerMinutes: 30,
				parked: {
					since: '2026-06-12T03:40:00Z',
					reason: '4 active tickets all waiting on owner',
					recheckAfter: '2026-06-12T09:40:00Z',
				},
				note: 'all quiet',
			});
		});

		it('parses parked without recheckAfter as recheckAfter null', () => {
			const raw = JSON.stringify({
				schemaVersion: 1,
				parked: { since: '2026-06-12T03:40:00Z', reason: 'waiting on owner' },
			});
			assert.deepStrictEqual(ok(parseOrchestratorFile(raw)).parked, {
				since: '2026-06-12T03:40:00Z',
				reason: 'waiting on owner',
				recheckAfter: null,
			});
		});

		it('nulls parked when since or reason is missing, and coerces garbled scalars', () => {
			const raw = JSON.stringify({
				schemaVersion: 1,
				passCount: 'many',
				parked: { since: '2026-06-12T03:40:00Z' },
			});
			const value = ok(parseOrchestratorFile(raw));
			assert.strictEqual(value.parked, null);
			assert.strictEqual(value.passCount, null);
		});

		it('rejects unknown schema versions', () => {
			assert.strictEqual(failure(parseOrchestratorFile('{"schemaVersion": 3}')).reason, 'unknown-schema');
		});
	});

	describe('parseAckFile', () => {
		const VALID_ACK = {
			schemaVersion: 1,
			kind: 'ready-for-look',
			ticket: '853',
			ackId: '7f3a9c2e',
			target: { waitingKind: 'owner', waitingSince: '2026-06-11T07:55:22Z', ref: null, pr: null },
			stateUpdatedAt: '2026-06-11T07:55:22Z',
			note: 'answered inline',
			createdAt: '2026-06-11T08:00:00Z',
			createdBy: 'ed',
		};

		it('round-trips a valid ack file', () => {
			assert.deepStrictEqual(ok(parseAckFile(JSON.stringify(VALID_ACK))), VALID_ACK);
		});

		it('accepts the synthetic blockers waiting kind in targets', () => {
			const raw = JSON.stringify({
				...VALID_ACK,
				target: { waitingKind: 'blockers', waitingSince: '2026-06-11T07:55:22Z' },
			});
			assert.deepStrictEqual(ok(parseAckFile(raw)).target, {
				waitingKind: 'blockers',
				waitingSince: '2026-06-11T07:55:22Z',
				ref: null,
				pr: null,
			});
		});

		it('rejects an ackId that is not exactly 8 lowercase hex chars', () => {
			for (const ackId of ['7f3a9c2', '7f3a9c2ef', '7F3A9C2E', 'zzzzzzzz']) {
				const result = failure(parseAckFile(JSON.stringify({ ...VALID_ACK, ackId })));
				assert.strictEqual(result.reason, 'corrupt');
			}
		});

		it('rejects a target with an unknown waiting kind', () => {
			const raw = JSON.stringify({
				...VALID_ACK,
				target: { waitingKind: 'nap', waitingSince: '2026-06-11T07:55:22Z' },
			});
			assert.strictEqual(failure(parseAckFile(raw)).reason, 'corrupt');
		});

		it('rejects a missing ticket', () => {
			const { ticket: _ticket, ...rest } = VALID_ACK;
			assert.strictEqual(failure(parseAckFile(JSON.stringify(rest))).reason, 'corrupt');
		});

		it('surfaces a future ack kind as unknown-schema, never as ready-for-look', () => {
			// Misreading a future `pause` as ready-for-look could unlink a
			// signal the operator meant to keep (design/02: kind is an enum
			// from day one).
			const result = failure(parseAckFile(JSON.stringify({ ...VALID_ACK, kind: 'pause' })));
			assert.strictEqual(result.reason, 'unknown-schema');
			assert.match(result.detail, /pause/);
		});

		it('treats a missing kind as ready-for-look (the only v1 kind)', () => {
			const { kind: _kind, ...rest } = VALID_ACK;
			assert.strictEqual(ok(parseAckFile(JSON.stringify(rest))).kind, 'ready-for-look');
		});
	});

	describe('parseLaunchFile', () => {
		it('parses agents and applies per-agent defaults', () => {
			const raw = JSON.stringify({
				schemaVersion: 1,
				agents: [
					{
						id: 'orc',
						title: 'Orchestrator',
						command: 'claude',
						args: ['-p'],
						stdin: 'tick',
						cwd: 'sub',
						env: { FOO: 'bar' },
						mode: 'tick',
						intervalMinutes: 5,
						timeoutMinutes: 20,
					},
					{ command: 'node', mode: 'daemon' },
				],
			});
			const value = ok(parseLaunchFile(raw));
			assert.strictEqual(value.agents.length, 2);
			assert.deepStrictEqual(value.agents[1], {
				id: 'agent-1',
				title: 'agent-1',
				command: 'node',
				args: [],
				stdin: '',
				cwd: '.',
				env: {},
				mode: 'daemon',
				intervalMinutes: 10,
				timeoutMinutes: 45,
			});
		});

		it('filters env to string values only', () => {
			const raw = JSON.stringify({
				schemaVersion: 1,
				agents: [{ command: 'node', mode: 'tick', env: { A: 'x', B: 5, C: null, D: { nested: true } } }],
			});
			assert.deepStrictEqual(ok(parseLaunchFile(raw)).agents[0].env, { A: 'x' });
		});

		it('drops agents with a missing command or unknown mode', () => {
			const raw = JSON.stringify({
				schemaVersion: 1,
				agents: [{ mode: 'tick' }, { command: 'node', mode: 'cron' }, { command: 'node', mode: 'tick' }],
			});
			const value = ok(parseLaunchFile(raw));
			assert.strictEqual(value.agents.length, 1);
			assert.strictEqual(value.agents[0].id, 'agent-2');
		});

		it('reports a launch file with no valid agents as corrupt', () => {
			for (const raw of ['{"schemaVersion": 1}', '{"schemaVersion": 1, "agents": [{"mode": "tick"}]}']) {
				const result = failure(parseLaunchFile(raw));
				assert.strictEqual(result.reason, 'corrupt');
				assert.strictEqual(result.detail, 'no valid agents[] entries');
			}
		});
	});

	describe('parseConfigFile', () => {
		it('applies defaults for an empty config', () => {
			assert.deepStrictEqual(ok(parseConfigFile('{"schemaVersion": 1}')), {
				schemaVersion: 1,
				epicsDir: 'epics',
				inventoryLabel: 'agent-queue',
				ticketSource: null,
				jiraSiteUrl: null,
				jiraProjectKey: null,
				staleWorkerMinutes: null,
				trustMode: null,
			});
		});

		it('parses a fully-populated config', () => {
			const raw = JSON.stringify({
				schemaVersion: 1,
				epics: { dir: 'plans' },
				inventory: { label: 'queue' },
				tickets: { source: 'jira-cloud', jira: { siteUrl: 'https://irl.atlassian.net', projectKey: 'PROJ' } },
				staleWorkerMinutes: 45,
				trust: { mode: 'single-maintainer' },
			});
			assert.deepStrictEqual(ok(parseConfigFile(raw)), {
				schemaVersion: 1,
				epicsDir: 'plans',
				inventoryLabel: 'queue',
				ticketSource: 'jira-cloud',
				jiraSiteUrl: 'https://irl.atlassian.net',
				jiraProjectKey: 'PROJ',
				staleWorkerMinutes: 45,
				trustMode: 'single-maintainer',
			});
		});

		it('nulls unknown ticket sources and trust modes', () => {
			const raw = JSON.stringify({
				schemaVersion: 1,
				tickets: { source: 'gitlab' },
				trust: { mode: 'anarchy' },
			});
			const value = ok(parseConfigFile(raw));
			assert.strictEqual(value.ticketSource, null);
			assert.strictEqual(value.trustMode, null);
		});
	});
});
