---
description: git-spice integration-aware status-pipe worker — runs the dispatched worker pass bracketed by git-spice integration-branch tip management. The worker entry for a repo that maintains a git-spice integration branch; wrap the planner's dispatched /status-pipe:work-* command with this.
argument-hint: "<the dispatched /status-pipe:work-ticket|work-epic command>"
---

**STATUS-PIPE GIT-SPICE WORKER — one integration-aware worker pass**

$ARGUMENTS

`$ARGUMENTS` is the status-pipe worker command the planner dispatched for this
item (e.g. `/status-pipe:work-ticket 19` or `/status-pipe:work-epic <path>`). You
run it exactly as a normal worker would, but you BRACKET it with git-spice
integration-branch tip management so the shared integration branch only ever
merges complete work — and a finishing worker keeps it fresh.

Load the **`git-spice-integration`** skill (binding for this pass) and the
**`protocol`** skill (binding for all protocol writes) before doing anything else.

Then, in order:

1. **Mark your stack unstable** — drop this stack's integration tip per the
   git-spice-integration skill, section A. (A resumed in-flight stack drops the
   tip it still carries; a brand-new stack has none.)

2. **Do the work** — run the dispatched command verbatim and let it finish:

   `$ARGUMENTS`

   Its report is part of your output.

3. **Publish — only if the feature is COMPLETE** — follow the git-spice-integration
   skill, section B: re-register your tip, acquire the integration branch in your
   own worktree (lock via git's one-worktree-per-branch rule + truncated
   exponential backoff with jitter), `repo sync`, `integration rebuild --push`,
   then release. If the feature is not complete, leave the tip disconnected and
   say so — a later session publishes it.

Report what the inner worker did, and whether you published the integration
branch, deferred the rebuild (lock contended), or left the stack unstable.
