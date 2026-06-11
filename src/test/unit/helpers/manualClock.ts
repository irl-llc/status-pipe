/**
 * Manual clock + scheduler for deterministic timer tests. Matches the
 * `schedule(fn, ms) => cancel` shape injected into ForgeEnricher,
 * AgentRunner, and AgentSupervisor.
 */

interface ManualTimer {
	fn: () => void;
	at: number;
	cancelled: boolean;
}

export class ManualClock {
	now = 0;
	private readonly pending: ManualTimer[] = [];

	readonly schedule = (fn: () => void, ms: number): (() => void) => {
		const timer: ManualTimer = { fn, at: this.now + ms, cancelled: false };
		this.pending.push(timer);
		return () => {
			timer.cancelled = true;
		};
	};

	/** Live (uncancelled, unfired) timer count. */
	pendingCount(): number {
		return this.pending.filter((t) => !t.cancelled).length;
	}

	/**
	 * Advance the clock, firing due timers in order with `now` set to each
	 * fire time, flushing microtasks after each so async fire-and-forget
	 * work settles before the next timer.
	 */
	async advance(ms: number): Promise<void> {
		const target = this.now + ms;
		for (;;) {
			const due = this.nextDue(target);
			if (!due) break;
			this.now = Math.max(this.now, due.at);
			due.fn();
			await flushMicrotasks();
		}
		this.now = target;
		await flushMicrotasks();
	}

	private nextDue(target: number): ManualTimer | null {
		const candidates = this.pending.filter((t) => !t.cancelled && t.at <= target).sort((a, b) => a.at - b.at);
		const due = candidates[0] ?? null;
		if (due) this.pending.splice(this.pending.indexOf(due), 1);
		return due;
	}
}

/** Settle promise chains kicked off by fire-and-forget (void) async calls. */
export function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}
