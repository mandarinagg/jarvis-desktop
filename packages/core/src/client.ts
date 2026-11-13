/** Client side of the Core IPC, shared by the desktop UI, the CLI and tests. */
import { EventEmitter } from "node:events";
import net from "node:net";
import {
  type ClientMessage,
  type CoreMessage,
  LineDecoder,
  PROTOCOL_VERSION,
  encodeLine,
  parseCoreMessage,
} from "@jarvis/shared";

export interface ConnectOptions {
  pipe: string;
  token: string;
  client: "desktop" | "cli" | "voice";
  timeoutMs?: number;
  protocolVersion?: string;
}

export class CoreConnectionError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CoreConnectionError";
  }
}

interface CoreClientEvents {
  message: [CoreMessage];
  close: [];
}

export class CoreClient extends EventEmitter<CoreClientEvents> {
  private constructor(
    private readonly socket: net.Socket,
    readonly coreVersion: string,
  ) {
    super();
  }

  static connect(opts: ConnectOptions): Promise<CoreClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(opts.pipe);
      const decoder = new LineDecoder();
      let client: CoreClient | undefined;
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        settle(() => reject(new CoreConnectionError("timed out connecting to Jarvis Core")));
        socket.destroy();
      }, opts.timeoutMs ?? 5_000);

      socket.on("connect", () => {
        const hello: ClientMessage = {
          type: "auth.hello",
          id: "hello",
          token: opts.token,
          protocolVersion: opts.protocolVersion ?? PROTOCOL_VERSION,
          client: opts.client,
        };
        socket.write(encodeLine(hello));
      });
      socket.on("data", (chunk: Buffer) => {
        for (const line of decoder.push(chunk)) {
          const parsed = parseCoreMessage(line);
          if (!parsed.ok) continue; // a misbehaving Core must not crash the client
          const msg = parsed.message;
          if (client) {
            client.emit("message", msg);
          } else if (msg.type === "auth.ok") {
            const ready = new CoreClient(socket, msg.coreVersion);
            client = ready;
            settle(() => resolve(ready));
          } else {
            const err =
              msg.type === "error"
                ? new CoreConnectionError(msg.message, msg.code)
                : new CoreConnectionError(`unexpected reply ${msg.type}`);
            settle(() => reject(err));
            socket.destroy();
          }
        }
      });
      socket.on("error", (err) => {
        settle(() => reject(new CoreConnectionError(`cannot reach Jarvis Core: ${err.message}`)));
      });
      socket.on("close", () => {
        settle(() => reject(new CoreConnectionError("Jarvis Core closed the connection")));
        client?.emit("close");
      });
    });
  }

  send(message: ClientMessage): void {
    this.socket.write(encodeLine(message));
  }

  /** Resolves with the first message matching `predicate`; rejects on timeout or disconnect. */
  waitFor<T extends CoreMessage>(predicate: (m: CoreMessage) => m is T, timeoutMs = 5_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const onMessage = (m: CoreMessage) => {
        if (!predicate(m)) return;
        cleanup();
        resolve(m);
      };
      const onClose = () => {
        cleanup();
        reject(new CoreConnectionError("connection closed"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new CoreConnectionError("timed out waiting for Jarvis Core"));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off("message", onMessage);
        this.off("close", onClose);
      };
      this.on("message", onMessage);
      this.on("close", onClose);
    });
  }

  close(): void {
    this.socket.end();
  }
}
