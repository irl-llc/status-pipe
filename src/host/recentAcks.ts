/**
 * Memory of acks the extension wrote (workspaceState-persisted). Needed
 * for the picked-up / superseded / pickup-unconfirmed chip states — once
 * the orchestrator consumes (deletes) the file, only this memory knows an
 * ack existed. Pruned after 7 days.
 */

import * as vscode from 'vscode';

import { AckFile } from '../protocol/types';
import { KnownAck } from '../queue/queueInputs';

const KEY = 'statusPipe.recentAcks';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type Stored = Record<string, AckFile[]>; // repoRoot → acks

export class RecentAcks {
	constructor(private readonly state: vscode.Memento) {}

	private all(): Stored {
		return this.state.get<Stored>(KEY, {});
	}

	async remember(repoRoot: string, ack: AckFile): Promise<void> {
		const all = this.all();
		const list = (all[repoRoot] ?? []).filter((a) => a.ackId !== ack.ackId);
		list.push(ack);
		all[repoRoot] = list;
		await this.state.update(KEY, this.prune(all));
	}

	async forget(repoRoot: string, ackId: string): Promise<void> {
		const all = this.all();
		all[repoRoot] = (all[repoRoot] ?? []).filter((a) => a.ackId !== ackId);
		await this.state.update(KEY, all);
	}

	/** Union of on-disk acks and remembered ones, flagged by presence. */
	knownAcks(repoRoot: string, onDisk: AckFile[]): KnownAck[] {
		const onDiskIds = new Set(onDisk.map((a) => a.ackId));
		const remembered = (this.all()[repoRoot] ?? []).filter((a) => !onDiskIds.has(a.ackId));
		return [...onDisk.map((ack) => ({ ack, onDisk: true })), ...remembered.map((ack) => ({ ack, onDisk: false }))];
	}

	private prune(all: Stored): Stored {
		const cutoff = Date.now() - RETENTION_MS;
		const pruned: Stored = {};
		for (const [repoRoot, acks] of Object.entries(all)) {
			const kept = acks.filter((a) => {
				const created = Date.parse(a.createdAt);
				return Number.isNaN(created) || created >= cutoff;
			});
			if (kept.length > 0) pruned[repoRoot] = kept;
		}
		return pruned;
	}
}
