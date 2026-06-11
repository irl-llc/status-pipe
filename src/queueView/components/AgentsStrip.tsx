/**
 * The agents strip (design/05-ui.md, 09): one collapsed summary row at
 * fixed height, expanding to one row per (repo, agent) with hover actions.
 */

import { useState, type JSX } from 'react';

import { AgentDisplay, DisplayState } from '../../queue/displayTypes';
import { formatDuration } from '../format';
import { AGENT_STATE_ICON } from '../icons';
import { usePost } from './QueueApp';

export function AgentsStrip({ state }: { state: DisplayState }): JSX.Element | null {
	const [expanded, setExpanded] = useState(false);
	if (state.agents.length === 0) return null;
	return (
		<div className="agents-strip">
			<div className="summary" onClick={() => setExpanded(!expanded)}>
				<span className={`codicon codicon-chevron-${expanded ? 'down' : 'right'}`} />
				<span>{summaryLine(state)}</span>
			</div>
			{expanded &&
				state.agents.map((agent) => (
					<AgentRow key={`${agent.repoRoot}:${agent.agentId}`} agent={agent} state={state} />
				))}
		</div>
	);
}

function summaryLine(state: DisplayState): string {
	const counts = new Map<string, number>();
	for (const agent of state.agents) counts.set(agent.state, (counts.get(agent.state) ?? 0) + 1);
	const parts = [...counts.entries()].map(([s, n]) => describeGroup(s, n, state));
	const prefix = state.agents.length === 1 ? 'agent' : 'agents';
	return `${prefix}: ${parts.join(' · ')}`;
}

function describeGroup(runState: string, n: number, state: DisplayState): string {
	if (runState === 'scheduled') {
		const next = Math.min(
			...state.agents.filter((a) => a.state === 'scheduled' && a.nextTickAt !== null).map((a) => a.nextTickAt!),
		);
		const eta = Number.isFinite(next) ? ` (${formatDuration(Math.max(0, next - state.generatedAt))})` : '';
		return `${n} scheduled${eta}`;
	}
	if (runState === 'parked') return `${n} parked — all work waiting on you`;
	return `${n} ${runState}`;
}

function AgentRow({ agent, state }: { agent: AgentDisplay; state: DisplayState }): JSX.Element {
	const post = usePost();
	const control = (action: 'start' | 'stop' | 'tickNow' | 'openLog' | 'retry'): void =>
		post({ type: 'agentControl', repoRoot: agent.repoRoot, agentId: agent.agentId, action });
	return (
		<div className="agent-row">
			<span
				className={`codicon codicon-${AGENT_STATE_ICON[agent.state]} agent-state-${agent.state}`}
				title={agent.detail ?? agent.state}
			/>
			<span>{agent.repoName}</span>
			<span className="agent-meta" title={agent.detail ?? ''}>
				{agentMeta(agent, state.generatedAt)}
			</span>
			<span className="agent-actions">
				{agent.state === 'failed' && (
					<button className="icon-button" title="Retry" onClick={() => control('retry')}>
						<span className="codicon codicon-debug-restart" />
					</button>
				)}
				{agent.state !== 'running' && agent.state !== 'failed' && (
					<button className="icon-button" title="Tick now" onClick={() => control('tickNow')}>
						<span className="codicon codicon-run" />
					</button>
				)}
				{agent.state === 'running' && (
					<button className="icon-button" title="Stop" onClick={() => control('stop')}>
						<span className="codicon codicon-stop-circle" />
					</button>
				)}
				<button className="icon-button" title="Open log" onClick={() => control('openLog')}>
					<span className="codicon codicon-output" />
				</button>
			</span>
		</div>
	);
}

function scheduledMeta(agent: AgentDisplay, now: number): string {
	return agent.nextTickAt !== null ? `next tick ${formatDuration(Math.max(0, agent.nextTickAt - now))}` : agent.state;
}

function agentMeta(agent: AgentDisplay, now: number): string {
	switch (agent.state) {
		case 'scheduled':
		case 'backoff':
			return scheduledMeta(agent, now);
		case 'running':
			return agent.runningSince !== null ? `running ${formatDuration(now - agent.runningSince)}` : 'running';
		case 'failed':
			return agent.detail ?? `failed ×${agent.consecutiveFailures}`;
		case 'parked':
			return agent.detail ?? 'parked — all work waiting on you';
		default:
			return agent.detail ?? agent.state;
	}
}
