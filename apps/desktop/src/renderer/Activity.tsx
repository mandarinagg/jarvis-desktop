import type { AuditEntryInfo, BuilderTaskInfo } from "@jarvis/shared";

const TASK_STATUS: Record<BuilderTaskInfo["status"], string> = {
  running: "Trabajando",
  review: "Lista para revisar",
  merged: "Mergeada",
  discarded: "Descartada",
  failed: "No se pudo completar",
  cancelled: "Cancelada",
};

/** Builder tasks (Phase 5, ADR-023). Summaries are written by the model: shown as plain text. */
function BuilderTasks({ tasks, onCancel }: { tasks: BuilderTaskInfo[]; onCancel: (taskId: string) => void }) {
  if (!tasks.length) return null;
  return (
    <>
      <h3>Builder</h3>
      <p className="hint">Para mergear o descartar una tarea, pedíselo a Jarvis: vas a ver el diff completo antes de aprobar.</p>
      <ol className="audit-list">
        {tasks.slice(0, 10).map((t) => (
          <li key={t.id} className={`audit builder-task ${t.status}`}>
            <div className="project-line">
              <span className="project-name">
                {t.project} · {t.id.slice(0, 8)} · {TASK_STATUS[t.status]}
              </span>
              <span className="project-meta">
                US$ {t.costUsd.toFixed(2)} de {t.budgetUsd.toFixed(2)}
                {t.filesChanged ? ` · ${t.filesChanged} archivos` : ""}
              </span>
            </div>
            <span>{t.task.split("\n")[0]}</span>
            <code className="audit-args">{t.branch}</code>
            {t.status === "running" && t.lastAction && <span className="project-meta">{t.lastAction}</span>}
            {t.error && <span className="project-meta">{t.error}</span>}
            {t.summary && t.status !== "running" && <pre className="builder-summary">{t.summary}</pre>}
            {t.status === "running" && (
              <button className="link" onClick={() => onCancel(t.id)}>
                Detener
              </button>
            )}
          </li>
        ))}
      </ol>
      <h3>Registro</h3>
    </>
  );
}

const RISK: Record<AuditEntryInfo["risk"], string> = {
  read: "lectura",
  prepare: "preparación",
  confirm: "con confirmación",
  destructive: "destructiva",
  forbidden: "prohibida",
};

export function verdict(e: Pick<AuditEntryInfo, "decision" | "reason" | "approvedBy" | "ok">): string {
  if (e.decision === "deny") return `No se hizo: ${e.reason ?? "sin permiso"}`;
  const who = e.approvedBy?.startsWith("owner") ? "La aprobaste vos" : e.approvedBy === "rule" ? "Permitida por una regla" : "Permitida";
  return `${who}${e.ok === false ? " · falló" : ""}`;
}

/**
 * Activity (Phase 4, TOOLS_AND_PERMISSIONS §4): the audit log, newest first. Arguments come
 * redacted from the Core and are shown as plain text. Export writes JSONL inside the Jarvis folder.
 */
export function Activity({
  entries,
  exported,
  tasks,
  onCancelTask,
  onRefresh,
  onExport,
  onClose,
}: {
  entries: AuditEntryInfo[] | undefined;
  exported: { path: string; count: number } | undefined;
  tasks: BuilderTaskInfo[] | undefined;
  onCancelTask: (taskId: string) => void;
  onRefresh: () => void;
  onExport: () => void;
  onClose: () => void;
}) {
  return (
    <section className="activity" aria-label="Actividad de Jarvis">
      <div className="activity-head">
        <h2>Actividad</h2>
        <div className="project-actions">
          <button className="link" onClick={onRefresh}>
            Actualizar
          </button>
          <button className="link" onClick={onExport}>
            Exportar (JSONL)
          </button>
          <button className="action small" onClick={onClose}>
            Volver al chat
          </button>
        </div>
      </div>
      <p className="hint">Todo lo que Jarvis hizo con sus herramientas. Este registro no se puede editar ni borrar.</p>
      {exported && (
        <p className="hint">
          Exporté {exported.count} entradas a {exported.path}
        </p>
      )}
      <BuilderTasks tasks={tasks ?? []} onCancel={onCancelTask} />
      {!entries && <p className="hint">Cargando…</p>}
      {entries?.length === 0 && <p className="hint">Jarvis todavía no usó ninguna herramienta.</p>}
      <ol className="audit-list">
        {entries?.map((e) => (
          <li key={e.id} className={`audit ${e.decision} ${e.risk}`}>
            <div className="project-line">
              <span className="project-name">
                {e.server} → {e.tool}
              </span>
              <span className="project-meta">
                {new Date(e.ts).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })} · {RISK[e.risk]}
              </span>
            </div>
            <code className="audit-args">{e.args}</code>
            <span className="project-meta">{verdict(e)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
