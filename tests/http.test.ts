import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startHttpServer, type RunningHttpServer } from "../src/http.js";
import { PlayerStore } from "../src/sleeper/players.js";
import { fakeFetch, testClient } from "./helpers.js";
import { LEAGUE_ID } from "./fixtures.js";

let running: RunningHttpServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(authToken: string | null = null) {
  const sleeper = testClient(fakeFetch());
  running = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    authToken,
    client: sleeper,
    players: new PlayerStore(sleeper, { cacheDir: null }),
    log: () => {},
    preloadPlayers: false,
  });
  return running;
}

describe("Streamable HTTP transport", () => {
  it("answers health and root endpoints", async () => {
    const { url } = await start();
    const base = url.replace(/\/mcp$/, "");
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, name: "sleeper-mcp" });
    const root = await fetch(base + "/");
    expect(await root.json()).toMatchObject({ endpoint: "/mcp", transport: "streamable-http" });
    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);
    const options = await fetch(url, { method: "OPTIONS" });
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("serves a full MCP session statelessly", async () => {
    const { url } = await start();
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(20);
      const result = (await client.callTool({ name: "get_league_standings", arguments: { league_id: LEAGUE_ID } })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      const text = result.content.find((c) => c.type === "text")?.text as string;
      expect(JSON.parse(text)).toMatchObject({ league: "Test Dynasty" });
      expect(result.structuredContent).toMatchObject({ league: "Test Dynasty" });
    } finally {
      await client.close();
    }
  });

  it("enforces bearer auth when configured", async () => {
    const { url } = await start("s3cret");
    const unauthorized = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("Bearer");

    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: "Bearer s3cret" } } }));
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it("rejects GET on the MCP endpoint in stateless mode", async () => {
    const { url } = await start();
    const res = await fetch(url);
    expect(res.status).toBe(405);
  });
});
