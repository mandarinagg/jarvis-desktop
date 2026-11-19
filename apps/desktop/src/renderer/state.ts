/** Pure chat state for the renderer: every Core message and UI action goes through `reduce`. */
import type { ConversationSummary, CoreMessage, VoiceStateName } from "@jarvis/shared";

export interface UiMessage {
  role: "user" | "assistant";
  content: string;
  interrupted: boolean;
  pending: boolean;
}

export interface State {
  connected: boolean;
  connectionError?: string;
  conversations: ConversationSummary[];
  activeId?: string;
  messages: UiMessage[];
  /** Request in flight: set on send (or on voice.transcript for voice turns), gets its turnId on chat.started. */
  streaming?: { requestId: string; turnId?: string; voice?: boolean };
  voice: { state: VoiceStateName; micOpen: boolean; detail?: string };
  budget?: { spentTodayUsd: number; dailyBudgetUsd: number };
  lastTurnCostUsd?: number;
  error?: string;
}

export type Action =
  | { kind: "status"; connected: boolean; error?: string }
  | { kind: "core"; message: CoreMessage }
  | { kind: "send"; requestId: string; text: string }
  | { kind: "select"; conversationId: string }
  | { kind: "new" }
  | { kind: "dismissError" };

export const initialState: State = {
  connected: false,
  conversations: [],
  messages: [],
  voice: { state: "unavailable", micOpen: false },
};

/**
 * The global shortcut is a toggle (Electron only reports key presses, not releases): it stops
 * listening if Jarvis is listening; otherwise it starts, which also interrupts a reply (barge-in).
 */
export function pttPressed(voice: State["voice"]): boolean {
  return voice.state !== "listening";
}

/** Chip and overlay text. The mic indicator always wins; while Jarvis speaks it may be listening for barge-in. */
export function voiceLabel(voice: Pick<State["voice"], "state" | "micOpen">): string {
  if (!voice.micOpen) return VOICE_LABELS[voice.state];
  return voice.state === "speaking" ? "Hablando · te escucho" : "Micrófono abierto";
}

export const VOICE_LABELS: Record<VoiceStateName, string> = {
  unavailable: "Voz no disponible",
  idle: "Listo",
  listening: "Escuchando",
  transcribing: "Transcribiendo",
  thinking: "Pensando",
  speaking: "Hablando",
};

const updateLastAssistant = (messages: UiMessage[], fn: (m: UiMessage) => UiMessage): UiMessage[] => {
  const i = messages.findLastIndex((m) => m.role === "assistant");
  return i === -1 ? messages : messages.map((m, j) => (j === i ? fn(m) : m));
};

export function reduce(state: State, action: Action): State {
  switch (action.kind) {
    case "status": {
      const next: State = { ...state, connected: action.connected };
      if (action.error) next.connectionError = action.error;
      else delete next.connectionError;
      return next;
    }
    case "send": {
      const next: State = {
        ...state,
        streaming: { requestId: action.requestId },
        messages: [
          ...state.messages,
          { role: "user", content: action.text, interrupted: false, pending: false },
          { role: "assistant", content: "", interrupted: false, pending: true },
        ],
      };
      delete next.error;
      return next;
    }
    case "select": {
      const next: State = { ...state, activeId: action.conversationId, messages: [] };
      delete next.error;
      return next;
    }
    case "new": {
      const next: State = { ...state, messages: [] };
      delete next.activeId;
      delete next.error;
      return next;
    }
    case "dismissError": {
      const next = { ...state };
      delete next.error;
      return next;
    }
    case "core":
      return reduceCore(state, action.message);
  }
}

/** A voice turn the Core started: its request id is unknown until chat.started arrives. */
const awaitingVoiceTurn = (s: State) => s.streaming?.voice === true && s.streaming.turnId === undefined;

function reduceCore(state: State, m: CoreMessage): State {
  switch (m.type) {
    case "voice.state": {
      const voice: State["voice"] = { state: m.state, micOpen: m.micOpen };
      if (m.detail) voice.detail = m.detail;
      return { ...state, voice };
    }
    case "voice.transcript":
      if (state.streaming) return state; // a typed turn is in flight; the Core will reject the overlap
      return {
        ...state,
        streaming: { requestId: `voice:${m.utteranceId}`, voice: true },
        messages: [
          ...state.messages,
          { role: "user", content: m.text, interrupted: false, pending: false },
          { role: "assistant", content: "", interrupted: false, pending: true },
        ],
      };
    case "chat.started":
      if (awaitingVoiceTurn(state)) {
        // Spoken into another conversation: show just this exchange until its history loads.
        const messages = state.activeId && state.activeId !== m.conversationId ? state.messages.slice(-2) : state.messages;
        return { ...state, messages, activeId: m.conversationId, streaming: { requestId: m.id, turnId: m.turnId, voice: true } };
      }
      if (state.streaming?.requestId !== m.id) return state;
      return { ...state, activeId: m.conversationId, streaming: { requestId: m.id, turnId: m.turnId } };
    case "chat.delta":
      if (state.streaming?.turnId !== m.turnId) return state;
      return { ...state, messages: updateLastAssistant(state.messages, (a) => ({ ...a, content: a.content + m.text })) };
    case "chat.done": {
      if (state.streaming?.turnId !== m.turnId) return state;
      const next: State = {
        ...state,
        lastTurnCostUsd: m.costUsd,
        messages: updateLastAssistant(state.messages, (a) => ({ ...a, pending: false })),
      };
      if (state.budget) next.budget = { ...state.budget, spentTodayUsd: state.budget.spentTodayUsd + m.costUsd };
      delete next.streaming;
      return next;
    }
    case "error": {
      if (!state.streaming || (state.streaming.requestId !== m.id && !(awaitingVoiceTurn(state) && m.id))) {
        return m.id ? state : { ...state, error: m.message };
      }
      const next: State = { ...state };
      delete next.streaming;
      if (m.code === "cancelled") {
        next.messages = updateLastAssistant(state.messages, (a) => ({ ...a, pending: false, interrupted: true }));
      } else {
        // Drop the empty placeholder; keep the user's message so it can be resent.
        next.messages = state.messages.filter((x, i) => !(i === state.messages.length - 1 && x.pending && !x.content));
        next.error = m.message;
      }
      return next;
    }
    case "conversations.list.result":
      return { ...state, conversations: m.conversations };
    case "conversations.history":
      if (m.conversationId !== state.activeId || state.streaming) return state;
      return { ...state, messages: m.messages.map((x) => ({ ...x, pending: false })) };
    case "budget.status":
      return { ...state, budget: { spentTodayUsd: m.spentTodayUsd, dailyBudgetUsd: m.dailyBudgetUsd } };
    default:
      return state;
  }
}

/** Budget meter level: calm below 80% (alert threshold, ADR-005), warning above, exhausted at 100%. */
export function budgetLevel(b: State["budget"]): "ok" | "warn" | "over" {
  if (!b) return "ok";
  const EPS = 1e-9; // 2.4 / 3 is 0.7999… in floating point; exactly 80% must warn
  const ratio = b.spentTodayUsd / b.dailyBudgetUsd;
  return ratio >= 1 - EPS ? "over" : ratio >= 0.8 - EPS ? "warn" : "ok";
}
