# Contributing to sleeper-mcp

Thanks for helping make fantasy football questions answerable by an AI assistant. Bug reports, tool ideas and pull requests are all welcome.

## Ground rules

- Be kind. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- Public-API tools are **read-only and require no login**. Optional account tools use Sleeper's unofficial private GraphQL API for private reads and account changes. Keep those tools behind explicit session configuration, honor `--read-only`, support `dry_run` for writes, and preserve validation and verification. Private API changes can break these tools without notice.
- Do not put credentials, session tokens, or private account responses in code, fixtures, logs, issues, or pull requests. Security-sensitive changes should follow [SECURITY.md](SECURITY.md).
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
| `src/injuries/` | Optional read-only injury feed, strict identity matching, source timestamps and conservative disagreement handling |
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

Bug reports are most useful with the exact tool call (name and redacted arguments), the `node dist/index.js --version` output, the checkout commit (`git rev-parse HEAD`) and which client you were using. The issue templates prompt for those. Never include credentials or unredacted private account responses.

## Releasing (maintainers)

The project is distributed as source, not through npm. `package.json` has `"private": true` to prevent accidental npm publication; the GitHub repository remains public. Do not remove this guard as part of a routine release.

1. Prepare a release PR: move **Unreleased** changelog entries under the intended version/date and run `npm version <patch|minor|major> --no-git-tag-version`. Commit both package manifests with the changelog. This does not create or push a tag.
2. Run `npm ci && npm run typecheck && npm test && npm run build`, then `node dist/index.js --help` and `node dist/index.js --version`. Review and merge the release PR normally.
3. Only when intentionally releasing, tag the reviewed commit as `vX.Y.Z` and push that specific tag: `git push origin vX.Y.Z`. Avoid `--follow-tags`, which can publish unrelated local tags too. Tags are public even while the release is a draft.
4. The **Draft GitHub release** workflow checks that the tag matches `package.json`, repeats validation, and creates a draft GitHub release with generated notes. Review the notes and source checkout instructions before manually publishing that GitHub release.

The workflow does not publish packages or images and does not need an npm token or OIDC publishing permission. Existing tags are verified rather than created by the release command. No release is created by an ordinary branch push or PR.

Enabling npm publication later must be a separate, explicitly reviewed change to the package guard, workflow, and installation documentation.
