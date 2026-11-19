import { type FormEvent, type KeyboardEvent, useEffect, useReducer, useRef, useState } from "react";
import { VOICE_LABELS, budgetLevel, initialState, pttPressed, reduce } from "./state.js";

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
    };
    const offHotkey = jarvis.onHotkey(() => {
      const s = latest.current;
      if (!s.connected || s.voice.state === "unavailable") return;
      jarvis.send({ type: "voice.ptt", id: nextId("p"), pressed: pttPressed(s.voice), ...(s.activeId ? { conversationId: s.activeId } : {}) });
    });
    const offMessage = jarvis.onMessage((message) => {
      dispatch({ kind: "core", message });
      if (message.type === "chat.done") jarvis.send({ type: "conversations.list", id: nextId("l") });
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
    jarvis.send({ type: "chat.send", id: requestId, text, ...(state.activeId ? { conversationId: state.activeId } : {}) });
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
    jarvis.send({ type: "conversations.get", id: nextId("g"), conversationId });
  };

  const startNew = () => {
    if (busy) return;
    dispatch({ kind: "new" });
    input.current?.focus();
  };

  return (
    <div className="shell">
      <aside className="rail" aria-label="Conversaciones">
        <div className="brand">
          <span className={`signal ${state.connected ? "on" : "off"}`} aria-hidden="true" />
          <span className="brand-name">Jarvis</span>
        </div>
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
      </aside>

      <main className="stage">
        <header className="meter-bar">
          <div
            className={`voice-chip ${state.voice.state} ${state.voice.micOpen ? "mic-open" : ""}`}
            title={state.voice.detail ?? (shortcut ? `Atajo global: ${shortcut}` : "Atajo global no disponible")}
          >
            <span className="voice-dot" aria-hidden="true" />
            <span>{state.voice.micOpen ? "Micrófono abierto" : VOICE_LABELS[state.voice.state]}</span>
            {shortcut && voiceReady && <kbd>{shortcut}</kbd>}
          </div>
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
