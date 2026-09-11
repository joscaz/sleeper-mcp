# Security policy

## What this server does and does not touch

- It makes outbound HTTPS requests only to Sleeper's public, read-only API (`api.sleeper.app`) and CDN (`sleepercdn.com`). It never authenticates to Sleeper and never handles Sleeper credentials.
- In HTTP mode it can require a bearer token (`SLEEPER_MCP_AUTH_TOKEN`). That token is compared in constant time and never logged.
- The only thing written to disk is the cached Sleeper player database (public data) under the cache directory.

## Supported versions

Only the latest published minor version receives fixes.

## Reporting a vulnerability

Please do not open a public issue for security problems.

Use GitHub's private vulnerability reporting: <https://github.com/joscaz/sleeper-mcp/security/advisories/new>. Include the version (`sleeper-mcp --version`), the transport (stdio or HTTP) and steps to reproduce.

You should hear back within a week. Once a fix is released the advisory is published with credit to the reporter, unless you prefer to stay anonymous.
