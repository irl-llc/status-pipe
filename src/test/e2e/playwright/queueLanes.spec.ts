/**
 * Snapshot + semantics: the three lanes, priority ordering, card anatomy,
 * stack indicators, stale-worker escalation, degraded cards — rendered
 * from protocol files alone (no forge enrichment).
 */

import { expect, test } from '@playwright/test';

import { buildFixtureWorkspace } from '../fixtures/protocolFixtures';
import { QUIET_TOASTS, degradedRepo, lanesRepo } from './fixtures/scenarios';
import { launchVSCode, type VSCodeInstance } from './fixtures/vscode';
import { dragEditorSplitter, openQueueEditor, openQueueView, setSidebarWidth } from './fixtures/webview';

test.describe('queue lanes', () => {
	let vscode: VSCodeInstance;

	test.afterEach(async () => {
		await vscode?.close();
	});

	test('editor view renders lanes, priorities, and stack indicators', async () => {
		const workspace = buildFixtureWorkspace([lanesRepo()], QUIET_TOASTS);
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

		// Acked card (#150): calm accent (not the owner-question alarm) and a
		// pending chip; it sinks below the un-acked WAITING card #161 (issue #10).
		const ackedCard = frame.locator('.card', { has: frame.locator('.ticket-key', { hasText: '#150' }) });
		// Both the calm accent and the standalone `acked` token (the (?<![-\w]) guard
		// keeps it from matching the `acked` inside `accent-acked`).
		await expect(ackedCard).toHaveClass(/accent-acked/);
		await expect(ackedCard).toHaveClass(/(?<![-\w])acked\b/);
		await expect(ackedCard.locator('.ack-chip.pending')).toBeVisible();
		expect(keys.indexOf('#150')).toBeGreaterThan(keys.indexOf('#161'));

		// Dedicated baseline of the acked card alone (issue #10): isolates the
		// calm accent + dimmed lines + pending chip so a reviewer can see the
		// ack'd visual without hunting for it inside the full-lane shot above.
		await expect(ackedCard).toHaveScreenshot('acked-card.png');

		await expect(vscode.workbench).toHaveScreenshot('lanes-editor.png', { fullPage: true });
	});

	test('editor list pane is resizable via the splitter', async () => {
		const workspace = buildFixtureWorkspace([lanesRepo()], QUIET_TOASTS);
		vscode = await launchVSCode(workspace);
		const frame = await openQueueEditor(vscode.workbench);

		// Splitter affordance is present between the two panes.
		const splitter = frame.locator('.editor-splitter');
		await expect(splitter).toBeVisible();

		// Drag it wider; the list pane grows from the 340px default toward the
		// 640px clamp and the detail pane gives up the width.
		const widthBefore = await frame
			.locator('.editor-list')
			.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
		const widthAfter = await dragEditorSplitter(vscode.workbench, frame, 200);
		expect(widthAfter).toBeGreaterThan(widthBefore);

		await expect(vscode.workbench).toHaveScreenshot('lanes-editor-resized.png', { fullPage: true });
	});

	test('tray view renders the compact triage index', async () => {
		const workspace = buildFixtureWorkspace([lanesRepo()], QUIET_TOASTS);
		vscode = await launchVSCode(workspace);
		await setSidebarWidth(vscode.workbench, 500);
		const frame = await openQueueView(vscode.workbench);
		await expect(frame.locator('.lane-header', { hasText: 'NEEDS YOU' })).toBeVisible();
		await expect(frame.locator('.card').first()).toBeVisible();
		await expect(vscode.workbench).toHaveScreenshot('lanes-tray.png', { fullPage: true });
	});

	test('unknown schema renders a degraded card, never hidden', async () => {
		const workspace = buildFixtureWorkspace([degradedRepo()], QUIET_TOASTS);
		vscode = await launchVSCode(workspace);
		const frame = await openQueueEditor(vscode.workbench);
		await expect(frame.locator('.card', { hasText: 'update status-pipe' })).toBeVisible();
		await expect(frame.locator('.lane-header', { hasText: 'NEEDS YOU (1)' })).toBeVisible();
		await expect(vscode.workbench).toHaveScreenshot('degraded-card.png', { fullPage: true });
	});
});
