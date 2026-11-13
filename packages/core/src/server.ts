/**
 * Core IPC server (ADR-008): named pipe, JSON Lines, every message validated with Zod,
 * first message must be `auth.hello` with the per-session token.
 */
import { randomUUID } from "node:crypto";
import net from "node:net";
import {
  type BudgetGet,
  type ChatCancel,
  type ChatSend,
  type ConversationsGet,
  type ConversationsList,
  type ClientMessage,
  type CoreMessage,
  FrameTooLargeError,
  LineDecoder,
  encodeLine,
  isCompatibleVersion,
  parseClientMessage,
} from "@jarvis/shared";
import { type Logger, silentLogger } from "./log.js";
import { tokensMatch } from "./token.js";

export class AlreadyRunningError extends Error {
  constructor(pipe: string) {
    super(`Jarvis Core is already running on ${pipe}`);
    this.name = "AlreadyRunningError";
  }
}

export interface Session {
  readonly id: string;
  readonly client: string;
  send(message: CoreMessage): void;
  close(): void;
}

export interface Handlers {
  chatSend?(session: Session, message: ChatSend): void | Promise<void>;
  chatCancel?(session: Session, message: ChatCancel): void | Promise<void>;
  shutdown?(session: Session): void | Promise<void>;
  conversationsList?(session: Session, message: ConversationsList): void;
  conversationsGet?(session: Session, message: ConversationsGet): void;
  budgetGet?(session: Session, message: BudgetGet): void;
  disconnected?(session: Session): void;
}

export interface CoreServerOptions {
  pipe: string;
  token: string;
  coreVersion: string;
  handlers?: Handlers;
  logger?: Logger;
  authTimeoutMs?: number;
  maxClients?: number;
}

type FailCode = "unauthenticated" | "incompatible_version" | "invalid_message";

export class CoreServer {
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private readonly handlers: Handlers;
  private readonly logger: Logger;
  private readonly authTimeoutMs: number;
  private readonly maxClients: number;

  constructor(private readonly options: CoreServerOptions) {
    this.handlers = options.handlers ?? {};
    this.logger = options.logger ?? silentLogger;
    this.authTimeoutMs = options.authTimeoutMs ?? 5_000;
    this.maxClients = options.maxClients ?? 8;
    this.server = net.createServer((socket) => this.accept(socket));
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        this.server.off("listening", onListening);
        reject(err.code === "EADDRINUSE" ? new AlreadyRunningError(this.options.pipe) : err);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.options.pipe);
    });
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get clientCount(): number {
    return this.sockets.size;
  }

  private accept(socket: net.Socket): void {
    const log = this.logger;
    if (this.sockets.size >= this.maxClients) {
      log.log("warn", "ipc.reject.max_clients");
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    const decoder = new LineDecoder();
    let session: Session | undefined;
    let closing = false;

    const write = (message: CoreMessage) => {
      if (!closing && !socket.destroyed && socket.writable) socket.write(encodeLine(message));
    };
    const fail = (code: FailCode, message: string) => {
      write({ type: "error", code, message });
      closing = true;
      socket.end();
    };

    const authTimer = setTimeout(() => {
      log.log("warn", "ipc.auth.timeout");
      fail("unauthenticated", "auth.hello not received in time");
    }, this.authTimeoutMs);

    socket.on("data", (chunk: Buffer) => {
      if (closing) return;
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (err) {
        if (!(err instanceof FrameTooLargeError)) throw err;
        log.log("warn", "ipc.frame_too_large");
        fail("invalid_message", err.message);
        return;
      }
      for (const line of lines) {
        if (closing) return;
        const parsed = parseClientMessage(line);
        if (!session) {
          if (!parsed.ok || parsed.message.type !== "auth.hello") {
            log.log("warn", "ipc.auth.missing");
            fail("unauthenticated", "first message must be a valid auth.hello");
            return;
          }
          const hello = parsed.message;
          if (!isCompatibleVersion(hello.protocolVersion)) {
            fail("incompatible_version", `unsupported protocol version ${hello.protocolVersion}`);
            return;
          }
          if (!tokensMatch(this.options.token, hello.token)) {
            log.log("warn", "ipc.auth.bad_token", { client: hello.client });
            fail("unauthenticated", "authentication failed");
            return;
          }
          clearTimeout(authTimer);
          session = { id: randomUUID(), client: hello.client, send: write, close: () => socket.end() };
          log.log("info", "ipc.auth.ok", { session: session.id, client: hello.client });
          write({ type: "auth.ok", id: hello.id, coreVersion: this.options.coreVersion });
          continue;
        }
        if (!parsed.ok) {
          log.log("warn", "ipc.invalid_message", { session: session.id, code: parsed.code });
          write({ type: "error", code: parsed.code, message: parsed.message });
          continue;
        }
        void this.dispatch(session, parsed.message);
      }
    });

    socket.on("error", (err) => log.log("debug", "ipc.socket_error", { error: err.message }));
    socket.on("close", () => {
      clearTimeout(authTimer);
      this.sockets.delete(socket);
      if (session) this.handlers.disconnected?.(session);
    });
  }

  /** Read-only queries: answered by the handler, or reported as unavailable. */
  private query<M extends ClientMessage>(
    session: Session,
    message: M,
    handler: ((session: Session, message: M) => void) | undefined,
  ): void {
    if (handler) return handler(session, message);
    session.send({ type: "error", id: message.id, code: "upstream_error", message: `${message.type} is not available` });
  }

  private async dispatch(session: Session, message: ClientMessage): Promise<void> {
    const h = this.handlers;
    try {
      switch (message.type) {
        case "core.ping":
          session.send({ type: "core.pong", id: message.id });
          return;
        case "auth.hello":
          session.send({ type: "error", id: message.id, code: "invalid_message", message: "already authenticated" });
          return;
        case "chat.send":
          if (!h.chatSend) {
            session.send({ type: "error", id: message.id, code: "upstream_error", message: "chat is not available" });
            return;
          }
          await h.chatSend(session, message);
          return;
        case "chat.cancel":
          await h.chatCancel?.(session, message);
          return;
        case "core.shutdown":
          await h.shutdown?.(session);
          return;
        case "conversations.list":
          return this.query(session, message, h.conversationsList);
        case "conversations.get":
          return this.query(session, message, h.conversationsGet);
        case "budget.get":
          return this.query(session, message, h.budgetGet);
      }
    } catch (err) {
      this.logger.log("error", "ipc.handler_failed", {
        type: message.type,
        error: err instanceof Error ? err.message : String(err),
      });
      session.send({ type: "error", id: message.id, code: "internal", message: "internal error" });
    }
  }
}
