/**
 * The product sentence: an empty NEEDS-YOU lane renders
 * "All quiet — N agents running, M done today."
 */

import { expect, test } from '@playwright/test';

import { buildFixtureWorkspace } from '../fixtures/protocolFixtures';
import { QUIET_TOASTS, quietRepo } from './fixtures/scenarios';
import { launchVSCode, type VSCodeInstance } from './fixtures/vscode';
import { openQueueEditor } from './fixtures/webview';

test.describe('all quiet', () => {
	let vscode: VSCodeInstance;

	test.afterEach(async () => {
		await vscode?.close();
	});

	test('empty needs-you renders the product sentence', async () => {
		const workspace = buildFixtureWorkspace([quietRepo()], QUIET_TOASTS);
		vscode = await launchVSCode(workspace);
		const frame = await openQueueEditor(vscode.workbench);
		await expect(frame.locator('.lane-empty', { hasText: 'All quiet' })).toBeVisible();
		await expect(frame.locator('.lane-empty', { hasText: '1 done today' })).toBeVisible();
		await expect(vscode.workbench).toHaveScreenshot('all-quiet.png', { fullPage: true });
	});
});
