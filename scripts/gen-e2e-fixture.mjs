/**
 * Generates the static fixture workspace the e2e suite opens
 * (.vscode-test.e2e.mjs workspaceFolder). Deterministic so test runs are
 * reproducible; regenerated on every `npm run test:e2e`.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = join(repoRoot, '.vscode-test', 'fixture-workspace');
const repo = join(workspace, 'fleet-api');

rmSync(workspace, { recursive: true, force: true });
mkdirSync(join(repo, '.git'), { recursive: true });
writeFileSync(
	join(repo, '.git', 'config'),
	'[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/acme/fleet-api.git\n',
);
writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');

const protocolDir = join(repo, '.status-pipe');
mkdirSync(join(protocolDir, 'tickets'), { recursive: true });
writeFileSync(
	join(protocolDir, 'tickets', '142.json'),
	JSON.stringify(
		{
			schemaVersion: 1,
			repo: 'acme/fleet-api',
			ticket: '142',
			title: 'Rotate signing keys',
			url: 'https://github.com/acme/fleet-api/issues/142',
			phase: 'implementation',
			health: 'waiting',
			headline: 'Asked the owner whether the rotation window is configurable.',
			waitingOn: {
				kind: 'owner',
				ref: 'https://github.com/acme/fleet-api/issues/142#issuecomment-1',
				pr: null,
				since: '2026-06-11T07:55:22Z',
				detail: 'rotation window configurable?',
			},
			prs: [],
			blockers: [],
			history: [{ at: '2026-06-11T07:55:22Z', phase: 'implementation', note: 'asked owner', runId: null }],
			worker: { status: 'idle', taskId: null, startedAt: null, heartbeatAt: null },
			updatedAt: '2026-06-11T07:55:22Z',
		},
		null,
		2,
	),
);
writeFileSync(
	join(protocolDir, 'orchestrator.json'),
	JSON.stringify(
		{
			schemaVersion: 1,
			repo: 'acme/fleet-api',
			passCount: 3,
			lastPassStartedAt: '2026-06-11T07:50:00Z',
			lastPassFinishedAt: '2026-06-11T07:56:00Z',
			staleWorkerMinutes: 30,
		},
		null,
		2,
	),
);

console.log(`e2e fixture workspace generated at ${workspace}`);
