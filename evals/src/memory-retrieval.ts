/**
 * Phase 6 exit, deterministic part (ADR-024): does retrieval put the right memory in front of the
 * model? A fixed corpus of memories and owner messages with the memory each one needs (or none).
 * Offline, no API: `pnpm --filter @jarvis/evals memory-eval` prints the table; the test enforces it.
 */
import { MemoryStore, ProjectStore, openDatabase, retrieve } from "@jarvis/core";

type Seed = { key: string; kind: "fact" | "preference" | "procedure" | "idea" | "episode"; text: string; project?: string; disabled?: boolean; expired?: boolean };

export const CORPUS: Seed[] = [
  { key: "ts-scripts", kind: "preference", text: "El owner prefiere TypeScript para los scripts chicos" },
  { key: "short-voice", kind: "preference", text: "Prefiere respuestas cortas cuando habla por voz" },
  { key: "commits-en", kind: "preference", text: "Los commits de sus proyectos van en inglés con Conventional Commits" },
  { key: "recetario-db", kind: "fact", text: "Recetario usa SQLite como base de datos", project: "Recetario" },
  { key: "tienda-db", kind: "fact", text: "La tienda online usa Postgres en Supabase", project: "Tienda" },
  { key: "pnpm", kind: "fact", text: "Usa pnpm como gestor de paquetes en todos sus proyectos" },
  { key: "windows", kind: "fact", text: "Trabaja en Windows 11 con una GPU AMD" },
  { key: "dog", kind: "fact", text: "Tiene una perra que se llama Luna" },
  { key: "deploy", kind: "procedure", text: "Para publicar la tienda: corre los tests, sube la versión y despliega en Vercel" , project: "Tienda" },
  { key: "weekly", kind: "procedure", text: "El informe semanal lo arma los viernes con el avance de cada proyecto y los bloqueos" },
  { key: "idea-voice-recipes", kind: "idea", text: "App de recetas que se maneja por voz mientras cocinás" },
  { key: "idea-invoices", kind: "idea", text: "Bot que lee facturas del mail y las carga en la planilla de gastos" },
  { key: "ep-arch", kind: "episode", text: "Se definió la arquitectura de Jarvis: un Core en Node y clientes livianos" },
  { key: "ep-old", kind: "episode", text: "Se habló de migrar la base de datos de la tienda a MySQL", expired: true },
  { key: "off-mysql", kind: "fact", text: "La base de datos vieja de la tienda era MySQL", disabled: true },
  { key: "gym", kind: "fact", text: "Va al gimnasio los martes y jueves a la mañana" },
  { key: "coffee", kind: "preference", text: "No le gusta que le agenden reuniones antes de las 10" },
];

/** Owner message, active project, memories that must be retrieved, memories that must not. */
export const QUERIES: { text: string; project?: string; expect: string[]; avoid?: string[] }[] = [
  { text: "¿Qué base de datos usa Recetario?", project: "Recetario", expect: ["recetario-db"], avoid: ["off-mysql", "ep-old"] },
  { text: "Necesito un script para renombrar fotos por fecha", expect: ["ts-scripts"] },
  { text: "¿Cómo publico la tienda?", project: "Tienda", expect: ["deploy"] },
  { text: "¿Qué base de datos tiene la tienda?", project: "Tienda", expect: ["tienda-db"], avoid: ["off-mysql", "ep-old"] },
  { text: "Instalá las dependencias del proyecto, ¿con qué gestor de paquetes?", expect: ["pnpm"] },
  { text: "Escribime el mensaje del commit para este cambio", expect: ["commits-en"] },
  { text: "¿Cómo se llama mi perra?", expect: ["dog"] },
  { text: "Ayudame con el informe semanal", expect: ["weekly"] },
  { text: "¿Qué ideas tenía sobre recetas?", expect: ["idea-voice-recipes"] },
  { text: "Tengo un montón de facturas en el mail, ¿se te ocurre algo?", expect: ["idea-invoices"] },
  { text: "Recordame cómo quedó la arquitectura de Jarvis", expect: ["ep-arch"] },
  { text: "¿Qué días voy al gimnasio?", expect: ["gym"] },
  { text: "¿Me podés agendar una reunión con el contador?", expect: ["coffee"] },
  { text: "¿Por qué no anda el driver de la GPU en Windows?", expect: ["windows"] },
  { text: "Contestame corto: ¿qué hora es en Tokio?", expect: ["short-voice"] },
];

export interface RetrievalResult {
  text: string;
  hit: boolean;
  missing: string[];
  leaked: string[];
  got: string[];
}

export function runRetrievalEval(now = new Date("2026-11-20T12:00:00Z")): { results: RetrievalResult[]; score: number } {
  const db = openDatabase(":memory:");
  try {
    const projects = new ProjectStore(db);
    const ids = new Map<number, string>();
    const projectId = (name?: string) => {
      if (!name) return null;
      return (projects.find(name) ?? projects.create({ name, root: `C:\\eval\\${name}` })).id;
    };
    const memories = new MemoryStore(db, () => now);
    for (const s of CORPUS) {
      const m = memories.add({
        kind: s.kind,
        text: s.text,
        projectId: projectId(s.project),
        source: s.kind === "episode" ? "reflection" : "owner",
        expiresAt: s.kind === "episode" ? new Date(now.getTime() + (s.expired ? -1 : 90) * 86_400_000).toISOString() : null,
      });
      if (s.disabled) memories.update(m.id, { status: "disabled" });
      ids.set(m.id, s.key);
    }
    const results = QUERIES.map((q) => {
      const got = retrieve(memories, { text: q.text, projectId: q.project ? (projects.find(q.project)?.id ?? undefined) : undefined, now }).memories.map((m) => ids.get(m.id) ?? "?");
      const missing = q.expect.filter((k) => !got.includes(k));
      const leaked = (q.avoid ?? []).filter((k) => got.includes(k));
      return { text: q.text, hit: !missing.length && !leaked.length, missing, leaked, got };
    });
    return { results, score: results.filter((r) => r.hit).length / results.length };
  } finally {
    db.close();
  }
}
