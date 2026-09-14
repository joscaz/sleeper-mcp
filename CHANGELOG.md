# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Optional Sleeper session (`SLEEPER_TOKEN`, or `SLEEPER_EMAIL` + `SLEEPER_PASSWORD`) backed by Sleeper's private GraphQL API, with 2 private reads (`get_auth_status`, `get_pending_transactions`) and 9 write tools: `set_lineup`, `update_ir`, `update_taxi`, `add_drop_player`, `submit_waiver_claim`, `cancel_waiver_claim`, `propose_trade`, `respond_to_trade`, `post_league_message`. Every write validates locally (slot eligibility, IR/taxi limits, roster ownership, FAAB budget), supports `dry_run`, and returns the refreshed roster/transaction. `--read-only` / `SLEEPER_MCP_READ_ONLY` keeps writes off; the health endpoint reports `sleeper_session` and `writes_enabled`.
- Optional default user via `--user <name>` / `SLEEPER_USERNAME`, so "my team" and "my leagues" questions work without naming yourself ([#1](https://github.com/joscaz/sleeper-mcp/pull/1)).
- Open-source project files: contributing guide, code of conduct, security policy, issue and PR templates, Dependabot, and a tag-triggered release workflow.

## [0.1.0] - 2026-09-11

### Added

- Initial release: 22 read-only tools covering leagues, standings, rosters, matchups, transactions, waivers, trades, drafts, players, free agents, projections and stats, with player IDs resolved to names everywhere.
- 3 prompts (start/sit, trade review, waiver targets) and 2 resources (league summary, NFL state).
- stdio and stateless Streamable HTTP transports, optional bearer auth, health check and CORS.
- TTL response cache, 600 requests/minute limiter with retries, and a memory + disk cache for the Sleeper player database.
- League-aware scoring for projections and lineup optimisation.

[Unreleased]: https://github.com/joscaz/sleeper-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/joscaz/sleeper-mcp/releases/tag/v0.1.0
