import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the visual-snapshot E2E suite. Launches VS Code
 * through @vscode/test-electron, attaches via CDP, and drives the Status Pipe
 * queue webview against generated fixture workspaces.
 *
 * Visual snapshots run inside the Linux Docker image
 * (mcr.microsoft.com/playwright:v1.60.0-jammy) on both CI and local
 * dev — see docker-compose.test.yml and `npm run
 * test:e2e:playwright:docker`. Running snapshot tests natively on
 * macOS will produce a one-time diff that doesn't match the
 * checked-in Linux baseline; that's expected. Use the Docker entrypoint to update
 * snapshots.
 */
export default defineConfig({
	testDir: './src/test/e2e/playwright',
	timeout: 180_000,
	workers: 1,
	reporter: [['list']],
	outputDir: 'test-results',
	expect: {
		toHaveScreenshot: {
			// VS Code's workbench has subtle font/rendering noise even with
			// animations disabled; 0.5% of pixels and the default per-pixel
			// threshold catch real visual regressions without flaking on
			// JIT-rendered text antialiasing.
			maxDiffPixelRatio: 0.005,
			threshold: 0.2,
			animations: 'disabled',
		},
	},
	use: {
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
	},
});
