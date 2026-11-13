import { randomUUID } from "node:crypto";
import net from "node:net";
import { type CoreMessage, LineDecoder, MAX_LINE_BYTES, PROTOCOL_VERSION, encodeLine } from "@jarvis/shared";
import { afterEach, describe, expect, it } from "vitest";
import { CoreClient, CoreConnectionError } from "./client.js";
import { type Logger } from "./log.js";
import { AlreadyRunningError, CoreServer, type Handlers } from "./server.js";
import { newSessionToken } from "./token.js";

const servers: CoreServer[] = [];
const pipe = () => `\\\\.\\pipe\\jarvis-test-${randomUUID()}`;

async function start(handlers: Handlers = {}, extra: { authTimeoutMs?: number; logger?: Logger } = {}) {
  const opts = { pipe: pipe(), token: newSessionToken(), coreVersion: "0.0.0-test", handlers, ...extra };
  const server = new CoreServer(opts);
  await server.listen();
  servers.push(server);
  return opts;
}

/** Raw socket that collects every Core message, for protocol-level assertions. */
function rawConnect(pipeName: string) {
  const socket = net.connect(pipeName);
  const decoder = new LineDecoder();
  const received: CoreMessage[] = [];
  const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
  socket.on("data", (c: Buffer) => decoder.push(c).forEach((l) => received.push(JSON.parse(l))));
  socket.on("error", () => {});
  return { socket, received, closed };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("CoreServer authentication", () => {
  it("accepts the right token and answers ping", async () => {
    const { pipe, token } = await start();
    const client = await CoreClient.connect({ pipe, token, client: "cli" });
    expect(client.coreVersion).toBe("0.0.0-test");
    client.send({ type: "core.ping", id: "p1" });
    const pong = await client.waitFor((m): m is Extract<CoreMessage, { type: "core.pong" }> => m.type === "core.pong");
    expect(pong.id).toBe("p1");
    client.close();
  });

  it("rejects a wrong token and closes the connection", async () => {
    const { pipe } = await start();
    await expect(CoreClient.connect({ pipe, token: newSessionToken(), client: "cli" })).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  it("rejects an incompatible protocol major version", async () => {
    const { pipe, token } = await start();
    await expect(CoreClient.connect({ pipe, token, client: "cli", protocolVersion: "2.0" })).rejects.toMatchObject({
      code: "incompatible_version",
    });
  });

  it("closes connections whose first message is not auth.hello", async () => {
    const { pipe } = await start();
    const c = rawConnect(pipe);
    c.socket.write(encodeLine({ type: "core.ping", id: "1" }));
    await c.closed;
    expect(c.received).toEqual([expect.objectContaining({ type: "error", code: "unauthenticated" })]);
  });

  it("closes silent connections after the auth timeout", async () => {
    const { pipe } = await start({}, { authTimeoutMs: 100 });
    const c = rawConnect(pipe);
    await c.closed;
    expect(c.received[0]).toMatchObject({ type: "error", code: "unauthenticated" });
  });

  it("does not log the token when authentication fails", async () => {
    const lines: string[] = [];
    const logger: Logger = { log: (level, msg, fields) => lines.push(JSON.stringify({ level, msg, fields })) };
    const { pipe } = await start({}, { logger });
    const wrong = newSessionToken();
    await CoreClient.connect({ pipe, token: wrong, client: "cli" }).catch(() => {});
    expect(lines.join("\n")).not.toContain(wrong);
  });
});

describe("CoreServer after authentication", () => {
  it("reports invalid messages without dropping the connection", async () => {
    const { pipe, token } = await start();
    const c = rawConnect(pipe);
    c.socket.write(
      encodeLine({ type: "auth.hello", id: "h", token, protocolVersion: PROTOCOL_VERSION, client: "cli" }) +
        "{not json\n" +
        encodeLine({ type: "fs.delete", id: "x" }) +
        encodeLine({ type: "core.ping", id: "after" }),
    );
    await expect.poll(() => c.received.length).toBe(4);
    expect(c.received.map((m) => m.type)).toEqual(["auth.ok", "error", "error", "core.pong"]);
    c.socket.destroy();
  });

  it("drops the connection when a frame exceeds the size limit", async () => {
    const { pipe, token } = await start();
    const c = rawConnect(pipe);
    c.socket.write(encodeLine({ type: "auth.hello", id: "h", token, protocolVersion: PROTOCOL_VERSION, client: "cli" }));
    c.socket.write("x".repeat(MAX_LINE_BYTES + 10));
    await c.closed;
    expect(c.received.at(-1)).toMatchObject({ type: "error", code: "invalid_message" });
  });

  it("routes chat.send to the handler and reports a missing handler", async () => {
    const seen: string[] = [];
    const { pipe, token } = await start({
      chatSend: (session, msg) => {
        seen.push(msg.text);
        session.send({ type: "chat.started", id: msg.id, turnId: "t1", conversationId: "c1" });
      },
    });
    const client = await CoreClient.connect({ pipe, token, client: "desktop" });
    client.send({ type: "chat.send", id: "m1", text: "hola" });
    await client.waitFor((m): m is Extract<CoreMessage, { type: "chat.started" }> => m.type === "chat.started");
    expect(seen).toEqual(["hola"]);
    client.close();

    const bare = await start();
    const c2 = await CoreClient.connect({ pipe: bare.pipe, token: bare.token, client: "cli" });
    c2.send({ type: "chat.send", id: "m2", text: "hola" });
    const err = await c2.waitFor((m): m is Extract<CoreMessage, { type: "error" }> => m.type === "error");
    expect(err).toMatchObject({ id: "m2", code: "upstream_error" });
    c2.close();
  });

  it("turns handler exceptions into an internal error for that request", async () => {
    const { pipe, token } = await start({
      chatSend: () => {
        throw new Error("boom");
      },
    });
    const client = await CoreClient.connect({ pipe, token, client: "cli" });
    client.send({ type: "chat.send", id: "m1", text: "hola" });
    const err = await client.waitFor((m): m is Extract<CoreMessage, { type: "error" }> => m.type === "error");
    expect(err).toMatchObject({ id: "m1", code: "internal", message: "internal error" });
    client.close();
  });
});

describe("single instance", () => {
  it("a second server on the same pipe fails with AlreadyRunningError", async () => {
    const { pipe: name, token } = await start();
    const second = new CoreServer({ pipe: name, token, coreVersion: "x" });
    await expect(second.listen()).rejects.toBeInstanceOf(AlreadyRunningError);
  });

  it("connecting when no Core is running fails cleanly", async () => {
    await expect(CoreClient.connect({ pipe: pipe(), token: newSessionToken(), client: "cli" })).rejects.toBeInstanceOf(
      CoreConnectionError,
    );
  });
});
