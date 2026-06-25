/**
 * Generated fixture workspaces for e2e/Playwright tests: temp dirs seeded
 * with fake git checkouts and .status-pipe protocol files. No vscode
 * imports — runs in the Playwright/node test process.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FixtureTicket {
	key: string;
	body: Record<string, unknown>;
}

/** An inbox ack file written to .status-pipe/inbox/<ticket>/ack-<ackId>.json. */
export interface FixtureAck {
	ticket: string;
	ackId: string;
	body: Record<string, unknown>;
}

export interface FixtureRepoSpec {
	name: string;
	remoteUrl: string;
	tickets: FixtureTicket[];
	acks?: FixtureAck[];
	orchestrator?: Record<string, unknown>;
	config?: Record<string, unknown>;
	launch?: Record<string, unknown>;
	/** Workspace settings written to <workspace>/.vscode/settings.json. */
}

/** Creates a fake primary checkout: .git/ directory with a config file. */
export function writeFakeGitRepo(root: string, remoteUrl: string): void {
	mkdirSync(join(root, '.git'), { recursive: true });
	writeFileSync(
		join(root, '.git', 'config'),
		`[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${remoteUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
	);
	writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
}

export function writeProtocolDir(repoRoot: string, spec: FixtureRepoSpec): void {
	const protocolDir = join(repoRoot, '.status-pipe');
	mkdirSync(join(protocolDir, 'tickets'), { recursive: true });
	for (const ticket of spec.tickets) {
		writeFileSync(join(protocolDir, 'tickets', `${ticket.key}.json`), JSON.stringify(ticket.body, null, 2));
	}
	for (const ack of spec.acks ?? []) {
		const inboxDir = join(protocolDir, 'inbox', ack.ticket);
		mkdirSync(inboxDir, { recursive: true });
		writeFileSync(join(inboxDir, `ack-${ack.ackId}.json`), JSON.stringify(ack.body, null, 2));
	}
	if (spec.orchestrator) {
		writeFileSync(join(protocolDir, 'orchestrator.json'), JSON.stringify(spec.orchestrator, null, 2));
	}
	if (spec.config) writeFileSync(join(protocolDir, 'config.json'), JSON.stringify(spec.config, null, 2));
	if (spec.launch) writeFileSync(join(protocolDir, 'launch.json'), JSON.stringify(spec.launch, null, 2));
}

/**
 * Builds a multi-root-style workspace folder containing one subdirectory
 * per repo (the root-plus-one-level discovery rule finds them) and returns
 * the workspace path.
 */
export function buildFixtureWorkspace(repos: FixtureRepoSpec[], settings?: Record<string, unknown>): string {
	const workspace = mkdtempSync(join(tmpdir(), 'status-pipe-e2e-'));
	for (const spec of repos) {
		const repoRoot = join(workspace, spec.name);
		mkdirSync(repoRoot, { recursive: true });
		writeFakeGitRepo(repoRoot, spec.remoteUrl);
		writeProtocolDir(repoRoot, spec);
	}
	if (settings) {
		mkdirSync(join(workspace, '.vscode'), { recursive: true });
		writeFileSync(join(workspace, '.vscode', 'settings.json'), JSON.stringify(settings, null, 2));
	}
	return workspace;
}

/** A ticket file body with sensible defaults; overrides win. */
export function ticketBody(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		schemaVersion: 1,
		repo: 'acme/fleet-api',
		ticket: '142',
		title: 'Ticket title',
		slug: null,
		url: 'https://github.com/acme/fleet-api/issues/142',
		phase: 'implementation',
		health: 'ok',
		headline: 'Working on it.',
		waitingOn: null,
		prs: [],
		blockers: [],
		history: [],
		worker: null,
		updatedAt: '2026-06-11T08:00:00Z',
		...overrides,
	};
}
