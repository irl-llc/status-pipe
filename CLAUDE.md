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
- Snapshot baselines are Linux renders. The CI amd64 render is the oracle;
  regenerate via the `update_snapshots` workflow_dispatch input on ci.yml
  (or locally via the docker `:update` script on an amd64-comparable setup).

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
  max-depth 2, max-params 4 (test files exempt from the size rules only).
- Prettier: tabs, single quotes, width 120. Run `npm run lint` and
  `npm run format:check` before committing.
- Every user-facing change needs a changie fragment in
  `.changes/unreleased/` (see CONTRIBUTING.md).
- Commit via the `git-spice` CLI (`~/go/bin/git-spice` — plain `gs` on this
  machine is Ghostscript).
