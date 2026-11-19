import type { ProjectInfo } from "@jarvis/shared";
import { type FormEvent, useState } from "react";

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * Projects panel (Phase 3, ADR-017). Registering asks the main process to open the native folder
 * picker: the renderer never sends a path. Removing asks twice, inline (no browser dialogs).
 */
export function Projects({ projects, connected, onError }: { projects: ProjectInfo[]; connected: boolean; onError: (m: string) => void }) {
  const { jarvis } = window;
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [goals, setGoals] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || picking) return;
    setPicking(true);
    try {
      const r = await jarvis.createProject({
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(goals.trim() ? { goals: goals.trim() } : {}),
      });
      if (!r.canceled) {
        setAdding(false);
        setName("");
        setDescription("");
        setGoals("");
      }
    } catch {
      onError("No se pudo abrir el selector de carpetas.");
    } finally {
      setPicking(false);
    }
  };

  return (
    <section className="projects" aria-label="Proyectos">
      <div className="projects-head">
        <span className="section-label">Proyectos</span>
        {!adding && (
          <button className="link" onClick={() => setAdding(true)} disabled={!connected}>
            Agregar
          </button>
        )}
      </div>

      {adding && (
        <form className="project-form" onSubmit={(e) => void add(e)}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre" maxLength={80} aria-label="Nombre del proyecto" autoFocus />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="De qué se trata (opcional)"
            maxLength={500}
            aria-label="Descripción"
          />
          <input value={goals} onChange={(e) => setGoals(e.target.value)} placeholder="Objetivos (opcional)" maxLength={1000} aria-label="Objetivos" />
          <p className="hint">Jarvis va a poder leer esa carpeta (nunca escribir). No lee .env, claves ni node_modules.</p>
          <div className="project-actions">
            <button type="submit" className="action small" disabled={!name.trim() || picking}>
              {picking ? "Elegí la carpeta…" : "Elegir carpeta"}
            </button>
            <button type="button" className="link" onClick={() => setAdding(false)}>
              Cancelar
            </button>
          </div>
        </form>
      )}

      {projects.length === 0 && !adding && <p className="hint">Agregá un proyecto para que Jarvis pueda buscar y leer sus archivos.</p>}
      <ul className="project-list">
        {projects.map((p) => (
          <li key={p.id} className="project" title={p.root}>
            <div className="project-line">
              <span className="project-name">{p.name}</span>
              <span className="project-meta">{p.indexing ? "indexando…" : `${p.files} archivos`}</span>
            </div>
            {p.description && <span className="project-desc">{p.description}</span>}
            <div className="project-actions">
              <button
                className="link"
                disabled={p.indexing}
                onClick={() => jarvis.send({ type: "projects.reindex", id: nextId("r"), projectId: p.id })}
              >
                Reindexar
              </button>
              {confirming === p.id ? (
                <>
                  <button
                    className="link danger"
                    onClick={() => {
                      jarvis.send({ type: "projects.delete", id: nextId("d"), projectId: p.id });
                      setConfirming(null);
                    }}
                  >
                    Sí, quitar
                  </button>
                  <button className="link" onClick={() => setConfirming(null)}>
                    No
                  </button>
                </>
              ) : (
                <button className="link" onClick={() => setConfirming(p.id)} title="Jarvis deja de ver la carpeta. No borra ningún archivo.">
                  Quitar
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
