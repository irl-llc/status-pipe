# Testing & Release

Both copied from git-spice-code-extension, with the release pipeline taken from
its `ci-auto-release-publish` branch (the corrected post-issue-#29 design) and
the snapshot-artifact pattern from `ci/playwright-snapshot-artifacts`.

## Test layers

Philosophy (per the house rules): no mocking of internal interfaces; real
implementations; simulate the real deployment; layer approaches.

### 1. Unit tests (mocha, `src/test/unit/`)

Primary targets — all pure or dependency-injected:

- **`queueModel`**: bucket assignment and priority ordering for every rule in
  [05-ui.md](05-ui.md) (crashed-worker beats blocked beats owner-question…),
  stack derivation from `head`/`base` matching, stale-heartbeat math with a
  injected `now`, clock-skew clamping, deterministic tie-breaks.
- **State parsing**: tolerant reader against fixture files — valid v1 files
  (real examples captured from irl-llc), corrupt JSON, unknown schemaVersion,
  missing optional fields.
- **Ack writer**: idempotent `ackId` derivation, atomic write behavior (temp
  file then rename), withdraw semantics.
- **Forge mapping layers**: recorded GitHub GraphQL and Bitbucket REST response
  fixtures → `PullRequestInfo`/`ChecksInfo`/`CommentCounts`, including the
  capability differences (tasks present/absent, `prLevelResolvable` captioning,
  Bitbucket status aggregation rules).
- **Enrichment cache policy**: terminal-state freeze, change-driven fetch
  narrowing, rate-budget interval stretching and backoff math (injected clock
  and fake transport recording request counts — assertions are "N requests for
  this scenario", the rate-limit budget being a tested invariant).
- **Agent supervisor**: tick/daemon state machine against a fake launch target
  (a small script that exits 0 / exits 1 / hangs / streams NDJSON) — schedule,
  timeout-kill, backoff, failed escalation, trust-hash gating logic.
- **Worktree recursion guard**: discovery against fixture repos containing
  linked worktrees (`.git` pointer files, `.claude/worktrees/<slug>` layouts) —
  worktrees classified, never supervised, protocol dir resolved to the
  primary; a worktree opened as the sole workspace folder renders the
  primary's queue monitor-only.
- **Webview components**: jsdom + @testing-library/react for card states (ack
  chip state machine, badge rendering, lane headers) — the
  git-spice-code-extension `reactTestHelper` pattern.

### 2. E2E suite (mocha via @vscode/test-cli, `src/test/e2e/suite/`)

Extension activates in a real VS Code against a temp workspace; commands are
registered; protocol-dir discovery finds fixture repos; file watcher delivers
updates; ack command produces a correct file on disk.

### 3. Playwright snapshot tests (`src/test/e2e/playwright/`)

Real VS Code launched via @vscode/test-electron, attached over CDP, webview
located through the nested-iframe fixture (port of `webview.ts` from
git-spice-code-extension). Fixture repos are generated temp dirs seeded with
`.status-pipe/tickets/*.json` files covering: the six-epic simulation scenario, every
lane, every badge type, stack indicators, degraded/unknown-schema cards, the
empty "all quiet" state. Forge enrichment served by the in-process **fake
forge** (shamhub pattern) speaking canned GitHub-GraphQL and Bitbucket-REST so
snapshots include enriched badges deterministically.

Snapshot discipline (proven in git-spice-code-extension):

- CI Linux/amd64 render is the baseline oracle; local arm64 is not byte-identical
- Docker compose harness (`docker-compose.test.yml`, Playwright Jammy image,
  xvfb) for local verify/regen: `npm run test:e2e:playwright:docker[:update]`
- PNG baselines in git-lfs
- `workers: 1`, animations disabled, fonts awaited, `maxDiffPixelRatio: 0.005`
- CI `workflow_dispatch` input `update_snapshots`: regenerates baselines in CI
  and uploads them as artifacts for download-and-commit

## CI (`.github/workflows/ci.yml`)

On PR + main push: install → lint → compile (webpack both bundles) →
unit tests → e2e suite → Playwright snapshots in Docker (with buildx cache and
MCR retry) → upload `test-results/` + generated snapshots on failure or
`update_snapshots`. A `changelog-gate.yml` requires a changie fragment under
`.changes/unreleased/` on every PR (label opt-out for chores).

## Release automation

Changie + scheduled auto-release + reusable publish — the
`ci-auto-release-publish` design verbatim:

1. **Fragments**: every PR adds `.changes/unreleased/<id>.yaml`
   (`kind: Added|Changed|Deprecated|Removed|Fixed|Security`, `body:`).
   Added/Changed/Deprecated/Removed ⇒ minor; Fixed/Security ⇒ patch; no major
   while on 0.x.
2. **`auto-release.yml`**: daily 05:00 UTC cron + manual dispatch with
   `dry_run`. If fragments are pending: derive bump via unit-tested
   `releaseBump.ts`, `changie batch` + `merge` into `CHANGELOG.md`, bump
   `package.json`, commit, tag `v<version>`, `gh release create`. No fragments
   ⇒ silent no-op. Concurrency group prevents racing releases.
3. **`publish.yml`** (reusable, `workflow_call`): checkout the tag → build →
   `vsce publish` (VS Code Marketplace, `VSCE_PAT`) → `ovsx publish`
   (Open VSX, `OVSX_PAT`). Called from **two** places so publish logic lives
   once: `ci.yml` on human-created Releases, and `auto-release.yml` as a
   chained job gated on its `released`/`tag` outputs — chained because GitHub
   does not re-trigger workflows from Releases created with the default
   `GITHUB_TOKEN` (the failure git-spice-code-extension hit as issue #29).
4. **`releaseOutput.ts`**: pure, unit-tested formatter for the
   `$GITHUB_OUTPUT` lines gating the chained publish job.

Repo: `https://github.com/ed-irl/status-pipe`. Publisher: `IRLAILLC`.
Required secrets: `VSCE_PAT`, `OVSX_PAT`.
