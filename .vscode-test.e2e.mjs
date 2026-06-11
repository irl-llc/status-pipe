import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/e2e/suite/**/*.test.js',
	mocha: {
		ui: 'bdd',
		timeout: 60000, // E2E tests need more time
	},
});
