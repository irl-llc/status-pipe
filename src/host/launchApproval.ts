/**
 * Launch-entry approval flow (design/09-launch-and-supervision.md "Trust
 * gating"): workspace trust + per-content-hash approval of the complete
 * entry. Approvals persist in workspaceState; a changed file re-prompts.
 * Worktree checkouts never reach this module (discovery refuses them).
 */

import * as vscode from 'vscode';

import { LaunchAgent } from '../protocol/types';
import { describeLaunchEntry, launchEntryHash } from '../supervisor/trustGate';

const APPROVALS_KEY = 'statusPipe.launchApprovals';

type ApprovalMap = Record<string, boolean>;

function approvals(state: vscode.Memento): ApprovalMap {
	return state.get<ApprovalMap>(APPROVALS_KEY, {});
}

export function isApproved(state: vscode.Memento, agent: LaunchAgent): boolean {
	return approvals(state)[launchEntryHash(agent)] === true;
}

async function recordApproval(state: vscode.Memento, agent: LaunchAgent, approved: boolean): Promise<void> {
	const map = approvals(state);
	map[launchEntryHash(agent)] = approved;
	await state.update(APPROVALS_KEY, map);
}

/**
 * Returns the agents the user has approved (prompting for unapproved
 * entries). Requires workspace trust; an untrusted workspace approves
 * nothing.
 */
export async function approveAgents(
	state: vscode.Memento,
	repoName: string,
	agents: LaunchAgent[],
): Promise<LaunchAgent[]> {
	if (!vscode.workspace.isTrusted) return [];
	const approved: LaunchAgent[] = [];
	for (const agent of agents) {
		if (isApproved(state, agent) || (await promptApproval(state, repoName, agent))) {
			approved.push(agent);
		}
	}
	return approved;
}

async function promptApproval(state: vscode.Memento, repoName: string, agent: LaunchAgent): Promise<boolean> {
	// The modal shows the COMPLETE entry — command, args, stdin, cwd, env —
	// everything the hash covers, so nothing rides through review unseen.
	const choice = await vscode.window.showWarningMessage(
		`Status Pipe: allow launching agent "${agent.title}" in ${repoName}?`,
		{ modal: true, detail: describeLaunchEntry(agent) },
		'Allow',
		'Never for this entry',
	);
	if (choice === 'Allow') {
		await recordApproval(state, agent, true);
		return true;
	}
	if (choice === 'Never for this entry') await recordApproval(state, agent, false);
	return false;
}

/** True when an entry has neither an approval nor a denial recorded yet. */
export function needsPrompt(state: vscode.Memento, agents: LaunchAgent[]): boolean {
	const map = approvals(state);
	return agents.some((a) => map[launchEntryHash(a)] === undefined);
}
