import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { coreBuildStampPath, isCoreStale, writeCoreBuildStamp } from "./paths.js";

describe("Core build stamp: a stale daemon is detected after a rebuild", () => {
  it("same build is fresh; a rebuilt main.js makes the running Core stale; no stamp is not stale", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "jarvis-stamp-"));
    mkdirSync(path.join(home, "run"));
    const main = path.join(home, "main.js");
    writeFileSync(main, "v1");
    expect(isCoreStale(home, main)).toBe(false); // no stamp yet
    writeCoreBuildStamp(home, main);
    expect(isCoreStale(home, main)).toBe(false);
    const later = new Date(Date.now() + 60_000);
    utimesSync(main, later, later); // pnpm build rewrote it
    expect(isCoreStale(home, main)).toBe(true);
    writeFileSync(coreBuildStampPath(home), "garbage");
    expect(isCoreStale(home, main)).toBe(true);
    expect(isCoreStale(home, path.join(home, "missing.js"))).toBe(false);
  });
});
