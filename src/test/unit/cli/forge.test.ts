/**
 * CLI forge connection (src/cli/forge.ts). connectForge resolves the forge,
 * token (env branch), and inventory with no network call up to openInventory, so
 * the host-matching logic is unit-testable offline. Covers the GHES/Actions web
 * host: the remote is matched against GITHUB_BASE_URL, else GITHUB_SERVER_URL
 * (Actions-native) — without that fallback an enterprise remote would not match.
 */

import * as assert from 'assert';

import { connectForge } from '../../../cli/forge';

describe('cli/forge connectForge', () => {
	it('resolves a github.com remote and slug', async () => {
		const res = await connectForge('https://github.com/acme/app.git', { GITHUB_TOKEN: 't' });
		assert.ok(res.ok);
		assert.equal(res.value.repoSlug, 'acme/app');
	});

	it('resolves a GHES remote via GITHUB_SERVER_URL (the Actions-native web host)', async () => {
		const res = await connectForge('https://github.acme.com/o/r.git', {
			GITHUB_TOKEN: 't',
			GITHUB_SERVER_URL: 'https://github.acme.com',
			GITHUB_API_URL: 'https://github.acme.com/api/v3',
		});
		assert.ok(res.ok);
		assert.equal(res.value.repoSlug, 'o/r');
	});

	it('rejects a GHES remote when no web-host override is set (host mismatch, fail loud)', async () => {
		const res = await connectForge('https://github.acme.com/o/r.git', { GITHUB_TOKEN: 't' });
		assert.equal(res.ok, false);
	});

	it('fails when there is no remote', async () => {
		const res = await connectForge(null, { GITHUB_TOKEN: 't' });
		assert.equal(res.ok, false);
	});
});
