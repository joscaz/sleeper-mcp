import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/index.js";

describe("CLI argument parsing", () => {
  it("defaults to stdio", () => {
    expect(parseArgs([])).toEqual({ http: false, preload: true, help: false, version: false });
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

  it("rejects bad input", () => {
    expect(() => parseArgs(["--port", "abc"])).toThrow(/Invalid --port/);
    expect(() => parseArgs(["--wat"])).toThrow(/Unknown option/);
  });
});
