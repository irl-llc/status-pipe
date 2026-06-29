/**
 * CLI GitHub-token resolution (src/cli/auth.ts). The env branch is deterministic
 * and is the headless-CI path that matters most; the gh-CLI and git-credential
 * fallbacks shell out and are exercised by the full run + manual smoke, not here.
 */

import * as assert from 'assert';

import { resolveGithubToken } from '../../../cli/auth';

const BASE = 'https://github.com';

describe('cli/auth resolveGithubToken', () => {
	it('returns GITHUB_TOKEN when set', async () => {
		assert.equal(await resolveGithubToken(BASE, { GITHUB_TOKEN: 'tok-a' }), 'tok-a');
	});

	it('falls back to GH_TOKEN', async () => {
		assert.equal(await resolveGithubToken(BASE, { GH_TOKEN: 'tok-b' }), 'tok-b');
	});

	it('prefers GITHUB_TOKEN over GH_TOKEN', async () => {
		assert.equal(await resolveGithubToken(BASE, { GITHUB_TOKEN: 'tok-a', GH_TOKEN: 'tok-b' }), 'tok-a');
	});
});
