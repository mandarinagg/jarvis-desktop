/** JSON Lines framing for every IPC channel (ADR-008): one message per line, 1 MB max. */

export const MAX_LINE_BYTES = 1024 * 1024;

export class FrameTooLargeError extends Error {
  constructor(bytes: number) {
    super(`IPC frame too large: ${bytes} bytes (max ${MAX_LINE_BYTES})`);
    this.name = "FrameTooLargeError";
  }
}

export function encodeLine(message: unknown): string {
  const json = JSON.stringify(message);
  const bytes = Buffer.byteLength(json, "utf8") + 1;
  if (bytes > MAX_LINE_BYTES) throw new FrameTooLargeError(bytes);
  return json + "\n";
}

/**
 * Accumulates raw chunks (Buffer or string) and yields complete lines.
 * Works on bytes so a UTF-8 character split across chunks is never corrupted, and fails fast
 * when a peer sends more than MAX_LINE_BYTES without a newline (memory exhaustion guard).
 */
export class LineDecoder {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer | string): string[] {
    const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.pending = this.pending.length ? Buffer.concat([this.pending, data]) : data;
    const lines: string[] = [];
    let start = 0;
    let nl: number;
    while ((nl = this.pending.indexOf(0x0a, start)) !== -1) {
      if (nl - start + 1 > MAX_LINE_BYTES) throw new FrameTooLargeError(nl - start + 1);
      const line = this.pending.subarray(start, nl).toString("utf8").replace(/\r$/, "");
      if (line.trim()) lines.push(line);
      start = nl + 1;
    }
    this.pending = this.pending.subarray(start);
    if (this.pending.length > MAX_LINE_BYTES) throw new FrameTooLargeError(this.pending.length);
    return lines;
  }
}
