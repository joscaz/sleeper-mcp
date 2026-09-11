import { describe, expect, it } from "vitest";
import { SleeperApiError, SleeperClient, SleeperNotFoundError, avatarUrl, playerHeadshotUrl } from "../src/sleeper/client.js";
import { fakeFetch, testClient } from "./helpers.js";
import { LEAGUE_ID } from "./fixtures.js";

describe("SleeperClient", () => {
  it("fetches and caches GET responses", async () => {
    const ff = fakeFetch();
    const client = testClient(ff);
    const a = await client.getLeague(LEAGUE_ID);
    const b = await client.getLeague(LEAGUE_ID);
    expect(a.name).toBe("Test Dynasty");
    expect(b).toBe(a);
    expect(ff.calls.filter((c) => c === `/league/${LEAGUE_ID}`)).toHaveLength(1);
    expect(client.requestsSent).toBe(1);
  });

  it("treats 404 and literal null bodies as not found", async () => {
    const client = testClient();
    await expect(client.getLeague("404404404")).rejects.toBeInstanceOf(SleeperNotFoundError);
    await expect(client.getLeague("does-not-exist")).rejects.toBeInstanceOf(SleeperNotFoundError);
    await expect(client.getUser("nobody")).rejects.toThrow(/user not found/);
    // List endpoints degrade to an empty array.
    expect(await client.getMatchups(LEAGUE_ID, 99)).toEqual([]);
  });

  it("retries 429 and 5xx before giving up", async () => {
    const ff = fakeFetch({
      "/state/nfl": (n: number) => (n < 3 ? { status: 503 } : { status: 200, body: { week: 1, season: "2026" } }),
    });
    const client = testClient(ff);
    const state = await client.getNflState();
    expect(state.week).toBe(1);
    expect(ff.calls.filter((c) => c === "/state/nfl")).toHaveLength(3);

    const ff2 = fakeFetch({ "/state/nfl": () => ({ status: 429 }) });
    const client2 = new SleeperClient({ fetch: ff2.fetch, sleep: async () => {}, maxRetries: 1 });
    await expect(client2.getNflState()).rejects.toMatchObject({ status: 429 } satisfies Partial<SleeperApiError>);
    expect(ff2.calls).toHaveLength(2);
  });

  it("encodes path segments", async () => {
    const ff = fakeFetch({ "/user/some%20one": { user_id: "9", username: "some one", display_name: null, avatar: null } });
    const client = testClient(ff);
    const user = await client.getUser("some one");
    expect(user.user_id).toBe("9");
  });

  it("enforces the per-minute request budget", async () => {
    let now = 0;
    const slept: number[] = [];
    const ff = fakeFetch();
    const client = new SleeperClient({
      fetch: ff.fetch,
      maxRequestsPerMinute: 2,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });
    await client.getMatchups(LEAGUE_ID, 1);
    await client.getMatchups(LEAGUE_ID, 2);
    await client.getMatchups(LEAGUE_ID, 3);
    expect(slept.length).toBeGreaterThan(0);
    expect(client.requestsSent).toBe(3);
  });

  it("builds CDN urls", () => {
    expect(avatarUrl("abc")).toBe("https://sleepercdn.com/avatars/abc");
    expect(avatarUrl("abc", true)).toBe("https://sleepercdn.com/avatars/thumbs/abc");
    expect(avatarUrl(null)).toBeNull();
    expect(playerHeadshotUrl("4046")).toBe("https://sleepercdn.com/content/nfl/players/thumb/4046.jpg");
    expect(playerHeadshotUrl("DET")).toBe("https://sleepercdn.com/images/team_logos/nfl/det.png");
  });
});
