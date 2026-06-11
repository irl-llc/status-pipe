/**
 * Unit tests for supervisor/trustGate.ts (design/09 trust gating): the hash
 * covers the COMPLETE entry and the approval dialog text shows everything
 * the hash covers — nothing can ride through review unseen.
 */

import assert from 'node:assert/strict';

import { LaunchAgent } from '../../../protocol/types';
import { describeLaunchEntry, launchEntryHash } from '../../../supervisor/trustGate';

function agent(overrides: Partial<LaunchAgent> = {}): LaunchAgent {
	return {
		id: 'orchestrator',
		title: 'Orchestrator',
		command: 'claude',
		args: ['-p', 'tick'],
		stdin: 'run the pass',
		cwd: '/work/repo',
		env: { NODE_OPTIONS: '--max-old-space-size=4096', PATH: '/usr/bin' },
		mode: 'tick',
		intervalMinutes: 10,
		timeoutMinutes: 30,
		...overrides,
	};
}

describe('supervisor/trustGate', () => {
	describe('launchEntryHash', () => {
		it('is stable across object key order', () => {
			const reordered: LaunchAgent = {
				timeoutMinutes: 30,
				intervalMinutes: 10,
				mode: 'tick',
				env: { NODE_OPTIONS: '--max-old-space-size=4096', PATH: '/usr/bin' },
				cwd: '/work/repo',
				stdin: 'run the pass',
				args: ['-p', 'tick'],
				command: 'claude',
				title: 'Orchestrator',
				id: 'orchestrator',
			};
			assert.equal(launchEntryHash(agent()), launchEntryHash(reordered));
		});

		it('is stable across env var order', () => {
			const flipped = agent({ env: { PATH: '/usr/bin', NODE_OPTIONS: '--max-old-space-size=4096' } });
			assert.equal(launchEntryHash(agent()), launchEntryHash(flipped));
		});

		const changes: Array<[string, Partial<LaunchAgent>]> = [
			['command', { command: 'bash' }],
			['args', { args: ['-p', 'tock'] }],
			['stdin', { stdin: 'different prompt' }],
			['cwd', { cwd: '/work/other' }],
			['env value', { env: { NODE_OPTIONS: '--inspect', PATH: '/usr/bin' } }],
			['added env var', { env: { NODE_OPTIONS: '--max-old-space-size=4096', PATH: '/usr/bin', LD_PRELOAD: '/x.so' } }],
			['mode', { mode: 'daemon' }],
			['intervalMinutes', { intervalMinutes: 11 }],
			['timeoutMinutes', { timeoutMinutes: 31 }],
		];
		for (const [field, override] of changes) {
			it(`changes when ${field} changes`, () => {
				assert.notEqual(launchEntryHash(agent()), launchEntryHash(agent(override)));
			});
		}

		it('ignores display-only fields (id, title)', () => {
			assert.equal(launchEntryHash(agent()), launchEntryHash(agent({ id: 'other', title: 'Other' })));
		});
	});

	describe('describeLaunchEntry', () => {
		it('includes command with args, mode/intervals, cwd, and stdin', () => {
			const text = describeLaunchEntry(agent());
			assert.match(text, /command: claude -p tick/);
			assert.match(text, /mode: tick \(interval 10m, timeout 30m\)/);
			assert.match(text, /cwd: \/work\/repo/);
			assert.match(text, /stdin: run the pass/);
		});

		it('includes EVERY env var as k=v — the complete-entry guarantee', () => {
			const text = describeLaunchEntry(agent());
			assert.match(text, /NODE_OPTIONS=--max-old-space-size=4096/);
			assert.match(text, /PATH=\/usr\/bin/);
		});

		it('omits the stdin and env lines when empty', () => {
			const text = describeLaunchEntry(agent({ stdin: '', env: {} }));
			assert.doesNotMatch(text, /stdin:/);
			assert.doesNotMatch(text, /env:/);
		});
	});
});
