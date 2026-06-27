---
name: git-spice-integration
description: BINDING for a status-pipe worker in a repo that maintains a git-spice integration branch (the merged tips of every open stack, built and tested together). Governs the worker's integration-tip lifecycle — keep your stack's tip disconnected while the feature is unstable, and only when the feature is COMPLETE re-register it and rebuild the integration branch inside your OWN worktree. git's one-worktree-per-branch rule is the lock; finishing workers contend with truncated exponential backoff + jitter. Load this alongside the protocol skill in any repo whose worker entry is /status-pipe:git-spice-worker.
---

# git-spice integration branch — worker rules (binding)

A repo using this skill maintains a single git-spice **integration branch**: the
merged tips of every **complete** open stack, so finished work can be built and
tested together. It is a throwaway artifact — it never gets its own PR. The
status-pipe planner only plans and dispatches; the integration branch is
maintained by the **finishing worker** — you, around your normal worker pass.

The invariant: **a stack feeds the integration branch only while it is complete.**
Your tip is your readiness signal, not a submit marker. The tip list lives in
git-spice's shared state store (`refs/spice/data`), so a tip you register in your
worktree is the same tip your rebuild reads — no fetch or cross-clone sync.

## A — When you START a pass: mark your stack UNSTABLE

The moment you (re)work a stack it must stop feeding the integration branch. If
this stack already carries a tip (you are resuming an in-flight stack from a
prior session), drop it:

```bash
git-spice integration tip ls                              # current tips
git-spice integration tip rm <this stack's top branch>    # drop yours if present
```

A brand-new stack has no tip yet — nothing to drop.

## B — When you FINISH: publish, but ONLY if the feature is COMPLETE

Judge completeness yourself: implemented, **tests pass**, the stack is submitted,
and it is ready to be built together with everyone else's work. If it is NOT
complete — you stopped mid-feature, tests are red, you're blocked, or the ticket
is waiting on the operator — **do not publish.** Leave the tip disconnected; a
later session that finishes the feature publishes it. Say so in your report.

When (and only when) the feature is complete:

1. **Ensure the integration branch exists** (a no-op after the first run):

   ```bash
   git-spice integration show 2>/dev/null | grep -q "^Integration branch:" \
     || git-spice integration create integration
   ```

2. **Re-register your tip** so the rebuild includes your now-complete stack:

   ```bash
   git-spice integration tip add "$(git branch --show-current)"
   git-spice integration tip advance      # move the tip to the stack's top if it grew
   ```

3. **Acquire the integration branch IN YOUR OWN worktree.** git refuses a second
   worktree on a branch already checked out elsewhere — that refusal IS the lock,
   so two finishing workers can never rebuild at once. Retry the checkout with
   **truncated exponential backoff + jitter** until you get it:

   ```bash
   acquired=
   for i in 1 2 3 4 5 6; do
     if git-spice integration co 2>/dev/null; then acquired=1; break; fi
     cap=$(( 2 ** i )); [ "$cap" -gt 30 ] && cap=30        # 2,4,8,16,30,30s ceiling
     sleep "$(awk -v c="$cap" 'BEGIN { srand(); print c * (0.5 + 0.5 * rand()) }')"
   done
   ```

   If you never acquire it within the retries, **stop — do not force it.** Your tip
   is registered, so the next finishing worker's rebuild will include your work.
   Report that you deferred the rebuild.

4. **Rebuild from the available tips and push** (you are now on the integration
   branch, off your own tip, so the rebuild is allowed):

   ```bash
   git-spice repo sync --no-prompt
   git-spice integration rebuild --push
   ```

   If the rebuild stops on an unresolved conflict (should not happen while
   accept-incoming is on), do NOT hand-resolve: report the conflicting tips and
   leave the branch as-is for the operator. Never merge, approve, or delete.

5. **Release the lock** — return your worktree to your own stack branch so the
   next finishing worker can acquire the integration branch:

   ```bash
   git checkout -    # back to the branch you were on before `integration co`
   ```

Report whether you published (tip re-registered + integration rebuilt/pushed),
deferred the rebuild (lock contended), or left the stack unstable (incomplete) —
and the integration push result.
