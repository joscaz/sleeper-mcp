# Security policy

## What this server does and does not touch

- Without a configured Sleeper session, tools use Sleeper's public read endpoints (`api.sleeper.app`) and CDN (`sleepercdn.com`). Some stats/projection endpoints are undocumented.
- When `SLEEPER_TOKEN` or `SLEEPER_EMAIL` plus `SLEEPER_PASSWORD` is configured, the server authenticates to Sleeper's unofficial private GraphQL API (`sleeper.com/graphql`). It handles those credentials and the resulting session in memory. Optional tools can read private pending transactions and change lineups, IR/taxi slots, players, waivers, trades, and league chat.
- `--read-only` (or `SLEEPER_MCP_READ_ONLY=1`) disables account write tools, including when a session is configured. The two private read tools remain available. A dry run previews a proposed write; it is not a substitute for an approval policy in your MCP client.
- In HTTP mode, `SLEEPER_MCP_AUTH_TOKEN` controls access to the MCP endpoint. It is separate from the Sleeper session credential and is compared in constant time. Non-loopback HTTP with account writes requires it unless `SLEEPER_MCP_INSECURE_NO_AUTH` explicitly bypasses that check. Only use that override behind independently enforced authentication. Protect remote private reads too, and terminate HTTPS before exposing the service.
- The runtime's disk cache contains the public Sleeper player database, not account sessions. Credentials supplied in environment variables or client configuration are still accessible to the processes and people with access to that host/configuration. Tool responses and logs may contain account or league data; review and redact them before sharing.

## Safe operation

- Start with the read-only examples in the README. Enable account writes only when you intend to use them, preview changes, and verify them in Sleeper.
- Use your host or client's secret storage. Never commit credentials, paste them into issues, or include them in screenshots.
- Treat access to a session-enabled MCP server as access to the configured Sleeper account. Static bearer authentication is not multi-user account isolation.
- The private API is unsupported and can change without notice. If credentials are exposed, revoke or replace them through the relevant provider and remove them from shared locations.

## Supported versions

During source-first development, fixes target the latest `main` branch. Older checkout commits are not maintained release branches; update and rebuild when a fix lands. npm publication is currently disabled.

## Reporting a vulnerability

Please do not open a public issue for security problems.

Use GitHub's private vulnerability reporting: <https://github.com/joscaz/sleeper-mcp/security/advisories/new>. Include the version (`node dist/index.js --version`), checkout commit (`git rev-parse HEAD`), transport (stdio or HTTP), whether account tools were enabled, and redacted steps to reproduce. Do not send active credentials.

You should hear back within a week. Once a fix is released the advisory is published with credit to the reporter, unless you prefer to stay anonymous.
