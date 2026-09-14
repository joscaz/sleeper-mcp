import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isLoopback, startHttpServer, type RunningHttpServer } from "../src/http.js";
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

describe("Sleeper session vs HTTP bearer auth", () => {
  it("does not turn the Sleeper session token into the /mcp bearer token", async () => {
    const sleeper = testClient(fakeFetch());
    const running = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      client: sleeper,
      players: new PlayerStore(sleeper, { cacheDir: null }),
      log: () => {},
      preloadPlayers: false,
      sleeperToken: "eyJ.fake.jwt",
    });
    try {
      const health = await (await fetch(`${running.url.replace(/\/mcp$/, "")}/health`)).json();
      expect(health).toMatchObject({ sleeper_session: true, writes_enabled: true });
      const res = await fetch(running.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: { tools: { name: string }[] } };
      expect(body.result.tools.map((x) => x.name)).toContain("set_lineup");
    } finally {
      await running.close();
    }
  });
});

describe("unauthenticated account write tools", () => {
  const sessionOptions = (host: string, extra: Record<string, unknown> = {}) => {
    const sleeper = testClient(fakeFetch());
    return {
      host,
      port: 0,
      client: sleeper,
      players: new PlayerStore(sleeper, { cacheDir: null }),
      log: () => {},
      preloadPlayers: false,
      sleeperToken: "eyJ.fake.jwt",
      authToken: null,
      ...extra,
    };
  };

  it("refuses to listen on a non-loopback address without a bearer token", async () => {
    await expect(startHttpServer(sessionOptions("0.0.0.0"))).rejects.toThrow(/SLEEPER_MCP_AUTH_TOKEN/);
  });

  it("starts on a non-loopback address when a bearer token is set", async () => {
    const running = await startHttpServer(sessionOptions("0.0.0.0", { authToken: "s3cret" }));
    try {
      const res = await fetch(running.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
      expect(res.status).toBe(401);
    } finally {
      await running.close();
    }
  });

  it("starts on a non-loopback address when the session is read-only", async () => {
    const running = await startHttpServer(sessionOptions("0.0.0.0", { allowWrites: false }));
    try {
      const health = await (await fetch(`${running.url.replace(/\/mcp$/, "")}/health`)).json();
      expect(health).toMatchObject({ sleeper_session: true, writes_enabled: false });
    } finally {
      await running.close();
    }
  });

  it("starts without a token on loopback, or anywhere with the explicit override", async () => {
    const local = await startHttpServer(sessionOptions("127.0.0.1"));
    await local.close();
    const overridden = await startHttpServer(sessionOptions("0.0.0.0", { insecureNoAuth: true }));
    await overridden.close();
  });

  it("classifies loopback addresses", () => {
    for (const h of ["127.0.0.1", "127.0.0.53", "localhost", "LOCALHOST", "::1", "[::1]", "::ffff:127.0.0.1"]) expect(isLoopback(h), h).toBe(true);
    for (const h of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.1", "example.com", ""]) expect(isLoopback(h), h).toBe(false);
  });
});
