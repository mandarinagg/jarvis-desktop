import path from "node:path";
import { describe, expect, it } from "vitest";
import { voiceLaunch } from "./spawn.js";

describe("voiceLaunch", () => {
  it("runs the service module through uv, never a generated launcher", () => {
    const l = voiceLaunch({ JARVIS_VOICE_DIR: "C:/x/voice" });
    expect(l.command).toBe("uv");
    expect(l.args).toEqual(["run", "--project", path.resolve("C:/x/voice"), "--locked", "python", "-m", "jarvis_voice.service"]);
    expect(l.cwd).toBe(path.resolve("C:/x/voice"));
  });

  it("does not leak secrets or Electron flags to the child", () => {
    const l = voiceLaunch({
      JARVIS_VOICE_DIR: "C:/x",
      ANTHROPIC_API_KEY: "sk-ant-x",
      JARVIS_GOOGLE_TTS_API_KEY: "AIza-x",
      ELECTRON_RUN_AS_NODE: "1",
      PATH: "p",
    });
    expect(l.env).toMatchObject({ PATH: "p", PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" });
    expect(l.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(l.env).not.toHaveProperty("JARVIS_GOOGLE_TTS_API_KEY");
    expect(l.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
  });

  it("defaults to services/voice in the repo", () => {
    expect(voiceLaunch({}).cwd.replaceAll("\\", "/")).toMatch(/\/services\/voice$/);
  });
});
