/**
 * Claude adapter (ADR-005, docs/CLAUDE_API.md): official SDK only, streaming always,
 * cancellation through AbortSignal, SDK retries for 408/409/429/5xx, cached system prompt,
 * server-side refusal fallbacks.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Usage } from "@jarvis/shared";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ChatTurnRequest {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  signal: AbortSignal;
  onText: (delta: string) => void;
}

export interface ChatTurnResult {
  text: string;
  stopReason: string;
  /** Model that actually served the turn (a refusal fallback may differ from the requested one). */
  model: string;
  usage: Usage;
}

export interface ChatModel {
  readonly model: string;
  complete(req: ChatTurnRequest): Promise<ChatTurnResult>;
}

/** Thrown when the caller aborted the turn (chat.cancel / barge-in). */
export class TurnCancelledError extends Error {
  constructor(readonly partialText: string) {
    super("turn cancelled");
    this.name = "TurnCancelledError";
  }
}

/** API failure with a message that is safe to show and log (never contains the key). */
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface AnthropicChatModelOptions {
  apiKey: string;
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

export class AnthropicChatModel implements ChatModel {
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: Effort;
  private readonly maxTokens: number;

  constructor(opts: AnthropicChatModelOptions) {
    this.model = opts.model ?? "claude-opus-5-5";
    this.effort = opts.effort ?? "low";
    this.maxTokens = opts.maxTokens ?? 16_000;
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      timeout: opts.timeoutMs ?? 120_000,
      maxRetries: opts.maxRetries ?? 2,
    });
  }

  async complete(req: ChatTurnRequest): Promise<ChatTurnResult> {
    let text = "";
    try {
      const stream = this.client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          // Stable prefix first so it is cached across turns (CLAUDE_API.md §3).
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          messages: req.messages,
          cache_control: { type: "ephemeral" }, // also cache the growing conversation history
          output_config: { effort: this.effort },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal: req.signal },
      );
      stream.on("text", (delta) => {
        text += delta;
        req.onText(delta);
      });
      const message = await stream.finalMessage();
      const u = message.usage;
      return {
        text,
        stopReason: message.stop_reason ?? "unknown",
        model: message.model,
        usage: {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        },
      };
    } catch (err) {
      if (req.signal.aborted || err instanceof Anthropic.APIUserAbortError) throw new TurnCancelledError(text);
      throw toUpstreamError(err);
    }
  }
}

export function toUpstreamError(err: unknown): UpstreamError {
  if (err instanceof Anthropic.AuthenticationError) return new UpstreamError("La API key de Anthropic es inválida o fue revocada.", 401);
  if (err instanceof Anthropic.PermissionDeniedError) return new UpstreamError("La API key no tiene permiso para este modelo.", 403);
  if (err instanceof Anthropic.RateLimitError) return new UpstreamError("Límite de uso de la API alcanzado; probá en un rato.", 429, true);
  if (err instanceof Anthropic.BadRequestError) return new UpstreamError("La API rechazó el pedido (400).", 400);
  if (err instanceof Anthropic.APIConnectionError) return new UpstreamError("No hay conexión con la API de Anthropic.", undefined, true);
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : undefined;
    return new UpstreamError(`Error de la API de Anthropic${status ? ` (${status})` : ""}.`, status, (status ?? 0) >= 500);
  }
  return new UpstreamError("Error inesperado hablando con Claude.");
}
