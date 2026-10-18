# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `get_player_trends` and `get_team_usage`: read-only regular-season offensive usage from Sleeper's weekly stat rows. Show snaps, targets, carries, red-zone work, air yards, team shares and numerical changes with per-metric sample sizes. Preserve historical teams, expose denominator coverage, distinguish inferred byes/no-offensive-snap rows/missing data, and exclude unfinished weeks. Bounded cached requests; no breakout scores, projections or account changes.

- `compare_lineups`: read-only, current-week comparison of up to five named scenarios against the actual weekly lineup. Reuses one set of scoring, matchup points, projections, game states, and injury context; returns projected-point and approximate win-probability deltas, validates eligibility and locks, isolates invalid scenarios, and makes missing opponent odds explicit. No account APIs or lineup mutations are called.
- `get_injury_report` and sourced injury context in `get_player`, current-week lineup projections, and `check_lineups`. Optional ESPN enrichment is off by default, uses one cached read-only feed, and reports source timestamps, stale snapshots, outages, and identity/report conflicts. Questionable and uncertain starters appear in a separate `needs_check` watchlist rather than injury-driven lineup moves. Projection and odds calculations remain Sleeper-based.
- Optional Sleeper session (`SLEEPER_TOKEN`, or `SLEEPER_EMAIL` + `SLEEPER_PASSWORD`) backed by Sleeper's private GraphQL API, with 2 private reads (`get_auth_status`, `get_pending_transactions`) and 9 write tools: `set_lineup`, `update_ir`, `update_taxi`, `add_drop_player`, `submit_waiver_claim`, `cancel_waiver_claim`, `propose_trade`, `respond_to_trade`, `post_league_message`. Every write validates locally (slot eligibility, IR/taxi limits, roster ownership, FAAB budget), supports `dry_run`, and returns the refreshed roster/transaction. `--read-only` / `SLEEPER_MCP_READ_ONLY` keeps writes off; the health endpoint reports `sleeper_session` and `writes_enabled`.
- Optional default user via `--user <name>` / `SLEEPER_USERNAME`, so "my team" and "my leagues" questions work without naming yourself ([#1](https://github.com/joscaz/sleeper-mcp/pull/1)).
- Open-source project files: contributing guide, code of conduct, security policy, issue and PR templates, Dependabot, and a tag-triggered release workflow.
- Write tools (`set_lineup`, `update_ir`, `update_taxi`, `add_drop_player`, `submit_waiver_claim`, `propose_trade`) read your roster from Sleeper's live store before planning a change. The public API trails a write by a minute or two, so a player added seconds earlier was "not on this roster" to `set_lineup`.
- Team selectors accept `team`: a username, display name or (partial) team name in one field. A caller that guessed `team` used to be silently answered with the default user's roster.
- `get_pending_transactions` searches the current and previous week by default: Sleeper keeps open claims and trade offers filed under the week they were created in, so right after the weekly rollover the queued claims were invisible.
- HTTP mode refuses to start when a Sleeper session with write tools enabled would listen on a non-loopback address without `SLEEPER_MCP_AUTH_TOKEN`. `SLEEPER_MCP_INSECURE_NO_AUTH=1` overrides for deployments that authenticate in front of the server.
- `get_matchup_odds`: win probability for a week's matchups, live during games. Points so far plus league-scored projections for the share of each starter's game still to play (game status from Sleeper's NFL schedule, live progress from team offensive snaps), with a starter-by-starter view for one team.
- `get_playoff_odds`: seeded Monte Carlo simulation of the rest of the regular season over the league's real schedule, using each team's best projected lineup under league scoring, live points for the week in progress, first-round byes and median games. Returns playoff, bye and #1-seed odds, projected records and average seeds, plus, for one team, the swing from this week's result and playoff odds by final win total.
- `get_move_impact`: what a trade, waiver claim or add/drop would do to playoff odds, for your team and the trade partner. Runs the season simulation twice with the same random draws (current rosters vs rosters after the move, from the next week that has not started), so the difference reflects the move rather than chance. Returns before/after playoff, bye and #1-seed odds, projected records, average weekly projection and who enters or leaves the best lineup, and warns when a roster would be over its limit.
- `check_lineups`: one call that checks every in-season league a manager is in for this week's lineup problems: starters who will score zero (empty slot, bye, no game, Out/IR/suspended) and starters at risk (Doubtful, no projection). For each problem it suggests the highest-projected healthy bench player who can play that slot and whose game has not started, and returns the zero-point fixes as `set_lineup` arguments per league, so fixing them is one more call with a session. Read-only and needs no login. Players whose game has kicked off are skipped (Sleeper locks them), best ball leagues, leagues outside the season and empty rosters (a team chopped from a guillotine league) are skipped, and in the playoffs a team with no matchup is skipped. Uses the live roster when a session is configured.

### Changed

- Source-first distribution: documented local builds and Docker replace unavailable npm install instructions and the npm badge. `package.json` is private to prevent accidental npm publication. Version tags now validate the source and create draft GitHub releases only, without npm publication or registry credentials.
- Contributor guidance, security policy, and issue templates now describe optional session-backed account tools, read-only mode, dry runs, and safe handling of credentials and account data.
- The README and package description distinguish public read-only tools from optional account tools.

### Fixed

- Player-map freshness now exposes the original snapshot retrieval time, expiry and stale-fallback warning. Explicit refreshes bypass the underlying response cache before fetching, rather than relabeling cached data with a new fetch time.
- In-season lineup reads and writes now use weekly matchup starters rather than roster defaults. `set_lineup` uses the weekly mutation, checks current week and kickoff locks, independently verifies the saved lineup, and invalidates matchup caches even after an ambiguous write. Missing live/weekly data fails safely; verification errors never report success. IR/taxi moves that bench a starter use the same weekly write path and report partial failures.
- Live odds and lineup projections treated every game in progress as half over, because Sleeper only fills in snap counts after a game ends. Progress now comes from the plays both teams have run (rushes, pass attempts and sacks in the live box scores), so early in a game most of each projection is still to come. Without the schedule, live games are also no longer mistaken for games that haven't started.
- `get_lineup_projections` counts the points a player has already scored once his game kicks off (plus a projection for the rest of a live game) and keeps him locked in his slot, as Sleeper does. It used to score everyone with their pre-game projection all week, so after Thursday night the totals ignored what had already happened, and it could suggest benching a starter whose game was over or starting a bench player who had already played. Starters on bye now get an explicit "is on bye" warning when the schedule shows it.
- `get_free_agents` flags players who can't be picked up right now: `availability: "locked"` once their NFL game this week has kicked off, and `availability: "on_waivers"` (with `dropped_at`) for players dropped in the league within its waiver period (`waiver_clear_days`, default 2). `addable_only=true` hides both. The list used to present them as available, including a player who had already played on Thursday night or one dropped an hour earlier.

## 0.1.0 - 2026-09-11

### Added

- Initial source version: 22 read-only tools covering leagues, standings, rosters, matchups, transactions, waivers, trades, drafts, players, free agents, projections and stats, with player IDs resolved to names everywhere.
- 3 prompts (start/sit, trade review, waiver targets) and 2 resources (league summary, NFL state).
- stdio and stateless Streamable HTTP transports, optional bearer auth, health check and CORS.
- TTL response cache, 600 requests/minute limiter with retries, and a memory + disk cache for the Sleeper player database.
- League-aware scoring for projections and lineup optimisation.

[Unreleased]: https://github.com/joscaz/sleeper-mcp/commits/main
