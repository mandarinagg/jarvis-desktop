import type { MemoryInfo, ProposalInfo } from "@jarvis/shared";
import { useState } from "react";

export const KIND_LABEL: Record<MemoryInfo["kind"], string> = {
  preference: "Preferencia",
  fact: "Dato",
  procedure: "Cómo lo hacés",
  idea: "Idea",
  episode: "Episodio",
};
const FILTERS: { kind?: MemoryInfo["kind"]; label: string }[] = [
  { label: "Todo" },
  { kind: "preference", label: "Preferencias" },
  { kind: "fact", label: "Datos" },
  { kind: "procedure", label: "Procedimientos" },
  { kind: "idea", label: "Idea Vault" },
  { kind: "episode", label: "Episodios" },
];
const IDEA_STATUS: Record<NonNullable<MemoryInfo["ideaStatus"]>, string> = { nueva: "Nueva", en_curso: "En curso", hecha: "Hecha", descartada: "Descartada" };

/** Start of the current week (Monday 00:00 local) as ISO, for "olvidá todo lo de esta semana". */
export function weekStart(now: Date): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString();
}

export type MemoryAction =
  | { type: "list"; query?: string; kind?: MemoryInfo["kind"] }
  | { type: "update"; memoryId: number; text?: string; status?: MemoryInfo["status"]; ideaStatus?: MemoryInfo["ideaStatus"] }
  | { type: "delete"; memoryIds: number[] }
  | { type: "forget"; since: string; until: string }
  | { type: "settings"; enabled: boolean }
  | { type: "decide"; proposalId: number; accept: boolean; text?: string }
  | { type: "reflect" };

type Acceptance = { accepted: number; decided: number; rate?: number | undefined };

/** Proposals from the daily reflection: accept as is, edit and accept, or reject. */
function Proposals({ proposals, acceptance, onAction }: { proposals: ProposalInfo[]; acceptance?: Acceptance | undefined; onAction: (a: MemoryAction) => void }) {
  const [editing, setEditing] = useState<{ id: number; text: string } | undefined>();
  return (
    <>
      <h3>Propuestas para recordar</h3>
      <p className="hint">
        Jarvis las sacó de tus conversaciones en la reflexión diaria. Nada se guarda sin tu OK.
        {acceptance?.decided ? ` Últimos 14 días: aceptaste ${acceptance.accepted} de ${acceptance.decided}${acceptance.rate !== undefined ? ` (${Math.round(acceptance.rate * 100)} %)` : ""}.` : ""}
      </p>
      {proposals.length === 0 && <p className="hint">No hay propuestas pendientes.</p>}
      <ol className="audit-list">
        {proposals.map((p) => (
          <li key={p.id} className={`audit memory-item proposal ${p.kind}`}>
            <div className="project-line">
              <span className="project-name">
                {KIND_LABEL[p.kind]}
                {p.project ? ` · ${p.project}` : ""}
              </span>
              <span className="project-meta">{new Date(p.createdAt).toLocaleDateString("es-AR")}</span>
            </div>
            {editing?.id === p.id ? (
              <textarea className="memory-edit-area" value={editing.text} maxLength={1000} onChange={(e) => setEditing({ id: p.id, text: e.target.value })} aria-label="Texto a recordar" />
            ) : (
              <p className="memory-text">{p.text}</p>
            )}
            <span className="project-meta">Por qué: {p.reason}</span>
            <div className="project-actions">
              <button
                className="action small"
                disabled={editing?.id === p.id && !editing.text.trim()}
                onClick={() => {
                  onAction({ type: "decide", proposalId: p.id, accept: true, ...(editing?.id === p.id ? { text: editing.text } : {}) });
                  setEditing(undefined);
                }}
              >
                {editing?.id === p.id ? "Guardar editado" : "Recordar"}
              </button>
              {editing?.id !== p.id && (
                <button className="link" onClick={() => setEditing({ id: p.id, text: p.text })}>
                  Editar
                </button>
              )}
              <button className="link danger" onClick={() => onAction({ type: "decide", proposalId: p.id, accept: false })}>
                No
              </button>
            </div>
          </li>
        ))}
      </ol>
      <h3>Recuerdos</h3>
    </>
  );
}

/**
 * Memory panel (Phase 6, ADR-024): everything Jarvis remembers, editable by the owner. Memory text
 * may come from the model (episodes): shown as plain text, never as markup.
 */
export function Memory({
  data,
  notice,
  onAction,
  onClose,
}: {
  data: { enabled: boolean; memories: MemoryInfo[]; proposals: ProposalInfo[]; acceptance?: Acceptance } | undefined;
  notice: string | undefined;
  onAction: (a: MemoryAction) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<MemoryInfo["kind"] | undefined>();
  const [editing, setEditing] = useState<{ id: number; text: string } | undefined>();
  const [confirmForget, setConfirmForget] = useState(false);
  const list = (k = kind, q = query) => onAction({ type: "list", ...(q.trim() ? { query: q.trim() } : {}), ...(k ? { kind: k } : {}) });

  return (
    <section className="activity memory" aria-label="Memoria de Jarvis">
      <div className="activity-head">
        <h2>Memoria</h2>
        <div className="project-actions">
          {data && (
            <button className="link" onClick={() => onAction({ type: "settings", enabled: !data.enabled })} aria-pressed={data.enabled}>
              {data.enabled ? "Desactivar la memoria" : "Activar la memoria"}
            </button>
          )}
          {data?.enabled && (
            <button className="link" onClick={() => onAction({ type: "reflect" })} title="Revisa las conversaciones nuevas y propone recuerdos (unos centavos)">
              Reflexionar ahora
            </button>
          )}
          {confirmForget ? (
            <button
              className="link danger"
              onClick={() => {
                setConfirmForget(false);
                onAction({ type: "forget", since: weekStart(new Date()), until: new Date(Date.now() + 60_000).toISOString() });
              }}
            >
              Sí, olvidar todo lo de esta semana
            </button>
          ) : (
            <button className="link" onClick={() => setConfirmForget(true)}>
              Olvidar esta semana…
            </button>
          )}
          <button className="action small" onClick={onClose}>
            Volver al chat
          </button>
        </div>
      </div>
      <p className="hint">
        Lo que Jarvis recuerda de vos. Usa solo lo activo, y como datos: nunca como órdenes. Solo se guarda lo que aprobás. Los episodios son resúmenes automáticos que vencen solos.
        {data && !data.enabled && " La memoria está desactivada: Jarvis no recuerda ni guarda nada."}
      </p>
      {notice && <p className="hint">{notice}</p>}
      {data && <Proposals proposals={data.proposals} acceptance={data.acceptance} onAction={onAction} />}
      <form
        className="memory-search"
        onSubmit={(e) => {
          e.preventDefault();
          list();
        }}
      >
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar en la memoria…" aria-label="Buscar en la memoria" />
        <div className="memory-filters" role="group" aria-label="Tipo de recuerdo">
          {FILTERS.map((f) => (
            <button
              type="button"
              key={f.label}
              className={`link ${kind === f.kind ? "active" : ""}`}
              aria-pressed={kind === f.kind}
              onClick={() => {
                setKind(f.kind);
                list(f.kind);
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      </form>
      {!data && <p className="hint">Cargando…</p>}
      {data?.memories.length === 0 && <p className="hint">No hay recuerdos{query || kind ? " con ese filtro" : " todavía"}.</p>}
      <ol className="audit-list">
        {data?.memories.map((m) => (
          <li key={m.id} className={`audit memory-item ${m.kind} ${m.status}`}>
            <div className="project-line">
              <span className="project-name">
                #{m.id} · {KIND_LABEL[m.kind]}
                {m.project ? ` · ${m.project}` : ""}
                {m.status === "disabled" ? " · desactivado" : ""}
              </span>
              <span className="project-meta">
                {new Date(m.createdAt).toLocaleDateString("es-AR")} · {m.source === "owner" ? "lo aprobaste vos" : "resumen automático"}
                {m.useCount ? ` · usado ${m.useCount} ${m.useCount === 1 ? "vez" : "veces"}` : ""}
              </span>
            </div>
            {editing?.id === m.id ? (
              <form
                className="memory-edit"
                onSubmit={(e) => {
                  e.preventDefault();
                  onAction({ type: "update", memoryId: m.id, text: editing.text });
                  setEditing(undefined);
                }}
              >
                <textarea value={editing.text} maxLength={1000} onChange={(e) => setEditing({ id: m.id, text: e.target.value })} aria-label="Texto del recuerdo" />
                <button className="action small" type="submit" disabled={!editing.text.trim()}>
                  Guardar
                </button>
                <button className="link" type="button" onClick={() => setEditing(undefined)}>
                  Cancelar
                </button>
              </form>
            ) : (
              <p className="memory-text">{m.text}</p>
            )}
            <div className="project-actions">
              {m.kind === "idea" && (
                <select value={m.ideaStatus ?? "nueva"} onChange={(e) => onAction({ type: "update", memoryId: m.id, ideaStatus: e.target.value as NonNullable<MemoryInfo["ideaStatus"]> })} aria-label="Estado de la idea">
                  {Object.entries(IDEA_STATUS).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              )}
              <button className="link" onClick={() => setEditing({ id: m.id, text: m.text })}>
                Editar
              </button>
              <button className="link" onClick={() => onAction({ type: "update", memoryId: m.id, status: m.status === "active" ? "disabled" : "active" })}>
                {m.status === "active" ? "Desactivar" : "Activar"}
              </button>
              <button className="link danger" onClick={() => onAction({ type: "delete", memoryIds: [m.id] })}>
                Borrar
              </button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
