import type { SkillInfo, SkillProposalInfo } from "@jarvis/shared";
import { useState } from "react";

export type SkillsAction =
  | { type: "list" }
  | { type: "evaluate"; proposalId: number }
  | { type: "approve"; proposalId: number }
  | { type: "reject"; proposalId: number }
  | { type: "setEnabled"; name: string; enabled: boolean }
  | { type: "delete"; name: string };

/** A proposal: its steps, test cases and evals. Approving opens a native dialog in the Core. */
function Proposal({ p, busy, onAction }: { p: SkillProposalInfo; busy: boolean; onAction: (a: SkillsAction) => void }) {
  const [open, setOpen] = useState(false);
  const e = p.eval;
  return (
    <li className="audit memory-item proposal">
      <div className="project-line">
        <span className="project-name">
          {p.name}
          {p.updates ? " · versión nueva" : ""}
        </span>
        <span className="project-meta">{new Date(p.createdAt).toLocaleDateString("es-AR")}</span>
      </div>
      <p className="memory-text">{p.description}</p>
      <span className="project-meta">Por qué: {p.reason}</span>
      <button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? "Ocultar pasos y casos" : "Ver pasos y casos"}
      </button>
      {open && (
        <>
          <pre className="builder-summary">{p.body}</pre>
          <ol className="skill-cases">
            {p.cases.map((c, i) => {
              const r = e?.current ? e.results[i] : undefined;
              return (
                <li key={i} className={r ? (r.pass ? "pass" : "fail") : ""}>
                  <span>«{c.prompt}»</span>
                  <span className="project-meta">Tiene que: {c.rubric.join(" · ")}</span>
                  {r && (
                    <span className="project-meta">
                      {r.pass ? "Pasó" : "No pasó"}: {r.reason}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
      <span className={`project-meta ${e?.current && !p.canApprove ? "warn-text" : ""}`}>
        {!e
          ? "Sin evaluar todavía."
          : !e.current
            ? "Las evals corrieron sobre otra versión del texto."
            : e.error
              ? `Las evals fallaron: ${e.error}`
              : `Evals: ${e.passed} de ${e.total} casos · US$ ${e.costUsd.toFixed(2)}`}
      </span>
      <div className="project-actions">
        <button className="link" disabled={busy} onClick={() => onAction({ type: "evaluate", proposalId: p.id })} title="Corre los casos con Claude: cuesta unos centavos, dentro del tope diario">
          {busy ? "Evaluando…" : e ? "Volver a evaluar" : "Correr evals"}
        </button>
        <button
          className="action small"
          disabled={!p.canApprove}
          onClick={() => onAction({ type: "approve", proposalId: p.id })}
          title={p.canApprove ? "Vas a ver el texto completo en un diálogo antes de activarla" : "Se puede aprobar cuando pasan todas sus evals"}
        >
          Aprobar…
        </button>
        <button className="link danger" onClick={() => onAction({ type: "reject", proposalId: p.id })}>
          Descartar
        </button>
      </div>
    </li>
  );
}

/**
 * Skills (Phase 7, ADR-027): procedures Jarvis proposed and the owner approved. Everything here is
 * model-written text shown as plain text. Disabling or deleting is the one-step rollback.
 */
export function Skills({
  data,
  notice,
  onAction,
  onClose,
}: {
  data: { skills: SkillInfo[]; proposals: SkillProposalInfo[] } | undefined;
  notice: string | undefined;
  onAction: (a: SkillsAction) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<number | undefined>();
  const act = (a: SkillsAction) => {
    if (a.type === "evaluate") setBusy(a.proposalId);
    onAction(a);
  };
  // The evaluation is over when the Core answers: every reply is a new list object.
  const [seen, setSeen] = useState(data);
  if (data !== seen) {
    setSeen(data);
    setBusy(undefined);
  }
  return (
    <section className="activity" aria-label="Skills de Jarvis">
      <div className="activity-head">
        <h2>Skills</h2>
        <div className="project-actions">
          <button className="link" onClick={() => onAction({ type: "list" })}>
            Actualizar
          </button>
          <button className="action small" onClick={onClose}>
            Volver al chat
          </button>
        </div>
      </div>
      <p className="hint">
        Procedimientos que Jarvis sigue con las herramientas que ya tiene: nunca le dan permisos nuevos. Una skill se activa solo si pasan sus evals y la aprobás.
        Para proponer una, pedíselo en el chat («armá una skill para el informe semanal»).
      </p>
      {notice && <p className="hint">{notice}</p>}
      {!data && <p className="hint">Cargando…</p>}
      {data && (
        <>
          <h3>Propuestas</h3>
          {data.proposals.length === 0 && <p className="hint">No hay propuestas pendientes.</p>}
          <ol className="audit-list">
            {data.proposals.map((p) => (
              <Proposal key={p.id} p={p} busy={busy === p.id} onAction={act} />
            ))}
          </ol>
          <h3>Activas y desactivadas</h3>
          {data.skills.length === 0 && <p className="hint">Todavía no hay skills.</p>}
          <ol className="audit-list">
            {data.skills.map((s) => (
              <li key={s.name} className={`audit memory-item ${s.status}`}>
                <div className="project-line">
                  <span className="project-name">
                    {s.name} · v{s.version}
                    {s.status === "disabled" ? " · desactivada" : ""}
                  </span>
                  <span className="project-meta">
                    usada {s.useCount} {s.useCount === 1 ? "vez" : "veces"}
                    {s.lastUsedAt ? ` · última ${new Date(s.lastUsedAt).toLocaleDateString("es-AR")}` : ""}
                  </span>
                </div>
                <p className="memory-text">{s.description}</p>
                <details>
                  <summary className="link">Pasos</summary>
                  <pre className="builder-summary">{s.body}</pre>
                </details>
                <div className="project-actions">
                  <button className="link" onClick={() => onAction({ type: "setEnabled", name: s.name, enabled: s.status !== "active" })}>
                    {s.status === "active" ? "Desactivar" : "Activar"}
                  </button>
                  <button className="link danger" onClick={() => onAction({ type: "delete", name: s.name })}>
                    Borrar
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
