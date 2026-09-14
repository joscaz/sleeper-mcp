#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_VERSION } from "./server.js";
import { startHttpServer } from "./http.js";

const HELP = `sleeper-mcp ${SERVER_VERSION} — MCP server for Sleeper fantasy football

Usage:
  sleeper-mcp                 Run over stdio (for Claude Desktop, Cursor, Claude Code, ...)
  sleeper-mcp --http          Run as a Streamable HTTP server (remote / hosted use)

Options:
  --http                      Use Streamable HTTP transport instead of stdio
  --port <n>                  HTTP port (default: $PORT or 3000)
  --host <addr>               HTTP bind address (default: $HOST or 0.0.0.0)
  --user <name>               Your Sleeper username: "my team" / "my leagues" resolve to it
  --read-only                 Keep account write tools off even when a Sleeper session is configured
  --no-preload                Do not download the player database at startup
  -h, --help                  Show this help
  -v, --version               Print version

Environment:
  SLEEPER_USERNAME            Same as --user
  SLEEPER_TOKEN               Sleeper session token (web app: DevTools → Network → graphql → request
                              header "authorization"). Enables lineup/IR/taxi/waiver/trade/chat tools.
  SLEEPER_EMAIL,
  SLEEPER_PASSWORD            Alternative to SLEEPER_TOKEN: log in with your Sleeper credentials
  SLEEPER_MCP_READ_ONLY       Same as --read-only when set to 1/true
  SLEEPER_MCP_AUTH_TOKEN      If set, HTTP clients must send "Authorization: Bearer <token>"
  SLEEPER_MCP_CACHE_DIR       Where to cache the player database (default: ~/.cache/sleeper-mcp)
  PORT, HOST                  HTTP defaults
`;

interface CliArgs {
  http: boolean;
  port?: number;
  host?: string;
  user?: string;
  readOnly: boolean;
  preload: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { http: false, readOnly: false, preload: true, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--http":
        args.http = true;
        break;
      case "--stdio":
        args.http = false;
        break;
      case "--port": {
        const value = Number(argv[++i]);
        if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`Invalid --port value: ${argv[i]}`);
        args.port = value;
        args.http = true;
        break;
      }
      case "--host":
        args.host = argv[++i];
        args.http = true;
        break;
      case "--user": {
        const value = argv[++i]?.trim();
        if (!value) throw new Error("Missing value for --user");
        args.user = value;
        break;
      }
      case "--read-only":
        args.readOnly = true;
        break;
      case "--no-preload":
        args.preload = false;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-v":
      case "--version":
        args.version = true;
        break;
      default:
        if (arg.startsWith("--port=")) {
          args.port = Number(arg.slice("--port=".length));
          args.http = true;
        } else if (arg.startsWith("--host=")) {
          args.host = arg.slice("--host=".length);
          args.http = true;
        } else if (arg.startsWith("--user=")) {
          args.user = arg.slice("--user=".length).trim() || undefined;
        } else {
          throw new Error(`Unknown option: ${arg}\n\n${HELP}`);
        }
    }
  }
  return args;
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  const cacheDir = process.env.SLEEPER_MCP_CACHE_DIR === "" ? null : process.env.SLEEPER_MCP_CACHE_DIR;
  const defaultUser = args.user ?? process.env.SLEEPER_USERNAME?.trim() ?? null;
  const sleeperToken = process.env.SLEEPER_TOKEN?.trim() || null;
  const sleeperEmail = process.env.SLEEPER_EMAIL?.trim() || null;
  const sleeperPassword = process.env.SLEEPER_PASSWORD || null;
  const allowWrites = !(args.readOnly || /^(1|true|yes)$/i.test(process.env.SLEEPER_MCP_READ_ONLY ?? ""));
  const session = { sleeperToken, sleeperEmail, sleeperPassword, allowWrites };

  if (args.http) {
    const running = await startHttpServer({ host: args.host, port: args.port, preloadPlayers: args.preload, cacheDir, defaultUser, ...session });
    const shutdown = () => {
      running.close().finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  // stdio: never write anything but JSON-RPC to stdout.
  const { server, ctx } = createServer({ preloadPlayers: args.preload, cacheDir, defaultUser, ...session });
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    // The client went away mid-write; exit quietly instead of dumping a stack trace.
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
  const transport = new StdioServerTransport();
  transport.onclose = () => process.exit(0);
  await server.connect(transport);
  ctx.log(`sleeper-mcp ${SERVER_VERSION} ready on stdio${ctx.defaultUser ? ` (default user: ${ctx.defaultUser})` : ""}${describeAuth(ctx)}`);
}

function describeAuth(ctx: { auth: unknown; allowWrites: boolean }): string {
  if (!ctx.auth) return "";
  return ctx.allowWrites ? " (Sleeper session: account write tools enabled)" : " (Sleeper session: read-only)";
}

main().catch((err) => {
  console.error(`[sleeper-mcp] fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
