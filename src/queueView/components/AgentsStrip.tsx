/**
 * The launch-configs strip (design/05-ui.md, 09): one row per declared
 * launch configuration, joined with live supervisor state. Each row shows a
 * status icon, schedule/uptime, and a Run/Stop toggle (plus Tick now / Open
 * log / Retry where they apply). Sits at the top of the view; collapsible
 * to an aggregate summary, expanded by default so the controls are visible.
 */

import { useState, type JSX } from 'react';

import { AgentActivity } from '../../output/claudeStream';
import { WORKER_ID } from '../../protocol/types';
import { AgentDisplay, DisplayState, WorkerProcessDisplay } from '../../queue/displayTypes';
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
	if (state.agents.length === 0 && state.workers.length === 0) return null;
	// Only count launch configs in the header when there are some — otherwise a
	// workers-only strip would read "0 launch configs: 2 workers running".
	const label = state.agents.length === 1 ? 'launch config' : 'launch configs';
	const prefix = state.agents.length > 0 ? `${state.agents.length} ${label}: ` : '';
	return (
		<div className="agents-strip">
			<div className="summary" onClick={() => setExpanded(!expanded)}>
				<span className={`codicon codicon-chevron-${expanded ? 'down' : 'right'}`} />
				<span>
					{prefix}
					{summaryLine(state)}
				</span>
			</div>
			{expanded && (
				<>
					{state.agents.map((agent) => (
						<AgentRow key={`${agent.repoRoot}:${agent.agentId}`} agent={agent} state={state} />
					))}
					{state.workers.map((worker) => (
						<WorkerRow key={`${worker.repoRoot}:${worker.key}`} worker={worker} state={state} />
					))}
				</>
			)}
		</div>
	);
}

function summaryLine(state: DisplayState): string {
	const counts = new Map<string, number>();
	for (const agent of state.agents) counts.set(agent.state, (counts.get(agent.state) ?? 0) + 1);
	const groups = [...counts.entries()].map(([s, n]) => describeGroup(s, n, state));
	if (state.workers.length > 0)
		groups.push(`${state.workers.length} ${state.workers.length === 1 ? 'worker' : 'workers'} running`);
	return groups.join(' · ');
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

/**
 * A live worker process (design/09): one `claude -p /work-ticket` the
 * supervisor spawned from the dispatch plan. No lifecycle controls — its
 * lifecycle is the planner's; the operator acts on the ticket card, not here.
 * Open log is the one exception: observing a worker's output is read-only, and
 * every worker streams into the shared WORKER_ID channel (issue #56).
 */
function WorkerRow({ worker, state }: { worker: WorkerProcessDisplay; state: DisplayState }): JSX.Element {
	const post = usePost();
	const openLog = (): void =>
		post({ type: 'agentControl', repoRoot: worker.repoRoot, agentId: WORKER_ID, action: 'openLog' });
	return (
		<div className="agent-row worker-row">
			<span className={`codicon codicon-${AGENT_STATE_ICON.running} agent-state-running`} title="worker running" />
			{state.multiRepo && <span className="agent-repo">{worker.repoName}</span>}
			<span className="agent-title" title={`worker · ${worker.key}`}>
				{worker.key}
			</span>
			<span className="agent-meta">{workerMeta(worker, state.generatedAt)}</span>
			<span className="agent-actions">
				<IconButton title="Open log" icon="output" onClick={openLog} />
			</span>
		</div>
	);
}

function workerMeta(worker: WorkerProcessDisplay, now: number): string {
	const activity = activitySummary(worker.activity);
	if (activity) return `running · ${activity}`;
	// Both timestamps come from the host clock, so this is only defensive: clamp
	// in case a snapshot's generatedAt was captured a hair before runningSince.
	return worker.runningSince !== null ? `running ${formatDuration(Math.max(0, now - worker.runningSince))}` : 'running';
}

function AgentActions({ agent }: { agent: AgentDisplay }): JSX.Element {
	const post = usePost();
	const control = (action: 'start' | 'stop' | 'tickNow' | 'openLog' | 'retry'): void =>
		post({ type: 'agentControl', repoRoot: agent.repoRoot, agentId: agent.agentId, action });
	// Tick-now forces an immediate pass on a loop the supervisor is already
	// driving between ticks. It's meaningless when stopped (Run does an
	// immediate pass) or mid-pass (running/launching) — and showing it next
	// to Run rendered two near-identical play triangles.
	const canTickNow =
		agent.installed &&
		agent.lifetime === 'scheduled' &&
		(agent.state === 'scheduled' || agent.state === 'backoff' || agent.state === 'parked');
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
	running: runningMeta,
	failed: (a) => a.detail ?? `failed ×${a.consecutiveFailures}`,
	parked: (a) => a.detail ?? 'parked — all work waiting on you',
	stopped: (a) => (a.installed ? 'stopped' : stoppedConfigMeta(a)),
};

/** A running agent shows what it's doing right now (from its output), else uptime. */
function runningMeta(agent: AgentDisplay, now: number): string {
	const activity = activitySummary(agent.activity);
	if (activity) return `running · ${activity}`;
	return agent.runningSince !== null ? `running ${formatDuration(now - agent.runningSince)}` : 'running';
}

/** The current tool + target, or the last thing the agent said. */
export function activitySummary(activity: AgentActivity): string | null {
	if (activity.currentTool) {
		return activity.currentToolDetail ? `${activity.currentTool}: ${activity.currentToolDetail}` : activity.currentTool;
	}
	return activity.lastText ? clip(activity.lastText, 60) : null;
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function agentMeta(agent: AgentDisplay, now: number): string {
	return META[agent.state]?.(agent, now) ?? agent.detail ?? agent.state;
}

/** A declared-but-not-installed config: show its cadence, not a runner state. */
function stoppedConfigMeta(agent: AgentDisplay): string {
	if (agent.lifetime === 'daemon') return 'daemon · not started';
	const cadence = agent.intervalMinutes !== null ? `every ${agent.intervalMinutes}m` : 'tick';
	return `${cadence} · not started`;
}
