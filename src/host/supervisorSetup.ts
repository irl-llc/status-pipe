/**
 * Builds the AgentSupervisor with its two spawners: the production process
 * spawner and the in-process planner spawner for `type:"built-in"` tick
 * entries. Kept out of the controller so the wiring (which spawner runs which
 * mechanism) reads in one place.
 */

import { AgentSupervisor } from '../supervisor/agentSupervisor';
import { nodeSpawner } from './nodeSpawner';
import { PlannerSpawnDeps, createPlannerSpawn } from './plannerSpawn';
import { supervisorSettings } from './settings';

export interface SupervisorHostDeps {
	log(repoRoot: string, agentId: string, line: string): void;
	onStateChange(): void;
	schedule(fn: () => void, ms: number): () => void;
	planner: PlannerSpawnDeps;
}

export function createSupervisor(deps: SupervisorHostDeps): AgentSupervisor {
	return new AgentSupervisor(
		{
			spawn: nodeSpawner,
			builtInSpawn: createPlannerSpawn(deps.planner),
			now: () => Date.now(),
			schedule: deps.schedule,
			log: deps.log,
			onStateChange: deps.onStateChange,
		},
		supervisorSettings(),
	);
}
