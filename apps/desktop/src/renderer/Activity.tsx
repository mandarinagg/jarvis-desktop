import type { AuditEntryInfo } from "@jarvis/shared";

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
  onRefresh,
  onExport,
  onClose,
}: {
  entries: AuditEntryInfo[] | undefined;
  exported: { path: string; count: number } | undefined;
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
