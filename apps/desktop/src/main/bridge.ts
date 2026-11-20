/**
 * The renderer is untrusted (it renders model output). It may only send this allowlisted subset of
 * client messages; auth and shutdown stay in the main process. Every payload is re-validated here.
 */
import { ClientMessage } from "@jarvis/shared";
import { z } from "zod";

export const RENDERER_ALLOWED = [
  "chat.send",
  "chat.cancel",
  "conversations.list",
  "conversations.get",
  "budget.get",
  "voice.ptt",
  "voice.status.get",
  // Phase 3. projects.create is NOT here: the folder comes only from the native picker in the main
  // process (createProjectRequest), so a compromised renderer can never authorize a path.
  "projects.list",
  "projects.update",
  "projects.delete",
  "projects.reindex",
  "conversations.setProject",
  // Phase 4. permission.respond is NOT here: confirmations are native dialogs in the main process
  // (confirm-dialog.ts), so model output rendered here can never approve an action.
  "audit.list",
  "audit.export",
  "voice.wake",
  // Phase 5. Listing and stopping Builder tasks only: starting, merging and discarding go through
  // Jarvis' tools, confirmed in native dialogs.
  "builder.list",
  "builder.cancel",
  // Phase 6. The Memory panel: list, edit, disable, delete, forget a range, turn memory off. It
  // cannot create memories (those need a native confirmation or an accepted proposal).
  "memory.list",
  "memory.update",
  "memory.delete",
  "memory.forget",
  "memory.settings",
  "memory.decide",
  "memory.reflect",
  "conversations.setMode",
] as const;

export type RendererMessage = Extract<ClientMessage, { type: (typeof RENDERER_ALLOWED)[number] }>;

export function parseRendererMessage(raw: unknown): RendererMessage | undefined {
  const parsed = ClientMessage.safeParse(raw);
  if (!parsed.success) return undefined;
  const msg = parsed.data;
  return (RENDERER_ALLOWED as readonly string[]).includes(msg.type) ? (msg as RendererMessage) : undefined;
}

/** What the renderer may say about a new project: everything except its folder. */
export const CreateProjectRequest = z.strictObject({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  goals: z.string().max(1_000).optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;
