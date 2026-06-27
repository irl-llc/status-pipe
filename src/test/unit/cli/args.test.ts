/**
 * CLI argument parsing (src/cli/args.ts) — pure, so exhaustively table-driven:
 * the default command, every flag, value validation, and the error shapes that
 * drive the exit-2 usage path.
 */

import * as assert from 'assert';

import { parseArgs } from '../../../cli/args';

describe('cli/args parseArgs', () => {
	it('defaults a bare invocation to a tick run with empty options', () => {
		assert.deepEqual(parseArgs([]), {
			kind: 'run',
			options: { repoRoot: null, protocolDir: null, maxConcurrent: null, json: false },
		});
	});

	it('treats an explicit `tick` command identically to a bare invocation', () => {
		assert.deepEqual(parseArgs(['tick']), parseArgs([]));
	});

	it('collects every option', () => {
		const parsed = parseArgs(['tick', '--repo-root', '/r', '--protocol-dir', '/p', '--max-concurrent', '5', '--json']);
		assert.deepEqual(parsed, {
			kind: 'run',
			options: { repoRoot: '/r', protocolDir: '/p', maxConcurrent: 5, json: true },
		});
	});

	it('parses options without the leading command word', () => {
		assert.deepEqual(parseArgs(['--json']).kind, 'run');
	});

	it('recognizes help and version, taking precedence over other tokens', () => {
		assert.equal(parseArgs(['--help']).kind, 'help');
		assert.equal(parseArgs(['-h']).kind, 'help');
		assert.equal(parseArgs(['--version']).kind, 'version');
		assert.equal(parseArgs(['-V']).kind, 'version');
		assert.equal(parseArgs(['tick', '--json', '--help']).kind, 'help');
	});

	it('errors on an unknown argument', () => {
		const parsed = parseArgs(['--nope']);
		assert.equal(parsed.kind, 'error');
	});

	it('errors when a value flag is missing its value', () => {
		assert.equal(parseArgs(['--repo-root']).kind, 'error');
	});

	it('rejects a non-positive or non-integer --max-concurrent', () => {
		assert.equal(parseArgs(['--max-concurrent', '0']).kind, 'error');
		assert.equal(parseArgs(['--max-concurrent', '-1']).kind, 'error');
		assert.equal(parseArgs(['--max-concurrent', 'two']).kind, 'error');
		assert.equal(parseArgs(['--max-concurrent', '2.5']).kind, 'error');
	});
});
