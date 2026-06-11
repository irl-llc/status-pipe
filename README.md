# status-pipe

A VS Code extension that gives a human operator a **review/response queue** over
a fleet of autonomous coding agents, plus a Claude Code plugin providing the
baseline agent workflow that feeds it.

Agents publish state as JSON files under `.status-pipe/` in each repo;
status-pipe watches those files across the workspace, enriches them with live
forge data (GitHub or Bitbucket Cloud + Jira Cloud), and renders a prioritized
queue of what needs the operator — blockers, design questions, review requests,
merges — alongside everything quietly in flight. The operator hands work back
to agents with a one-click **"Ready for another look"** signal, and in fleet
mode the extension launches and supervises the per-repo agent loops itself.

## Parts

| Path | What it is |
|---|---|
| `src/` | The extension: protocol reader/watcher, queue model, forge enrichment (GitHub GraphQL / Bitbucket REST, rate-budget-aware caching), agent supervisor, React webview (tray + editor tab) |
| `plugin/` | The `status-pipe` Claude Code plugin: `/status-pipe:tick`, `work-ticket`, `work-epic`, `launch`, `split`, `ack-check`, the trust-gateway and attribution `bin/` scripts, and the binding protocol skill |
| `schemas/` | JSON Schemas for the protocol files (`ticket`, `ack`, `launch`, `orchestrator`, `config`) — one contract shared by extension and plugin |
| `design/` | The design documents (01–10) and SVG wireframes; `design/02-protocol.md` is the protocol spec, `design/10-naming.md` the terminology decision record |

## The protocol in one breath

`.status-pipe/` at each repo root: committed `launch.json` (how to start the
agent loop) and `config.json` (epics dir, ticketing source, trust mode,
attribution); gitignored `tickets/<key>.json` (agent-owned work-item state),
`orchestrator.json` (pass metadata + parking), and `inbox/<ticket>/ack-*.json`
(operator → orchestrator signals, the one thing the extension writes). Full
spec: [design/02-protocol.md](design/02-protocol.md).

## Development

```sh
npm install
npm run compile          # webpack both bundles
npm run test:unit        # mocha unit suite (run compile-tests first)
npm run test:e2e:docker  # @vscode/test-cli suite, headless in Docker
npm run test:e2e:playwright:docker   # visual snapshots (Linux baseline)
```

Releases are automated: changie fragments per PR → scheduled auto-release →
marketplace publish. See [CONTRIBUTING.md](CONTRIBUTING.md).

Repository: https://github.com/ed-irl/status-pipe · Publisher: `IRLAILLC`
