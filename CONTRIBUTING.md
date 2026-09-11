# Contributing to sleeper-mcp

Thanks for helping make fantasy football questions answerable by an AI assistant. Bug reports, tool ideas and pull requests are all welcome.

## Ground rules

- Be kind. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- The server is **read-only by design**. Sleeper has no public write API, and we will not ship anything that scrapes private endpoints or stores login tokens. Proposals for lineup changes, waiver claims or trades will be closed with a pointer to this section.
- Every tool must return **resolved player names**, never bare Sleeper player IDs. That is the whole point of this server.
- No new runtime dependencies without a discussion first. The runtime footprint is `@modelcontextprotocol/sdk` and `zod`, and it should stay that small.

## Development setup

You need Node.js 20 or newer.

```bash
git clone https://github.com/joscaz/sleeper-mcp.git
cd sleeper-mcp
npm ci
npm test              # unit tests against recorded fixtures, no network
npm run typecheck
npm run dev           # stdio server from TypeScript sources
npm run dev:http      # Streamable HTTP on http://localhost:3000/mcp
npm run inspect       # MCP Inspector against the built server (run `npm run build` first)
npm run smoke         # hits the real Sleeper API; optional SLEEPER_USERNAME=<you>
```

The first run downloads Sleeper's player database (~5 MB) and caches it under `~/.cache/sleeper-mcp`. Set `SLEEPER_MCP_CACHE_DIR=/some/dir` to move it or `SLEEPER_MCP_CACHE_DIR=` (empty) to keep it in memory only.

## Project layout

| Path | What lives there |
| --- | --- |
| `src/index.ts` | CLI entry point: argument parsing, stdio and HTTP startup |
| `src/server.ts` | Builds the MCP server: registers tools, prompts and resources |
| `src/http.ts` | Streamable HTTP transport, health check, optional bearer auth |
| `src/context.ts` | Shared per-server context: resolving users, rosters, seasons, weeks |
| `src/format.ts` | Turns raw Sleeper objects into named, assistant-friendly shapes |
| `src/sleeper/` | Typed Sleeper API client, TTL cache, rate limiter, player database |
| `src/tools/` | One file per tool family (leagues, rosters, transactions, drafts, players, stats) |
| `tests/` | Vitest suites; `fixtures.ts` is a small 4-team league served by a fake `fetch` |
| `scripts/smoke.ts` | End-to-end check against the live API |

## Adding or changing a tool

1. Add the tool to the matching file in `src/tools/`. Define its input with a zod schema and wrap the handler with `guard` from `src/tools/shared.ts` so validation and upstream errors come back as MCP tool errors instead of crashes.
2. Reuse the selectors in `src/tools/shared.ts` (`leagueIdSchema`, `teamSelectorShape`, `seasonSchema`, ...) so every tool accepts teams and seasons the same way.
3. Return named data: run player IDs through the player store and league objects through `src/format.ts`.
4. If the tool needs a Sleeper endpoint that the fixtures do not cover yet, add the route to `routes()` in `tests/fixtures.ts`.
5. Add a test to `tests/tools.test.ts` (the `connectedClient` helper gives you a real MCP client wired to the fake API) and update the tool count assertion in the "server surface" suite.
6. Document the tool in the README's tool reference.

## Pull requests

- Keep each PR focused on one change. Small PRs get reviewed quickly.
- Run `npm run typecheck && npm test && npm run build` before pushing; CI runs the same on Node 20 and 22.
- Add or update tests for behaviour changes. The unit suite must stay network-free.
- Update `CHANGELOG.md` under **Unreleased**.
- Describe *why* in the PR description, not just what. The template asks for the essentials.

Bug reports are most useful with the exact tool call (name and arguments), the `sleeper-mcp --version` output and which client you were using. The issue templates prompt for those.

## Releasing (maintainers)

1. Move the **Unreleased** section of `CHANGELOG.md` under the new version and date.
2. `npm version <patch|minor|major>` (this commits and tags `vX.Y.Z`).
3. `git push --follow-tags`.

Pushing a `v*` tag runs the `Release` workflow, which re-runs the checks, publishes `@joscaz/sleeper-mcp` to npm with provenance and creates a GitHub release with generated notes. The workflow needs an `NPM_TOKEN` repository secret (an npm automation token) until npm trusted publishing is configured for the package.
