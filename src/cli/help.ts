/**
 * Help, usage, and version strings for the CLI. VERSION is injected at build
 * time by webpack's DefinePlugin (from package.json); under tests (plain tsc, no
 * webpack) the define is absent and it falls back to a dev marker.
 */

export const VERSION = process.env.SP_CLI_VERSION ?? '0.0.0-dev';

export const USAGE =
	'usage: status-pipe [tick] [--repo-root <path>] [--protocol-dir <path>] [--max-concurrent <n>] [--json]';

export const HELP_TEXT = `status-pipe — standalone planner for the status-pipe protocol

Runs one deterministic planner pass (reconcile → dispatch → report) over a
repo's .status-pipe/ state with no VS Code extension. For CI, cron, and
headless servers.

${USAGE}

Commands:
  tick                 Run one planner pass (the default when omitted).

Options:
  --repo-root <path>   Repo to plan over (default: the current directory's
                       checkout; a worktree resolves to its primary).
  --protocol-dir <path>  Override the protocol dir (default: <repo>/.status-pipe).
  --max-concurrent <n>   Dispatch concurrency cap (default: the planner's).
  --json               Emit the machine-readable PlanResult as JSON.
  -h, --help           Show this help.
  -V, --version        Show the version.

Authentication (GitHub): GITHUB_TOKEN or GH_TOKEN, else \`gh auth token\`, else
the git credential helper. Tokens are never read from committed config.json.

Exit codes: 0 success · 1 runtime error or trust refusal · 2 usage error.
`;
