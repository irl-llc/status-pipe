/**
 * Snapshot-stability helpers for Playwright tests.
 *
 * VS Code's webview CSP blocks `frame.addStyleTag` (style-src 'self'
 * https://*.vscode-cdn.net), so we can't inject a global "kill
 * transitions" stylesheet. We rely on Playwright's config-level
 * `toHaveScreenshot.animations: 'disabled'` to handle in-flight
 * animations and use only this `waitForFontsReady` helper from the
 * webview fixture.
 */

import type { Frame } from '@playwright/test';

/**
 * Font family used by VS Code Codicons. Glyphs from this family only
 * render once the font is actually loaded; the webview requests it lazily
 * the first time a codicon paints.
 */
const CODICON_FONT_FAMILY = 'codicon';

/**
 * Resolves once the frame's web fonts — including the lazily-loaded
 * codicon icon font — are loaded and painted. `document.fonts.ready`
 * alone is insufficient: it resolves immediately when no font load is
 * pending, which is the common case at the instant we check. We
 * explicitly `load()` the codicon family to force the request, then
 * await `ready` so all in-flight loads settle.
 */
export async function waitForFontsReady(frame: Frame): Promise<void> {
	await frame.evaluate(async (fontFamily) => {
		const fonts = document.fonts;
		if (!fonts) return;
		try {
			await fonts.load(`16px "${fontFamily}"`);
		} catch {
			// best-effort: fall through to ready below
		}
		await fonts.ready;
	}, CODICON_FONT_FAMILY);
}
