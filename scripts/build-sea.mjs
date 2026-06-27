// Build a self-contained `status-pipe` executable with Node's Single Executable
// Application (SEA) support — a CI/cron/headless box can drop in one binary with
// no preinstalled Node (#39). Pure Node, no second toolchain: SEA ships with the
// Node we already build on. Cross-OS in one script (Windows .exe, macOS
// re-signing) so the release matrix runs the same command on every runner.
//
// Prereq: `dist/cli.js` (the webpack CLI bundle — `npm run build:cli`). Output:
// `dist/status-pipe[.exe]`. Node ≥ 20 (SEA reached stability there).

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'build');
const dist = join(root, 'dist');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const binary = join(dist, isWin ? 'status-pipe.exe' : 'status-pipe');
const blob = join(build, 'sea-prep.blob');
const seaConfig = join(build, 'sea-config.json');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function sh(cmd, args) {
	console.log(`$ ${cmd} ${args.join(' ')}`);
	execFileSync(cmd, args, { stdio: 'inherit' });
}

// postject injects the blob at the fuse sentinel baked into the node binary.
// Homebrew's node omits it; official nodejs.org builds (and actions/setup-node)
// carry it. Fail early with that pointer instead of postject's opaque error.
function assertFuse() {
	if (!readFileSync(process.execPath).includes(FUSE)) {
		console.error(`node at ${process.execPath} has no SEA fuse — use an official build from`);
		console.error('https://nodejs.org/dist (CI: actions/setup-node provides one). Homebrew node omits it.');
		process.exit(1);
	}
}

function writeBlob() {
	rmSync(build, { recursive: true, force: true });
	mkdirSync(build, { recursive: true });
	writeFileSync(seaConfig, JSON.stringify({ main: join(dist, 'cli.js'), output: blob, disableExperimentalSEAWarning: true }));
	sh(process.execPath, ['--experimental-sea-config', seaConfig]);
}

function copyNode() {
	mkdirSync(dist, { recursive: true });
	// A prior build leaves a read-only (0555) binary that copyFileSync can't
	// overwrite — clear it first so the build is repeatable.
	rmSync(binary, { force: true });
	copyFileSync(process.execPath, binary);
	// The node binary is often mode 0555 (no owner write); postject opens the
	// target read+write, so make the copy writable (and executable) first.
	chmodSync(binary, 0o755);
	// macOS rejects an injected, already-signed binary until its signature is removed.
	if (isMac) sh('codesign', ['--remove-signature', binary]);
}

function inject() {
	const args = [binary, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE];
	if (isMac) args.push('--macho-segment-name', 'NODE_SEA');
	sh('npx', ['--yes', 'postject', ...args]);
	// Re-sign so macOS Gatekeeper will run it (ad-hoc; release signing is a later concern).
	if (isMac) sh('codesign', ['--sign', '-', binary]);
}

assertFuse();
writeBlob();
copyNode();
inject();
console.log(`\nBuilt ${binary}`);
