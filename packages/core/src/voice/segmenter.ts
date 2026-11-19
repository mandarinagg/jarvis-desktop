/**
 * Cuts Claude's streamed reply into speakable phrases (ADR-013): TTS starts on the first phrase
 * instead of waiting for the whole answer. Markdown is cleaned up and code blocks are not read.
 *
 * Boundaries: end of sentence (. ! ? …) followed by whitespace, and line breaks. The first phrase
 * may also end at a comma/colon once it is long enough, so the first audio comes sooner.
 */

export interface SegmenterOptions {
  /** Minimum length before the first phrase may be cut at , ; : (default 30). */
  firstClauseChars?: number;
  /** Phrases longer than this are cut at the last clause mark or space (default 250). */
  maxChars?: number;
}

const ABBREVIATIONS = new Set([
  "sr", "sra", "srta", "dr", "dra", "ud", "uds", "vs", "etc", "ej", "aprox", "núm", "num", "pág", "pag", "tel", "av", "lic", "ing",
]);

const SENTENCE_END = /[.!?…]+["'”»)\]]*(?=\s)/g;
const CLAUSE_END = /[,;:](?=\s)/g;

export function cleanForSpeech(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) and images -> text
    .replace(/https?:\/\/\S+/g, "el enlace")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // headings
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, "") // list markers
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^\n]*?\S)\1/g, "$2") // emphasis
    .replace(/^\s*>\s?/gm, "") // quotes
    .replace(/\|/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

const speakable = (text: string) => /[\p{L}\p{N}]/u.test(text);

export class PhraseSegmenter {
  private buf = "";
  private emitted = 0;
  private readonly firstClauseChars: number;
  private readonly maxChars: number;

  constructor(opts: SegmenterOptions = {}) {
    this.firstClauseChars = opts.firstClauseChars ?? 30;
    this.maxChars = opts.maxChars ?? 250;
  }

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      if (!this.skipCodeBlock()) break;
      const cut = this.findBoundary();
      if (cut === undefined) break;
      this.emit(this.buf.slice(0, cut), out);
      this.buf = this.buf.slice(cut);
    }
    return out;
  }

  /** End of the stream: whatever is left is the last phrase (an unclosed code block is dropped). */
  flush(): string[] {
    const out: string[] = [];
    this.skipCodeBlock();
    if (!this.buf.trimStart().startsWith("```")) this.emit(this.buf, out);
    this.buf = "";
    return out;
  }

  /** Returns false while waiting for the end of a code block. */
  private skipCodeBlock(): boolean {
    for (;;) {
      const lead = this.buf.length - this.buf.trimStart().length;
      if (!this.buf.startsWith("```", lead)) return true;
      const close = this.buf.indexOf("```", lead + 3);
      if (close === -1) return false;
      const eol = this.buf.indexOf("\n", close + 3);
      this.buf = eol === -1 ? "" : this.buf.slice(eol + 1);
      if (eol === -1) return true;
    }
  }

  private findBoundary(): number | undefined {
    const text = this.buf;
    const nl = text.indexOf("\n");
    const fence = text.indexOf("```", text.length - text.trimStart().length + 1);
    let best: number | undefined;
    for (const m of text.matchAll(SENTENCE_END)) {
      const end = m.index + m[0].length;
      if (this.isRealSentenceEnd(text, m.index)) {
        best = end;
        break;
      }
    }
    if (nl !== -1 && (best === undefined || nl < best)) best = nl + 1;
    if (fence > 0 && (best === undefined || fence < best)) best = fence;
    if (best !== undefined) return best;

    if (this.emitted === 0) {
      for (const m of text.matchAll(CLAUSE_END)) {
        if (m.index + 1 >= this.firstClauseChars) return m.index + 1;
      }
    }
    if (text.length > this.maxChars) {
      const window = text.slice(0, this.maxChars);
      const clause = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
      if (clause > 0) return clause + 1;
      const space = window.lastIndexOf(" ");
      return space > 0 ? space : this.maxChars;
    }
    return undefined;
  }

  private isRealSentenceEnd(text: string, at: number): boolean {
    if (text[at] !== ".") return true;
    const before = text.slice(0, at);
    const word = /([\p{L}\p{N}]+)$/u.exec(before)?.[1];
    if (!word) return true;
    if (ABBREVIATIONS.has(word.toLowerCase())) return false;
    // "1. Comprar pan": a list number at the start of a line is not a sentence.
    const lineStart = before.lastIndexOf("\n") + 1;
    return !(/^\d+$/.test(word) && before.slice(lineStart).trim() === word);
  }

  private emit(raw: string, out: string[]): void {
    const text = cleanForSpeech(raw);
    if (!speakable(text)) return;
    out.push(text);
    this.emitted += 1;
  }
}
