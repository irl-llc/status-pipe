# Contributing

## Building and testing

```bash
npm ci                  # install dependencies
npm run compile         # webpack both bundles (dist/extension.js + dist/queueView.js)
npm run lint            # eslint src --max-warnings=0 (the CI gate)
npm run format:check    # prettier check
npm run compile-tests   # tsc -> out/ (required before unit tests)
npm run test:unit       # mocha unit tests (out/test/unit/**)
npm run test:e2e:docker # mocha E2E suite in a real VS Code, headless in Docker
```

Anything that launches a real VS Code (the e2e suite, the Playwright
snapshots) should run through the Docker scripts locally — a natively
spawned VS Code window steals focus and disturbs your desktop session.
`npm run test:e2e` exists for CI (xvfb) and debugging only.

### Playwright snapshot tests

Visual snapshots are rendered inside a Linux Docker container
(`mcr.microsoft.com/playwright:v1.60.0-jammy`) so the PNG baselines —
git-lfs-tracked under `src/test/e2e/playwright/*-snapshots/` — are
byte-identical between local runs and CI:

```bash
npm run test:e2e:playwright:docker          # verify against baselines
npm run test:e2e:playwright:docker:update   # regenerate baselines
```

Running `npm run test:e2e:playwright` natively on macOS produces diffs that
don't match the Linux baselines; that's expected. CI Linux/amd64 is the
baseline oracle: the CI workflow's `update_snapshots` dispatch input
regenerates baselines in CI and uploads them as an artifact for
download-and-commit.

## Changelog fragments (Changie)

This project tracks user-facing changes with [Changie](https://changie.dev).
Instead of editing `CHANGELOG.md` directly, every pull request that changes
user-facing behavior adds a small "change fragment" file under
`.changes/unreleased/`. A scheduled job
([`.github/workflows/auto-release.yml`](.github/workflows/auto-release.yml))
batches these fragments into a release daily and publishes to the VS Code
Marketplace and Open VSX.

### Adding a fragment

Install Changie (e.g. `brew install changie` on macOS/Linux,
`go install github.com/miniscruff/changie@latest`, or see the
[install docs](https://changie.dev/guide/installation/)) and run:

```bash
changie new
```

This prompts for a **kind** and a **body**, then writes a YAML fragment to
`.changes/unreleased/`. Commit that file with your change.

You can also write the fragment by hand — create
`.changes/unreleased/<descriptive-name>.yaml`:

```yaml
kind: Fixed
body: Queue view no longer flickers when refreshing enrichment badges.
```

### Kinds and version bumps

The extension is pre-1.0, so it stays on `0.x`. Per semver for `0.x`, both
features and breaking changes bump the **minor** component (we never bump major
while on `0.x`); bug fixes bump the **patch** component. The auto-release
derives the bump from the pending fragment kinds:

| Kind         | Use for                                       | Bump  |
| ------------ | --------------------------------------------- | ----- |
| `Added`      | New user-facing feature                       | minor |
| `Changed`    | Change to existing behavior (incl. breaking)  | minor |
| `Deprecated` | Soon-to-be-removed behavior                   | minor |
| `Removed`    | Removed behavior                              | minor |
| `Fixed`      | Bug fix                                       | patch |
| `Security`   | Security fix                                  | patch |

When multiple fragments are pending, the highest bump wins (any
`Added`/`Changed`/`Deprecated`/`Removed` => minor; otherwise patch).

### When a fragment is NOT required

Docs-only, CI-only, and other non-user-facing changes do not warrant a release
and do not need a fragment. CI recognizes these automatically by the paths a PR
touches (see `src/utils/changelogGate.ts`); if it cannot, add the
`skip-changelog` label to the PR to bypass the gate. Docs-only changes never
trigger a release.
