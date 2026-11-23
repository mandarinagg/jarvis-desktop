/**
 * Electron main process: a thin client of Jarvis Core (ADR-001/002).
 * Security: contextIsolation, sandbox, no nodeIntegration, strict CSP, allowlisted + validated IPC,
 * no navigation or new windows.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreClient } from "@jarvis/core/client";
import { jarvisHome } from "@jarvis/core/paths";
import type { CoreMessage, PermissionRequest } from "@jarvis/shared";
import { randomUUID } from "node:crypto";
import { BrowserWindow, Notification, app, dialog, globalShortcut, ipcMain, nativeImage, screen, shell } from "electron";
import { CreateProjectRequest, parseRendererMessage, WhatsAppRequest } from "./bridge.js";
import { dialogSteps } from "./confirm-dialog.js";
import { ensureCore } from "./core-connection.js";
import { overlayVisible, wakeBadgeBitmap } from "./overlay.js";
import { qrPage, whatsappDialog } from "./whatsapp-qr.js";

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

/** Open native confirmation dialogs, closed when the request is answered elsewhere or expires. */
const asking = new Map<string, AbortController>();

/**
 * Phase 4 (ADR-018): the owner approves in a native dialog shown here. The renderer never sees a
 * way to answer: it only shows that Jarvis is waiting (chat.tool status "waiting").
 */
async function askOwner(req: PermissionRequest): Promise<void> {
  if (!win || asking.has(req.requestId)) return;
  const ac = new AbortController();
  asking.set(req.requestId, ac);
  let confirmations = 0;
  try {
    if (win.isMinimized()) win.restore();
    win.show();
    win.flashFrame(true);
    for (const step of dialogSteps(req)) {
      const { response } = await dialog.showMessageBox(win, {
        type: "warning",
        title: step.title,
        message: step.message,
        detail: step.detail,
        buttons: step.buttons,
        defaultId: 1, // Enter never approves by accident
        cancelId: 1,
        noLink: true,
        signal: ac.signal,
      });
      if (ac.signal.aborted || response !== 0) break;
      confirmations++;
    }
  } finally {
    asking.delete(req.requestId);
    win?.flashFrame(false);
  }
  if (ac.signal.aborted) return;
  const approved = confirmations === req.confirmations;
  core?.send({ type: "permission.respond", id: randomUUID(), requestId: req.requestId, approved, confirmations });
}

let wakeBadge = false;

/** Mandatory indicator while the mic waits for the wake word: a dot on the taskbar button. */
function showWakeBadge(on: boolean): void {
  if (!win || on === wakeBadge) return;
  wakeBadge = on;
  win.setOverlayIcon(on ? nativeImage.createFromBitmap(wakeBadgeBitmap(), { width: 16, height: 16 }) : null, on ? "Micrófono atento a «Hey Jarvis»" : "");
  win.setTitle(on ? "Jarvis · atento a «Hey Jarvis»" : "Jarvis");
}

/** A Builder task finished: tell the owner even if the window is in the background. */
const notified = new Set<string>();
function notifyBuilder(t: Extract<CoreMessage, { type: "builder.task" }>["task"]): void {
  if (t.status === "running" || notified.has(`${t.id}:${t.status}`) || !Notification.isSupported()) return;
  notified.add(`${t.id}:${t.status}`);
  const what = { review: "lista para revisar", failed: "no se pudo completar", cancelled: "cancelada", merged: "mergeada", discarded: "descartada" }[t.status];
  if (t.status !== "review" && t.status !== "failed") return;
  new Notification({ title: `Builder · ${t.project}`, body: `Tarea ${t.id.slice(0, 8)} ${what}.`, silent: false }).show();
}

/** Reminders and the briefing (Phase 7): the Core already held them during quiet hours. Plain text. */
function notifyOwner(m: Extract<CoreMessage, { type: "proactive.notify" }>): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: m.title, body: m.body.slice(0, 1_000), silent: false });
  n.on("click", () => {
    win?.show();
    win?.focus();
  });
  n.show();
}

let qrWindow: BrowserWindow | undefined;

/** The WhatsApp QR (ADR-029), in its own window: no preload, no JavaScript, only the SVG. */
function showWhatsAppQr(qr: string | undefined): void {
  if (!qr) {
    qrWindow?.close();
    return;
  }
  if (!qrWindow || qrWindow.isDestroyed()) {
    qrWindow = new BrowserWindow({
      width: 360,
      height: 440,
      resizable: false,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      title: "Vincular WhatsApp",
      backgroundColor: "#1a2230",
      ...(win ? { parent: win } : {}),
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, javascript: false, webSecurity: true },
    });
    qrWindow.webContents.on("will-navigate", (e) => e.preventDefault());
    qrWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    qrWindow.on("closed", () => (qrWindow = undefined));
  }
  void qrWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(qrPage(qr))}`);
}

function forward(m: CoreMessage): void {
  if (m.type === "whatsapp.state") {
    showWhatsAppQr(m.qr);
    const { qr: _qr, ...rest } = m;
    win?.webContents.send("jarvis:message", rest); // the renderer never sees the QR
    return;
  }
  if (m.type === "voice.state") showWakeBadge(m.wake === true);
  if (m.type === "permission.request") void askOwner(m);
  if (m.type === "permission.resolved") asking.get(m.requestId)?.abort();
  if (m.type === "builder.task") notifyBuilder(m.task);
  if (m.type === "proactive.notify") notifyOwner(m);
  // The export is written by the Core inside the Jarvis folder; only reveal paths that live there.
  if (m.type === "audit.exported" && path.resolve(m.path).toLowerCase().startsWith(path.join(jarvisHome(), "exports").toLowerCase() + path.sep)) {
    shell.showItemInFolder(m.path);
  }
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
    showWakeBadge(false);
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

/** Linking or unlinking WhatsApp (ADR-029): the renderer asks, the owner confirms here. */
ipcMain.handle("jarvis:whatsapp", async (event, raw: unknown) => {
  if (event.senderFrame?.url && !event.senderFrame.url.startsWith("file://")) return { sent: false };
  const action = WhatsAppRequest.safeParse(raw);
  if (!action.success || !core || !win) return { sent: false };
  const step = whatsappDialog(action.data);
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    title: step.title,
    message: step.message,
    detail: step.detail,
    buttons: step.buttons,
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0 || !core) return { sent: false };
  core.send({ type: action.data === "link" ? "whatsapp.link" : "whatsapp.unlink", id: randomUUID() });
  return { sent: true };
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
