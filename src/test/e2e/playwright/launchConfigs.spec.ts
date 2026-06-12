/**
 * The launch-config strip and the unconfigured-workspace prompt:
 *  - declared launch configs render at the top with a Run control each;
 *  - a repo with no status files and no launch.json shows a configure prompt.
 */

import { expect, test } from '@playwright/test';

import { buildFixtureWorkspace } from '../fixtures/protocolFixtures';
import { QUIET_TOASTS, launchConfigsRepo, unconfiguredRepo } from './fixtures/scenarios';
import { launchVSCode, type VSCodeInstance } from './fixtures/vscode';
import { openQueueEditor } from './fixtures/webview';

test.describe('launch configs', () => {
	let vscode: VSCodeInstance;

	test.afterEach(async () => {
		await vscode?.close();
	});

	test('declared launch configs render a strip with per-config Run controls', async () => {
		const workspace = buildFixtureWorkspace([launchConfigsRepo()], QUIET_TOASTS);
		vscode = await launchVSCode(workspace);
		const frame = await openQueueEditor(vscode.workbench);

		await expect(frame.locator('.agents-strip .summary')).toContainText('2 launch configs');
		await expect(frame.locator('.agent-row')).toHaveCount(2);
		await expect(frame.locator('.agent-title', { hasText: 'Orchestrator' })).toBeVisible();
		await expect(frame.locator('.agent-row', { hasText: 'CI watcher' })).toContainText('not started');
		// Both declared-but-not-installed → a Run control, no Open log yet.
		await expect(frame.locator('.agent-actions [title="Run"]')).toHaveCount(2);
		await expect(frame.locator('.agent-actions [title="Open log"]')).toHaveCount(0);
		await expect(vscode.workbench).toHaveScreenshot('launch-configs-strip.png', { fullPage: true });
	});

	test('an unconfigured repo shows the configure prompt instead of all-quiet', async () => {
		const workspace = buildFixtureWorkspace([unconfiguredRepo()], QUIET_TOASTS);
		vscode = await launchVSCode(workspace);
		const frame = await openQueueEditor(vscode.workbench);

		await expect(frame.locator('.configure-prompt')).toContainText('No automation configured');
		await expect(frame.locator('.configure-prompt .text-button')).toHaveText('How to configure a launch file');
		await expect(frame.locator('.agents-strip')).toHaveCount(0);
		await expect(vscode.workbench).toHaveScreenshot('configure-prompt.png', { fullPage: true });
	});
});
