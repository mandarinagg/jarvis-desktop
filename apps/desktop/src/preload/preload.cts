/**
 * Sandboxed preload: exposes a minimal, typed bridge. No Node APIs reach the renderer.
 * The main process re-validates every outgoing message (bridge.ts).
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type Listener = (message: unknown) => void;

contextBridge.exposeInMainWorld("jarvis", {
  send(message: unknown): void {
    ipcRenderer.send("jarvis:send", message);
  },
  onMessage(listener: Listener): () => void {
    const wrapped = (_e: IpcRendererEvent, m: unknown) => listener(m);
    ipcRenderer.on("jarvis:message", wrapped);
    return () => ipcRenderer.off("jarvis:message", wrapped);
  },
  onStatus(listener: Listener): () => void {
    const wrapped = (_e: IpcRendererEvent, s: unknown) => listener(s);
    ipcRenderer.on("jarvis:status", wrapped);
    return () => ipcRenderer.off("jarvis:status", wrapped);
  },
  status(): Promise<unknown> {
    return ipcRenderer.invoke("jarvis:status");
  },
});
