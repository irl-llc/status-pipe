/**
 * Live worker rows in the agents strip (issue #56): a supervisor-spawned
 * worker renders one read-only row whose sole control is Open log — the
 * exception to worker-row read-only-ness (design/05, design/09).
 *
 * Worker rows come from in-memory supervisor state, which the disk-fixture
 * harness can't spawn; the controller's display-only `STATUS_PIPE_E2E_WORKERS`
 * seam injects the same `DisplayState.workers` the jsdom layer constructs by
 * hand, so this is the snapshot oracle the jsdom tests defer to for the row's
 * 30px indent and the open-log glyph.
 */

import { expect, test } from '@playwright/test';

import { buildFixtureWorkspace } from '../fixtures/protocolFixtures';
import { QUIET_TOASTS, quietRepo } from './fixtures/scenarios';
import { launchVSCode, type VSCodeInstance } from './fixtures/vscode';
import { openQueueEditor } from './fixtures/webview';

test.describe('worker rows', () => {
	let vscode: VSCodeInstance;

	test.afterEach(async () => {
		await vscode?.close();
	});

	test('a live worker renders a read-only row whose only control is Open log', async () => {
		const workspace = buildFixtureWorkspace([quietRepo()], QUIET_TOASTS);
		vscode = await launchVSCode(workspace, {
			STATUS_PIPE_E2E_WORKERS: JSON.stringify([{ key: '19', currentTool: 'Edit', currentToolDetail: 'queue/lane.ts' }]),
		});
		const frame = await openQueueEditor(vscode.workbench);

		const row = frame.locator('.worker-row');
		await expect(row).toHaveCount(1);
		await expect(row).toContainText('19');
		// Deterministic activity meta (no live duration) — the seam leaves runningSince null.
		await expect(row).toContainText('running · Edit: queue/lane.ts');
		// Read-only: Open log is the lone action — no Run/Stop/Tick.
		await expect(row.locator('.agent-actions .icon-button')).toHaveCount(1);
		await expect(row.locator('[title="Open log"]')).toBeVisible();
		// Workers-only strip drops the "N launch configs" prefix.
		await expect(frame.locator('.agents-strip .summary')).toContainText('1 worker running');

		await expect(frame.locator('.agents-strip')).toHaveScreenshot('worker-row.png');
	});
});
