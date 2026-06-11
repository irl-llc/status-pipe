/**
 * E2E: extension activation + command registration in a real VS Code
 * against the generated fixture workspace.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

import { EXTENSION_ID } from '../constants';
import { activateExtension } from '../helpers/extensionHelper';

const EXTENSION_COMMANDS = [
	'statusPipe.openInEditor',
	'statusPipe.refresh',
	'statusPipe.signIn.github',
	'statusPipe.signIn.bitbucket',
	'statusPipe.revealTicketFile',
	'statusPipe.agents.startAll',
	'statusPipe.agents.stopAll',
	'statusPipe.agents.tickNow',
	'statusPipe.agents.openLog',
];

describe('Extension Activation', () => {
	it('is present in installed extensions', () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(extension, `Extension ${EXTENSION_ID} should be installed`);
	});

	it('activates successfully', async () => {
		const extension = await activateExtension();
		assert.strictEqual(extension.isActive, true, 'Extension should be active');
	});

	describe('Command Registration', () => {
		before(async () => {
			await activateExtension();
		});

		it('registers all expected commands', async () => {
			const allCommands = await vscode.commands.getCommands(true);
			const missing = EXTENSION_COMMANDS.filter((cmd) => !allCommands.includes(cmd));
			assert.strictEqual(missing.length, 0, `Missing commands: ${missing.join(', ')}`);
		});
	});
});
