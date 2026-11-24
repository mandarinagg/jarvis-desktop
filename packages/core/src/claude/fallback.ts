/**
 * Backup model through a local OmniRoute (ADR-031). Used only when Claude can't answer: the daily
 * cap was reached or the API failed before any text arrived. Same official SDK (`@anthropic-ai/sdk`)
 * pointed at OmniRoute's Anthropic-compatible `/v1/messages`, which routes to the providers the
 * owner configured in the combo (free tiers such as Gemini). OmniRoute listens on loopback only and
 * requires its API key.
 *
 * The backup model has not passed Jarvis' safety evals, so it gets read tools only (`readOnlyTools`):
 * no writes, no Builder, no memory changes, no reminders. Every call still goes through the gate.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Usage } from "@jarvis/shared";
import type { ToolRuntime } from "../tools/hub.js";
import type { Risk } from "../tools/permissions.js";
import { type ChatModel, type ChatTurnRequest, type ChatTurnResult, MAX_TOOL_ROUNDS, TurnCancelledError, UpstreamError } from "./model.js";

/** OmniRoute's default port, loopback only (never a LAN address: the turn carries personal data). */
export const DEFAULT_FALLBACK_URL = "http://127.0.0.1:20128";
/** The combo the owner creates in OmniRoute. Never `auto`: that could pick any connected provider. */
export const DEFAULT_FALLBACK_MODEL = "jarvis-fallback";
/** Shown (and spoken) before a backup answer, so the owner always knows who is answering. */
export const FALLBACK_NOTICE = "(Respaldo: Claude no está disponible ahora, te respondo con otro modelo y sin acciones.)\n\n";
/** Prefix for the model recorded in usage: the cost is not Anthropic's, it's tracked in OmniRoute. */
export const FALLBACK_MODEL_PREFIX = "omniroute:";

/** Only loopback URLs are accepted: a typo must not send the conversation to another machine. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

/** The subset of tools the backup model may use: read risk only, everything else is hidden and refused. */
export function readOnlyTools(tools: ToolRuntime, riskOf: (name: string) => Risk | undefined): ToolRuntime {
  const allowed = (name: string) => riskOf(name) === "read";
  return {
    definitions: () => tools.definitions().filter((t) => allowed(t.name)),
    describe: (name, input) => tools.describe(name, input),
    call: (name, input, ctx) =>
      allowed(name)
        ? tools.call(name, input, ctx)
        : Promise.resolve({ content: "Permiso denegado: en modo respaldo solo hay herramientas de lectura.", isError: true }),
  };
}

export interface FallbackChatModelOptions {
  apiKey: string;
  baseURL?: string | undefined;
  model?: string | undefined;
  maxTokens?: number;
  timeoutMs?: number;
  /** Maps a tool name to its risk class (Permission Engine). */
  riskOf: (name: string) => Risk | undefined;
  /** Tests only. */
  client?: Anthropic;
}

export class FallbackChatModel implements ChatModel {
  readonly model: string;
  private readonly client: Anthropic;
  private readonly maxTokens: number;
  private readonly riskOf: (name: string) => Risk | undefined;

  constructor(opts: FallbackChatModelOptions) {
    const baseURL = opts.baseURL ?? DEFAULT_FALLBACK_URL;
    if (!isLoopbackUrl(baseURL)) throw new Error("el respaldo solo puede apuntar a localhost");
    this.model = opts.model ?? DEFAULT_FALLBACK_MODEL;
    this.maxTokens = opts.maxTokens ?? 4_000;
    this.riskOf = opts.riskOf;
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, baseURL, timeout: opts.timeoutMs ?? 90_000, maxRetries: 1 });
  }

  async complete(req: ChatTurnRequest): Promise<ChatTurnResult> {
    let text = "";
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const tools = req.tools ? readOnlyTools(req.tools, this.riskOf) : undefined;
    const definitions = (tools?.definitions() ?? []) as unknown as Anthropic.Tool[];
    // Plain Messages API: no betas, effort or cache_control, which a translated provider may reject.
    const system = req.systemSuffix ? `${req.system}\n\n${req.systemSuffix}` : req.system;
    const messages: Anthropic.MessageParam[] = req.messages.map((m) => ({ role: m.role, content: m.content }));
    let stopReason: string;
    let model: string;
    try {
      for (let round = 0; ; round++) {
        const lastRound = round >= MAX_TOOL_ROUNDS;
        const stream = this.client.messages.stream(
          {
            model: this.model,
            max_tokens: this.maxTokens,
            system,
            messages,
            ...(definitions.length && !lastRound ? { tools: definitions } : {}),
          },
          { signal: req.signal },
        );
        stream.on("text", (delta) => {
          text += delta;
          req.onText(delta);
        });
        const message = await stream.finalMessage();
        usage.inputTokens += message.usage?.input_tokens ?? 0;
        usage.outputTokens += message.usage?.output_tokens ?? 0;
        model = message.model || this.model;
        stopReason = message.stop_reason ?? "unknown";
        const uses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        if (message.stop_reason !== "tool_use" || !uses.length || !tools) break;
        messages.push({ role: "assistant", content: message.content as Anthropic.ContentBlockParam[] });
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const use of uses) {
          const summary = tools.describe(use.name, use.input);
          req.onTool?.({ name: use.name, summary, status: "started" });
          const r = await tools.call(use.name, use.input, { turnId: req.turnId, channel: req.channel, signal: req.signal });
          req.onTool?.({ name: use.name, summary, status: !r.isError ? "done" : r.content.startsWith("Permiso denegado") ? "denied" : "error" });
          results.push({ type: "tool_result", tool_use_id: use.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
        }
        messages.push({ role: "user", content: results });
      }
      return { text, stopReason, model: `${FALLBACK_MODEL_PREFIX}${model}`, usage };
    } catch (err) {
      if (req.signal.aborted || err instanceof Anthropic.APIUserAbortError) throw new TurnCancelledError(text);
      if (err instanceof Anthropic.APIConnectionError) throw new UpstreamError("El respaldo (OmniRoute) no está corriendo.", undefined, false);
      if (err instanceof Anthropic.AuthenticationError) throw new UpstreamError("La API key de OmniRoute es inválida.", 401);
      if (err instanceof Anthropic.APIError) throw new UpstreamError(`El respaldo (OmniRoute) falló${err.status ? ` (${err.status})` : ""}.`, err.status);
      throw new UpstreamError("Error inesperado en el modelo de respaldo.");
    }
  }
}

/** Claude failed in a way a backup can cover: no credit left, rate limits, overload, server errors, no connection. */
export function fallbackWorthy(err: unknown): boolean {
  if (!(err instanceof UpstreamError)) return false;
  return err.kind === "billing" || err.retryable || err.status === 529 || err.status === 503;
}
