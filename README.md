# sleeper-mcp

[![CI](https://github.com/joscaz/sleeper-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/joscaz/sleeper-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40joscaz%2Fsleeper-mcp)](https://www.npmjs.com/package/@joscaz/sleeper-mcp)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Sleeper](https://sleeper.com) fantasy football, built so an AI assistant can actually answer fantasy questions instead of handing you a wall of player IDs.

Ask Claude, Cursor, or any MCP client things like:

- "Who should I start this week in my dynasty league?"
- "Show me the standings and who's on the waiver wire at RB."
- "Was the Bijan-for-Chase trade fair? Who won it?"
- "Who did I draft in round 1 the last three years?"

No login, no API key: Sleeper's API is public and read-only.

## Why another Sleeper MCP?

There are several community Sleeper MCP servers. This one focuses on the things that make the difference between "it works" and "it's useful in a conversation":

| | sleeper-mcp (this) | typical alternatives |
| --- | --- | --- |
| Player IDs resolved to names/positions/teams/injury flags in every response | ✅ everywhere (rosters, matchups, transactions, drafts, brackets) | usually raw IDs, or names only in one or two tools |
| Roster IDs resolved to team + manager names | ✅ | rarely |
| Computed standings (rank, record, PF/PA, streak, FAAB left, divisions) | ✅ | raw roster settings |
| Matchups paired with per-player points and margins | ✅ | raw matchup arrays |
| Trades summarized as "gave / got" per side, picks and FAAB included | ✅ | raw adds/drops maps |
| Free agents for a league (unrostered, ranked, trending-annotated) | ✅ | ❌ |
| Projections & stats scored with the **league's exact scoring settings** | ✅ | ❌ (or PPR only) |
| Start/sit: optimal lineup with slot eligibility (FLEX, SUPER_FLEX, IDP) | ✅ | ❌ |
| League history across seasons with champions | ✅ | ❌ |
| Select a team by username, user_id, roster_id **or team name** | ✅ | user_id / roster_id only |
| "Current week/season" defaults from Sleeper's NFL state | ✅ | manual |
| Transports | stdio **and** Streamable HTTP (stateless, bearer auth, CORS, health check, Docker) | stdio only |
| Player database (~5 MB) | memory + disk cache, daily refresh, stale-cache fallback | re-downloaded per process |
| Rate limiting / retries | 600 req/min budget, backoff on 429/5xx, in-flight de-dup | none |
| Tests | 60+ unit + integration tests (in-memory and HTTP transports) plus a live smoke test | varies |
| Tool annotations, `structuredContent`, prompts, resources | ✅ | partial |

All 22 tools are read-only. Nothing here can change a lineup or make a trade.

## Quick start

Requires Node.js 20+.

### From source (today)

```bash
git clone https://github.com/joscaz/sleeper-mcp.git
cd sleeper-mcp
npm install
npm run build
node dist/index.js --help
```

Then point your MCP client at `node /absolute/path/to/sleeper-mcp/dist/index.js`.

### From npm (once published)

```bash
npx -y @joscaz/sleeper-mcp
```

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sleeper": {
      "command": "node",
      "args": ["/absolute/path/to/sleeper-mcp/dist/index.js"],
      "env": { "SLEEPER_USERNAME": "your_sleeper_username" }
    }
  }
}
```

(or `"command": "npx", "args": ["-y", "@joscaz/sleeper-mcp"]` after publishing.)

### Claude Code

```bash
claude mcp add sleeper -e SLEEPER_USERNAME=your_sleeper_username -- node /absolute/path/to/sleeper-mcp/dist/index.js
```

### Cursor / Windsurf / other stdio clients

Same shape: command `node`, args `["/absolute/path/to/sleeper-mcp/dist/index.js"]`, env `SLEEPER_USERNAME`.

### Make it yours

Sleeper's API is public and read-only, so there is no login step: every league, roster and matchup is readable by anyone who knows a username or league ID. The only thing the server cannot know by itself is *who you are*. Set `SLEEPER_USERNAME` (or pass `--user`) and every tool that takes a user or team falls back to you, so "what are my leagues?", "show my roster" and "who should I start?" work without naming yourself. Explicit selectors always win, so questions about other managers still work.

### Remote / hosted (Streamable HTTP)

```bash
SLEEPER_MCP_AUTH_TOKEN=change-me node dist/index.js --http --port 3000
# MCP endpoint:  http://localhost:3000/mcp   (POST, JSON-RPC)
# Health check:  http://localhost:3000/healthz
```

Clients connect with the URL `http://host:3000/mcp` and, if a token is set, the header `Authorization: Bearer change-me`. This works for Replit, Claude's remote MCP connectors, and anything else that speaks Streamable HTTP. The server is stateless (no sessions), so it can sit behind a load balancer or run on serverless platforms.

```bash
docker build -t sleeper-mcp .
docker run -p 3000:3000 -e SLEEPER_MCP_AUTH_TOKEN=change-me -v sleeper-cache:/data sleeper-mcp
```

## Tools

Every tool that takes a team accepts any of `username` (or display name), `user_id`, `roster_id`, `team_name` (partial, case-insensitive), or nothing at all when `SLEEPER_USERNAME` is set. `week` defaults to the current NFL week and `season` to the current league season.

### Users & leagues

| Tool | What it returns |
| --- | --- |
| `get_nfl_state` | Current season, `season_type`, week, `league_season`. |
| `get_user` | Username ↔ `user_id`, display name, avatar. |
| `get_user_leagues` | A user's leagues for a season with league_id, scoring format, roster shape, status. |
| `get_league` | Summarized settings: scoring (PPR/half/std, TE premium, pass TD, bonuses), roster slots, redraft/keeper/dynasty, waivers/FAAB, playoffs, trade deadline, divisions, commissioners. `include_raw` for the full objects. |
| `get_league_standings` | Ranked standings with record, PF/PA, streak, waiver position, FAAB remaining, division. Doubles as the roster_id → manager map. |
| `get_league_history` | Walks `previous_league_id` back through seasons: champion, runner-up, regular-season leader, points leader. |

### Rosters & matchups

| Tool | What it returns |
| --- | --- |
| `get_roster` | One team: starters labeled with slots (QB, RB, FLEX…), bench, IR, taxi, record, FAAB. |
| `get_league_rosters` | Every roster in the league (`include_bench=false` for a lighter payload). |
| `get_matchups` | Paired matchups for a week with scores, margin, leader, starters with per-player points (`include_bench` for bench points). Filter to one team. |
| `get_playoff_bracket` | Winners/losers bracket with round labels ("Championship", "Semifinal", "Toilet bowl final"), teams and results. |

### Transactions & picks

| Tool | What it returns |
| --- | --- |
| `get_transactions` | Trades, waivers, free-agent moves with players, teams, FAAB bids, traded picks and a per-side `trade_summary`. Current week or `all_weeks`. Failed claims hidden unless `status="failed"`/`"all"`. |
| `get_traded_picks` | All traded picks grouped by current owner with original/previous owners. |

### Drafts

| Tool | What it returns |
| --- | --- |
| `get_drafts` | Drafts for a league or for a user + season. |
| `get_draft` | Draft settings and the resolved draft order (slot → manager → roster). |
| `get_draft_picks` | Every pick with player, position, overall/round pick, drafter, keeper flag, auction price. Filter by round or team. |

### Players

| Tool | What it returns |
| --- | --- |
| `search_players` | Name search (handles "ja marr", "lions") with position/team filters, injury and depth-chart info. |
| `get_player` | Full profile: injury details, practice participation, depth chart, measurables, external IDs, headshot URL. |
| `get_trending_players` | Most added/dropped players platform-wide over the last N hours. |
| `get_free_agents` | Unrostered players in a league ranked by Sleeper's player rank, annotated with 24h trending adds. |

### Projections & stats

| Tool | What it returns |
| --- | --- |
| `get_projections` | Weekly or season (`week=0`) projections. Filter by players/position/league/team. `scoring="league"` applies the league's exact `scoring_settings`. |
| `get_player_stats` | Actual weekly/season fantasy production with the same filters and scoring options. |
| `get_lineup_projections` | Start/sit for one team: current vs optimal lineup (respecting FLEX/SUPER_FLEX/IDP eligibility), suggested swaps, bye/injury/empty-slot warnings. |

### Prompts

- `weekly_briefing(league_id, username, week?)` — matchup preview, lineup check, waiver targets, league news.
- `waiver_wire_report(league_id, username)` — prioritized claims with drop candidates and FAAB suggestions.
- `trade_analysis(league_id, team_a, team_b, proposal)` — needs, lineup impact, depth, dynasty value, verdict.

### Resources

- `sleeper://nfl/state`
- `sleeper://league/{league_id}`

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `SLEEPER_USERNAME` | Your Sleeper username (or user_id). Tools that take a user/team default to it, so "my team" questions need no selector. | unset |
| `SLEEPER_MCP_AUTH_TOKEN` | If set, HTTP clients must send `Authorization: Bearer <token>`. | unset (no auth) |
| `SLEEPER_MCP_CACHE_DIR` | Where the player database is cached on disk. Set to an empty string to disable. | `~/.cache/sleeper-mcp` |
| `PORT`, `HOST` | HTTP bind defaults (`--port`/`--host` override). | `3000`, `0.0.0.0` |

CLI flags: `--http`, `--port <n>`, `--host <addr>`, `--user <name>`, `--no-preload`, `--help`, `--version`.

## How it works

- **Player database.** Sleeper publishes one ~5 MB JSON of every NFL player. It is downloaded once, indexed for name search, cached in memory and on disk for 24 hours, and preloaded in the background on startup. If a refresh fails, the stale copy is used rather than failing requests.
- **Caching & rate limits.** Every endpoint is cached with a TTL matched to how fast it changes (20 s for live matchups, 5 min for league lists, 24 h for players). Concurrent identical requests are de-duplicated. Outbound calls are capped at 600/min (Sleeper asks for < 1000) and retried with backoff on 429/5xx.
- **Payload design.** Responses use short keys where they repeat hundreds of times (`{id, name, pos, team, inj, pts}`) and drop empty fields, which keeps token usage down for large leagues.
- **Projections/stats.** These use Sleeper's `/projections` and `/stats` endpoints, which power the Sleeper app but are not in the public docs. They have been stable for years; if they change, the rest of the server is unaffected.

## Development

```bash
npm install
npm run dev            # stdio server via tsx
npm run dev:http       # HTTP on :3000
npm test               # vitest (unit + in-memory MCP + HTTP integration)
npm run typecheck
npm run smoke          # live checks against the real Sleeper API
SLEEPER_USERNAME=you npm run smoke   # also exercises your own leagues
npm run inspect        # MCP Inspector against the built server
```

Layout:

```
src/
  index.ts            CLI entry (stdio / --http)
  server.ts           createServer(): tools, prompts, resources
  http.ts             Streamable HTTP host (stateless, auth, CORS, /healthz)
  context.ts          Shared context + resolvers (user, season, week, league, team)
  format.ts           Scoring summaries, standings math, slot eligibility, lineup helpers
  sleeper/            API client, TTL cache, player store, types
  tools/              Tool registrations grouped by domain
tests/                Fixtures + fake fetch; no network needed
scripts/smoke.ts      Live end-to-end check
```

### Using the client library directly

```ts
import { SleeperClient } from "@joscaz/sleeper-mcp/client";

const sleeper = new SleeperClient();
const state = await sleeper.getNflState();
const leagues = await sleeper.getUserLeagues("<user_id>", "nfl", state.league_season);
```

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the dev setup, the project layout and how to add a tool; the short version is `npm ci && npm test`. Security reports go through [SECURITY.md](SECURITY.md), and everyone is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Releasing

```bash
npm version minor        # bumps package.json and tags vX.Y.Z
git push --follow-tags   # the Release workflow publishes to npm and creates the GitHub release
```

See the "Releasing" section of CONTRIBUTING.md for the one-time npm setup.

## Credits & license

Data comes from Sleeper's public API ([docs.sleeper.com](https://docs.sleeper.com)). This project is not affiliated with Sleeper. Thanks to the earlier community servers, in particular [FloSchl8/sleeper-mcp](https://github.com/FloSchl8/sleeper-mcp), for mapping out the space.

MIT © 2026 Jose Zertuche
