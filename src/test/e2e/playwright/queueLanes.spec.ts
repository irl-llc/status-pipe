/**
 * Snapshot + semantics: the three lanes, priority ordering, card anatomy,
 * stack indicators, stale-worker escalation, degraded cards — rendered
 * from protocol files alone (no forge enrichment).
 */

import { expect, test } from '@playwright/test';

import { buildFixtureWorkspace } from '../fixtures/protocolFixtures';
import { degradedRepo, lanesRepo } from './fixtures/scenarios';
import { launchVSCode, type VSCodeInstance } from './fixtures/vscode';
import { clearNotifications, openQueueEditor, openQueueView, setSidebarWidth } from './fixtures/webview';

test.describe('queue lanes', () => {
	let vscode: VSCodeInstance;

	test.afterEach(async () => {
		await vscode?.close();
	});

	test('editor view renders lanes, priorities, and stack indicators', async () => {
		const workspace = buildFixtureWorkspace([lanesRepo()]);
		vscode = await launchVSCode(workspace);
		const frame = await openQueueEditor(vscode.workbench);

		// Lanes with counts.
		await expect(frame.locator('.lane-header', { hasText: 'NEEDS YOU' })).toBeVisible();
		await expect(frame.locator('.lane-header', { hasText: 'WAITING ON WORLD' })).toBeVisible();
		await expect(frame.locator('.lane-header', { hasText: 'QUIET' })).toBeVisible();

		// Priority order inside NEEDS YOU: stale worker (#190) first, then
		// blocked (#177), then owner question (#142), then review (#155).
		const keys = await frame.locator('.card .ticket-key').allTextContents();
		const order = ['#190', '#177', '#142', '#155'];
		const positions = order.map((k) => keys.indexOf(k));
		expect(positions.every((p) => p >= 0)).toBe(true);
		expect([...positions]).toEqual([...positions].sort((a, b) => a - b));

		// Stack indicators from head/base matching across tickets.
		await expect(frame.locator('.stack-ref', { hasText: '↑ T1a #512' })).toBeVisible();
		await expect(frame.locator('.stack-ref', { hasText: '↓ T2 #530' })).toBeVisible();

		// Blockers render verbatim in red text.
		await expect(frame.locator('.blocker-line', { hasText: 'STRIPE_SANDBOX_KEY' })).toBeVisible();

		// The ack control is present on the owner-question card.
		await expect(frame.locator('.text-button', { hasText: 'Ready for another look' }).first()).toBeVisible();

		await clearNotifications(vscode.workbench);
		await expect(vscode.workbench).toHaveScreenshot('lanes-editor.png', { fullPage: true });
	});

	test('tray view renders the compact triage index', async () => {
		const workspace = buildFixtureWorkspace([lanesRepo()]);
		vscode = await launchVSCode(workspace);
		await setSidebarWidth(vscode.workbench, 500);
		const frame = await openQueueView(vscode.workbench);
		await expect(frame.locator('.lane-header', { hasText: 'NEEDS YOU' })).toBeVisible();
		await expect(frame.locator('.card').first()).toBeVisible();
		await clearNotifications(vscode.workbench);
		await expect(vscode.workbench).toHaveScreenshot('lanes-tray.png', { fullPage: true });
	});

	test('unknown schema renders a degraded card, never hidden', async () => {
		const workspace = buildFixtureWorkspace([degradedRepo()]);
		vscode = await launchVSCode(workspace);
		const frame = await openQueueEditor(vscode.workbench);
		await expect(frame.locator('.card', { hasText: 'update status-pipe' })).toBeVisible();
		await expect(frame.locator('.lane-header', { hasText: 'NEEDS YOU (1)' })).toBeVisible();
		await clearNotifications(vscode.workbench);
		await expect(vscode.workbench).toHaveScreenshot('degraded-card.png', { fullPage: true });
	});
});
