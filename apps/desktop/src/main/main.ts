/**
 * Electron main process: a thin client of Jarvis Core (ADR-001/002).
 * Security: contextIsolation, sandbox, no nodeIntegration, strict CSP, allowlisted + validated IPC,
 * no navigation or new windows.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreClient } from "@jarvis/core/client";
import type { CoreMessage } from "@jarvis/shared";
import { randomUUID } from "node:crypto";
import { BrowserWindow, app, dialog, globalShortcut, ipcMain, screen, shell } from "electron";
import { CreateProjectRequest, parseRendererMessage } from "./bridge.js";
import { ensureCore } from "./core-connection.js";
import { overlayVisible } from "./overlay.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const smokeShot = process.argv.find((a) => a.startsWith("--smoke-screenshot="))?.split("=")[1];
const smokeOverlay = process.argv.find((a) => a.startsWith("--smoke-overlay="))?.split("=")[1];

let core: CoreClient | undefined;
let win: BrowserWindow | undefined;
let overlay: BrowserWindow | undefined;
let hotkey: string | null = null;

// First free one wins: another app may already own a shortcut (Ctrl+Alt+Space was taken on the owner's PC).
const PTT_SHORTCUTS = process.env.JARVIS_PTT_SHORTCUT ? [process.env.JARVIS_PTT_SHORTCUT] : ["Control+Shift+Space", "Control+Alt+J"];

const webPreferences = () => ({
  preload: path.join(here, "../preload/preload.cjs"),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
});

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
    webPreferences: { ...webPreferences(), spellcheck: true },
  });
  // Model output is rendered here: never let it navigate the app or open windows.
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  // Hidden windows are not repainted, so smoke runs show the window without stealing focus.
  w.once("ready-to-show", () => (smokeShot ? w.showInactive() : w.show()));
  w.on("closed", () => app.quit()); // the overlay alone must not keep the app alive
  void w.loadFile(path.join(here, "../renderer/index.html"));
  return w;
}

/**
 * Voice overlay (VOICE_PIPELINE §3): small, always on top, never focused, click-through.
 * Its visibility is decided here, not in a renderer: while the microphone is open it is always
 * shown, and model output can never hide it.
 */
function createOverlay(): BrowserWindow {
  const area = screen.getPrimaryDisplay().workArea;
  const width = 280;
  const height = 64;
  const o = new BrowserWindow({
    width,
    height,
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + area.height - height - 24,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    title: "Jarvis: voz",
    webPreferences: webPreferences(),
  });
  o.setAlwaysOnTop(true, "screen-saver");
  o.setIgnoreMouseEvents(true);
  o.webContents.on("will-navigate", (e) => e.preventDefault());
  o.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  void o.loadFile(path.join(here, "../renderer/index.html"), { hash: "overlay" });
  return o;
}

function forward(m: CoreMessage): void {
  win?.webContents.send("jarvis:message", m);
  if (m.type !== "voice.state" || !overlay) return;
  overlay.webContents.send("jarvis:message", m);
  if (overlayVisible(m)) {
    if (!overlay.isVisible()) overlay.showInactive();
  } else if (overlay.isVisible()) {
    overlay.hide();
  }
}

/** Electron reports presses only, so the shortcut toggles; the renderer knows the voice state. */
function registerHotkey(): void {
  hotkey = null;
  for (const accelerator of PTT_SHORTCUTS) {
    try {
      if (globalShortcut.register(accelerator, () => win?.webContents.send("jarvis:hotkey"))) {
        hotkey = accelerator;
        return;
      }
    } catch {
      // invalid accelerator in JARVIS_PTT_SHORTCUT: try the next one
    }
  }
}

async function connectCore(): Promise<void> {
  core = await ensureCore();
  core.on("message", forward);
  core.on("close", () => {
    core = undefined;
    overlay?.hide();
    win?.webContents.send("jarvis:status", { connected: false, hotkey });
  });
  win?.webContents.send("jarvis:status", { connected: true, hotkey });
}

ipcMain.on("jarvis:send", (event, raw: unknown) => {
  if (event.senderFrame?.url && !event.senderFrame.url.startsWith("file://")) return;
  const msg = parseRendererMessage(raw);
  if (!msg) return; // dropped: the renderer only ever sends well-formed allowlisted messages
  core?.send(msg);
});

ipcMain.handle("jarvis:status", () => ({ connected: core !== undefined, hotkey }));

/**
 * Registering a project (ADR-017): the renderer sends name and notes; the folder is chosen by the
 * owner in the native dialog shown here. Returns the request id so the renderer can match errors.
 */
ipcMain.handle("jarvis:create-project", async (event, raw: unknown) => {
  if (event.senderFrame?.url && !event.senderFrame.url.startsWith("file://")) return { canceled: true };
  const req = CreateProjectRequest.safeParse(raw);
  if (!req.success || !core || !win) return { canceled: true };
  const picked = await dialog.showOpenDialog(win, {
    title: `Carpeta del proyecto «${req.data.name}»`,
    buttonLabel: "Autorizar esta carpeta",
    properties: ["openDirectory"],
  });
  const root = picked.filePaths[0];
  if (picked.canceled || !root) return { canceled: true };
  const id = randomUUID();
  core.send({ type: "projects.create", id, root, ...req.data });
  return { canceled: false, id, root };
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app.whenReady().then(async () => {
    win = createWindow();
    overlay = createOverlay();
    registerHotkey();
    try {
      await connectCore();
    } catch (err) {
      win.webContents.send("jarvis:status", { connected: false, hotkey, error: err instanceof Error ? err.message : String(err) });
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
      process.stdout.write(`[smoke] hotkey: ${hotkey ?? "none"}
`);
      const image = await win.webContents.capturePage();
      await writeFile(smokeShot, image.toPNG());
      if (smokeOverlay && overlay) {
        // Simulated state only: the real microphone is never opened by a smoke run.
        forward({ type: "voice.state", state: "listening", micOpen: true });
        await new Promise((r) => setTimeout(r, 600));
        await writeFile(smokeOverlay, (await overlay.webContents.capturePage()).toPNG());
      }
      app.quit();
    }
  });
  // Closing the main window does not stop the Core (ADR-001); the app itself exits.
  app.on("will-quit", () => globalShortcut.unregisterAll());
  app.on("window-all-closed", () => app.quit());
}
