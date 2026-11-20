import type { DashboardResult, SpendDay } from "@jarvis/shared";
import { useState } from "react";

type Dashboard = Omit<DashboardResult, "type" | "id">;

const usd = (n: number) => `US$ ${n.toFixed(2)}`;
const SERIES = [
  { key: "chatUsd", label: "Chat y voz", cls: "s1" },
  { key: "builderUsd", label: "Builder", cls: "s2" },
  { key: "reflectionUsd", label: "Reflexión", cls: "s3" },
] as const;
const total = (d: SpendDay) => d.chatUsd + d.builderUsd + d.reflectionUsd;
const dayLabel = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString("es-AR", { day: "numeric", month: "short" });

/** Daily spend for the last 30 days, stacked by what spent it. Hover a day for its breakdown. */
function SpendChart({ days, budget }: { days: SpendDay[]; budget: number }) {
  const [hover, setHover] = useState<number | undefined>();
  const [table, setTable] = useState(false);
  const W = 600;
  const H = 140;
  const max = Math.max(budget, ...days.map(total)) || 1;
  const slot = W / days.length;
  const bar = Math.max(4, slot - 4);
  const y = (v: number) => (v / max) * H;
  const h = hover !== undefined ? days[hover] : undefined;
  return (
    <figure className="spend-chart">
      <figcaption className="chart-head">
        <span>Gasto por día · últimos 30 días</span>
        <span className="chart-legend">
          {SERIES.map((s) => (
            <span key={s.key} className="legend-item">
              <i className={`swatch ${s.cls}`} aria-hidden="true" />
              {s.label}
            </span>
          ))}
          <span className="legend-item">
            <i className="swatch budget" aria-hidden="true" />
            Tope diario
          </span>
        </span>
      </figcaption>
      <div className="chart-wrap" onPointerLeave={() => setHover(undefined)}>
        <svg viewBox={`0 0 ${W} ${H + 2}`} preserveAspectRatio="none" role="img" aria-label="Gasto diario de los últimos 30 días">
          <line className="grid" x1={0} x2={W} y1={H} y2={H} />
          <line className="budget-line" x1={0} x2={W} y1={H - y(budget)} y2={H - y(budget)} />
          {days.map((d, i) => {
            let base = H;
            const x = i * slot + (slot - bar) / 2;
            const parts = SERIES.filter((s) => d[s.key] > 0);
            return (
              <g key={d.day} className={hover === i ? "day hovered" : "day"}>
                {parts.map((s, j) => {
                  // 2px gap between stacked segments; only the top one gets rounded corners.
                  const hh = Math.max(1, y(d[s.key]) - (j < parts.length - 1 ? 2 : 0));
                  base -= y(d[s.key]);
                  return <rect key={s.key} className={s.cls} x={x} y={base} width={bar} height={hh} rx={j === parts.length - 1 ? 2 : 0} />;
                })}
                <rect className="hit" x={i * slot} y={0} width={slot} height={H} onPointerEnter={() => setHover(i)} />
              </g>
            );
          })}
        </svg>
        {h && hover !== undefined && (
          <div className="chart-tip" style={{ left: `${((hover + 0.5) / days.length) * 100}%` }} role="status">
            <strong>
              {dayLabel(h.day)} · {usd(total(h))}
            </strong>
            {SERIES.filter((s) => h[s.key] > 0).map((s) => (
              <span key={s.key}>
                <i className={`swatch ${s.cls}`} aria-hidden="true" /> {s.label} {usd(h[s.key])}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="chart-axis">
        <span>{dayLabel(days[0]?.day ?? "")}</span>
        <span>hoy</span>
      </div>
      <button className="link" onClick={() => setTable(!table)} aria-expanded={table}>
        {table ? "Ocultar tabla" : "Ver como tabla"}
      </button>
      {table && (
        <table className="spend-table">
          <thead>
            <tr>
              <th>Día</th>
              {SERIES.map((s) => (
                <th key={s.key}>{s.label}</th>
              ))}
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {days
              .filter((d) => total(d) > 0)
              .reverse()
              .map((d) => (
                <tr key={d.day}>
                  <td>{dayLabel(d.day)}</td>
                  {SERIES.map((s) => (
                    <td key={s.key}>{usd(d[s.key])}</td>
                  ))}
                  <td>{usd(total(d))}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </figure>
  );
}

/**
 * Home (Phase 7, ADR-025): spend today and this month, where data went, what Jarvis did today and
 * what is waiting for the owner. Titles and ideas are owner/model text: plain text only.
 */
export function Home({
  data,
  onRefresh,
  onOpenConversation,
  onShowMemory,
  onShowActivity,
}: {
  data: Dashboard | undefined;
  onRefresh: () => void;
  onOpenConversation: (id: string) => void;
  onShowMemory: () => void;
  onShowActivity: () => void;
}) {
  if (!data) {
    return (
      <section className="activity home" aria-label="Inicio">
        <p className="hint">Cargando…</p>
      </section>
    );
  }
  const { spend, memory, builder, activity } = data;
  const ratio = spend.todayUsd / spend.dailyBudgetUsd;
  const pending = memory.pendingProposals + builder.review;
  return (
    <section className="activity home" aria-label="Inicio">
      <div className="activity-head">
        <h2>Inicio</h2>
        <div className="project-actions">
          <button className="link" onClick={onRefresh}>
            Actualizar
          </button>
        </div>
      </div>

      <div className="tiles">
        <div className={`tile ${ratio >= 1 ? "over" : ratio >= 0.8 ? "warn" : ""}`}>
          <span className="tile-label">Hoy</span>
          <span className="tile-value">{usd(spend.todayUsd)}</span>
          <span className="tile-sub">de {usd(spend.dailyBudgetUsd)} de tope diario</span>
        </div>
        <div className="tile">
          <span className="tile-label">Este mes</span>
          <span className="tile-value">{usd(spend.monthUsd)}</span>
          <span className="tile-sub">a este ritmo, {usd(spend.projectedMonthUsd)} al cierre</span>
        </div>
        <div className="tile">
          <span className="tile-label">Caché del prompt</span>
          <span className="tile-value">{spend.cacheHitRate !== undefined ? `${Math.round(spend.cacheHitRate * 100)} %` : "—"}</span>
          <span className="tile-sub">de la entrada se leyó del caché (más barato)</span>
        </div>
        <button className={`tile action-tile ${pending ? "attention" : ""}`} onClick={pending ? (memory.pendingProposals ? onShowMemory : onShowActivity) : onShowActivity}>
          <span className="tile-label">Esperando tu OK</span>
          <span className="tile-value">{pending}</span>
          <span className="tile-sub">
            {memory.pendingProposals} {memory.pendingProposals === 1 ? "propuesta" : "propuestas"} de memoria · {builder.review}{" "}
            {builder.review === 1 ? "tarea" : "tareas"} del Builder
          </span>
        </button>
      </div>

      <SpendChart days={spend.days} budget={spend.dailyBudgetUsd} />

      <div className="home-grid">
        <div>
          <h3>Este mes, por uso</h3>
          <ul className="plain-list">
            {SERIES.map((s) => (
              <li key={s.key}>
                <span>
                  <i className={`swatch ${s.cls}`} aria-hidden="true" /> {s.label}
                </span>
                <span>{usd(spend.month[s.key])}</span>
              </li>
            ))}
          </ul>
          <h3>Conversaciones más caras del mes</h3>
          {spend.topConversations.length === 0 && <p className="hint">Todavía no hay gasto este mes.</p>}
          <ul className="plain-list">
            {spend.topConversations.map((c) => (
              <li key={c.id}>
                <button className="link" onClick={() => onOpenConversation(c.id)}>
                  {c.title}
                </button>
                <span>{usd(c.costUsd)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>Hoy</h3>
          <ul className="plain-list">
            <li>
              <span>Acciones con herramientas</span>
              <span>{activity.actionsToday}</span>
            </li>
            <li>
              <span>Aprobadas por vos</span>
              <span>{activity.confirmedToday}</span>
            </li>
            <li>
              <span>Rechazadas o bloqueadas</span>
              <span>{activity.deniedToday}</span>
            </li>
            <li>
              <span>Tareas del Builder trabajando</span>
              <span>{builder.running}</span>
            </li>
          </ul>
          <h3>Datos que salieron de tu PC hoy</h3>
          <ul className="plain-list">
            {data.cloud.map((c) => (
              <li key={`${c.provider}-${c.purpose}`}>
                <span>
                  {c.provider} · {c.purpose}
                </span>
                <span>{c.callsToday !== undefined ? `${c.callsToday} ${c.callsToday === 1 ? "vez" : "veces"}` : "activa"}</span>
              </li>
            ))}
          </ul>
          <h3>Ideas abiertas</h3>
          {!memory.enabled && <p className="hint">La memoria está apagada.</p>}
          {memory.enabled && memory.openIdeas.length === 0 && <p className="hint">No hay ideas nuevas ni en curso.</p>}
          <ul className="plain-list">
            {memory.openIdeas.map((i) => (
              <li key={i.id}>
                <span>{i.text}</span>
                <span className="project-meta">{i.status === "en_curso" ? "En curso" : "Nueva"}</span>
              </li>
            ))}
          </ul>
          <p className="hint">{memory.active} recuerdos activos.</p>
        </div>
      </div>
    </section>
  );
}
