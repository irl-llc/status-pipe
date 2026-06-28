/**
 * Indicator meanings (design/05-ui.md rule 6: "Meaning is never JSON-only").
 * Every encoded indicator — the accent bar's health colour, the blocker and
 * waiting glyphs, the launch-config state glyph — carries its meaning in words.
 *
 * The meaning renders as a DOM tooltip (the `.tip` widget), not a native
 * `title`: a native tooltip is OS chrome drawn outside the page surface, so
 * Playwright cannot screenshot it. Because this one is part of the page, the
 * suite both pins the tooltip *text* (via `data-tip`) and — what the operator
 * asked for on #25 — captures it *rendered on hover*, so a human can see the
 * meaning actually pops. The at-rest shot pins the colours/glyphs; the two
 * hover shots pin an accent meaning and a glyph meaning visibly displayed.
 */

import { expect, test, type Frame, type Locator } from '@playwright/test';

import { buildFixtureWorkspace } from '../fixtures/protocolFixtures';
import { QUIET_TOASTS, lanesRepo } from './fixtures/scenarios';
import { launchVSCode, type VSCodeInstance } from './fixtures/vscode';
import { openQueueEditor } from './fixtures/webview';

/**
 * The first triage card whose header shows this #key. `.first()` resolves the
 * QUIET-lane orchestrator-summary row that repeats an active ticket's key —
 * the triage card sorts ahead of it in DOM order.
 */
function cardFor(frame: Frame, key: string): Locator {
	return frame.locator('.card', { has: frame.locator('.ticket-key', { hasText: new RegExp(`^${key}$`) }) }).first();
}

/** The accent bar's meaning lives on its `.accent-tip` hover zone. */
async function accentMeaningOf(card: Locator): Promise<string> {
	return (await card.locator('.accent-tip').first().getAttribute('data-tip')) ?? '';
}

/** A child indicator's meaning (status/blocker/waiting glyph) by selector. */
async function glyphMeaning(card: Locator, selector: string): Promise<string> {
	return (await card.locator(selector).first().getAttribute('data-tip')) ?? '';
}

test.describe('indicator meanings', () => {
	let vscode: VSCodeInstance;

	test.afterEach(async () => {
		await vscode?.close();
	});

	test('accent colours and indicator glyphs each carry their meaning in words', async () => {
		const launch = {
			schemaVersion: 1,
			agents: [{ id: 'orchestrator', title: 'Orchestrator', command: 'claude', args: ['-p'], mode: 'tick' }],
		};
		const workspace = buildFixtureWorkspace([{ ...lanesRepo(), launch }], QUIET_TOASTS);
		vscode = await launchVSCode(workspace);
		const frame = await openQueueEditor(vscode.workbench);
		await expect(frame.locator('.card').first()).toBeVisible();

		// Accent bar (health colour) → health/override phrase, per card. The
		// colour class lives on the card; its meaning on the accent-tip zone.
		await expect(cardFor(frame, '#177')).toHaveClass(/accent-error/);
		expect(await accentMeaningOf(cardFor(frame, '#177'))).toBe('Blocked — needs you');
		await expect(cardFor(frame, '#142')).toHaveClass(/accent-waiting/);
		expect(await accentMeaningOf(cardFor(frame, '#142'))).toBe('Waiting on you or the world');
		await expect(cardFor(frame, '#161')).toHaveClass(/accent-ok/);
		expect(await accentMeaningOf(cardFor(frame, '#161'))).toBe('Healthy — agent working');
		// #190 is healthy but its worker is stale → the accent paints error red
		// and the meaning names the override, not the underlying health.
		await expect(cardFor(frame, '#190')).toHaveClass(/accent-error/);
		expect(await accentMeaningOf(cardFor(frame, '#190'))).toMatch(/^Stale worker — no heartbeat/);

		// Waiting-line glyph → the waiting kind in words.
		expect(await glyphMeaning(cardFor(frame, '#142'), '.waiting-line .codicon')).toBe(
			'Waiting on you — a reply is needed',
		);
		expect(await glyphMeaning(cardFor(frame, '#155'), '.waiting-line .codicon')).toBe('Waiting on review');
		expect(await glyphMeaning(cardFor(frame, '#161'), '.waiting-line .codicon')).toBe('Waiting on CI');

		// Blocker glyph → the blocked meaning.
		expect(await glyphMeaning(cardFor(frame, '#177'), '.blocker-line .codicon')).toBe('Blocked — needs you');

		// Launch-config state glyph → the run state in words.
		await expect(frame.locator('.agent-row .codicon').first()).toHaveAttribute('data-tip', 'Stopped');

		// At rest: colours and glyphs, no tooltip showing.
		await expect(vscode.workbench).toHaveScreenshot('indicator-meanings.png', { fullPage: true });

		// Operator ask (#25): show the meaning actually rendered on hover. Hover
		// the accent bar of the blocked card → "Blocked — needs you" pops as a
		// DOM tooltip the screenshot can capture (a native title never would).
		await cardFor(frame, '#177').locator('.accent-tip').first().hover();
		await expect(vscode.workbench).toHaveScreenshot('indicator-meanings-accent-hover.png', { fullPage: true });

		// And a status codicon: hover #161's waiting glyph → "Waiting on CI".
		await cardFor(frame, '#161').locator('.waiting-line .codicon').first().hover();
		await expect(vscode.workbench).toHaveScreenshot('indicator-meanings-glyph-hover.png', { fullPage: true });
	});
});
