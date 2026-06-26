/**
 * The extension-host controller: discovery → protocol store → enricher +
 * supervisor → queue model → DisplayState pushed to views
 * (design/04-architecture.md). All vscode wiring lives here; the modules
 * it composes are vscode-free.
 */

import * as path from 'path';
import * as vscode from 'vscode';

import { RepoContext, scanForRepos } from '../discovery/repoScan';
import { ForgeEnricher, PersistedEnrichment } from '../forge/enricher';
import { buildAck } from '../protocol/ackId';
import { LaunchAgent } from '../protocol/types';
import { sweepOrphanedInboxDirs, withdrawAckFile, writeAckFile } from '../protocol/ackWriter';
import { DisplayState } from '../queue/displayTypes';
import { QueueModelInput, RepoState } from '../queue/queueInputs';
import { buildDisplayState } from '../queue/queueModel';
import { AgentSupervisor } from '../supervisor/agentSupervisor';
import { resolveAgentCwd } from '../supervisor/launchTemplate';
import { PlannerRepo } from './plannerSpawn';
import { createSupervisor } from './supervisorSetup';
import { ForgeConnection, connectRepo } from './forgeSetup';
import { approveAgents, isApproved } from './launchApproval';
import { computeToasts } from './notifications';
import { RecentAcks } from './recentAcks';
import { RepoProtocolState, changedPrNumbers, loadRepoProtocol } from './protocolStore';
import * as settings from './settings';

const RELOAD_COALESCE_MS = 250;
const PUSH_DEBOUNCE_MS = 100;
const ENRICHMENT_CACHE_KEY = 'statusPipe.enrichmentCache';

interface ManagedRepo {
	context: RepoContext;
	state: RepoProtocolState | null;
	connection: ForgeConnection | null;
	connectionTried: boolean;
	watcher: vscode.FileSystemWatcher;
	epicWatcher: vscode.FileSystemWatcher | null;
	reloadTimer: NodeJS.Timeout | null;
	knownAckIds: Set<string>;
	installedLaunchRaw: string | null;
}

export class StatusPipeController implements vscode.Disposable {
	private readonly repos = new Map<string, ManagedRepo>();
	private readonly enricher: ForgeEnricher;
	private readonly supervisor: AgentSupervisor;
	private readonly recentAcks: RecentAcks;
	private readonly listeners = new Set<(s: DisplayState) => void>();
	private readonly channels = new Map<string, vscode.OutputChannel>();
	private readonly disposables: vscode.Disposable[] = [];
	private lastState: DisplayState | null = null;
	private pushTimer: NodeJS.Timeout | null = null;

	constructor(private readonly ctx: vscode.ExtensionContext) {
		this.recentAcks = new RecentAcks(ctx.workspaceState);
		this.enricher = new ForgeEnricher(
			{ now: () => Date.now(), schedule: scheduleTimer, onUpdate: () => this.pushSoon() },
			{ refreshIntervalSeconds: settings.refreshIntervalSeconds() },
		);
		this.enricher.load(ctx.workspaceState.get<PersistedEnrichment>(ENRICHMENT_CACHE_KEY, {}));
		this.supervisor = createSupervisor({
			log: (repoRoot, agentId, line) => this.channel(repoRoot, agentId).append(line),
			onStateChange: () => this.pushSoon(),
			schedule: scheduleTimer,
			planner: {
				lookup: (root) => this.plannerRepo(root),
				liveWorkerKeys: (root) => this.supervisor.liveWorkerKeys(root),
			},
		});
		this.wireWorkspaceEvents();
	}

	private wireWorkspaceEvents(): void {
		this.disposables.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => void this.rediscover()),
			vscode.window.onDidChangeWindowState((e) => this.onWindowState(e)),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('statusPipe')) this.supervisor.updateSettings(settings.supervisorSettings());
			}),
		);
	}

	private onWindowState(e: vscode.WindowState): void {
		if (e.focused) {
			this.supervisor.noteFocus();
			this.enricher.onFocusRegained();
		}
	}

	async initialize(): Promise<void> {
		await this.rediscover();
	}

	// ── discovery ────────────────────────────────────────────────────────

	private async rediscover(): Promise<void> {
		const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
		const contexts = await scanForRepos(folders, settings.protocolDirName());
		const seen = new Set(contexts.map((c) => c.repoRoot));
		for (const [root, repo] of this.repos) {
			if (!seen.has(root)) this.dropRepo(repo);
		}
		for (const context of contexts) {
			if (!this.repos.has(context.repoRoot)) this.addRepo(context);
		}
		this.pushSoon();
	}

	private addRepo(context: RepoContext): void {
		const repo: ManagedRepo = {
			context,
			state: null,
			connection: null,
			connectionTried: false,
			watcher: this.buildProtocolWatcher(context),
			epicWatcher: null,
			reloadTimer: null,
			knownAckIds: new Set(),
			installedLaunchRaw: null,
		};
		this.wireWatcher(repo);
		this.repos.set(context.repoRoot, repo);
		this.scheduleReload(repo);
	}

	private wireWatcher(repo: ManagedRepo): void {
		const onEvent = (uri: vscode.Uri): void => {
			if (!uri.fsPath.endsWith('.tmp')) this.scheduleReload(repo);
		};
		repo.watcher.onDidCreate(onEvent);
		repo.watcher.onDidChange(onEvent);
		repo.watcher.onDidDelete(onEvent);
	}

	private buildProtocolWatcher(context: RepoContext): vscode.FileSystemWatcher {
		return vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(context.protocolDir), '**'),
		);
	}

	private dropRepo(repo: ManagedRepo): void {
		repo.watcher.dispose();
		repo.epicWatcher?.dispose();
		if (repo.reloadTimer) clearTimeout(repo.reloadTimer);
		this.supervisor.setAgents(repo.context.repoRoot, []);
		this.repos.delete(repo.context.repoRoot);
	}

	private scheduleReload(repo: ManagedRepo): void {
		if (repo.reloadTimer) clearTimeout(repo.reloadTimer);
		repo.reloadTimer = setTimeout(() => {
			repo.reloadTimer = null;
			void this.reloadRepo(repo);
		}, RELOAD_COALESCE_MS);
	}

	// ── per-repo reload pipeline ─────────────────────────────────────────

	private async reloadRepo(repo: ManagedRepo): Promise<void> {
		const prev = repo.state;
		repo.state = await loadRepoProtocol(repo.context);
		await this.ensureConnection(repo);
		this.feedEnricher(repo, prev);
		this.feedSupervisor(repo);
		this.detectNewAcks(repo);
		this.ensureEpicWatcher(repo);
		void sweepOrphanedInboxDirs(repo.context.protocolDir, Date.now()).catch(() => undefined);
		this.pushSoon();
	}

	private async ensureConnection(repo: ManagedRepo): Promise<void> {
		if (repo.connectionTried || !repo.state) return;
		repo.connectionTried = true;
		const root = repo.context.repoRoot;
		repo.connection = await connectRepo(repo.context, repo.state.config, this.ctx.secrets, (rate) =>
			this.enricher.noteRateInfo(root, rate),
		);
		this.enricher.setRepository(root, repo.connection?.repository ?? null);
	}

	private feedEnricher(repo: ManagedRepo, prev: RepoProtocolState | null): void {
		if (!repo.state) return;
		const root = repo.context.repoRoot;
		const prs = goodTickets(repo.state).flatMap((t) => t.prs.map((pr) => ({ number: pr.number, state: pr.state })));
		this.enricher.setTrackedPrs(root, prs);
		const changed = changedPrNumbers(prev, repo.state);
		if (changed.length > 0) this.enricher.noteTicketsChanged(root, changed);
	}

	private feedSupervisor(repo: ManagedRepo): void {
		if (!repo.state || repo.context.role === 'worktree') return; // never supervise worktrees
		const root = repo.context.repoRoot;
		// Install agents (sets the worker template) BEFORE feeding the orchestrator:
		// noteOrchestrator reconciles the dispatch plan and the supervisor records
		// each plan once, so a cold-start feed that ran before the template was
		// installed would drop that pass's dispatch until the next pass.
		if (repo.state.launchRaw !== repo.installedLaunchRaw) {
			repo.installedLaunchRaw = repo.state.launchRaw;
			this.installApprovedAgents(repo, false);
		}
		this.supervisor.noteOrchestrator(root, repo.state.orchestrator);
	}

	/** Resolve a repo's planner inputs for the built-in tick spawner (by repo root). */
	private plannerRepo(repoRoot: string): PlannerRepo | null {
		const repo = this.repos.get(repoRoot);
		if (!repo) return null;
		return {
			repo: repo.connection?.id.slug ?? repoRoot,
			protocolDir: repo.context.protocolDir,
			inventory: repo.connection?.inventory ?? null,
			forgeConnected: repo.connection !== null,
			config: repo.state?.config ?? null,
		};
	}

	/** Install already-approved agents; optionally prompt for the rest. */
	private installApprovedAgents(repo: ManagedRepo, prompt: boolean): Promise<LaunchAgent[]> {
		const agents = repo.state?.launch?.agents ?? [];
		const root = repo.context.repoRoot;
		const install = (list: LaunchAgent[]): LaunchAgent[] => {
			const resolved = list.map((a) => ({ ...a, cwd: resolveAgentCwd(root, a) }));
			this.supervisor.setAgents(root, resolved);
			return resolved;
		};
		if (!prompt) {
			const approved = install(agents.filter((a) => isApproved(this.ctx.workspaceState, a)));
			if (approved.length > 0 && settings.autoStart()) this.supervisor.tickNow(root);
			return Promise.resolve(approved);
		}
		return approveAgents(this.ctx.workspaceState, path.basename(root), agents).then(install);
	}

	private detectNewAcks(repo: ManagedRepo): void {
		if (!repo.state) return;
		const current = new Set(repo.state.acksOnDisk.map((a) => a.ackId));
		const isNew = [...current].some((id) => !repo.knownAckIds.has(id));
		repo.knownAckIds = current;
		if (isNew) this.supervisor.noteAckCreated(repo.context.repoRoot);
	}

	private ensureEpicWatcher(repo: ManagedRepo): void {
		if (repo.epicWatcher || !repo.state) return;
		const epicsDir = repo.state.config?.epicsDir ?? 'epics';
		repo.epicWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(path.join(repo.context.repoRoot, epicsDir)), '*.md'),
		);
		const wake = (): void => this.supervisor.noteBacklogChanged(repo.context.repoRoot);
		repo.epicWatcher.onDidCreate(wake);
		repo.epicWatcher.onDidChange(wake);
		repo.epicWatcher.onDidDelete(wake);
	}

	// ── DisplayState pipeline ────────────────────────────────────────────

	subscribe(listener: (s: DisplayState) => void): vscode.Disposable {
		this.listeners.add(listener);
		listener(this.currentState());
		return new vscode.Disposable(() => this.listeners.delete(listener));
	}

	currentState(): DisplayState {
		return this.lastState ?? this.buildState();
	}

	private pushSoon(): void {
		if (this.pushTimer) return;
		this.pushTimer = setTimeout(() => {
			this.pushTimer = null;
			this.push();
		}, PUSH_DEBOUNCE_MS);
	}

	private push(): void {
		const state = this.buildState();
		for (const toast of computeToasts(this.lastState, state, settings.toastSettings())) {
			const show = toast.kind === 'warning' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
			void show(`Status Pipe — ${toast.message}`);
		}
		this.lastState = state;
		void this.ctx.workspaceState.update(ENRICHMENT_CACHE_KEY, this.enricher.serialize());
		for (const listener of this.listeners) listener(state);
	}

	private buildState(): DisplayState {
		const input: QueueModelInput = {
			repos: [...this.repos.values()].filter((r) => r.state !== null).map((r) => this.repoState(r)),
			agents: this.supervisor.states(),
			workers: this.supervisor.workerStates(),
			activity: this.enricher.activity(),
			now: Date.now(),
			settings: settings.queueSettings(),
		};
		return buildDisplayState(input);
	}

	private repoState(repo: ManagedRepo): RepoState {
		const state = repo.state!;
		const root = repo.context.repoRoot;
		return {
			repoRoot: root,
			name: path.basename(root),
			forgeId: repo.connection?.forge.id ?? null,
			capabilities: repo.connection?.forge.capabilities ?? null,
			monitorOnly: repo.context.role === 'worktree',
			issuesUrl: repo.connection ? `${repo.connection.forge.baseUrl}/${repo.connection.id.slug}/issues` : null,
			orchestrator: state.orchestrator,
			config: state.config,
			launch: state.launch,
			tickets: state.tickets,
			acks: this.recentAcks.knownAcks(root, state.acksOnDisk),
			enrichment: this.enricher.getEnrichment(root),
		};
	}

	// ── operations (messageRouter calls these) ───────────────────────────

	async ack(repoRoot: string, ticketKey: string, note: string | null): Promise<'created' | 'already-sent' | 'error'> {
		const repo = this.repos.get(repoRoot);
		const ticket = repo?.state ? goodTickets(repo.state).find((t) => t.ticket === ticketKey) : undefined;
		if (!repo || !ticket) return 'error';
		const ack = buildAck({
			ticket,
			note,
			createdAt: new Date().toISOString(),
			createdBy: `status-pipe-vscode@${extensionVersion(this.ctx)}`,
		});
		if (!ack) return 'error';
		const result = await writeAckFile(repo.context.protocolDir, ack);
		await this.recentAcks.remember(repoRoot, ack);
		this.supervisor.noteAckCreated(repoRoot);
		this.scheduleReload(repo);
		return result;
	}

	async withdrawAck(repoRoot: string, ticketKey: string, ackId: string): Promise<'withdrawn' | 'picked-up-first'> {
		const repo = this.repos.get(repoRoot);
		if (!repo) return 'withdrawn';
		await withdrawAckFile(repo.context.protocolDir, ticketKey, ackId);
		// Re-check the race: a consumption may have landed in the window.
		repo.state = await loadRepoProtocol(repo.context);
		const ticket = goodTickets(repo.state).find((t) => t.ticket === ticketKey);
		const pickedUp = ticket?.history.some((h) => h.note.includes(ackId)) ?? false;
		if (!pickedUp) await this.recentAcks.forget(repoRoot, ackId);
		this.pushSoon();
		return pickedUp ? 'picked-up-first' : 'withdrawn';
	}

	async restartWorker(repoRoot: string): Promise<void> {
		const repo = this.repos.get(repoRoot);
		if (repo?.state?.launch && repo.context.role !== 'worktree') {
			await this.installApprovedAgents(repo, true);
			this.supervisor.tickNow(repoRoot);
			return;
		}
		const command = settings.resumeCommand();
		if (!command) {
			void vscode.window.showInformationMessage(
				'Status Pipe: no launch.json in this repo and no statusPipe.resumeCommand configured.',
			);
			return;
		}
		const terminal = vscode.window.createTerminal({ name: 'Status Pipe', cwd: repoRoot });
		terminal.show();
		terminal.sendText(command);
	}

	async agentControl(repoRoot: string, agentId: string, action: string): Promise<void> {
		const repo = this.repos.get(repoRoot);
		if (action === 'openLog') {
			this.channel(repoRoot, agentId).show();
			return;
		}
		if (repo && (action === 'start' || action === 'tickNow')) await this.installApprovedAgents(repo, true);
		if (action === 'start' || action === 'tickNow' || action === 'stop' || action === 'retry') {
			this.supervisor.control(repoRoot, agentId, action);
		}
	}

	startAll(): void {
		for (const repo of this.repos.values()) {
			if (repo.context.role === 'worktree') continue;
			void this.installApprovedAgents(repo, true).then(() => this.supervisor.tickNow(repo.context.repoRoot));
		}
	}

	stopAll(): void {
		this.supervisor.stopAll();
	}

	/** Immediate pass on already-installed agents; never (re)installs or prompts. */
	tickNow(): void {
		this.supervisor.tickNow();
	}

	refresh(repoRoot?: string): void {
		this.enricher.forceRefresh(repoRoot);
		for (const repo of this.repos.values()) {
			if (!repoRoot || repo.context.repoRoot === repoRoot) this.scheduleReload(repo);
		}
	}

	setViewVisible(visible: boolean): void {
		this.enricher.setVisible(visible);
	}

	async revealTicketFile(repoRoot: string, ticketKey: string): Promise<void> {
		// Fall back to the conventional path when discovery has not landed yet.
		const protocolDir =
			this.repos.get(repoRoot)?.context.protocolDir ?? path.join(repoRoot, settings.protocolDirName());
		const file = path.join(protocolDir, 'tickets', `${ticketKey}.json`);
		await vscode.window.showTextDocument(vscode.Uri.file(file));
	}

	async openEpicFile(repoRoot: string, slug: string): Promise<void> {
		const repo = this.repos.get(repoRoot);
		if (!repo) return;
		const epicsDir = repo.state?.config?.epicsDir ?? 'epics';
		const file = vscode.Uri.file(path.join(repoRoot, epicsDir, `${slug}.md`));
		try {
			await vscode.window.showTextDocument(file);
		} catch {
			const ticket = goodTickets(repo.state!).find((t) => t.slug === slug);
			if (ticket) await this.revealTicketFile(repoRoot, ticket.ticket);
		}
	}

	private channel(repoRoot: string, agentId: string): vscode.OutputChannel {
		const key = `${repoRoot}::${agentId}`;
		let channel = this.channels.get(key);
		if (!channel) {
			channel = vscode.window.createOutputChannel(`Status Pipe: ${path.basename(repoRoot)} · ${agentId}`);
			this.channels.set(key, channel);
		}
		return channel;
	}

	dispose(): void {
		for (const repo of [...this.repos.values()]) this.dropRepo(repo);
		this.supervisor.dispose();
		this.enricher.dispose();
		for (const channel of this.channels.values()) channel.dispose();
		for (const d of this.disposables) d.dispose();
		if (this.pushTimer) clearTimeout(this.pushTimer);
	}
}

// ── helpers ──────────────────────────────────────────────────────────────

function goodTickets(state: RepoProtocolState): import('../protocol/types').TicketFile[] {
	return state.tickets.flatMap((t) => (t.parsed.ok ? [t.parsed.value] : []));
}

function scheduleTimer(fn: () => void, ms: number): () => void {
	const timer = setTimeout(fn, ms);
	return () => clearTimeout(timer);
}

function extensionVersion(ctx: vscode.ExtensionContext): string {
	const packageJson = ctx.extension.packageJSON as { version?: string };
	return packageJson.version ?? '0.0.0';
}
