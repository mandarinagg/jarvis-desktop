#!/usr/bin/env node
/**
 * Terminal chat client for the Core (usable before the desktop UI exists).
 *   node packages/core/dist/chat-cli.js
 * Commands: /nueva (new conversation), /salir. Ctrl+C while Jarvis answers cancels the answer.
 */
import readline from "node:readline/promises";
import type { CoreMessage } from "@jarvis/shared";
import { CoreClient } from "./client.js";
import { defaultPipeName, jarvisHome, tokenPath } from "./paths.js";
import { readSessionToken } from "./token.js";

const out = (s: string) => process.stdout.write(s);

async function main(): Promise<number> {
  let token: string;
  try {
    token = await readSessionToken(tokenPath(jarvisHome()));
  } catch {
    process.stderr.write("Jarvis Core no está corriendo. Arrancalo con: node packages/core/dist/main.js\n");
    return 1;
  }
  const client = await CoreClient.connect({ pipe: process.env.JARVIS_PIPE ?? defaultPipeName(), token, client: "cli" });
  client.on("close", () => {
    process.stderr.write("\nSe cerró la conexión con Jarvis Core.\n");
    process.exit(1);
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let conversationId: string | undefined;
  let turnId: string | undefined;
  let spentToday = 0;
  rl.on("SIGINT", () => {
    if (turnId) client.send({ type: "chat.cancel", id: `c-${Date.now()}`, turnId });
    else {
      rl.close();
      process.exit(0);
    }
  });

  out(`Jarvis (Core ${client.coreVersion}). /nueva = conversación nueva, /salir = salir, Ctrl+C = cortar respuesta.\n`);
  for (;;) {
    const text = (await rl.question("\nvos › ")).trim();
    if (!text) continue;
    if (text === "/salir") break;
    if (text === "/nueva") {
      conversationId = undefined;
      out("(conversación nueva)\n");
      continue;
    }
    const id = `m-${Date.now()}`;
    client.send({ type: "chat.send", id, text, ...(conversationId ? { conversationId } : {}) });
    out("jarvis › ");
    await new Promise<void>((resolve) => {
      const onMessage = (m: CoreMessage) => {
        if (m.type === "chat.started" && m.id === id) {
          conversationId = m.conversationId;
          turnId = m.turnId;
        } else if (m.type === "chat.delta" && m.turnId === turnId) {
          out(m.text);
        } else if (m.type === "chat.done" && m.turnId === turnId) {
          spentToday += m.costUsd;
          out(`\n  · US$ ${m.costUsd.toFixed(4)} (sesión: US$ ${spentToday.toFixed(4)})\n`);
          finish();
        } else if (m.type === "error" && m.id === id) {
          out(m.code === "cancelled" ? "\n  · (cortado)\n" : `\n  ⚠ ${m.message}\n`);
          finish();
        }
      };
      const finish = () => {
        turnId = undefined;
        client.off("message", onMessage);
        resolve();
      };
      client.on("message", onMessage);
    });
  }
  rl.close();
  client.close();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
