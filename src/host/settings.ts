/**
 * Typed access to the statusPipe.* configuration surface
 * (design/04-architecture.md, settings table).
 */

import * as vscode from 'vscode';

import { SupervisorSettings } from '../supervisor/agentSupervisor';
import { ToastSettings } from './notifications';

function cfg(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('statusPipe');
}

export function protocolDirName(): string {
	return cfg().get<string>('protocolDir') ?? '.status-pipe';
}

export function queueSettings(): { staleWorkerMinutesDefault: number; quietRetentionHours: number } {
	return {
		staleWorkerMinutesDefault: cfg().get<number>('staleWorkerMinutesDefault') ?? 30,
		quietRetentionHours: cfg().get<number>('quietRetentionHours') ?? 24,
	};
}

export function refreshIntervalSeconds(): number {
	return cfg().get<number>('forge.refreshIntervalSeconds') ?? 60;
}

export function supervisorSettings(): SupervisorSettings {
	return {
		enabled: cfg().get<boolean>('launch.enabled') ?? true,
		pauseWhenIdle: cfg().get<boolean>('launch.pauseWhenIdle') ?? false,
		maxRestarts: cfg().get<number>('launch.maxRestarts') ?? 3,
	};
}

export function autoStart(): boolean {
	return cfg().get<boolean>('launch.autoStart') ?? false;
}

export function resumeCommand(): string {
	return cfg().get<string>('resumeCommand') ?? '';
}

export function toastSettings(): ToastSettings {
	return {
		blocker: cfg().get<boolean>('notifications.blocker') ?? true,
		crashOrStale: cfg().get<boolean>('notifications.crashOrStale') ?? true,
		completed: cfg().get<boolean>('notifications.completed') ?? true,
		orphanedCi: cfg().get<boolean>('notifications.orphanedCi') ?? true,
		doNotDisturb: cfg().get<boolean>('notifications.doNotDisturb') ?? false,
	};
}
