/**
 * Tests for the git-credential lookup (src/forge/gitCredential.ts) — a fake
 * `git` on PATH answers `credential fill`, so the parse, the non-interactive
 * env, and the no-credential path are all exercised against a real spawn.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { fillGitCredential, hostOfUrl } from '../../../forge/gitCredential';

const FAKE_GIT = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] !== 'credential' || args[1] !== 'fill') process.exit(1);
const input = fs.readFileSync(0, 'utf8');
fs.writeFileSync(process.env.FAKE_GIT_CRED_LOG, input + 'prompt=' + (process.env.GIT_TERMINAL_PROMPT || '') + '\\n');
if (!process.env.FAKE_GIT_CRED) process.exit(1);
process.stdout.write(process.env.FAKE_GIT_CRED);
`;

describe('forge/gitCredential', () => {
	let dir: string;
	let credLog: string;
	let originalPath: string | undefined;

	before(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-pipe-cred-'));
		credLog = path.join(dir, 'cred.log');
		fs.writeFileSync(path.join(dir, 'git'), FAKE_GIT, { mode: 0o755 });
		originalPath = process.env.PATH;
		process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ''}`;
		process.env.FAKE_GIT_CRED_LOG = credLog;
	});

	after(() => {
		process.env.PATH = originalPath;
		delete process.env.FAKE_GIT_CRED;
		delete process.env.FAKE_GIT_CRED_LOG;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('parses username/password and asks for the right host, non-interactively', async () => {
		process.env.FAKE_GIT_CRED = 'protocol=https\nhost=github.com\nusername=ed\npassword=helper-tok\n';
		const cred = await fillGitCredential('github.com');
		assert.deepEqual(cred, { username: 'ed', password: 'helper-tok' });
		const log = fs.readFileSync(credLog, 'utf8');
		assert.match(log, /host=github\.com/);
		assert.match(log, /prompt=0/); // GIT_TERMINAL_PROMPT=0 — never blocks on a prompt
	});

	it('returns a token-only credential with null username', async () => {
		process.env.FAKE_GIT_CRED = 'password=bare-token\n';
		assert.deepEqual(await fillGitCredential('bitbucket.org'), { username: null, password: 'bare-token' });
	});

	it('returns null when the helper has no stored credential', async () => {
		delete process.env.FAKE_GIT_CRED;
		assert.equal(await fillGitCredential('github.com'), null);
	});

	it('hostOfUrl extracts the credential-helper key from a base URL', () => {
		assert.equal(hostOfUrl('https://github.com'), 'github.com');
		assert.equal(hostOfUrl('https://bitbucket.org/'), 'bitbucket.org');
		assert.equal(hostOfUrl('not a url'), 'not a url');
	});
});
