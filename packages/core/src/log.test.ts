import { describe, expect, it } from "vitest";
import { createLogger, redact } from "./log.js";
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
