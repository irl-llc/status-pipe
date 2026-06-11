/**
 * The product's core interaction end-to-end: click "Ready for another
 * look", attach a note, and verify the idempotent ack file lands in the
 * repo's inbox with the protocol-correct 8-hex id.
 */

import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildFixtureWorkspace, ticketBody } from '../fixtures/protocolFixtures';
import { QUIET_TOASTS, minutesAgo } from './fixtures/scenarios';
import { launchVSCode, type VSCodeInstance } from './fixtures/vscode';
import { openQueueEditor } from './fixtures/webview';

test.describe('ack flow', () => {
	let vscode: VSCodeInstance;

	test.afterEach(async () => {
		await vscode?.close();
	});

	test('Ready for another look writes the ack file and shows the chip', async () => {
		const since = minutesAgo(90);
		const workspace = buildFixtureWorkspace(
			[
				{
					name: 'fleet-api',
					remoteUrl: 'https://github.com/acme/fleet-api.git',
					tickets: [
						{
							key: '142',
							body: ticketBody({
								ticket: '142',
								title: 'Rotate signing keys',
								health: 'waiting',
								headline: 'Asked the owner a question.',
								waitingOn: {
									kind: 'owner',
									ref: 'https://github.com/acme/fleet-api/issues/142#issuecomment-1',
									pr: null,
									since,
									detail: 'rotation window configurable?',
								},
								updatedAt: since,
							}),
						},
					],
				},
			],
			QUIET_TOASTS,
		);
		vscode = await launchVSCode(workspace);
		const frame = await openQueueEditor(vscode.workbench);

		await frame.locator('.text-button', { hasText: 'Ready for another look' }).first().click();
		await frame.locator('.ack-note-input').fill('Answered — go with option B');
		await frame.locator('.ack-note-input').press('Enter');

		// The protocol-correct idempotent id: sha256(ticket+kind+since)[0:8].
		const ackId = createHash('sha256').update(`142owner${since}`, 'utf8').digest('hex').slice(0, 8);
		const ackPath = join(workspace, 'fleet-api', '.status-pipe', 'inbox', '142', `ack-${ackId}.json`);
		await expect.poll(() => existsSync(ackPath), { timeout: 15_000 }).toBe(true);

		const ack = JSON.parse(readFileSync(ackPath, 'utf8')) as Record<string, unknown>;
		expect(ack.kind).toBe('ready-for-look');
		expect(ack.ackId).toBe(ackId);
		expect(ack.note).toBe('Answered — go with option B');

		// Chip appears in the fixed ack slot; the card leaves NEEDS YOU.
		await expect(frame.locator('.ack-chip', { hasText: 'sent' }).first()).toBeVisible({ timeout: 15_000 });
		await expect(vscode.workbench).toHaveScreenshot('ack-sent-chip.png', { fullPage: true });
	});
});
