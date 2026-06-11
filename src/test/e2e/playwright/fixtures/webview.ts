/**
 * Webview fixture: opens the Status Pipe view via the command palette and
 * returns a Playwright `Frame` whose DOM contains our webview content.
 *
 * VS Code renders custom webview views through two layered iframes;
 * Playwright flattens nested frames into `page.frames()`. We scan all
 * frames from VS Code's webview-origin scheme and pick the one that
 * contains our well-known root element (the pattern proven in
 * git-spice-code-extension).
 */

import type { Frame, Page } from '@playwright/test';

import { waitForFontsReady } from './stability';

/** Root element our webview always renders (see host/webviewHtml.ts). */
const WEBVIEW_ROOT_SELECTOR = '#queueRoot';

/** Focuses the Status Pipe tray view and returns its content frame. */
export async function openQueueView(workbench: Page): Promise<Frame> {
	await runCommand(workbench, 'Focus on Queue View');
	const frame = await waitForQueueFrame(workbench, 30_000);
	await waitForFontsReady(frame);
	return frame;
}

/**
 * Opens the queue as a full editor pane (statusPipe.openInEditor). Gives
 * snapshot tests a wide canvas. Don't combine with openQueueView in one
 * test — both webviews match the root selector.
 */
export async function openQueueEditor(workbench: Page): Promise<Frame> {
	await runCommand(workbench, 'Status Pipe: Open in Editor');
	const frame = await waitForQueueFrame(workbench, 60_000);
	await waitForFontsReady(frame);
	return frame;
}

async function runCommand(workbench: Page, command: string): Promise<void> {
	await workbench.keyboard.press('F1');
	await workbench.locator('.quick-input-widget').waitFor({ state: 'visible', timeout: 10_000 });
	await workbench.keyboard.type(command);
	// Let the palette filter settle before pressing Enter.
	await workbench.waitForTimeout(500);
	await workbench.keyboard.press('Enter');
}

/** Waits for a webview frame containing our root element. */
export async function waitForQueueFrame(workbench: Page, timeoutMs: number): Promise<Frame> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const candidate = await findQueueFrame(workbench);
		if (candidate) return candidate;
		await workbench.waitForTimeout(250);
	}
	throw new Error(`Status Pipe webview frame did not appear within ${timeoutMs}ms`);
}

async function findQueueFrame(workbench: Page): Promise<Frame | undefined> {
	for (const frame of workbench.frames()) {
		if (!frame.url().startsWith('vscode-webview://')) continue;
		const count = await frame
			.locator(WEBVIEW_ROOT_SELECTOR)
			.count()
			.catch(() => 0);
		if (count > 0) return frame;
	}
	return undefined;
}

/**
 * Drags the sash between the primary sidebar and the editor area so the
 * sidebar is `widthPx` wide (the tray default ~300px clips cards).
 */
export async function setSidebarWidth(workbench: Page, widthPx: number): Promise<void> {
	const sidebar = workbench.locator('.monaco-workbench .part.sidebar').first();
	const sbBox = await sidebar.boundingBox();
	if (!sbBox) throw new Error('Primary sidebar has no bounding box');
	const sashes = workbench.locator('.monaco-sash.vertical');
	const nearest = await sashes.evaluateAll((els, target) => {
		let bestIndex = -1;
		let bestDelta = Infinity;
		els.forEach((el, i) => {
			const r = el.getBoundingClientRect();
			const delta = Math.abs(r.x + r.width / 2 - target);
			if (delta < bestDelta) {
				bestDelta = delta;
				bestIndex = i;
			}
		});
		return { index: bestIndex, delta: bestDelta };
	}, sbBox.x + sbBox.width);
	if (nearest.index < 0 || nearest.delta > 8) {
		throw new Error(`No vertical sash found near sidebar right edge; best delta ${nearest.delta}`);
	}
	const sash = sashes.nth(nearest.index);
	const box = await sash.boundingBox();
	if (!box) throw new Error('Resolved sash has no bounding box');
	const startY = box.y + box.height / 2;
	await workbench.mouse.move(box.x + box.width / 2, startY);
	await workbench.mouse.down();
	await workbench.mouse.move(sbBox.x + widthPx, startY, { steps: 10 });
	await workbench.mouse.up();
	await workbench.waitForTimeout(150);
}
