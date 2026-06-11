/**
 * A recording Spawner for AgentRunner/AgentSupervisor tests: captures every
 * SpawnRequest, exposes the per-process event hooks so tests fire
 * onOutput/onExit manually, and counts kill() calls.
 */

import { ProcessEvents, SpawnRequest, Spawner } from '../../../supervisor/agentRunner';

export class FakeSpawner {
	readonly requests: SpawnRequest[] = [];
	readonly events: ProcessEvents[] = [];
	kills = 0;
	/** When set, the next spawn throws (spawn-failure path). */
	failNext: Error | null = null;

	readonly spawn: Spawner = (request, events) => {
		if (this.failNext) {
			const err = this.failNext;
			this.failNext = null;
			throw err;
		}
		this.requests.push(request);
		this.events.push(events);
		return {
			kill: () => {
				this.kills += 1;
			},
		};
	};

	/** Fire onExit on the most recently spawned process. */
	exitLast(code: number | null): void {
		const events = this.events[this.events.length - 1];
		if (!events) throw new Error('no spawned process to exit');
		events.onExit(code);
	}

	/** Fire onOutput on the most recently spawned process. */
	outputLast(chunk: string): void {
		const events = this.events[this.events.length - 1];
		if (!events) throw new Error('no spawned process for output');
		events.onOutput(chunk);
	}
}
