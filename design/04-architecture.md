# Extension Architecture

Follows the proven git-spice-code-extension shape: a Node-side extension host
that owns all I/O, a browser-side React webview that owns all rendering, and a
typed message bus between them. Two webpack bundles from one TypeScript project.

```
┌────────────────────────────── extension host (node) ──────────────────────────────┐
│                                                                                    │
│  repoDiscovery ──► protocolStore ◄── protocolWatcher (fs watch .status-pipe/**)      │
│      │                 │                                                           │
│      │                 ├──◄ forgeEnricher (debounced; ForgeRepository per repo)    │
│      │                 │        └── forge registry: github | bitbucket | fake      │
│      │                 ▼                                                           │
│      │           queueModel (pure: ticket files + enrichment → DisplayState)        │
│      │                 │                                                           │
│      ▼                 ▼                                                           │
│  QueueViewProvider (sidebar)  ╲                                                    │
│  QueueEditorProvider (tab)    ─┼── postMessage(DisplayState) ──► webview           │
│  messageRouter ◄───────────────┼── onDidReceiveMessage ◄──────── webview           │
│      └── handlers: openExternal, openFile, ack(feedback write), refresh, expand    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

## Modules (extension host)

### `repoDiscovery`
Enumerates workspace folders; for each, finds git repos containing
`.status-pipe/` (the folder root plus one level of subdirectories, covering
both single-repo folders and meta-workspaces). Reads `git config --get
remote.origin.url` **by parsing `.git/config` directly** — no git exec, keeping
the no-git-dependency promise. When `.git` is a *file* (worktrees, submodules)
its `gitdir:` pointer is followed to the real config; `url.*.insteadOf`
rewrites are explicitly out of scope (raw remote URLs are matched). Emits
`RepoContext { folder, repoRoot, protocolDir, remoteUrl, role: 'primary' |
'worktree', primaryRoot?, forgeRepo? }`. Re-runs on workspace-folder changes.

**Worktree guard (recursion safety).** A checkout whose `.git` file points
into another repo's `.git/worktrees/` is classified `role: 'worktree'` —
worktrees are full checkouts, so they carry the committed `launch.json`, and
naively supervising one would spawn a second orchestrator over the same
backlog that mints nested worktrees every tick. Rules: worktrees are **never
supervised** (no launch, no fleet-strip entry, launch.json ignored) and never
produce their own queue entries; their `protocolDir` resolves through the
`gitdir:` pointer to the **primary** checkout's `.status-pipe/`. If the
primary is also a workspace folder the worktree folder is skipped outright;
if only the worktree is open (a legitimate way to work), it renders the
primary's queue monitor-only with a "worktree of `<primary>` — supervision
disabled" note in the inactive-roots footer. This is one of three independent
recursion guards (the others live in the plugin:
[07-claude-plugin.md](07-claude-plugin.md)).

### `protocolWatcher` / `protocolStore`
One `vscode.FileSystemWatcher` per protocol dir on the pattern
`.status-pipe/**` (the API takes one glob per watcher), filtered in the
handler to: `tickets/*.json`, `orchestrator.json`, `inbox/**/*.json` — plus
the two committed files, whose changes re-trigger their own flows
(`launch.json` → re-approval per content hash, `config.json` → re-resolve
ticketing/trust display hints). Events are
coalesced (250ms) because agent passes rewrite several files in a burst.
`protocolStore` parses with a tolerant reader: JSON parse errors (a file caught
mid-rename) retry once after 200ms, then surface a "corrupt ticket file" badge
on the affected card rather than throwing. Unknown `schemaVersion` ⇒ degraded
card. Holds the canonical map `repoRoot → { orchestratorMeta, tickets: Map<string,
TicketState>, acks: Map<string, AckFile[]> }`.

### `forgeEnricher`
Per repo: collects all PR numbers across that repo's ticket files, batch-calls
`ForgeRepository.getPullRequests` / `getChecks` / `getLinkedTickets`, caches
results with timestamps. Triggers: ticket-file change (debounced 5s,
change-driven — only the PRs the changed file references), visible view +
stale cache (>60s), focus regained, manual refresh. The full cache/budget
design (persisted `workspaceState` cache, terminal-state freeze, ETags, rate
budgeting and backoff) is in [03-forge.md](03-forge.md). Enrichment results
merge into the store as an overlay — the ticket file is never mutated, and a
card can always render without the overlay. Enricher activity/degradation is
published to the views' reserved activity slot, never as per-card errors.

### `agentSupervisor` (fleet mode; see [09-launch-and-supervision.md](09-launch-and-supervision.md))
Reads `.status-pipe/launch.json` per repo (trust-gated by content hash), runs the
tick/daemon state machine per `(repo, agent)`, spawns children via
`child_process.spawn` with stdout/stderr to per-agent OutputChannels, tracks
`lastOutputAt` liveness and exit codes, applies backoff, and feeds the
`DisplayState` agents strip plus synthetic launcher-failed queue cards.
Strictly separate from the protocol’s agent-owned files — process health is
supervisor-owned, work-item health is agent-owned.

### `queueModel` (pure, unit-test target #1)
`(tickets, acks, enrichment, supervisorState, now) → DisplayState`
(supervisorState feeds the fleet strip and the synthetic launcher-failed
cards). Implements the queue
semantics from [05-ui.md](05-ui.md): bucket assignment, priority ordering,
stack-relationship derivation (base/head matching), stale-heartbeat detection,
waiting-duration formatting. Pure function of inputs — `now` is a parameter so
durations and staleness are deterministic under test.

### View providers
- `QueueViewProvider implements WebviewViewProvider` — the side-tray view,
  registered in its own activity-bar container (`statusPipe.queue`).
- `QueueEditorProvider` — `statusPipe.openInEditor` command opens the same
  webview content in a `WebviewPanel` (retainContextWhenHidden). Same React
  app; a `mode: 'tray' | 'editor'` flag in the init message selects layout
  density. One DisplayState pipeline feeds both; both may be open at once.
- Activity-bar badge: count of Needs-you items, via `WebviewView.badge`.

### `messageRouter` + handlers
Typed discriminated unions in `webviewTypes.ts` (the git-spice-code-extension
pattern). Webview → host messages:

| message | handler behavior |
|---|---|
| `openExternal {url}` | `vscode.env.openExternal` (PRs, issues, checks) |
| `openEpicFile {repoRoot, slug}` | open `epics/<slug>.md` if present, else reveal ticket JSON |
| `showHistory {repoRoot, ticket}` | switch card to expanded timeline (editor mode) |
| `ack {repoRoot, ticket, target, note}` | create `inbox/<ticket>/ack-<id>.json` (atomic temp+rename; idempotent id) |
| `withdrawAck {repoRoot, ticket, ackId}` | unlink an unconsumed ack file we authored |
| `restartWorker {repoRoot, ticket}` | supervisor tick-now when a launch file exists; else the configured resume command in the integrated terminal |
| `agentControl {repoRoot, agentId, action: start\|stop\|tickNow\|openLog}` | drive the supervisor |
| `refresh {repoRoot?}` | force enrichment refresh (semantics per [03-forge.md](03-forge.md)) |

Host → webview: `displayState` (full snapshot — small data, no need for
diffing), `enrichmentStatus` (per-repo fetching/error indicators).

## Webview (browser bundle)

React 18, no state library (DisplayState snapshots are the store). Component
tree:

```
<QueueApp mode>
  <RepoSection>            // per repo: name, forge icon, orchestrator-last-ran
    <Bucket title>         // Needs you / In flight / Done
      <TicketCard>         // accent = health; phase dim text; headline; blockers
        <WaitingBanner>    // waitingOn kind icon + detail + live duration
        <AckControl>       // button / pending chip / moved-on warning
        <PrRow>            // upstream indicator ↑, PR #, title, badges, ↓ downstream
          <Badges>         // comments 3/7, tasks 1/4, checks ✓✗●, review state
        <Timeline>         // editor mode, expanded: history[]
```

Styling via VS Code CSS variables (`--vscode-*`) for theme fidelity; codicons
for iconography; CSP with nonce exactly as git-spice-code-extension's
`webviewHtml.ts`.

## Configuration surface

| setting | default | notes |
|---|---|---|
| `statusPipe.forge.type` | `auto` | `auto\|github\|bitbucket`, resource-scoped |
| `statusPipe.forge.github.baseUrl/apiUrl/token` | github.com | token falls back to env/gh/VS Code auth |
| `statusPipe.forge.bitbucket.baseUrl/apiUrl/token` | bitbucket.org | token falls back to env/SecretStorage |
| `statusPipe.tickets.jira.siteUrl/email` | — | Jira Cloud ticketing for Bitbucket repos; token via env/SecretStorage |
| `statusPipe.forge.refreshIntervalSeconds` | 60 | enrichment min interval |
| `statusPipe.protocolDir` | `.status-pipe` | escape hatch for future conventions |
| `statusPipe.staleWorkerMinutesDefault` | 30 | when orchestrator.json absent |
| `statusPipe.launch.enabled` | true | master switch for the supervisor |
| `statusPipe.launch.autoStart` | false | auto-start approved agents on workspace open |
| `statusPipe.launch.pauseWhenIdle` | false | pause ticks after 30 min without focus (conflicts with overnight runs; see 09) |
| `statusPipe.launch.maxRestarts` | 3 | consecutive failures before `failed` |
| `statusPipe.resumeCommand` | — | fallback restart command when no launch file |
| `statusPipe.quietRetentionHours` | 24 | how long done items stay visible in QUIET |
| `statusPipe.notifications.*` | on | per-toast toggles (blocker, crash/stale, completed, orphanedCi) + `doNotDisturb` |

## Commands

`statusPipe.openInEditor`, `statusPipe.refresh`, `statusPipe.signIn.github`,
`statusPipe.signIn.bitbucket`, `statusPipe.revealTicketFile`,
`statusPipe.agents.startAll`, `statusPipe.agents.stopAll`,
`statusPipe.agents.tickNow`, `statusPipe.agents.openLog`.

## Build tooling

Webpack dual-bundle, copied from git-spice-code-extension:
`dist/extension.js` (target node, externals: vscode) and `dist/queueView.js`
(target web, React, codicons copied via CopyWebpackPlugin). `tsconfig` ES2022 /
strict / `react-jsx`. Tests compile separately to `out/` for mocha.
