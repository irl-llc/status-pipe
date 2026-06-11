# Extension Architecture

Follows the proven git-spice-code-extension shape: a Node-side extension host
that owns all I/O, a browser-side React webview that owns all rendering, and a
typed message bus between them. Two webpack bundles from one TypeScript project.

```
┌────────────────────────────── extension host (node) ──────────────────────────────┐
│                                                                                    │
│  repoDiscovery ──► stateStore ◄── stateWatcher (fs watch .autopilot/run/*.json)    │
│      │                 │                                                           │
│      │                 ├──◄ forgeEnricher (debounced; ForgeRepository per repo)    │
│      │                 │        └── forge registry: github | bitbucket | fake      │
│      │                 ▼                                                           │
│      │           queueModel (pure: state files + enrichment → DisplayState)        │
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
`.autopilot/run/` (the folder root plus one level of subdirectories, covering
both single-repo folders and meta-workspaces). Reads `git config --get
remote.origin.url` **by parsing `.git/config` directly** — no git exec, keeping
the no-git-dependency promise. Emits `RepoContext { folder, repoRoot, stateDir,
remoteUrl, forgeRepo? }`. Re-runs on workspace-folder changes.

### `stateWatcher` / `stateStore`
One `vscode.FileSystemWatcher` per state dir covering `run/*.json` and
`inbox/**/*.json`. Events are
coalesced (250ms) because agent passes rewrite several files in a burst.
`stateStore` parses with a tolerant reader: JSON parse errors (a file caught
mid-rename) retry once after 200ms, then surface a "corrupt state file" badge
on the affected card rather than throwing. Unknown `schemaVersion` ⇒ degraded
card. Holds the canonical map `repoRoot → { runMeta, issues: Map<number,
IssueState>, acks: Map<number, AckFile[]> }`.

### `forgeEnricher`
Per repo: collects all PR numbers across that repo's issue states, batch-calls
`ForgeRepository.getPullRequests` / `getChecks` / `getLinkedIssues`, caches
results with timestamps. Triggers: state-file change (debounced 5s), visible
view + stale cache (>60s), manual refresh command. Enrichment results merge
into the store as an overlay — the state file is never mutated, and a card can
always render without the overlay.

### `queueModel` (pure, unit-test target #1)
`(issueStates, feedback, enrichment, now) → DisplayState`. Implements the queue
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
| `openEpicFile {repoRoot, slug}` | open `epics/<slug>.md` if present, else reveal state JSON |
| `showHistory {repoRoot, issue}` | switch card to expanded timeline (editor mode) |
| `ack {repoRoot, issue, target, note}` | create `inbox/issue-<N>/ack-<id>.json` (atomic temp+rename; idempotent id) |
| `withdrawAck {repoRoot, issue, ackId}` | unlink an unconsumed ack file we authored |
| `restartRun {repoRoot, issue}` | run the user-configured per-repo resume command in the integrated terminal |
| `refresh {repoRoot?}` | force enrichment refresh |

Host → webview: `displayState` (full snapshot — small data, no need for
diffing), `enrichmentStatus` (per-repo fetching/error indicators).

## Webview (browser bundle)

React 18, no state library (DisplayState snapshots are the store). Component
tree:

```
<QueueApp mode>
  <RepoSection>            // per repo: name, forge icon, orchestrator-last-ran
    <Bucket title>         // Needs you / In flight / Done
      <IssueCard>          // accent = health; phase chip; headline; blockers
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
| `statusPipe.forge.refreshIntervalSeconds` | 60 | enrichment min interval |
| `statusPipe.stateDir` | `.autopilot` | escape hatch for future conventions |
| `statusPipe.staleRunMinutesDefault` | 30 | when run.json absent |

## Commands

`statusPipe.openInEditor`, `statusPipe.refresh`, `statusPipe.signIn.github`,
`statusPipe.signIn.bitbucket`, `statusPipe.revealStateFile`.

## Build tooling

Webpack dual-bundle, copied from git-spice-code-extension:
`dist/extension.js` (target node, externals: vscode) and `dist/queueView.js`
(target web, React, codicons copied via CopyWebpackPlugin). `tsconfig` ES2022 /
strict / `react-jsx`. Tests compile separately to `out/` for mocha.
