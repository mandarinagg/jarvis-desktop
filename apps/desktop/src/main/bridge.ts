/**
 * The renderer is untrusted (it renders model output). It may only send this allowlisted subset of
 * client messages; auth and shutdown stay in the main process. Every payload is re-validated here.
 */
import { ClientMessage } from "@jarvis/shared";

export const RENDERER_ALLOWED = ["chat.send", "chat.cancel", "conversations.list", "conversations.get", "budget.get"] as const;

export type RendererMessage = Extract<ClientMessage, { type: (typeof RENDERER_ALLOWED)[number] }>;

export function parseRendererMessage(raw: unknown): RendererMessage | undefined {
  const parsed = ClientMessage.safeParse(raw);
  if (!parsed.success) return undefined;
  const msg = parsed.data;
  return (RENDERER_ALLOWED as readonly string[]).includes(msg.type) ? (msg as RendererMessage) : undefined;
}
