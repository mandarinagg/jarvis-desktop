import { type FormEvent, type KeyboardEvent, useEffect, useReducer, useRef, useState } from "react";
import { Activity } from "./Activity.js";
import { Home } from "./Home.js";
import { Memory, type MemoryAction } from "./Memory.js";
import { Projects } from "./Projects.js";
import { type ToolStatus, budgetLevel, initialState, pttPressed, reduce, voiceLabel } from "./state.js";

const TOOL_SUFFIX: Record<ToolStatus, string> = {
  started: "…",
  waiting: " · esperando tu confirmación",
  done: "",
  denied: " (sin permiso)",
  error: " (falló)",
};

const usd = (n: number) => `US$ ${n.toFixed(2)}`;
let seq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

function relativeDay(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days === 0) return d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  if (days === 1) return "ayer";
  if (days < 7) return d.toLocaleDateString("es-AR", { weekday: "long" });
  return d.toLocaleDateString("es-AR", { day: "numeric", month: "short" });
}

export function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [draft, setDraft] = useState("");
  const [hotkey, setHotkey] = useState<string | null>(null);
  const [holding, setHolding] = useState(false);
  const [view, setView] = useState<"home" | "chat" | "activity" | "memory">("home");
  const latest = useRef(state);
  latest.current = state;
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const { jarvis } = window;

  useEffect(() => {
    const refresh = () => {
      jarvis.send({ type: "conversations.list", id: nextId("l") });
      jarvis.send({ type: "budget.get", id: nextId("b") });
      jarvis.send({ type: "voice.status.get", id: nextId("v") });
      jarvis.send({ type: "projects.list", id: nextId("pl") });
      jarvis.send({ type: "builder.list", id: nextId("bl") });
      jarvis.send({ type: "dashboard.get", id: nextId("d") });
      jarvis.send({ type: "proactive.get", id: nextId("pg") });
    };
    const offHotkey = jarvis.onHotkey(() => {
      const s = latest.current;
      if (!s.connected || s.voice.state === "unavailable") return;
      jarvis.send({ type: "voice.ptt", id: nextId("p"), pressed: pttPressed(s.voice), ...(s.activeId ? { conversationId: s.activeId } : {}) });
    });
    const offMessage = jarvis.onMessage((message) => {
      dispatch({ kind: "core", message });
      if (message.type === "chat.done") jarvis.send({ type: "conversations.list", id: nextId("l") });
      // A confirmation is a native dialog over this window: show the conversation it belongs to.
      if (message.type === "permission.request") setView("chat");
      // A spoken turn shows up in the conversation, wherever the window was.
      if (message.type === "voice.transcript") setView("chat");
    });
    const offStatus = jarvis.onStatus((s) => {
      dispatch({ kind: "status", connected: s.connected, ...(s.error ? { error: s.error } : {}) });
      setHotkey(s.hotkey ?? null);
      if (s.connected) refresh();
    });
    void jarvis.status().then((s) => {
      dispatch({ kind: "status", connected: s.connected });
      setHotkey(s.hotkey ?? null);
      if (s.connected) refresh();
    });
    return () => {
      offHotkey();
      offMessage();
      offStatus();
    };
  }, [jarvis]);

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ block: "end" });
  }, [state.messages]);

  const busy = state.streaming !== undefined;
  const level = budgetLevel(state.budget);
  const voiceReady = state.connected && state.voice.state !== "unavailable";
  const shortcut = hotkey?.replaceAll("Control", "Ctrl").replaceAll("+", " + ");

  /** In-window push-to-talk: hold the button, like a walkie-talkie. */
  const ptt = (pressed: boolean) => {
    if (!voiceReady || pressed === holding) return;
    setHolding(pressed);
    jarvis.send({ type: "voice.ptt", id: nextId("p"), pressed, ...(state.activeId ? { conversationId: state.activeId } : {}) });
  };

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || busy || !state.connected) return;
    const requestId = nextId("m");
    dispatch({ kind: "send", requestId, text });
    setView("chat");
    jarvis.send({
      type: "chat.send",
      id: requestId,
      text,
      ...(state.activeId ? { conversationId: state.activeId } : state.projectId ? { projectId: state.projectId } : {}),
    });
    setDraft("");
  };

  const cancel = () => {
    if (state.streaming?.turnId) jarvis.send({ type: "chat.cancel", id: nextId("c"), turnId: state.streaming.turnId });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) send(e);
    if (e.key === "Escape" && busy) cancel();
  };

  const open = (conversationId: string) => {
    if (busy) return;
    dispatch({ kind: "select", conversationId });
    setView("chat");
    jarvis.send({ type: "conversations.get", id: nextId("g"), conversationId });
  };

  /** Active project: saved on the open conversation, or kept for the next new one. */
  const chooseProject = (projectId: string) => {
    dispatch({ kind: "setProject", ...(projectId ? { projectId } : {}) });
    if (state.activeId) {
      jarvis.send({ type: "conversations.setProject", id: nextId("sp"), conversationId: state.activeId, projectId: projectId || null });
    }
  };

  const showActivity = () => {
    setView("activity");
    jarvis.send({ type: "audit.list", id: nextId("al"), limit: 100 });
    jarvis.send({ type: "builder.list", id: nextId("bl") });
  };

  const showHome = () => {
    setView("home");
    jarvis.send({ type: "dashboard.get", id: nextId("d") });
    jarvis.send({ type: "proactive.get", id: nextId("pg") });
  };

  const showMemory = () => {
    setView("memory");
    jarvis.send({ type: "memory.list", id: nextId("ml") });
  };
  const memoryAction = (a: MemoryAction) => {
    const id = nextId("m");
    if (a.type === "list") jarvis.send({ type: "memory.list", id, ...(a.query ? { query: a.query } : {}), ...(a.kind ? { kind: a.kind } : {}) });
    else if (a.type === "update") jarvis.send({ ...a, type: "memory.update", id });
    else if (a.type === "delete") jarvis.send({ type: "memory.delete", id, memoryIds: a.memoryIds });
    else if (a.type === "forget") jarvis.send({ type: "memory.forget", id, since: a.since, until: a.until });
    else if (a.type === "decide") jarvis.send({ type: "memory.decide", id, proposalId: a.proposalId, accept: a.accept, ...(a.text ? { text: a.text } : {}) });
    else if (a.type === "reflect") jarvis.send({ type: "memory.reflect", id });
    else jarvis.send({ type: "memory.settings", id, enabled: a.enabled });
  };

  const startNew = () => {
    if (busy) return;
    dispatch({ kind: "new" });
    setView("chat");
    input.current?.focus();
  };

  return (
    <div className="shell">
      <aside className="rail" aria-label="Conversaciones">
        <div className="brand">
          <span className={`signal ${state.connected ? "on" : "off"}`} aria-hidden="true" />
          <span className="brand-name">Jarvis</span>
        </div>
        <button className="link activity-link home-link" onClick={showHome} disabled={!state.connected} aria-pressed={view === "home"}>
          Inicio
        </button>
        <button className="new" onClick={startNew} disabled={busy}>
          Nueva conversación
        </button>
        <nav className="history">
          {state.conversations.length === 0 && <p className="hint">Tus conversaciones van a aparecer acá.</p>}
          {state.conversations.map((c) => (
            <button
              key={c.id}
              className={`thread ${c.id === state.activeId ? "active" : ""}`}
              onClick={() => open(c.id)}
              disabled={busy}
              aria-current={c.id === state.activeId ? "true" : undefined}
            >
              <span className="thread-title">{c.title}</span>
              <span className="thread-when">{relativeDay(c.updatedAt)}</span>
            </button>
          ))}
        </nav>
        <Projects projects={state.projects} connected={state.connected} onError={(m) => dispatch({ kind: "core", message: { type: "error", code: "internal", message: m } })} />
        <button className="link activity-link" onClick={showActivity} disabled={!state.connected} aria-pressed={view === "activity"}>
          Actividad
        </button>
        <button className="link activity-link" onClick={showMemory} disabled={!state.connected} aria-pressed={view === "memory"}>
          Memoria
        </button>
      </aside>

      <main className="stage">
        <header className="meter-bar">
          <div
            className={`voice-chip ${state.voice.state} ${state.voice.micOpen ? "mic-open" : ""} ${state.voice.wake ? "wake" : ""}`}
            title={state.voice.detail ?? (shortcut ? `Atajo global: ${shortcut}` : "Atajo global no disponible")}
          >
            <span className="voice-dot" aria-hidden="true" />
            <span>{voiceLabel(state.voice)}</span>
            {shortcut && voiceReady && <kbd>{shortcut}</kbd>}
          </div>
          {voiceReady && (
            <button
              className="link wake-toggle"
              onClick={() => jarvis.send({ type: "voice.wake", id: nextId("w"), enabled: !state.voice.wake })}
              aria-pressed={state.voice.wake === true}
              title="La detección es local: nada de lo que digas antes de «Hey Jarvis» se guarda ni sale de tu PC"
            >
              {state.voice.wake ? "Apagar «Hey Jarvis»" : "Activar «Hey Jarvis»"}
            </button>
          )}
          {state.projects.length > 0 && (
            <label className="project-picker" title="Jarvis busca primero en este proyecto">
              <span>Proyecto</span>
              <select value={state.projectId ?? ""} onChange={(e) => chooseProject(e.target.value)} disabled={busy}>
                <option value="">Ninguno</option>
                {state.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {state.activeId && (
            <label className="project-picker" title="Cómo te responde Jarvis en esta conversación">
              <span>Modo</span>
              <select
                value={state.thinkingMode ?? ""}
                onChange={(e) =>
                  jarvis.send({
                    type: "conversations.setMode",
                    id: nextId("md"),
                    conversationId: state.activeId as string,
                    mode: (e.target.value || null) as "sparring" | "brainstorm" | "abogado" | null,
                  })
                }
                disabled={busy}
              >
                <option value="">Normal</option>
                <option value="sparring">Sparring</option>
                <option value="brainstorm">Brainstorm</option>
                <option value="abogado">Abogado del diablo</option>
              </select>
            </label>
          )}
          {state.budget ? (
            <div className={`meter ${level}`} title="Gasto de hoy en la API de Claude">
              <div className="meter-track">
                <div
                  className="meter-fill"
                  style={{ width: `${Math.min(100, (state.budget.spentTodayUsd / state.budget.dailyBudgetUsd) * 100)}%` }}
                />
              </div>
              <span className="meter-text">
                Hoy {usd(state.budget.spentTodayUsd)} de {usd(state.budget.dailyBudgetUsd)}
              </span>
              {state.lastTurnCostUsd !== undefined && (
                <span className="meter-last">Última respuesta {usd(state.lastTurnCostUsd)}</span>
              )}
            </div>
          ) : (
            <span className="meter-text">{state.connected ? "Cargando gasto…" : "Sin conexión con Jarvis Core"}</span>
          )}
        </header>

        {view === "home" ? (
          <Home
            data={state.dashboard}
            proactive={state.proactive}
            onProactive={(a) =>
              a.type === "cancel"
                ? jarvis.send({ type: "reminders.cancel", id: nextId("rc"), reminderId: a.reminderId })
                : jarvis.send({ type: "proactive.set", id: nextId("ps"), ...a.settings })
            }
            onRefresh={showHome} onOpenConversation={open} onShowMemory={showMemory} onShowActivity={showActivity} />
        ) : view === "memory" ? (
          <Memory data={state.memory} notice={state.memoryNotice} onAction={memoryAction} onClose={() => setView("chat")} />
        ) : view === "activity" ? (
          <Activity
            entries={state.audit}
            exported={state.auditExport}
            tasks={state.builder}
            onCancelTask={(taskId) => jarvis.send({ type: "builder.cancel", id: nextId("bc"), taskId })}
            onRefresh={showActivity}
            onExport={() => jarvis.send({ type: "audit.export", id: nextId("ae") })}
            onClose={() => setView("chat")}
          />
        ) : (
        <section className="transcript" aria-live="polite">
          {state.messages.length === 0 && (
            <div className="empty">
              <p className="empty-lead">¿En qué te ayudo?</p>
              <p className="empty-sub">
                Escribí abajo o mantené apretado «Mantené para hablar». Enter envía, Shift+Enter agrega una línea y Esc
                corta una respuesta en curso.
                {shortcut ? ` Desde cualquier ventana, ${shortcut} empieza y termina de escuchar.` : ""}
              </p>
            </div>
          )}
          {state.messages.map((m, i) =>
            m.role === "user" ? (
              <p key={i} className="said user">
                {m.content}
              </p>
            ) : (
              <div key={i} className={`said jarvis ${m.pending ? "live" : ""}`}>
                {m.tools && m.tools.length > 0 && (
                  <ul className="tool-trail" aria-label="Lo que consultó Jarvis">
                    {m.tools.map((t, j) => (
                      <li key={j} className={`tool ${t.status}`}>
                        {t.summary}
                        {TOOL_SUFFIX[t.status]}
                      </li>
                    ))}
                  </ul>
                )}
                <p>
                  {m.content}
                  {m.pending && <span className="caret" aria-hidden="true" />}
                </p>
                {m.interrupted && <span className="cut">Respuesta cortada</span>}
              </div>
            ),
          )}
          <div ref={transcriptEnd} />
        </section>
        )}

        {(state.error ?? state.connectionError) && (
          <div className="notice" role="alert">
            <span>{state.error ?? state.connectionError}</span>
            {state.error && (
              <button className="link" onClick={() => dispatch({ kind: "dismissError" })}>
                Cerrar
              </button>
            )}
          </div>
        )}

        <form className="composer" onSubmit={send}>
          <textarea
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={state.connected ? "Escribile a Jarvis…" : "Esperando a Jarvis Core…"}
            rows={2}
            disabled={!state.connected}
            aria-label="Mensaje para Jarvis"
          />
          <button
            type="button"
            className={`action talk ${holding ? "held" : ""}`}
            disabled={!voiceReady}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              ptt(true);
            }}
            onPointerUp={() => ptt(false)}
            onPointerCancel={() => ptt(false)}
            onKeyDown={(e) => {
              if ((e.key === " " || e.key === "Enter") && !e.repeat) ptt(true);
            }}
            onKeyUp={(e) => {
              if (e.key === " " || e.key === "Enter") ptt(false);
            }}
            aria-pressed={holding}
            title={voiceReady ? "Mantené apretado para hablar" : (state.voice.detail ?? "La voz no está disponible")}
          >
            {holding ? "Soltá para enviar" : "Mantené para hablar"}
          </button>
          {busy ? (
            <button type="button" className="action stop" onClick={cancel} disabled={!state.streaming?.turnId}>
              Cortar respuesta
            </button>
          ) : (
            <button type="submit" className="action" disabled={!draft.trim() || !state.connected || level === "over"}>
              Enviar
            </button>
          )}
        </form>
      </main>
    </div>
  );
}
