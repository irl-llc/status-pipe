/**
 * Unit tests for releaseOutput.ts — the GitHub Actions step output the
 * scheduled auto-release emits to gate + steer the downstream publish job.
 */

import * as assert from 'assert';

import { formatReleaseOutput } from '../../../utils/releaseOutput';

describe('releaseOutput', () => {
	describe('formatReleaseOutput', () => {
		it('emits released=true with the tag when a release was cut', () => {
			assert.strictEqual(formatReleaseOutput({ released: true, tag: 'v0.1.0' }), 'released=true\ntag=v0.1.0\n');
		});

		it('emits released=false with an empty tag on a no-op day', () => {
			assert.strictEqual(formatReleaseOutput({ released: false, tag: '' }), 'released=false\ntag=\n');
		});

		it('always terminates each key with a newline so $GITHUB_OUTPUT parses', () => {
			const lines = formatReleaseOutput({ released: true, tag: 'v1.2.3' }).split('\n');
			// 'released=true', 'tag=v1.2.3', '' (trailing newline)
			assert.strictEqual(lines.length, 3);
			assert.strictEqual(lines[2], '');
		});
	});
});
