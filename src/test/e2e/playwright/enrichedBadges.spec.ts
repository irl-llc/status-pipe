/**
 * Forge enrichment against the in-process fake forge (shamhub pattern):
 * the extension's GitHub GraphQL client hits the fake server and the
 * cards grow non-default badges — failing CI, unresolved comments,
 * changes-requested — deterministically.
 */

import { expect, test } from '@playwright/test';

import { FakeForgeServer } from '../../../forge/fake/fakeForgeServer';
import { buildFixtureWorkspace, ticketBody } from '../fixtures/protocolFixtures';
import { minutesAgo } from './fixtures/scenarios';
import { launchVSCode, type VSCodeInstance } from './fixtures/vscode';
import { clearNotifications, openQueueEditor } from './fixtures/webview';

test.describe('enriched badges', () => {
	let vscode: VSCodeInstance;
	let server: FakeForgeServer;

	test.afterEach(async () => {
		await vscode?.close();
		await server?.stop();
	});

	test('cards show CI, comment, and review badges from the fake forge', async () => {
		server = new FakeForgeServer({
			slug: 'acme/fleet-api',
			viewerLogin: 'ed-irl',
			prs: [
				{
					number: 512,
					title: 'Rate limit core',
					state: 'open',
					draft: false,
					head: 'rate-limit-core',
					base: 'main',
					updatedAt: minutesAgo(30),
					prLevelComments: 2,
					threads: [
						{ resolved: true, comments: 3 },
						{ resolved: false, comments: 2 },
						{ resolved: false, comments: 1 },
					],
					reviewDecision: 'CHANGES_REQUESTED',
					reviewRequests: ['ed-irl'],
					checks: [
						{ name: 'build', status: 'passing' },
						{ name: 'e2e', status: 'failing', url: 'https://ci.example/run/9' },
					],
					linkedTickets: [{ key: '155', title: 'Rate limit core' }],
				},
			],
		});
		const apiUrl = await server.start();

		const workspace = buildFixtureWorkspace(
			[
				{
					name: 'fleet-api',
					remoteUrl: 'https://github.com/acme/fleet-api.git',
					tickets: [
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
									since: minutesAgo(40),
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
										ci: 'unknown',
										part: 'T1a',
									},
								],
								updatedAt: minutesAgo(40),
							}),
						},
					],
				},
			],
			{
				'statusPipe.forge.type': 'github',
				'statusPipe.forge.github.apiUrl': apiUrl,
				'statusPipe.forge.github.token': 'fixture-token',
			},
		);

		vscode = await launchVSCode(workspace);
		const frame = await openQueueEditor(vscode.workbench);

		// Enrichment is change-driven with a 5s coalesce — wait for badges.
		await expect(frame.locator('.pr-badge.ci-failing')).toBeVisible({ timeout: 30_000 });
		await expect(frame.locator('.pr-badge', { hasText: '2/8' })).toBeVisible();
		await expect(frame.locator('.pr-badge.changes-requested')).toBeVisible();

		await clearNotifications(vscode.workbench);
		await expect(vscode.workbench).toHaveScreenshot('enriched-badges.png', { fullPage: true });
	});
});
