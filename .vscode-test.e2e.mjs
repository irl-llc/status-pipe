import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/e2e/suite/**/*.test.js',
	workspaceFolder: '.vscode-test/fixture-workspace',
	mocha: {
		ui: 'bdd',
		timeout: 60000, // E2E tests need more time
	},
});
