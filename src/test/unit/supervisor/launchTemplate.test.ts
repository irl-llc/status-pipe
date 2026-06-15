/**
 * Unit tests for supervisor/launchTemplate.ts — the `%home%` substitution
 * applied to a SpawnRequest at spawn time.
 */

import assert from 'node:assert/strict';

import { SpawnRequest } from '../../../supervisor/agentRunner';
import { resolveLaunchTemplates, substituteHome } from '../../../supervisor/launchTemplate';

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
});
