/**
 * Shared scenario data for the snapshot specs: ticket files covering every
 * lane, badge type, stack indicator, and degraded state (design/06).
 * Timestamps are fixed in the future-near-past relative to nothing — the
 * queue model uses live `now`, so durations render as large values; that
 * is deterministic enough for snapshots because the *layout* is what we
 * assert (durations sit in fixed-width slots), and locator assertions
 * cover semantics.
 */

import { FixtureRepoSpec, ticketBody } from '../../fixtures/protocolFixtures';

/**
 * Workspace settings suppressing status-pipe toasts: persistent warning
 * toasts would otherwise be baked into the screenshot baselines.
 */
export const QUIET_TOASTS: Record<string, unknown> = { 'statusPipe.notifications.doNotDisturb': true };

/** A recent ISO timestamp helper: minutes before "now", minute precision. */
export function minutesAgo(minutes: number): string {
	const ms = Date.now() - minutes * 60_000;
	return new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
}

export function lanesRepo(): FixtureRepoSpec {
	return {
		name: 'fleet-api',
		remoteUrl: 'https://github.com/acme/fleet-api.git',
		orchestrator: {
			schemaVersion: 1,
			repo: 'acme/fleet-api',
			passCount: 12,
			lastPassStartedAt: minutesAgo(20),
			lastPassFinishedAt: minutesAgo(18),
			staleWorkerMinutes: 30,
		},
		tickets: [
			{
				key: '142',
				body: ticketBody({
					ticket: '142',
					title: 'Rotate signing keys',
					health: 'waiting',
					phase: 'implementation',
					headline: 'Asked the owner whether the rotation window should be configurable.',
					waitingOn: {
						kind: 'owner',
						ref: 'https://github.com/acme/fleet-api/issues/142#issuecomment-9981',
						pr: null,
						since: minutesAgo(95),
						detail: 'rotation window configurable?',
					},
					updatedAt: minutesAgo(95),
				}),
			},
			{
				key: '177',
				body: ticketBody({
					ticket: '177',
					title: 'Migrate billing webhooks',
					health: 'blocked',
					phase: 'blocked',
					headline: 'Cannot proceed without the new Stripe sandbox credentials.',
					blockers: ['Need STRIPE_SANDBOX_KEY in CI secrets'],
					updatedAt: minutesAgo(200),
				}),
			},
			{
				key: '155',
				body: ticketBody({
					ticket: '155',
					title: 'Rate limit core',
					health: 'waiting',
					phase: 'review',
					headline: 'PR is up and ready for review.',
					waitingOn: {
						kind: 'review',
						ref: 'https://github.com/acme/fleet-api/pull/512',
						pr: 512,
						since: minutesAgo(45),
						detail: 'PR #512 awaiting review',
					},
					prs: [
						{
							number: 512,
							url: 'https://github.com/acme/fleet-api/pull/512',
							head: 'rate-limit-core',
							base: 'main',
							draft: false,
							state: 'open',
							ci: 'passing',
							part: 'T1a',
						},
					],
					updatedAt: minutesAgo(45),
				}),
			},
			{
				key: '161',
				body: ticketBody({
					ticket: '161',
					title: 'Rate limit dashboards',
					health: 'ok',
					phase: 'implementation',
					headline: 'Building on top of the rate-limit core branch.',
					waitingOn: {
						kind: 'build',
						ref: null,
						pr: 530,
						since: minutesAgo(8),
						detail: 'CI running on #530',
					},
					prs: [
						{
							number: 530,
							url: 'https://github.com/acme/fleet-api/pull/530',
							head: 'rate-limit-dash',
							base: 'rate-limit-core',
							draft: true,
							state: 'open',
							ci: 'pending',
							part: 'T2',
						},
					],
					worker: { status: 'running', taskId: 'task-9', startedAt: minutesAgo(12), heartbeatAt: minutesAgo(1) },
					updatedAt: minutesAgo(8),
				}),
			},
			{
				key: '130',
				body: ticketBody({
					ticket: '130',
					title: 'Drop legacy auth shim',
					health: 'done',
					phase: 'merged',
					headline: 'Merged and deployed.',
					prs: [
						{
							number: 488,
							url: 'https://github.com/acme/fleet-api/pull/488',
							head: 'drop-auth-shim',
							base: 'main',
							draft: false,
							state: 'merged',
							ci: 'passing',
							part: null,
						},
					],
					updatedAt: minutesAgo(120),
				}),
			},
			{
				key: '190',
				body: ticketBody({
					ticket: '190',
					title: 'Nightly index rebuild',
					health: 'ok',
					phase: 'implementation',
					headline: 'Crunching through the index migration.',
					worker: { status: 'running', taskId: 'task-12', startedAt: minutesAgo(300), heartbeatAt: minutesAgo(120) },
					updatedAt: minutesAgo(120),
				}),
			},
		],
	};
}

export function degradedRepo(): FixtureRepoSpec {
	return {
		name: 'fleet-api',
		remoteUrl: 'https://github.com/acme/fleet-api.git',
		tickets: [
			{
				key: '999',
				body: { schemaVersion: 9, ticket: '999', title: 'From the future', mystery: true },
			},
		],
	};
}

/**
 * A repo whose launch.json declares two configs (one tick, one daemon).
 * Neither is approved in the test, so both render as declared-but-stopped
 * rows with Run buttons — the launch-config strip's default state.
 */
export function launchConfigsRepo(): FixtureRepoSpec {
	return {
		name: 'fleet-api',
		remoteUrl: 'https://github.com/acme/fleet-api.git',
		orchestrator: { schemaVersion: 1, repo: 'acme/fleet-api', passCount: 3, lastPassFinishedAt: minutesAgo(12) },
		launch: {
			schemaVersion: 1,
			agents: [
				{
					id: 'orchestrator',
					title: 'Orchestrator',
					command: 'claude',
					args: ['-p'],
					mode: 'tick',
					intervalMinutes: 10,
				},
				{ id: 'watcher', title: 'CI watcher', command: 'claude', args: ['-p'], mode: 'daemon' },
			],
		},
		tickets: [
			{
				key: '142',
				body: ticketBody({
					ticket: '142',
					title: 'Rotate signing keys',
					health: 'waiting',
					phase: 'review',
					headline: 'PR is up and ready for review.',
					waitingOn: { kind: 'review', ref: null, pr: 512, since: minutesAgo(40), detail: 'PR #512 awaiting review' },
					updatedAt: minutesAgo(40),
				}),
			},
		],
	};
}

/** A discovered repo with no tickets, no orchestrator, and no launch.json. */
export function unconfiguredRepo(): FixtureRepoSpec {
	return { name: 'fresh-repo', remoteUrl: 'https://github.com/acme/fresh-repo.git', tickets: [] };
}

export function quietRepo(): FixtureRepoSpec {
	return {
		name: 'fleet-api',
		remoteUrl: 'https://github.com/acme/fleet-api.git',
		orchestrator: {
			schemaVersion: 1,
			repo: 'acme/fleet-api',
			passCount: 40,
			lastPassFinishedAt: minutesAgo(5),
			staleWorkerMinutes: 30,
		},
		tickets: [
			{
				key: '130',
				body: ticketBody({
					ticket: '130',
					title: 'Drop legacy auth shim',
					health: 'done',
					phase: 'merged',
					headline: 'Merged and deployed.',
					updatedAt: minutesAgo(60),
				}),
			},
		],
	};
}
