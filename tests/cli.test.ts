import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/index.js";

describe("CLI argument parsing", () => {
  it("defaults to stdio", () => {
    expect(parseArgs([])).toEqual({ http: false, readOnly: false, preload: true, help: false, version: false });
  });

  it("parses http options in both forms", () => {
    expect(parseArgs(["--http", "--port", "8080", "--host", "127.0.0.1"])).toMatchObject({ http: true, port: 8080, host: "127.0.0.1" });
    expect(parseArgs(["--port=9000"])).toMatchObject({ http: true, port: 9000 });
    expect(parseArgs(["--host=::"])).toMatchObject({ http: true, host: "::" });
  });

  it("handles flags", () => {
    expect(parseArgs(["--no-preload"]).preload).toBe(false);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--version"]).version).toBe(true);
  });

  it("accepts a default user in both forms without implying http", () => {
    expect(parseArgs(["--user", "joscaz"])).toMatchObject({ user: "joscaz", http: false });
    expect(parseArgs(["--user=joscaz"]).user).toBe("joscaz");
  });

  it("rejects bad input", () => {
    expect(() => parseArgs(["--port", "abc"])).toThrow(/Invalid --port/);
    expect(() => parseArgs(["--user"])).toThrow(/Missing value for --user/);
    expect(() => parseArgs(["--wat"])).toThrow(/Unknown option/);
  });
});

describe("CLI --read-only", () => {
  it("parses the flag", () => {
    expect(parseArgs(["--read-only"]).readOnly).toBe(true);
    expect(parseArgs(["--http", "--read-only", "--user", "alice"])).toMatchObject({ http: true, readOnly: true, user: "alice" });
  });
});
