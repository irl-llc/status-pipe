# status-pipe — agent working rules

## Running tests

- **Never launch a real VS Code on the host.** Any test that spawns VS Code
  (the e2e suite, the Playwright snapshot suite) runs headless in Docker —
  the Electron windows steal focus and mess up the operator's desktop state.
  - e2e suite: `npm run test:e2e:docker` (NOT `npm run test:e2e`)
  - snapshots: `npm run test:e2e:playwright:docker[:update]`
    (NOT `npm run test:e2e:playwright`)
- Unit tests are plain mocha and safe on the host:
  `npm run compile-tests && npm run test:unit`.
- Snapshot baselines are Linux/amd64 renders. The CI amd64 render is the
  **verify-only oracle** — it pixel-compares and reports drift; it never
  regenerates baselines.
- **Never regenerate snapshots via CI — there is no CI snapshot-update path.**
  Baselines are regenerated locally and committed by the submitter:
  `npm run test:e2e:playwright:docker:update`. On Apple Silicon this emulates
  amd64 via **OrbStack/Rosetta** (NOT QEMU) and renders the headless VS Code
  webview fine; the full snapshot suite passes locally. If you genuinely cannot
  regenerate locally, that is a human handoff: say so and stop. Do not look for
  a CI dispatch to trigger, and do not author a new CI workflow to do it.

## Source layout

- `design/` is the authoritative spec (02 = protocol, 05 = UI rules,
  09 = supervisor, 10 = naming). Implementation follows it; if code and
  design disagree, fix one and say which.
- Modules under `src/` except `src/host/` and `src/extension.ts` are
  vscode-free by design — unit tests must never import `vscode`.
- `schemas/` is the protocol contract shared with `plugin/`; the plugin's
  ackId derivation must stay byte-identical to `src/protocol/ackId.ts`.

## Conventions

- eslint runs with `--max-warnings=0`: functions ≤20 lines, complexity ≤10,
  max-depth 2, max-params 4 (test files and .tsx components are exempt
  from the size rules only).
- Prettier: tabs, single quotes, width 120. Run `npm run lint` and
  `npm run format:check` before committing.
- Every user-facing change needs a changie fragment in
  `.changes/unreleased/` (see CONTRIBUTING.md).
- Commit via the `git-spice` CLI (`~/go/bin/git-spice` — plain `gs` on this
  machine is Ghostscript).
