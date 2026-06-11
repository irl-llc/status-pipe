/**
 * Unit tests for forge/registry.ts — forge resolution: auto (first match
 * wins) vs explicit override (always wins, slug parsed even off-host).
 */

import assert from 'node:assert/strict';

import { BitbucketForge } from '../../../forge/bitbucket';
import { GithubForge } from '../../../forge/github';
import { resolveForge } from '../../../forge/registry';
import { HttpClient } from '../../../forge/http';
import { Forge } from '../../../forge/types';

const noNetwork: HttpClient = () => {
	throw new Error('registry resolution must not touch the network');
};

function makeForges(): Forge[] {
	return [new GithubForge({ http: noNetwork }), new BitbucketForge({ http: noNetwork })];
}

describe('forge/registry', () => {
	describe('resolveForge (auto)', () => {
		it('matches the first registry entry whose host matches the URL', () => {
			const resolved = resolveForge(makeForges(), 'https://github.com/owner/repo.git', 'auto');
			assert.ok(resolved);
			assert.equal(resolved.forge.id, 'github');
			assert.equal(resolved.id.slug, 'owner/repo');
			assert.equal(resolved.id.prUrl(7), 'https://github.com/owner/repo/pull/7');
		});

		it('matches a later entry when the first does not match', () => {
			const resolved = resolveForge(makeForges(), 'git@bitbucket.org:workspace/repo.git', 'auto');
			assert.ok(resolved);
			assert.equal(resolved.forge.id, 'bitbucket');
			assert.equal(resolved.id.slug, 'workspace/repo');
		});

		it('returns null when no entry matches', () => {
			assert.equal(resolveForge(makeForges(), 'https://gitlab.example.com/owner/repo.git', 'auto'), null);
		});
	});

	describe('resolveForge (explicit override)', () => {
		it("'github' wins even for a bitbucket-host URL, parsing the slug", () => {
			const resolved = resolveForge(makeForges(), 'https://bitbucket.org/workspace/repo.git', 'github');
			assert.ok(resolved);
			assert.equal(resolved.forge.id, 'github');
			assert.equal(resolved.id.slug, 'workspace/repo');
			assert.equal(resolved.id.prUrl(3), 'https://github.com/workspace/repo/pull/3');
		});

		it('uses the host-aware match when the host does match', () => {
			const resolved = resolveForge(makeForges(), 'git@github.com:owner/repo.git', 'github');
			assert.ok(resolved);
			assert.equal(resolved.forge.id, 'github');
			assert.equal(resolved.id.slug, 'owner/repo');
		});

		it('returns null for an unknown override id', () => {
			assert.equal(resolveForge(makeForges(), 'https://github.com/owner/repo.git', 'gitlab'), null);
		});

		it('returns null when the override forge cannot parse the remote', () => {
			assert.equal(resolveForge(makeForges(), 'not a remote url', 'github'), null);
		});
	});

	it('returns null without a remote URL regardless of override', () => {
		assert.equal(resolveForge(makeForges(), null, 'auto'), null);
		assert.equal(resolveForge(makeForges(), null, 'github'), null);
	});
});
