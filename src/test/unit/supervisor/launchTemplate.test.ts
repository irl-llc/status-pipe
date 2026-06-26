/**
 * Unit tests for supervisor/launchTemplate.ts — the `%home%` substitution
 * applied to a SpawnRequest at spawn time.
 */

import assert from 'node:assert/strict';

import { SpawnRequest } from '../../../supervisor/agentRunner';
import { resolveLaunchTemplates, resolveWorkerRequest, substituteHome } from '../../../supervisor/launchTemplate';

const HOME = '/Users/octocat';

function request(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
	return { command: 'claude', args: [], cwd: '.', env: {}, stdin: '', ...overrides };
}

describe('launchTemplate', () => {
	describe('substituteHome', () => {
		it('replaces every %home% occurrence', () => {
			assert.equal(substituteHome('%home%/.config:%home%/bin', HOME), `${HOME}/.config:${HOME}/bin`);
		});

		it('leaves a string without the token untouched', () => {
			assert.equal(substituteHome('/etc/profile', HOME), '/etc/profile');
		});

		it('does not interpret shell-style syntax', () => {
			// Deliberately NOT a shell: ${HOME} and %HOME% are left verbatim.
			assert.equal(substituteHome('${HOME}/%HOME%', HOME), '${HOME}/%HOME%');
		});
	});

	describe('resolveLaunchTemplates', () => {
		it('resolves %home% in command, args, cwd, and env values', () => {
			const resolved = resolveLaunchTemplates(
				request({
					command: '%home%/bin/agent',
					args: ['--config', '%home%/.config/x'],
					cwd: '%home%/work',
					env: { GH_CONFIG_DIR: '%home%/.config/claude-gh', LITERAL: 'plain' },
				}),
				HOME,
			);
			assert.equal(resolved.command, `${HOME}/bin/agent`);
			assert.deepEqual(resolved.args, ['--config', `${HOME}/.config/x`]);
			assert.equal(resolved.cwd, `${HOME}/work`);
			assert.deepEqual(resolved.env, { GH_CONFIG_DIR: `${HOME}/.config/claude-gh`, LITERAL: 'plain' });
		});

		it('leaves stdin untouched (prompt content, not a path)', () => {
			const resolved = resolveLaunchTemplates(request({ stdin: 'see %home% in the prompt' }), HOME);
			assert.equal(resolved.stdin, 'see %home% in the prompt');
		});
	});

	describe('resolveWorkerRequest', () => {
		const PROMPT = '/status-pipe:work-ticket 19';
		const WORKTREE = '/repo/.claude/worktrees/ticket-19';

		it('resolves %prompt% and %worktree% in args and cwd', () => {
			const resolved = resolveWorkerRequest(
				request({ args: ['-p', '%prompt%', '--permission-mode', 'auto'], cwd: '%worktree%' }),
				PROMPT,
				WORKTREE,
			);
			assert.deepEqual(resolved.args, ['-p', PROMPT, '--permission-mode', 'auto']);
			assert.equal(resolved.cwd, WORKTREE);
		});

		it('places the prompt as a single argv element (no shell splitting)', () => {
			const resolved = resolveWorkerRequest(
				request({ args: ['-p', '%prompt%'] }),
				`${PROMPT} Operator ack note: "do X"`,
				WORKTREE,
			);
			assert.equal(resolved.args.length, 2);
			assert.equal(resolved.args[1], `${PROMPT} Operator ack note: "do X"`);
		});

		it('substitutes worker tokens in stdin (for backends that read the prompt there)', () => {
			const resolved = resolveWorkerRequest(request({ stdin: '%prompt% @ %worktree%' }), PROMPT, WORKTREE);
			assert.equal(resolved.stdin, `${PROMPT} @ ${WORKTREE}`);
		});

		it('leaves %home% for the spawner to resolve later', () => {
			const resolved = resolveWorkerRequest(
				request({ env: { GH_CONFIG_DIR: '%home%/.config/claude-gh' } }),
				PROMPT,
				WORKTREE,
			);
			assert.equal(resolved.env.GH_CONFIG_DIR, '%home%/.config/claude-gh');
		});

		it('resolves a relative cwd against the worktree (never the host cwd)', () => {
			const resolved = resolveWorkerRequest(request({ cwd: 'sub/dir' }), PROMPT, WORKTREE);
			assert.equal(resolved.cwd, `${WORKTREE}/sub/dir`);
		});

		it('treats an empty/"." cwd as the worktree root', () => {
			assert.equal(resolveWorkerRequest(request({ cwd: '.' }), PROMPT, WORKTREE).cwd, WORKTREE);
			assert.equal(resolveWorkerRequest(request({ cwd: '' }), PROMPT, WORKTREE).cwd, WORKTREE);
		});

		it('leaves an absolute cwd untouched', () => {
			const resolved = resolveWorkerRequest(request({ cwd: '/srv/work' }), PROMPT, WORKTREE);
			assert.equal(resolved.cwd, '/srv/work');
		});

		it('leaves a %home%-anchored cwd for the spawner (does not resolve against worktree)', () => {
			const resolved = resolveWorkerRequest(request({ cwd: '%home%/work' }), PROMPT, WORKTREE);
			assert.equal(resolved.cwd, '%home%/work');
		});
	});
});
