/**
 * Unit tests for the Claude Code stream-json parser/reducer
 * (src/output/claudeStream.ts) — folds NDJSON launcher output into the
 * rolling AgentActivity the webview renders.
 */

import assert from 'node:assert/strict';

import { ClaudeActivityReducer, parseStreamLine } from '../../../output/claudeStream';

function line(obj: unknown): string {
	return `${JSON.stringify(obj)}\n`;
}

describe('output/claudeStream', () => {
	describe('parseStreamLine', () => {
		it('parses a JSON object line', () => {
			assert.deepEqual(parseStreamLine('{"type":"system"}'), { type: 'system' });
		});
		it('returns null for blank, non-object, and malformed lines', () => {
			for (const raw of ['', '   ', 'not json', '[1,2]', '"str"', '{"oops": ']) {
				assert.equal(parseStreamLine(raw), null);
			}
		});
	});

	describe('ClaudeActivityReducer', () => {
		it('tracks a full run: init → assistant text/tool → result', () => {
			const r = new ClaudeActivityReducer();
			r.pushChunk(line({ type: 'system', subtype: 'init', model: 'claude-opus-4-8' }));
			assert.equal(r.snapshot().phase, 'starting');
			assert.equal(r.snapshot().model, 'claude-opus-4-8');

			r.pushChunk(
				line({
					type: 'assistant',
					message: {
						model: 'claude-opus-4-8',
						usage: { input_tokens: 1200, output_tokens: 340 },
						content: [
							{ type: 'text', text: '  Looking at the failing test.  ' },
							{ type: 'tool_use', name: 'Bash', input: { command: 'npm test -- --grep parse' } },
						],
					},
				}),
			);
			let a = r.snapshot();
			assert.equal(a.phase, 'working');
			assert.equal(a.lastText, 'Looking at the failing test.');
			assert.equal(a.currentTool, 'Bash');
			assert.equal(a.currentToolDetail, 'npm test -- --grep parse');
			assert.equal(a.toolCalls, 1);
			assert.equal(a.inputTokens, 1200);
			assert.equal(a.outputTokens, 340);

			r.pushChunk(
				line({
					type: 'result',
					subtype: 'success',
					is_error: false,
					result: 'Fixed the parser and all tests pass.',
					total_cost_usd: 0.0423,
					duration_ms: 91200,
					num_turns: 7,
				}),
			);
			a = r.snapshot();
			assert.equal(a.phase, 'done');
			assert.deepEqual(a.result, { ok: true, text: 'Fixed the parser and all tests pass.' });
			assert.equal(a.costUsd, 0.0423);
			assert.equal(a.durationMs, 91200);
			assert.equal(a.numTurns, 7);
		});

		it('counts multiple tool calls and keeps the most recent as current', () => {
			const r = new ClaudeActivityReducer();
			r.pushChunk(
				line({
					type: 'assistant',
					message: {
						content: [
							{ type: 'tool_use', name: 'Read', input: { file_path: '/work/src/protocol/parse.ts' } },
							{ type: 'tool_use', name: 'Edit', input: { file_path: '/work/src/protocol/types.ts' } },
						],
					},
				}),
			);
			const a = r.snapshot();
			assert.equal(a.toolCalls, 2);
			assert.equal(a.currentTool, 'Edit');
			assert.equal(a.currentToolDetail, 'protocol/types.ts'); // last two path segments
		});

		it('marks an error result as phase error with result.ok false', () => {
			const r = new ClaudeActivityReducer();
			r.pushChunk(line({ type: 'result', subtype: 'error_max_turns', is_error: true, result: null }));
			const a = r.snapshot();
			assert.equal(a.phase, 'error');
			assert.deepEqual(a.result, { ok: false, text: null });
		});

		it('reassembles events split across chunk boundaries', () => {
			const r = new ClaudeActivityReducer();
			const full = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } });
			const mid = Math.floor(full.length / 2);
			r.pushChunk(full.slice(0, mid));
			assert.equal(r.snapshot().lastText, null); // line not complete yet
			r.pushChunk(full.slice(mid));
			assert.equal(r.snapshot().lastText, 'hello');
		});

		it('ignores malformed/unknown lines without throwing', () => {
			const r = new ClaudeActivityReducer();
			r.pushChunk('garbage not json\n');
			r.pushChunk(line({ type: 'stream_event', foo: 'bar' })); // unknown type
			r.pushChunk(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }));
			assert.equal(r.snapshot().lastText, 'ok');
		});

		it('reset() clears activity and the line buffer', () => {
			const r = new ClaudeActivityReducer();
			r.pushChunk(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }));
			r.pushChunk('{"type":"assist'); // partial in buffer
			r.reset();
			assert.equal(r.snapshot().lastText, null);
			r.pushChunk('ant"}\n'); // must NOT complete the discarded partial
			assert.equal(r.snapshot().phase, null); // leftover fragment is gone → garbage line ignored
			r.pushChunk(line({ type: 'assistant', message: { content: [] } }));
			assert.equal(r.snapshot().phase, 'working'); // reducer still works after reset
		});

		it('derives tool detail from command, pattern, url, or Task description', () => {
			const cases: Array<[string, Record<string, unknown>, string]> = [
				['Grep', { pattern: 'TODO' }, 'TODO'],
				['WebFetch', { url: 'https://example.com' }, 'https://example.com'],
				['Task', { description: 'audit forge layer' }, 'audit forge layer'],
			];
			for (const [name, input, expected] of cases) {
				const r = new ClaudeActivityReducer();
				r.pushChunk(line({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } }));
				assert.equal(r.snapshot().currentToolDetail, expected, name);
			}
		});
	});
});
