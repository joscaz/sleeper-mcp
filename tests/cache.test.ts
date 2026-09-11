import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/sleeper/cache.js";

describe("TtlCache", () => {
  it("stores values until they expire", () => {
    let now = 1000;
    const cache = new TtlCache(() => now);
    cache.set("a", 1, 500);
    expect(cache.get("a")).toBe(1);
    now = 1499;
    expect(cache.get("a")).toBe(1);
    now = 1500;
    expect(cache.get("a")).toBeUndefined();
  });

  it("de-duplicates concurrent loads", async () => {
    const cache = new TtlCache();
    let loads = 0;
    const loader = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 5));
      return "v";
    };
    const results = await Promise.all([cache.getOrLoad("k", 1000, loader), cache.getOrLoad("k", 1000, loader), cache.getOrLoad("k", 1000, loader)]);
    expect(results).toEqual(["v", "v", "v"]);
    expect(loads).toBe(1);
    expect(await cache.getOrLoad("k", 1000, loader)).toBe("v");
    expect(loads).toBe(1);
  });

  it("does not cache failures", async () => {
    const cache = new TtlCache();
    let attempts = 0;
    const loader = async () => {
      attempts++;
      if (attempts === 1) throw new Error("boom");
      return 42;
    };
    await expect(cache.getOrLoad("k", 1000, loader)).rejects.toThrow("boom");
    expect(await cache.getOrLoad("k", 1000, loader)).toBe(42);
    expect(attempts).toBe(2);
  });

  it("evicts the oldest entry when full", () => {
    const cache = new TtlCache(() => 0, 2);
    cache.set("a", 1, 1000);
    cache.set("b", 2, 1000);
    cache.set("c", 3, 1000);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });
});
