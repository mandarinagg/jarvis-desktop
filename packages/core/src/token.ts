import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}

/** Written fresh on every Core start (ADR-008): a leaked token dies with the session. */
export async function writeSessionToken(file: string, token: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, token, { encoding: "utf8", mode: 0o600 });
}

export async function readSessionToken(file: string): Promise<string> {
  return (await readFile(file, "utf8")).trim();
}

export function tokensMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
