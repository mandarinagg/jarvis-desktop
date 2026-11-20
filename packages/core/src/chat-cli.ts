#!/usr/bin/env node
/**
 * Terminal chat client for the Core (usable before the desktop UI exists).
 *   node packages/core/dist/chat-cli.js
 * Commands: /nueva (new conversation), /salir. Ctrl+C while Jarvis answers cancels the answer.
 */
import readline from "node:readline/promises";
import type { CoreMessage, PermissionRequest } from "@jarvis/shared";
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

  // Phase 4 (ADR-018): the CLI is a trustworthy prompt, so it can answer permission requests.
  const asking = new Map<string, AbortController>();
  const askPermission = async (m: PermissionRequest) => {
    const ac = new AbortController();
    asking.set(m.requestId, ac);
    let approved: boolean;
    let confirmations = 0;
    try {
      out(`\n\n  ⚠ ${m.title}\n${m.detail.split("\n").map((l) => `    ${l}`).join("\n")}\n`);
      approved = /^s(i|í)?$/i.test((await rl.question("  ¿Lo permitís? (s/N) ", { signal: ac.signal })).trim());
      if (approved) confirmations = 1;
      if (approved && m.confirmations === 2) {
        const again = await rl.question("  No se puede deshacer. Escribí BORRAR para confirmar: ", { signal: ac.signal });
        approved = again.trim() === "BORRAR";
        if (approved) confirmations = 2;
      }
    } catch {
      return; // answered elsewhere, expired or cancelled
    } finally {
      asking.delete(m.requestId);
    }
    client.send({ type: "permission.respond", id: `p-${Date.now()}`, requestId: m.requestId, approved, confirmations });
  };
  client.on("message", (m: CoreMessage) => {
    if (m.type === "permission.request") void askPermission(m);
    else if (m.type === "permission.resolved") {
      asking.get(m.requestId)?.abort();
      out(m.approved ? "  · permitido\n" : `  · no se hizo${m.reason ? ` (${m.reason})` : ""}\n`);
    } else if (m.type === "builder.task" && (m.task.status === "review" || m.task.status === "failed")) {
      out(`\n  · Builder: la tarea ${m.task.id.slice(0, 8)} en ${m.task.project} ${m.task.status === "review" ? "está lista para revisar" : `no se pudo completar (${m.task.error ?? "sin detalle"})`}\n`);
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
