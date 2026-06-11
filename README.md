# status-pipe

A VS Code extension that gives a human operator a **review/response queue** over
a fleet of autonomous coding agents, plus a Claude Code plugin providing the
baseline agent workflow that feeds it.

Agents publish state as JSON files under `.status-pipe/` in each repo;
status-pipe watches those files across the workspace, enriches them with live
forge data (GitHub or Bitbucket), and renders a prioritized queue of what needs
the operator — blockers, design questions, review requests, merges — alongside
everything quietly in flight. The operator hands work back to agents with a
one-click **"ready for another look"** signal.

**Status: design phase.** See [design/01-overview.md](design/01-overview.md)
for the document map, and [design/wireframes/](design/wireframes/) for UI
wireframes.

Repository: https://github.com/ed-irl/status-pipe
