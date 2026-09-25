# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Optional Sleeper session (`SLEEPER_TOKEN`, or `SLEEPER_EMAIL` + `SLEEPER_PASSWORD`) backed by Sleeper's private GraphQL API, with 2 private reads (`get_auth_status`, `get_pending_transactions`) and 9 write tools: `set_lineup`, `update_ir`, `update_taxi`, `add_drop_player`, `submit_waiver_claim`, `cancel_waiver_claim`, `propose_trade`, `respond_to_trade`, `post_league_message`. Every write validates locally (slot eligibility, IR/taxi limits, roster ownership, FAAB budget), supports `dry_run`, and returns the refreshed roster/transaction. `--read-only` / `SLEEPER_MCP_READ_ONLY` keeps writes off; the health endpoint reports `sleeper_session` and `writes_enabled`.
- Optional default user via `--user <name>` / `SLEEPER_USERNAME`, so "my team" and "my leagues" questions work without naming yourself ([#1](https://github.com/joscaz/sleeper-mcp/pull/1)).
- Open-source project files: contributing guide, code of conduct, security policy, issue and PR templates, Dependabot, and a tag-triggered release workflow.
- Write tools (`set_lineup`, `update_ir`, `update_taxi`, `add_drop_player`, `submit_waiver_claim`, `propose_trade`) read your roster from Sleeper's live store before planning a change. The public API trails a write by a minute or two, so a player added seconds earlier was "not on this roster" to `set_lineup`.
- Team selectors accept `team`: a username, display name or (partial) team name in one field. A caller that guessed `team` used to be silently answered with the default user's roster.
- `get_pending_transactions` searches the current and previous week by default: Sleeper keeps open claims and trade offers filed under the week they were created in, so right after the weekly rollover the queued claims were invisible.
- HTTP mode refuses to start when a Sleeper session with write tools enabled would listen on a non-loopback address without `SLEEPER_MCP_AUTH_TOKEN`. `SLEEPER_MCP_INSECURE_NO_AUTH=1` overrides for deployments that authenticate in front of the server.

### Changed

- The README leads with `npx -y @joscaz/sleeper-mcp` for every client, keeps a source checkout as the alternative, and no longer says every tool is read-only now that the optional account tools exist. The npm package description mentions the account tools too.

## [0.1.0] - 2026-09-11

### Added

- Initial release: 22 read-only tools covering leagues, standings, rosters, matchups, transactions, waivers, trades, drafts, players, free agents, projections and stats, with player IDs resolved to names everywhere.
- 3 prompts (start/sit, trade review, waiver targets) and 2 resources (league summary, NFL state).
- stdio and stateless Streamable HTTP transports, optional bearer auth, health check and CORS.
- TTL response cache, 600 requests/minute limiter with retries, and a memory + disk cache for the Sleeper player database.
- League-aware scoring for projections and lineup optimisation.

[Unreleased]: https://github.com/joscaz/sleeper-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/joscaz/sleeper-mcp/releases/tag/v0.1.0
