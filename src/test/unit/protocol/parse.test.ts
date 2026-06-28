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

		it('keeps the hardening phase (a known phase, not coerced to planning)', () => {
			// reviewLoop is agent-owned working memory the parser ignores (like plan/deadEnds);
			// it survives only in the raw text the unknown-field peek renders, not the typed value.
			const raw = JSON.stringify({
				schemaVersion: 1,
				phase: 'hardening',
				reviewLoop: { status: 'running', waves: [] },
			});
			const value = ok(parseTicketFile(raw, '853'));
			assert.strictEqual(value.phase, 'hardening');
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
				dispatch: {
					maxConcurrent: 3,
					items: [{ kind: 'ticket', key: '19', prompt: '/status-pipe:work-ticket 19', worktree: '/wt/19' }],
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
				dispatch: {
					maxConcurrent: 3,
					items: [{ kind: 'ticket', key: '19', prompt: '/status-pipe:work-ticket 19', worktree: '/wt/19' }],
				},
				note: 'all quiet',
			});
		});

		it('defaults maxConcurrent to item count and drops malformed items', () => {
			const raw = JSON.stringify({
				schemaVersion: 1,
				dispatch: {
					items: [
						{ kind: 'epic', key: 'auth', prompt: '/status-pipe:work-epic /e/auth.md', worktree: '/wt/auth' },
						{ kind: 'ticket', key: '20' }, // missing prompt/worktree → dropped
						{ kind: 'bogus', key: '21', prompt: 'p', worktree: '/wt/21' }, // bad kind → dropped
					],
				},
			});
			const dispatch = ok(parseOrchestratorFile(raw)).dispatch;
			assert.strictEqual(dispatch?.items.length, 1);
			assert.strictEqual(dispatch?.maxConcurrent, 1);
			assert.strictEqual(dispatch?.items[0].key, 'auth');
		});

		it('nulls dispatch when absent or with no valid items', () => {
			assert.strictEqual(ok(parseOrchestratorFile('{"schemaVersion": 1}')).dispatch, null);
			const empty = JSON.stringify({ schemaVersion: 1, dispatch: { items: [{ key: 'x' }] } });
			assert.strictEqual(ok(parseOrchestratorFile(empty)).dispatch, null);
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
						type: 'exec',
						command: 'claude',
						args: ['-p'],
						stdin: 'tick',
						cwd: 'sub',
						env: { FOO: 'bar' },
						lifetime: 'scheduled',
						intervalMinutes: 5,
						timeoutMinutes: 20,
					},
					{ command: 'node', lifetime: 'daemon' },
				],
			});
			const value = ok(parseLaunchFile(raw));
			assert.strictEqual(value.agents.length, 2);
			assert.deepStrictEqual(value.agents[1], {
				id: 'agent-1',
				title: 'agent-1',
				type: 'exec',
				command: 'node',
				args: [],
				stdin: '',
				cwd: '.',
				env: {},
				lifetime: 'daemon',
				intervalMinutes: 10,
				timeoutMinutes: 45,
			});
		});

		it('defaults an untyped entry with a command to exec / scheduled (back-compat)', () => {
			const agent = ok(parseLaunchFile('{"schemaVersion":1,"agents":[{"command":"node"}]}')).agents[0];
			assert.strictEqual(agent.type, 'exec');
			assert.strictEqual(agent.lifetime, 'scheduled');
		});

		it('supplies the claude command + role default args for reserved ids', () => {
			const raw = JSON.stringify({
				schemaVersion: 1,
				agents: [
					{ id: 'tick', type: 'claude' },
					{ id: 'worker', type: 'claude', cwd: '%worktree%' },
				],
			});
			const value = ok(parseLaunchFile(raw));
			const tick = value.agents.find((a) => a.id === 'tick');
			const worker = value.agents.find((a) => a.id === 'worker');
			assert.strictEqual(tick?.command, 'claude');
			// Assert the FULL resolved args, including the stream-json/verbose/auto
			// tail the supervisor relies on for liveness parsing and unattended runs.
			const tail = ['--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto'];
			assert.deepStrictEqual(tick?.args, ['-p', '/status-pipe:tick --max-concurrent 3', ...tail]);
			assert.deepStrictEqual(worker?.args, ['-p', '%prompt%', ...tail]);
			assert.strictEqual(worker?.cwd, '%worktree%');
		});

		it('lets a claude entry override the default args', () => {
			const raw = '{"schemaVersion":1,"agents":[{"id":"tick","type":"claude","args":["-p","custom"]}]}';
			assert.deepStrictEqual(ok(parseLaunchFile(raw)).agents[0].args, ['-p', 'custom']);
		});

		it('falls back to the `claude` command when a claude entry blanks it (no ENOENT spawn)', () => {
			// An explicit empty command must default to `claude`, not reach spawn() as
			// `""`; `??` would have leaked the empty string through. (Reserved id supplies args.)
			const raw = '{"schemaVersion":1,"agents":[{"id":"tick","type":"claude","command":""}]}';
			assert.strictEqual(ok(parseLaunchFile(raw)).agents[0].command, 'claude');
		});

		it('accepts a built-in tick entry with no command/args', () => {
			const raw = '{"schemaVersion":1,"agents":[{"id":"tick","type":"built-in"}]}';
			const agent = ok(parseLaunchFile(raw)).agents[0];
			assert.strictEqual(agent.type, 'built-in');
			assert.strictEqual(agent.command, '');
			assert.deepStrictEqual(agent.args, []);
			assert.strictEqual(agent.lifetime, 'scheduled');
		});

		it('drops a built-in entry on any id other than the reserved tick', () => {
			const raw = JSON.stringify({
				schemaVersion: 1,
				agents: [
					{ id: 'tick', type: 'built-in' },
					{ id: 'other', type: 'built-in' },
				],
			});
			const value = ok(parseLaunchFile(raw));
			assert.deepStrictEqual(
				value.agents.map((a) => a.id),
				['tick'],
			);
		});

		it('filters env to string values only', () => {
			const raw = JSON.stringify({
				schemaVersion: 1,
				agents: [{ command: 'node', env: { A: 'x', B: 5, C: null, D: { nested: true } } }],
			});
			assert.deepStrictEqual(ok(parseLaunchFile(raw)).agents[0].env, { A: 'x' });
		});

		it('drops exec entries with no command and claude entries lacking a role default or args', () => {
			const raw = JSON.stringify({
				schemaVersion: 1,
				agents: [{ type: 'exec' }, { id: 'custom', type: 'claude' }, { command: 'node' }],
			});
			const value = ok(parseLaunchFile(raw));
			assert.strictEqual(value.agents.length, 1);
			assert.strictEqual(value.agents[0].id, 'agent-2');
		});

		it('reports a launch file with no valid agents as corrupt', () => {
			for (const raw of ['{"schemaVersion": 1}', '{"schemaVersion": 1, "agents": [{"type": "exec"}]}']) {
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
				inventoryAssignees: [],
				ticketSource: null,
				jiraSiteUrl: null,
				jiraProjectKey: null,
				staleWorkerMinutes: null,
				trustMode: null,
				trustOperators: [],
				reviewGateRequireCiGreen: true,
				reviewGateWaitForBots: [],
				reviewGateBotWaitMaxMinutes: 30,
			});
		});

		it('parses a fully-populated config', () => {
			const raw = JSON.stringify({
				schemaVersion: 1,
				epics: { dir: 'plans' },
				inventory: { label: 'queue', assignees: ['ekohlwey', 'ed-irl'] },
				tickets: { source: 'jira-cloud', jira: { siteUrl: 'https://irl.atlassian.net', projectKey: 'PROJ' } },
				staleWorkerMinutes: 45,
				trust: { mode: 'multi-maintainer', operators: ['ekohlwey', 'ed-irl'] },
				reviewGate: { requireCiGreen: false, waitForBots: ['gemini-code-assist[bot]'], botWaitMaxMinutes: 45 },
			});
			assert.deepStrictEqual(ok(parseConfigFile(raw)), {
				schemaVersion: 1,
				epicsDir: 'plans',
				inventoryLabel: 'queue',
				inventoryAssignees: ['ekohlwey', 'ed-irl'],
				ticketSource: 'jira-cloud',
				jiraSiteUrl: 'https://irl.atlassian.net',
				jiraProjectKey: 'PROJ',
				staleWorkerMinutes: 45,
				trustMode: 'multi-maintainer',
				trustOperators: ['ekohlwey', 'ed-irl'],
				reviewGateRequireCiGreen: false,
				reviewGateWaitForBots: ['gemini-code-assist[bot]'],
				reviewGateBotWaitMaxMinutes: 45,
			});
		});

		it('defaults reviewGate: requireCiGreen on, no bots, 30-minute bound', () => {
			const value = ok(parseConfigFile('{"schemaVersion": 1}'));
			assert.strictEqual(value.reviewGateRequireCiGreen, true);
			assert.deepStrictEqual(value.reviewGateWaitForBots, []);
			assert.strictEqual(value.reviewGateBotWaitMaxMinutes, 30);
		});

		it('only an explicit false disables requireCiGreen; a malformed value keeps the default', () => {
			const off = ok(parseConfigFile(JSON.stringify({ schemaVersion: 1, reviewGate: { requireCiGreen: false } })));
			assert.strictEqual(off.reviewGateRequireCiGreen, false);
			const garbled = ok(parseConfigFile(JSON.stringify({ schemaVersion: 1, reviewGate: { requireCiGreen: 'no' } })));
			assert.strictEqual(garbled.reviewGateRequireCiGreen, true);
		});

		it('drops non-string waitForBots entries and a malformed botWaitMaxMinutes', () => {
			const raw = JSON.stringify({
				schemaVersion: 1,
				reviewGate: { waitForBots: ['gemini-code-assist[bot]', 7, null], botWaitMaxMinutes: 'soon' },
			});
			const value = ok(parseConfigFile(raw));
			assert.deepStrictEqual(value.reviewGateWaitForBots, ['gemini-code-assist[bot]']);
			assert.strictEqual(value.reviewGateBotWaitMaxMinutes, 30);
		});

		it('clamps a negative botWaitMaxMinutes to 0 (never a wait bound in the past)', () => {
			const raw = JSON.stringify({ schemaVersion: 1, reviewGate: { botWaitMaxMinutes: -5 } });
			const value = ok(parseConfigFile(raw));
			assert.strictEqual(value.reviewGateBotWaitMaxMinutes, 0);
		});

		it('flattens the per-channel object form of trust.operators', () => {
			const raw = JSON.stringify({
				schemaVersion: 1,
				trust: { mode: 'multi-maintainer', operators: { bitbucket: ['{uuid}'], jira: ['acct-1'] } },
			});
			assert.deepStrictEqual(ok(parseConfigFile(raw)).trustOperators, ['{uuid}', 'acct-1']);
		});

		it('flattens the per-channel object form of inventory.assignees', () => {
			const raw = JSON.stringify({
				schemaVersion: 1,
				inventory: { label: 'queue', assignees: { bitbucket: ['{uuid}'], jira: ['acct-1', 'acct-2'] } },
			});
			assert.deepStrictEqual(ok(parseConfigFile(raw)).inventoryAssignees, ['{uuid}', 'acct-1', 'acct-2']);
		});

		it('treats a malformed inventory.assignees as no scoping', () => {
			const raw = JSON.stringify({ schemaVersion: 1, inventory: { assignees: 'ekohlwey' } });
			assert.deepStrictEqual(ok(parseConfigFile(raw)).inventoryAssignees, []);
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
