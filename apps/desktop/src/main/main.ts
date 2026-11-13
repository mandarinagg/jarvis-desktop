/**
 * Electron main process: a thin client of Jarvis Core (ADR-001/002).
 * Security: contextIsolation, sandbox, no nodeIntegration, strict CSP, allowlisted + validated IPC,
 * no navigation or new windows.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreClient } from "@jarvis/core/client";
import { BrowserWindow, app, ipcMain, shell } from "electron";
import { parseRendererMessage } from "./bridge.js";
import { ensureCore } from "./core-connection.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const smokeShot = process.argv.find((a) => a.startsWith("--smoke-screenshot="))?.split("=")[1];

let core: CoreClient | undefined;
let win: BrowserWindow | undefined;

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: "#1a2230",
    title: "Jarvis",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, "../preload/preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
    },
  });
  // Model output is rendered here: never let it navigate the app or open windows.
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  // Hidden windows are not repainted, so smoke runs show the window without stealing focus.
  w.once("ready-to-show", () => (smokeShot ? w.showInactive() : w.show()));
  void w.loadFile(path.join(here, "../renderer/index.html"));
  return w;
}

async function connectCore(): Promise<void> {
  core = await ensureCore();
  core.on("message", (m) => win?.webContents.send("jarvis:message", m));
  core.on("close", () => {
    core = undefined;
    win?.webContents.send("jarvis:status", { connected: false });
  });
  win?.webContents.send("jarvis:status", { connected: true });
}

ipcMain.on("jarvis:send", (event, raw: unknown) => {
  if (event.senderFrame?.url && !event.senderFrame.url.startsWith("file://")) return;
  const msg = parseRendererMessage(raw);
  if (!msg) return; // dropped: the renderer only ever sends well-formed allowlisted messages
  core?.send(msg);
});

ipcMain.handle("jarvis:status", () => ({ connected: core !== undefined }));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app.whenReady().then(async () => {
    win = createWindow();
    try {
      await connectCore();
    } catch (err) {
      win.webContents.send("jarvis:status", { connected: false, error: err instanceof Error ? err.message : String(err) });
    }
    if (smokeShot) {
      // Headless check used in development: render, give the UI time to load data, screenshot, quit.
      win.webContents.on("console-message", (e) => process.stdout.write(`[renderer] ${e.message}\n`));
      await new Promise((r) => setTimeout(r, 1_500));
      if (process.argv.includes("--smoke-open-first")) {
        await win.webContents.executeJavaScript("document.querySelector('.thread')?.click()");
        await new Promise((r) => setTimeout(r, 800));
        const shown = (await win.webContents.executeJavaScript("document.querySelector('.transcript')?.innerText ?? ''")) as string;
        process.stdout.write(`[smoke] transcript: ${shown.slice(0, 200).replace(/\n/g, " | ")}\n`);
      }
      const image = await win.webContents.capturePage();
      await writeFile(smokeShot, image.toPNG());
      app.quit();
    }
  });
  // Closing the window does not stop the Core (ADR-001); the app itself exits.
  app.on("window-all-closed", () => app.quit());
}
