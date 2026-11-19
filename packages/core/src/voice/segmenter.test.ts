import { describe, expect, it } from "vitest";
import { PhraseSegmenter, cleanForSpeech } from "./segmenter.js";

/** Feed text in small chunks, like a token stream. */
function segment(text: string, chunk = 3, opts = {}): string[] {
  const s = new PhraseSegmenter(opts);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += chunk) out.push(...s.push(text.slice(i, i + chunk)));
  return [...out, ...s.flush()];
}

describe("PhraseSegmenter", () => {
  it("cuts at sentence ends", () => {
    expect(segment("Hola, soy Jarvis. ¿Qué necesitás? ¡Dale!")).toEqual(["Hola, soy Jarvis.", "¿Qué necesitás?", "¡Dale!"]);
  });

  it("is independent of how the stream is chunked", () => {
    const text = "Tenés tres proyectos activos. El primero es Jarvis, el segundo es la web.\nEl tercero está pausado.";
    const expected = segment(text, 1000);
    for (const n of [1, 2, 5, 17]) expect(segment(text, n)).toEqual(expected);
  });

  it("waits for whitespace after the period before cutting", () => {
    const s = new PhraseSegmenter();
    expect(s.push("Listo.")).toEqual([]);
    expect(s.push(" Sigo")).toEqual(["Listo."]);
    expect(s.flush()).toEqual(["Sigo"]);
  });

  it("does not cut decimals, abbreviations or list numbers", () => {
    expect(segment("Cuesta 3.5 dólares, lo dijo el Dr. Pérez. Fin.")).toEqual(["Cuesta 3.5 dólares, lo dijo el Dr. Pérez.", "Fin."]);
    expect(segment("Pasos:\n1. Abrir la app.\n2. Guardar.")).toEqual(["Pasos:", "Abrir la app.", "Guardar."]);
  });

  it("cuts the first phrase early at a clause mark once it is long enough", () => {
    expect(segment("Mirá, esto es lo que encontré en tus notas de ayer, que son varias")).toEqual([
      "Mirá, esto es lo que encontré en tus notas de ayer,",
      "que son varias",
    ]);
  });

  it("only cuts at clauses for the first phrase", () => {
    expect(segment("Bien. Mirá, esto es lo que encontré en tus notas de ayer, que son varias.")).toEqual([
      "Bien.",
      "Mirá, esto es lo que encontré en tus notas de ayer, que son varias.",
    ]);
  });

  it("splits very long phrases", () => {
    const long = "palabra ".repeat(60).trim() + ".";
    const out = segment(long, 7, { maxChars: 100 });
    expect(out.length).toBeGreaterThan(3);
    for (const p of out) expect(p.length).toBeLessThanOrEqual(100);
    expect(out.join(" ")).toBe(long);
  });

  it("does not read code blocks", () => {
    const text = "Probá esto:\n```ts\nconst a = 1. b = 2;\n```\nDespués corré los tests.";
    expect(segment(text, 4)).toEqual(["Probá esto:", "Después corré los tests."]);
  });

  it("drops an unclosed code block at the end", () => {
    expect(segment("Mirá:\n```py\nprint('x')")).toEqual(["Mirá:"]);
  });

  it("skips phrases with nothing to say", () => {
    expect(segment("---\n\n**Listo.**\n")).toEqual(["Listo."]);
  });
});

describe("cleanForSpeech", () => {
  it("removes markdown", () => {
    expect(cleanForSpeech("## Resumen")).toBe("Resumen");
    expect(cleanForSpeech("- **Jarvis**: el `core` anda")).toBe("Jarvis: el core anda");
    expect(cleanForSpeech("Mirá [la doc](https://x.y/z) o https://a.b/c")).toBe("Mirá la doc o el enlace");
    expect(cleanForSpeech("> cita _importante_")).toBe("cita importante");
  });

  it("keeps normal punctuation and snake_case words", () => {
    expect(cleanForSpeech("¿Querés que siga? Usá mi_variable.")).toBe("¿Querés que siga? Usá mi_variable.");
  });
});
