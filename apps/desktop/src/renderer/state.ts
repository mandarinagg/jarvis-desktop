/** Pure chat state for the renderer: every Core message and UI action goes through `reduce`. */
import type { DashboardResult, ProactiveState, AuditEntryInfo, BuilderTaskInfo, ConversationSummary, MemoryInfo, ProposalInfo, CoreMessage, ProjectInfo, VoiceStateName } from "@jarvis/shared";

export interface UiMessage {
  role: "user" | "assistant";
  content: string;
  interrupted: boolean;
  pending: boolean;
  /** What Jarvis looked up while answering (Phase 3), in words. */
  tools?: { summary: string; status: ToolStatus }[];
}

export type ToolStatus = "started" | "waiting" | "done" | "error" | "denied";

export interface State {
  connected: boolean;
  connectionError?: string;
  conversations: ConversationSummary[];
  activeId?: string;
  projects: ProjectInfo[];
  /** Active project of the open conversation, or the one chosen for the next new conversation. */
  projectId?: string;
  messages: UiMessage[];
  /** Request in flight: set on send (or on voice.transcript for voice turns), gets its turnId on chat.started. */
  streaming?: { requestId: string; turnId?: string; voice?: boolean };
  voice: { state: VoiceStateName; micOpen: boolean; wake?: boolean; detail?: string };
  budget?: { spentTodayUsd: number; dailyBudgetUsd: number };
  lastTurnCostUsd?: number;
  /** Audit log page (Phase 4), newest first; undefined until loaded. */
  audit?: AuditEntryInfo[];
  auditExport?: { path: string; count: number };
  /** Builder tasks (Phase 5), newest first. */
  builder?: BuilderTaskInfo[];
  /** Memory panel (Phase 6). */
  memory?: { enabled: boolean; memories: MemoryInfo[]; proposals: ProposalInfo[]; acceptance?: { accepted: number; decided: number; rate?: number | undefined } };
  /** Result of the last memory.delete / memory.forget / memory.reflect. */
  memoryNotice?: string;
  /** Thinking mode of the open conversation (Phase 6). */
  thinkingMode?: "sparring" | "brainstorm" | "abogado";
  /** Home panel (Phase 7). */
  dashboard?: Omit<DashboardResult, "type" | "id">;
  /** Proactivity (Phase 7): rules, pending reminders and today's briefing. */
  proactive?: Omit<ProactiveState, "type" | "id">;
  error?: string;
}

export type Action =
  | { kind: "status"; connected: boolean; error?: string }
  | { kind: "core"; message: CoreMessage }
  | { kind: "send"; requestId: string; text: string }
  | { kind: "select"; conversationId: string }
  | { kind: "new" }
  | { kind: "setProject"; projectId?: string }
  | { kind: "dismissError" };

export const initialState: State = {
  connected: false,
  conversations: [],
  projects: [],
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
export function voiceLabel(voice: Pick<State["voice"], "state" | "micOpen" | "wake">): string {
  if (!voice.micOpen) return voice.wake && voice.state === "idle" ? "Atento a «Hey Jarvis»" : VOICE_LABELS[voice.state];
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
      const projectId = state.conversations.find((c) => c.id === action.conversationId)?.projectId;
      if (projectId) next.projectId = projectId;
      else delete next.projectId;
      delete next.error;
      return next;
    }
    case "new": {
      // The chosen project stays selected: a new conversation usually continues on the same project.
      const next: State = { ...state, messages: [] };
      delete next.activeId;
      delete next.thinkingMode;
      delete next.error;
      return next;
    }
    case "setProject": {
      const next: State = { ...state };
      if (action.projectId) next.projectId = action.projectId;
      else delete next.projectId;
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
      if (m.wake) voice.wake = true;
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
    case "chat.tool": {
      if (state.streaming?.turnId !== m.turnId) return state;
      return {
        ...state,
        messages: updateLastAssistant(state.messages, (a) => {
          const tools = [...(a.tools ?? [])];
          const i = tools.findLastIndex((t) => t.summary === m.summary && (t.status === "started" || t.status === "waiting"));
          if (m.status !== "started" && i !== -1) tools[i] = { summary: m.summary, status: m.status };
          else tools.push({ summary: m.summary, status: m.status });
          return { ...a, tools };
        }),
      };
    }
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
    case "conversations.list.result": {
      const next: State = { ...state, conversations: m.conversations };
      const active = state.activeId ? m.conversations.find((c) => c.id === state.activeId) : undefined;
      if (active) {
        if (active.projectId) next.projectId = active.projectId;
        else delete next.projectId;
      }
      return next;
    }
    case "conversations.history": {
      if (m.conversationId !== state.activeId || state.streaming) return state;
      const next: State = { ...state, messages: m.messages.map((x) => ({ ...x, pending: false })) };
      if (m.projectId) next.projectId = m.projectId;
      else delete next.projectId;
      if (m.thinkingMode) next.thinkingMode = m.thinkingMode;
      else delete next.thinkingMode;
      return next;
    }
    case "projects.list.result": {
      const next: State = { ...state, projects: m.projects };
      if (state.projectId && !m.projects.some((p) => p.id === state.projectId)) delete next.projectId;
      return next;
    }
    case "audit.list.result":
      return { ...state, audit: m.entries };
    case "proactive.state": {
      const { type: _type, id: _id, ...proactive } = m;
      return { ...state, proactive };
    }
    case "dashboard.result": {
      const { type: _type, id: _id, ...dashboard } = m;
      return { ...state, dashboard };
    }
    case "memory.list.result": {
      const next: State = {
        ...state,
        memory: { enabled: m.enabled, memories: m.memories, proposals: m.proposals, ...(m.acceptance ? { acceptance: m.acceptance } : {}) },
      };
      const notice = m.reflection ?? (m.removed !== undefined ? `Borré ${m.removed} ${m.removed === 1 ? "recuerdo" : "recuerdos"}.` : undefined);
      if (notice) next.memoryNotice = notice;
      else delete next.memoryNotice;
      return next;
    }
    case "builder.list.result":
      return { ...state, builder: m.tasks };
    case "builder.task":
      return { ...state, builder: [m.task, ...(state.builder ?? []).filter((t) => t.id !== m.task.id)] };
    case "audit.exported":
      return { ...state, auditExport: { path: m.path, count: m.count } };
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
