/**
 * VS Code launcher fixture: downloads VS Code via @vscode/test-electron,
 * launches it with the extension under development, opens a workspace,
 * and attaches Playwright via CDP.
 *
 * Encapsulates the non-obvious bits proven in git-spice-code-extension:
 * - `_electron.launch()` doesn't work with VS Code (its Node-bootstrap
 *   rejects --inspect=0). We `cp.spawn` directly and attach via
 *   `chromium.connectOverCDP`.
 * - ELECTRON_RUN_AS_NODE must be unset in the child env so Electron
 *   doesn't run as plain Node.
 * - --extensions-dir must be a fresh temp dir to isolate from the
 *   user's installed extensions.
 */

import { chromium, type Browser, type Page } from '@playwright/test';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../../..');

/**
 * Writes a user-settings.json into the temp `--user-data-dir` to keep
 * snapshot captures clean: hides Copilot/chat chrome, disables minimap,
 * prevents the welcome page, etc.
 */
function writeUserSettings(userDataDir: string): void {
	const settingsDir = join(userDataDir, 'User');
	mkdirSync(settingsDir, { recursive: true });
	const settings = {
		'workbench.startupEditor': 'none',
		'window.commandCenter': false,
		'chat.commandCenter.enabled': false,
		'chat.experimental.offerSetup': false,
		'workbench.activityBar.location': 'side',
		'workbench.statusBar.visible': false,
		'editor.minimap.enabled': false,
		'telemetry.telemetryLevel': 'off',
		'update.mode': 'none',
		'extensions.autoUpdate': false,
		'security.workspace.trust.enabled': false,
	};
	writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify(settings, null, 2));
}

/** Reads the pinned VS Code version from .vscode-version at repo root. */
function readPinnedVSCodeVersion(): string {
	const path = resolve(REPO_ROOT, '.vscode-version');
	const raw = readFileSync(path, 'utf8').trim();
	if (!/^\d+\.\d+\.\d+$/.test(raw)) {
		throw new Error(`Invalid .vscode-version: "${raw}" — expected semver like 1.121.0`);
	}
	return raw;
}

/** A live VS Code instance under Playwright's control. */
export interface VSCodeInstance {
	proc: ChildProcess;
	browser: Browser;
	workbench: Page;
	close(): Promise<void>;
}

/**
 * Launches VS Code with the extension loaded and the given workspace open.
 * `extraEnv` is merged into the child environment — used to inject fake
 * forge tokens (GITHUB_TOKEN) for the in-process fake forge server.
 */
export async function launchVSCode(
	workspacePath: string,
	extraEnv: Record<string, string> = {},
): Promise<VSCodeInstance> {
	const vscodePath = await downloadAndUnzipVSCode(readPinnedVSCodeVersion());
	const userDataDir = mkdtempSync(join(tmpdir(), 'sp-e2e-userdata-'));
	const extensionsDir = mkdtempSync(join(tmpdir(), 'sp-e2e-extensions-'));
	writeUserSettings(userDataDir);
	const debugPort = pickPort();

	const childEnv: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
	delete childEnv.ELECTRON_RUN_AS_NODE;

	const proc = spawn(
		vscodePath,
		[
			'--no-sandbox',
			'--disable-gpu-sandbox',
			'--disable-updates',
			'--skip-welcome',
			'--skip-release-notes',
			'--disable-workspace-trust',
			'--disable-telemetry',
			`--remote-debugging-port=${debugPort}`,
			`--extensionDevelopmentPath=${REPO_ROOT}`,
			`--extensions-dir=${extensionsDir}`,
			`--user-data-dir=${userDataDir}`,
			workspacePath,
		],
		{ env: childEnv, stdio: ['ignore', 'ignore', 'ignore'] },
	);

	await waitForCdp(debugPort, 60_000);
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
	const workbench = await waitForWorkbench(browser, 30_000);
	await workbench.locator('.monaco-workbench').waitFor({ state: 'attached', timeout: 30_000 });

	return {
		proc,
		browser,
		workbench,
		close: () => closeInstance(browser, proc),
	};
}

async function closeInstance(browser: Browser, proc: ChildProcess): Promise<void> {
	await browser.close().catch(() => undefined);
	if (proc.killed) return;
	proc.kill('SIGTERM');
	await new Promise((r) => setTimeout(r, 1000));
	if (!proc.killed) proc.kill('SIGKILL');
}

/** Probes the CDP version endpoint once; returns the error on failure. */
async function probeCdp(port: number): Promise<unknown> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/version`);
		return res.ok ? undefined : new Error(`CDP responded ${res.status}`);
	} catch (err) {
		return err;
	}
}

async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		lastErr = await probeCdp(port);
		if (lastErr === undefined) return;
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`CDP did not come up on port ${port} within ${timeoutMs}ms: ${String(lastErr)}`);
}

/** Returns the open workbench page across all browser contexts, if any. */
function findWorkbenchPage(browser: Browser): Page | undefined {
	for (const ctx of browser.contexts()) {
		const page = ctx.pages().find((p) => p.url().includes('workbench.html'));
		if (page) return page;
	}
	return undefined;
}

async function waitForWorkbench(browser: Browser, timeoutMs: number): Promise<Page> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const page = findWorkbenchPage(browser);
		if (page) return page;
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`No VS Code workbench page found within ${timeoutMs}ms`);
}

/** Picks a port in the ephemeral range. Collisions are rare in CI. */
function pickPort(): number {
	return 9229 + Math.floor(Math.random() * 1000);
}
