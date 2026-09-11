import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SleeperClient, SLEEPER_API_BASE } from "../src/sleeper/client.js";
import { PlayerStore } from "../src/sleeper/players.js";
import { createServer } from "../src/server.js";
import { routes } from "./fixtures.js";

export interface FakeFetch {
  fetch: typeof fetch;
  calls: string[];
  /** Override a route (path relative to the API base, including query string if any). */
  set: (path: string, body: unknown | ((n: number) => { status: number; body?: unknown })) => void;
}

/** A fetch stand-in that serves fixture routes. Unknown paths return 404 like Sleeper does. */
export function fakeFetch(overrides: Record<string, unknown> = {}): FakeFetch {
  const table: Record<string, unknown> = { ...routes(), ...overrides };
  const calls: string[] = [];
  const hits = new Map<string, number>();
  const impl = (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(SLEEPER_API_BASE, "");
    calls.push(path);
    const n = (hits.get(path) ?? 0) + 1;
    hits.set(path, n);
    if (!(path in table)) return new Response("null", { status: 404 });
    const entry = table[path];
    if (typeof entry === "function") {
      const { status, body } = (entry as (n: number) => { status: number; body?: unknown })(n);
      return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(entry), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return {
    fetch: impl,
    calls,
    set: (path, body) => {
      table[path] = body;
    },
  };
}

export function testClient(ff: FakeFetch = fakeFetch()): SleeperClient {
  return new SleeperClient({ fetch: ff.fetch, sleep: async () => {}, maxRetries: 2 });
}

/** Full server + MCP client wired over an in-memory transport. */
export async function connectedClient(overrides: Record<string, unknown> = {}) {
  const ff = fakeFetch(overrides);
  const sleeper = testClient(ff);
  const players = new PlayerStore(sleeper, { cacheDir: null });
  const { server, ctx } = createServer({ client: sleeper, players, log: () => {}, preloadPlayers: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    return { result, text, data: result.isError ? undefined : (JSON.parse(text) as Record<string, unknown>) };
  };

  return {
    client,
    server,
    ctx,
    ff,
    call,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
