import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger, redact, rotatingFile, tee } from "./log.js";
import { defaultPipeName, jarvisHome, tokenPath } from "./paths.js";
import { newSessionToken, tokensMatch } from "./token.js";

describe("redact", () => {
  it("removes API keys, bearer tokens and session tokens", () => {
    const token = newSessionToken();
    const text = `key sk-ant-api03-abcdefghijkl google AIzaSyA1234567890abcdefghijk auth Bearer abc.def.ghi1234 t=${token}`;
    const out = redact(text);
    expect(out).not.toContain("sk-ant-api03-abcdefghijkl");
    expect(out).not.toContain("AIzaSyA1234567890abcdefghijk");
    expect(out).not.toContain("abc.def.ghi1234");
    expect(out).not.toContain(token);
  });

  it("leaves ordinary text alone", () => {
    expect(redact("hola Jarvis, 3 proyectos")).toBe("hola Jarvis, 3 proyectos");
  });

  it("the logger redacts fields too", () => {
    const lines: string[] = [];
    createLogger((l) => lines.push(l)).log("info", "x", { apiKey: "sk-ant-api03-secretsecret" });
    expect(lines[0]).not.toContain("secretsecret");
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ level: "info", msg: "x" });
  });
});

describe("tokens", () => {
  it("are 256-bit hex and compared in constant time", () => {
    const t = newSessionToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(tokensMatch(t, t)).toBe(true);
    expect(tokensMatch(t, newSessionToken())).toBe(false);
    expect(tokensMatch(t, "short")).toBe(false);
  });
});

describe("paths", () => {
  it("honours JARVIS_DATA_DIR and falls back to APPDATA", () => {
    expect(jarvisHome({ JARVIS_DATA_DIR: "C:\\tmp\\j" })).toBe("C:\\tmp\\j");
    expect(jarvisHome({ APPDATA: "C:\\Users\\x\\AppData\\Roaming" })).toBe("C:\\Users\\x\\AppData\\Roaming\\Jarvis");
    expect(tokenPath("C:\\J")).toBe("C:\\J\\run\\session.token");
  });

  it("builds a per-user pipe name without unsafe characters", () => {
    expect(defaultPipeName("Ana María")).toBe("\\\\.\\pipe\\jarvis-core-ana_mar_a");
  });
});

describe("log file", () => {
  it("rotates by size, keeps N generations, and stays redacted", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jarvis-log-"));
    const file = path.join(dir, "logs", "core.log");
    const logger = createLogger(rotatingFile(file, { maxBytes: 200, keep: 2 }));
    for (let i = 0; i < 20; i++) logger.log("info", "linea", { i, key: "sk-ant-api03-secretsecret" });
    const files = readdirSync(path.dirname(file)).sort();
    expect(files).toEqual(["core.log", "core.log.1", "core.log.2"]);
    for (const f of files) {
      const text = readFileSync(path.join(path.dirname(file), f), "utf8");
      expect(text).not.toContain("secretsecret");
      expect(text.length).toBeLessThanOrEqual(400);
    }
  });

  it("never throws when the file can't be written", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jarvis-log-"));
    const blocker = path.join(dir, "logs");
    writeFileSync(blocker, "not a folder");
    const write = rotatingFile(path.join(blocker, "core.log"));
    expect(() => write("x")).not.toThrow();
  });

  it("tee writes to every sink", () => {
    const a: string[] = [];
    const b: string[] = [];
    tee((l) => a.push(l), (l) => b.push(l))("hola");
    expect([a, b]).toEqual([["hola"], ["hola"]]);
  });
});
