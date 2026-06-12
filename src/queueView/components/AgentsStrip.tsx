/**
 * The launch-configs strip (design/05-ui.md, 09): one row per declared
 * launch configuration, joined with live supervisor state. Each row shows a
 * status icon, schedule/uptime, and a Run/Stop toggle (plus Tick now / Open
 * log / Retry where they apply). Sits at the top of the view; collapsible
 * to an aggregate summary, expanded by default so the controls are visible.
 */

import { useState, type JSX } from 'react';

import { AgentDisplay, DisplayState } from '../../queue/displayTypes';
import { formatDuration } from '../format';
import { AGENT_STATE_ICON } from '../icons';
import { usePost } from './QueueApp';

/** States in which the supervisor is actively driving the config (→ Stop). */
function isActive(state: AgentDisplay['state']): boolean {
	return (
		state === 'running' || state === 'launching' || state === 'scheduled' || state === 'backoff' || state === 'parked'
	);
}

export function AgentsStrip({ state }: { state: DisplayState }): JSX.Element | null {
	const [expanded, setExpanded] = useState(true);
	if (state.agents.length === 0) return null;
	const label = state.agents.length === 1 ? 'launch config' : 'launch configs';
	return (
		<div className="agents-strip">
			<div className="summary" onClick={() => setExpanded(!expanded)}>
				<span className={`codicon codicon-chevron-${expanded ? 'down' : 'right'}`} />
				<span>
					{state.agents.length} {label}: {summaryLine(state)}
				</span>
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
	return [...counts.entries()].map(([s, n]) => describeGroup(s, n, state)).join(' · ');
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
	return (
		<div className="agent-row">
			<span
				className={`codicon codicon-${AGENT_STATE_ICON[agent.state]} agent-state-${agent.state}`}
				title={agent.detail ?? agent.state}
			/>
			{state.multiRepo && <span className="agent-repo">{agent.repoName}</span>}
			<span className="agent-title" title={agent.title}>
				{agent.title}
			</span>
			<span className="agent-meta" title={agent.detail ?? ''}>
				{agentMeta(agent, state.generatedAt)}
			</span>
			<AgentActions agent={agent} />
		</div>
	);
}

function AgentActions({ agent }: { agent: AgentDisplay }): JSX.Element {
	const post = usePost();
	const control = (action: 'start' | 'stop' | 'tickNow' | 'openLog' | 'retry'): void =>
		post({ type: 'agentControl', repoRoot: agent.repoRoot, agentId: agent.agentId, action });
	const canTickNow =
		agent.installed && agent.mode === 'tick' && agent.state !== 'running' && agent.state !== 'launching';
	return (
		<span className="agent-actions">
			{agent.state === 'failed' ? (
				<IconButton title="Retry" icon="debug-restart" onClick={() => control('retry')} />
			) : isActive(agent.state) ? (
				<IconButton title="Stop" icon="stop-circle" onClick={() => control('stop')} />
			) : (
				<IconButton title="Run" icon="play" onClick={() => control('start')} />
			)}
			{canTickNow && <IconButton title="Tick now" icon="run" onClick={() => control('tickNow')} />}
			{agent.installed && <IconButton title="Open log" icon="output" onClick={() => control('openLog')} />}
		</span>
	);
}

function IconButton({ title, icon, onClick }: { title: string; icon: string; onClick: () => void }): JSX.Element {
	return (
		<button className="icon-button" title={title} onClick={onClick}>
			<span className={`codicon codicon-${icon}`} />
		</button>
	);
}

function scheduledMeta(agent: AgentDisplay, now: number): string {
	return agent.nextTickAt !== null ? `next tick ${formatDuration(Math.max(0, agent.nextTickAt - now))}` : agent.state;
}

const META: Partial<Record<AgentDisplay['state'], (a: AgentDisplay, now: number) => string>> = {
	scheduled: scheduledMeta,
	backoff: scheduledMeta,
	running: (a, now) => (a.runningSince !== null ? `running ${formatDuration(now - a.runningSince)}` : 'running'),
	failed: (a) => a.detail ?? `failed ×${a.consecutiveFailures}`,
	parked: (a) => a.detail ?? 'parked — all work waiting on you',
	stopped: (a) => (a.installed ? 'stopped' : stoppedConfigMeta(a)),
};

function agentMeta(agent: AgentDisplay, now: number): string {
	return META[agent.state]?.(agent, now) ?? agent.detail ?? agent.state;
}

/** A declared-but-not-installed config: show its cadence, not a runner state. */
function stoppedConfigMeta(agent: AgentDisplay): string {
	if (agent.mode === 'daemon') return 'daemon · not started';
	const cadence = agent.intervalMinutes !== null ? `every ${agent.intervalMinutes}m` : 'tick';
	return `${cadence} · not started`;
}
