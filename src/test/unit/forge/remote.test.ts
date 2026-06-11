/**
 * Unit tests for forge/remote.ts — git remote URL parsing and host matching.
 */

import assert from 'node:assert/strict';

import { hostMatches, hostOf, parseRemote } from '../../../forge/remote';

describe('forge/remote', () => {
	describe('parseRemote', () => {
		it('parses an https remote', () => {
			assert.deepEqual(parseRemote('https://github.com/owner/repo'), {
				host: 'github.com',
				slug: 'owner/repo',
			});
		});

		it('parses an https remote with .git suffix', () => {
			assert.deepEqual(parseRemote('https://github.com/owner/repo.git'), {
				host: 'github.com',
				slug: 'owner/repo',
			});
		});

		it('parses an ssh:// remote', () => {
			assert.deepEqual(parseRemote('ssh://git@github.com/owner/repo.git'), {
				host: 'github.com',
				slug: 'owner/repo',
			});
		});

		it('parses an scp-like remote (git@host:owner/repo.git)', () => {
			assert.deepEqual(parseRemote('git@github.com:owner/repo.git'), {
				host: 'github.com',
				slug: 'owner/repo',
			});
		});

		it('parses an scp-like remote without a user', () => {
			assert.deepEqual(parseRemote('bitbucket.org:workspace/repo.git'), {
				host: 'bitbucket.org',
				slug: 'workspace/repo',
			});
		});

		it('lowercases the host and keeps slug case', () => {
			assert.deepEqual(parseRemote('https://GitHub.COM/Owner/Repo.git'), {
				host: 'github.com',
				slug: 'Owner/Repo',
			});
		});

		it('uses only the first two path segments', () => {
			assert.deepEqual(parseRemote('https://github.com/owner/repo/extra/segments'), {
				host: 'github.com',
				slug: 'owner/repo',
			});
		});

		it('trims surrounding whitespace', () => {
			assert.deepEqual(parseRemote('  git@github.com:owner/repo.git\n'), {
				host: 'github.com',
				slug: 'owner/repo',
			});
		});

		it('rejects garbage', () => {
			assert.equal(parseRemote('not a remote'), null);
		});

		it('rejects a URL with fewer than two path segments', () => {
			assert.equal(parseRemote('https://github.com/owner'), null);
			assert.equal(parseRemote('git@github.com:owner'), null);
		});

		it('rejects an empty string', () => {
			assert.equal(parseRemote(''), null);
		});

		it('rejects a name that is only .git', () => {
			assert.equal(parseRemote('https://github.com/owner/.git'), null);
		});
	});

	describe('hostMatches', () => {
		it('matches an exact host', () => {
			assert.equal(hostMatches('github.com', 'github.com'), true);
		});

		it('matches case-insensitively', () => {
			assert.equal(hostMatches('GitHub.com', 'github.COM'), true);
		});

		it('tolerates ssh subdomains (ssh.github.com under github.com)', () => {
			assert.equal(hostMatches('ssh.github.com', 'github.com'), true);
		});

		it('does not false-match suffix lookalikes (evilgithub.com)', () => {
			assert.equal(hostMatches('evilgithub.com', 'github.com'), false);
		});

		it('does not match in the reverse direction (forge under remote)', () => {
			assert.equal(hostMatches('github.com', 'ssh.github.com'), false);
		});

		it('does not match unrelated hosts', () => {
			assert.equal(hostMatches('bitbucket.org', 'github.com'), false);
		});
	});

	describe('hostOf', () => {
		it('extracts the hostname of a base URL', () => {
			assert.equal(hostOf('https://github.com'), 'github.com');
		});

		it('lowercases the hostname', () => {
			assert.equal(hostOf('https://GitHub.Example.COM/path'), 'github.example.com');
		});

		it('falls back to the lowercased input for a bare host', () => {
			assert.equal(hostOf('GitHub.com'), 'github.com');
		});
	});
});
