import type { CoreMessage } from "@jarvis/shared";
import type { RendererMessage } from "../main/bridge.js";

export interface JarvisBridge {
  send(message: RendererMessage): void;
  onMessage(listener: (message: CoreMessage) => void): () => void;
  onStatus(listener: (status: { connected: boolean; hotkey?: string | null; error?: string }) => void): () => void;
  status(): Promise<{ connected: boolean; hotkey?: string | null }>;
  onHotkey(listener: () => void): () => void;
}

declare global {
  interface Window {
    jarvis: JarvisBridge;
  }
}
