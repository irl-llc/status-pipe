/**
 * Protocol-dir / config discovery for the CLI — the standalone equivalent of the
 * extension's repo scan, minus VS Code. Anchors at the PRIMARY checkout
 * (protocol §1): run from a linked worktree and `.status-pipe/` still resolves
 * to the main repo, never a nested dir. `config.json` is read from the local
 * working tree (never a PR branch); a corrupt one fails loud rather than
 * silently planning with defaults, since it drives the trust gate.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { inspectGitCheckout } from '../discovery/gitRepo';
import { parseConfigFile } from '../protocol/parse';
import { ConfigFile } from '../protocol/types';

export interface Discovered {
	/** The primary checkout — worktrees and the epics dir resolve against it. */
	repoRoot: string;
	protocolDir: string;
	remoteUrl: string | null;
	config: ConfigFile | null;
}

export type DiscoverResult = { ok: true; value: Discovered } | { ok: false; message: string };

async function isDirectory(p: string): Promise<boolean> {
	return fs.stat(p).then(
		(s) => s.isDirectory(),
		() => false,
	);
}

async function loadConfig(
	protocolDir: string,
): Promise<{ ok: true; value: ConfigFile | null } | { ok: false; message: string }> {
	const raw = await fs.readFile(path.join(protocolDir, 'config.json'), 'utf8').catch(() => null);
	if (raw === null) return { ok: true, value: null };
	const parsed = parseConfigFile(raw);
	if (!parsed.ok) return { ok: false, message: `config.json is unreadable (${parsed.reason}): ${parsed.detail}` };
	return { ok: true, value: parsed.value };
}

export async function discover(
	cwd: string,
	repoRootArg: string | null,
	protocolDirArg: string | null,
): Promise<DiscoverResult> {
	const root = path.resolve(repoRootArg ?? cwd);
	const checkout = await inspectGitCheckout(root);
	if (!checkout) return { ok: false, message: `not a git checkout: ${root}` };
	const protocolDir = protocolDirArg ? path.resolve(protocolDirArg) : path.join(checkout.primaryRoot, '.status-pipe');
	if (!(await isDirectory(protocolDir))) return { ok: false, message: `no protocol directory at ${protocolDir}` };
	const config = await loadConfig(protocolDir);
	if (!config.ok) return config;
	return {
		ok: true,
		value: { repoRoot: checkout.primaryRoot, protocolDir, remoteUrl: checkout.remoteUrl, config: config.value },
	};
}
