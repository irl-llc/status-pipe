/**
 * E2E: protocol-dir discovery against the fixture workspace — the
 * extension finds the repo, and revealTicketFile opens the ticket JSON.
 * Also exercises the file watcher path indirectly: a ticket file created
 * after activation becomes revealable.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { activateExtension } from '../helpers/extensionHelper';

function fixtureRepoRoot(): string {
	const folders = vscode.workspace.workspaceFolders;
	assert.ok(folders && folders.length > 0, 'fixture workspace should be open');
	return path.join(folders[0].uri.fsPath, 'fleet-api');
}

describe('Protocol discovery', () => {
	before(async () => {
		await activateExtension();
	});

	it('opens the ticket file via statusPipe.revealTicketFile', async () => {
		const repoRoot = fixtureRepoRoot();
		await vscode.commands.executeCommand('statusPipe.revealTicketFile', repoRoot, '142');
		const active = vscode.window.activeTextEditor;
		assert.ok(active, 'an editor should be active');
		assert.ok(active.document.uri.fsPath.endsWith(path.join('tickets', '142.json')), 'ticket JSON should be open');
		const parsed = JSON.parse(active.document.getText()) as { ticket?: string };
		assert.strictEqual(parsed.ticket, '142');
	});

	it('reveals a ticket file created after activation (watcher path)', async () => {
		const repoRoot = fixtureRepoRoot();
		const newTicket = path.join(repoRoot, '.status-pipe', 'tickets', '900.json');
		fs.writeFileSync(
			newTicket,
			JSON.stringify({
				schemaVersion: 1,
				repo: 'acme/fleet-api',
				ticket: '900',
				title: 'Late arrival',
				phase: 'planning',
				health: 'ok',
				headline: 'Just created.',
				updatedAt: new Date().toISOString(),
			}),
		);
		// Give the 250ms-coalesced watcher a moment to pick it up.
		await new Promise((resolve) => setTimeout(resolve, 1500));
		await vscode.commands.executeCommand('statusPipe.revealTicketFile', repoRoot, '900');
		const active = vscode.window.activeTextEditor;
		assert.ok(active, 'an editor should be active');
		assert.ok(active.document.uri.fsPath.endsWith('900.json'));
	});

	it('refresh command executes without error', async () => {
		await vscode.commands.executeCommand('statusPipe.refresh');
	});
});
