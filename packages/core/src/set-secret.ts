#!/usr/bin/env node
/**
 * Store a secret in Windows Credential Manager without it ever touching argv, shell history or logs:
 *   node packages/core/dist/set-secret.js anthropic-api-key      (prompts with hidden input)
 *   Get-Clipboard | node packages/core/dist/set-secret.js anthropic-api-key
 */
import { KeyringSecretStore, type SecretName } from "./secrets.js";

const NAMES: readonly SecretName[] = ["anthropic-api-key", "google-tts-api-key"];

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          done();
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          done();
          reject(new Error("cancelled"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
    };
    stdin.on("data", onData);
  });
}

async function readPiped(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += String(chunk);
  return data;
}

async function main(): Promise<number> {
  const name = process.argv[2] as SecretName | undefined;
  if (!name || !NAMES.includes(name)) {
    process.stderr.write(`Uso: set-secret <${NAMES.join("|")}>\n`);
    return 2;
  }
  const value = (process.stdin.isTTY ? await readHidden(`Pegá el valor de ${name} (no se muestra): `) : await readPiped()).trim();
  if (!value) {
    process.stderr.write("Valor vacío: no se guardó nada.\n");
    return 1;
  }
  new KeyringSecretStore().set(name, value);
  process.stderr.write(`Guardado en Windows Credential Manager (servicio Jarvis, cuenta ${name}).\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
