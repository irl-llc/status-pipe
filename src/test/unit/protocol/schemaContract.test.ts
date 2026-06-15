/**
 * The schema contract test design/07 promises: every fixture this repo's
 * tests feed to the extension, and everything the extension itself writes,
 * validates against schemas/ — one contract, two consumers (extension +
 * plugin), enforced in CI. Schema drift fails here, not in a prototype repo.
 */

import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildAck } from '../../../protocol/ackId';
import { degradedRepo, lanesRepo, quietRepo } from '../../e2e/playwright/fixtures/scenarios';
import { ticketBody } from '../../e2e/fixtures/protocolFixtures';
import { makeTicket } from '../queue/fixtures';

const SCHEMA_DIR = path.resolve(__dirname, '../../../../schemas');

function compile(name: string): ValidateFunction {
	const ajv = new Ajv({ strict: false, allErrors: true });
	addFormats(ajv);
	return ajv.compile(JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, `${name}.schema.json`), 'utf8')));
}

function assertValid(validate: ValidateFunction, value: unknown, label: string): void {
	assert.ok(validate(value), `${label} failed schema validation:\n${JSON.stringify(validate.errors, null, 2)}`);
}

describe('protocol/schema contract (schemas/ vs fixtures and writers)', () => {
	const ticketSchema = compile('ticket');
	const ackSchema = compile('ack');
	const orchestratorSchema = compile('orchestrator');
	const configSchema = compile('config');
	const launchSchema = compile('launch');

	it('validates every Playwright scenario ticket against ticket.schema.json', () => {
		for (const repo of [lanesRepo(), quietRepo()]) {
			for (const ticket of repo.tickets) {
				assertValid(ticketSchema, ticket.body, `scenario ticket ${ticket.key}`);
			}
		}
	});

	it('validates the e2e fixture factory output (incl. explicit nulls for optional fields)', () => {
		assertValid(ticketSchema, ticketBody({}), 'ticketBody defaults');
		assertValid(
			ticketSchema,
			ticketBody({ slug: null, url: null, headline: null, worker: null }),
			'ticketBody with explicit nulls',
		);
	});

	it('validates a ticket carrying agent working memory (plan/notes/deadEnds)', () => {
		assertValid(
			ticketSchema,
			ticketBody({
				plan: 'Implement the parser, then wire it into the CLI.',
				notes: 'Key file: src/parse.ts; gotcha: the lexer is whitespace-sensitive.',
				deadEnds: [
					{
						at: '2026-06-13T10:00:00Z',
						tried: 'publish the release to the registry',
						failedBecause: 'needs an operator-only publish token not present in this environment',
						doNotRetryWithout: 'operator runs the gated release step',
					},
					{ at: '2026-06-13T10:30:00Z', tried: 'bump the timeout', failedBecause: 'flaky test is a real race' },
				],
			}),
			'ticketBody with working memory',
		);

		assert.equal(
			ticketSchema(ticketBody({ deadEnds: [{ at: '2026-06-13T10:00:00Z' }] })),
			false,
			'a deadEnds entry missing required tried/failedBecause must fail validation',
		);
	});

	it('validates a ticket with the no-progress signal (stalledPasses)', () => {
		assertValid(ticketSchema, ticketBody({ stalledPasses: 2 }), 'ticketBody with stalledPasses');
		assert.equal(
			ticketSchema(ticketBody({ stalledPasses: -1 })),
			false,
			'a negative stalledPasses must fail validation (minimum: 0)',
		);
		assert.equal(
			ticketSchema(ticketBody({ stalledPasses: 1.5 })),
			false,
			'a fractional stalledPasses must fail validation (type: integer)',
		);
	});

	it('validates the unit fixture ticket (the parsed shape serializes to a valid file)', () => {
		assertValid(ticketSchema, JSON.parse(JSON.stringify(makeTicket())), 'makeTicket()');
	});

	it('REJECTS the degraded scenario ticket — unknown schemaVersion must not validate', () => {
		const degraded = degradedRepo().tickets[0];
		assert.equal(ticketSchema(degraded.body), false, 'schemaVersion 9 should fail the const:1 schema');
	});

	it('validates what the extension actually writes: buildAck output against ack.schema.json', () => {
		const ticket = makeTicket({
			ticket: '853',
			waitingOn: { kind: 'owner', ref: null, pr: null, since: '2026-06-11T07:55:22Z', detail: null },
		});
		const ack = buildAck({ ticket, note: 'answered', createdAt: '2026-06-11T08:05:00Z', createdBy: 'ed' });
		assert.ok(ack);
		assertValid(ackSchema, ack, 'buildAck payload');

		const blockersAck = buildAck({
			ticket: makeTicket({ blockers: ['needs key'], updatedAt: '2026-06-11T09:00:00Z' }),
			note: null,
			createdAt: '2026-06-11T09:05:00Z',
			createdBy: 'ed',
		});
		assert.ok(blockersAck);
		assertValid(ackSchema, blockersAck, 'buildAck blockers payload');
	});

	it('validates the scenario orchestrator files against orchestrator.schema.json', () => {
		for (const repo of [lanesRepo(), quietRepo()]) {
			if (repo.orchestrator) assertValid(orchestratorSchema, repo.orchestrator, `${repo.name} orchestrator`);
		}
		assertValid(
			orchestratorSchema,
			{
				schemaVersion: 1,
				repo: null,
				passCount: null,
				lastPassStartedAt: null,
				lastPassFinishedAt: null,
				staleWorkerMinutes: null,
				parked: { since: '2026-06-12T03:40:00Z', reason: 'all waiting on owner', recheckAfter: null },
				note: null,
			},
			'orchestrator with explicit nulls + parked',
		);
	});

	it('validates representative committed files against config and launch schemas', () => {
		assertValid(
			configSchema,
			{
				schemaVersion: 1,
				epics: { dir: 'epics' },
				inventory: { label: 'agent-queue', assignees: ['ekohlwey', 'ed-irl', 'ed-irl-codebot'] },
				tickets: { source: 'github-issues' },
				staleWorkerMinutes: 30,
				trust: { mode: 'multi-maintainer', operators: ['ed'], minAssociation: null },
				attribution: { commentPrefix: '**CLAUDE COMMENT**', includeAgentId: true },
			},
			'config example',
		);
		assertValid(
			launchSchema,
			{
				schemaVersion: 1,
				agents: [
					{ id: 'orc', title: 'Orchestrator', command: 'claude', args: ['-p'], stdin: 'tick', mode: 'tick' },
					{ command: 'claude', mode: 'daemon' },
				],
			},
			'launch example (second agent omits the optional id)',
		);
	});
});
