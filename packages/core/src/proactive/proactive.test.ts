import type { CoreMessage, PermissionRequest } from "@jarvis/shared";
import { describe, expect, it } from "vitest";
import { localDay, openDatabase } from "../db.js";
import { MemoryStore } from "../memory/store.js";
import type { Session } from "../server.js";
import { ConfirmationBroker } from "../tools/confirm.js";
import { ToolHub } from "../tools/hub.js";
import { AuditLog, PermissionEngine } from "../tools/permissions.js";
import { REMINDERS_SERVER, REMINDERS_TOOLS, createRemindersServer, remindersPreviews } from "../tools/reminders-server.js";
import { composeBriefing } from "./briefing.js";
import { briefingDue, inQuietHours, nowLine, whenLabel } from "./schedule.js";
import { Proactive } from "./service.js";
import { DEFAULT_SETTINGS, ProactiveStore } from "./store.js";

const at = (h: number, m = 0, day = 20) => new Date(2026, 10, day, h, m); // November 2026, local

function world(start = at(10)) {
  const db = openDatabase(":memory:");
  const clock = { now: start };
  const store = new ProactiveStore(db, () => clock.now);
  const sent: CoreMessage[] = [];
  const desktop = { connected: true };
  const proactive = new Proactive({ db, store, broadcast: (m) => sent.push(m), canNotify: () => desktop.connected, dailyBudgetUsd: 3, now: () => clock.now });
  const notes = () => sent.filter((m): m is Extract<CoreMessage, { type: "proactive.notify" }> => m.type === "proactive.notify");
  return { db, clock, store, proactive, sent, notes, desktop };
}

describe("schedule rules", () => {
  it("quiet hours may cross midnight", () => {
    const q = { start: "22:00", end: "08:00" };
    expect(inQuietHours(at(23), q)).toBe(true);
    expect(inQuietHours(at(3), q)).toBe(true);
    expect(inQuietHours(at(8), q), "the end is exclusive").toBe(false);
    expect(inQuietHours(at(12), q)).toBe(false);
    expect(inQuietHours(at(13), { start: "13:00", end: "14:00" })).toBe(true);
    expect(inQuietHours(at(3), null)).toBe(false);
  });

  it("the briefing is due once its time passed, once a day, and never when off", () => {
    expect(briefingDue(at(7, 59), "08:00", false)).toBe(false);
    expect(briefingDue(at(8, 0), "08:00", false)).toBe(true);
    expect(briefingDue(at(15), "08:00", true)).toBe(false);
    expect(briefingDue(at(15), null, false)).toBe(false);
  });

  it("labels times for people and tells the model the local time with its offset", () => {
    const now = at(10);
    expect(whenLabel(at(15).toISOString(), now)).toBe("hoy 15:00");
    expect(whenLabel(at(9, 30, 21).toISOString(), now)).toBe("mañana 09:30");
    expect(whenLabel(at(9, 0, 24).toISOString(), now)).toMatch(/^martes 24\/11 09:00$/);
    expect(nowLine(now)).toMatch(/^Ahora es viernes, 20 de noviembre de 2026, 10:00 \(hora local del owner, UTC[+-]\d\d:\d\d\)\.$/);
  });
});

describe("settings", () => {
  it("briefing off and quiet 22:00-08:00 by default; the owner changes or clears them", () => {
    const { store } = world();
    expect(store.settings()).toEqual(DEFAULT_SETTINGS);
    expect(store.setSettings({ briefingTime: "07:30" })).toEqual({ briefingTime: "07:30", quietHours: { start: "22:00", end: "08:00" } });
    expect(store.setSettings({ quietHours: null }).quietHours).toBeNull();
    expect(store.setSettings({ briefingTime: null }).briefingTime).toBeNull();
  });
});

describe("Proactive.tick", () => {
  it("fires due reminders once, as plain notifications, and updates the clients", () => {
    const w = world(at(10));
    w.store.addReminder({ text: "Llamar a Juan", dueAt: at(10, 30).toISOString() });
    w.proactive.tick();
    expect(w.notes()).toHaveLength(0);
    w.clock.now = at(10, 31);
    w.proactive.tick();
    w.proactive.tick();
    expect(w.notes()).toEqual([{ type: "proactive.notify", kind: "reminder", title: "Recordatorio", body: "Llamar a Juan" }]);
    expect(w.sent.at(-1)).toMatchObject({ type: "proactive.state", reminders: [] });
  });

  it("holds everything during quiet hours and says when a late reminder was for", () => {
    const w = world(at(23));
    w.store.addReminder({ text: "Sacar la basura", dueAt: at(23, 15).toISOString() });
    w.clock.now = at(23, 30);
    w.proactive.tick();
    w.clock.now = at(7, 59, 21);
    w.proactive.tick();
    expect(w.notes()).toHaveLength(0);
    w.clock.now = at(8, 0, 21);
    w.proactive.tick();
    expect(w.notes()[0]?.body).toBe("Sacar la basura\n(era para ayer 23:15)".replace("ayer 23:15", whenLabel(at(23, 15).toISOString(), at(8, 0, 21))));
  });

  it("waits for a desktop window to show anything", () => {
    const w = world(at(10));
    w.store.addReminder({ text: "Pagar el monotributo", dueAt: at(9).toISOString() });
    w.desktop.connected = false;
    w.proactive.tick();
    expect(w.store.pending()).toHaveLength(1);
    w.desktop.connected = true;
    w.proactive.tick();
    expect(w.store.pending()).toHaveLength(0);
  });

  it("composes the briefing once a day at the owner's time, without a model", () => {
    const w = world(at(7));
    w.store.setSettings({ briefingTime: "08:00" });
    w.store.addReminder({ text: "Reunión con el contador", dueAt: at(16).toISOString() });
    w.store.addReminder({ text: "Mañana no", dueAt: at(16, 0, 21).toISOString() });
    new MemoryStore(w.db).addProposal({ kind: "fact", text: "Usa SQLite", reason: "lo dijo" });
    w.proactive.tick();
    w.clock.now = at(8, 5);
    w.proactive.tick();
    w.proactive.tick();
    const briefings = w.notes().filter((n) => n.kind === "briefing");
    expect(briefings).toHaveLength(1);
    expect(briefings[0]?.body).toContain("Recordatorios de hoy: 16:00 Reunión con el contador.");
    expect(briefings[0]?.body).not.toContain("Mañana no");
    expect(briefings[0]?.body).toContain("Esperan tu OK: 1 propuesta de memoria.");
    expect(w.store.briefing(localDay(at(8, 5)))?.text).toBe(briefings[0]?.body);
    expect(w.proactive.state()).toMatchObject({ briefing: { day: "2026-11-20" } });
  });

  it("the briefing mentions overdue reminders and yesterday's spend", () => {
    const w = world(at(9));
    w.store.addReminder({ text: "Renovar el dominio", dueAt: at(18, 0, 19).toISOString() });
    const text = composeBriefing(w.db, w.store, at(9), 3);
    expect(text).toContain("No tenés recordatorios para hoy.");
    expect(text).toContain("Pendientes de antes: Renovar el dominio.");
    expect(text).toContain("Ayer gastaste US$ 0,00; en el mes, US$ 0,00.");
  });
});

describe("Proactive.handle", () => {
  it("saves rules and cancels reminders for the owner's clients", () => {
    const w = world();
    const r = w.store.addReminder({ text: "Algo", dueAt: at(12).toISOString() });
    const replies: CoreMessage[] = [];
    const s: Session = { id: "s", client: "desktop", send: (m) => replies.push(m), close: () => {} };
    w.proactive.handle(s, { type: "proactive.set", id: "a", briefingTime: "08:30", quietHours: { start: "23:00", end: "07:00" } });
    w.proactive.handle(s, { type: "reminders.cancel", id: "b", reminderId: r.id });
    expect(replies.at(-1)).toMatchObject({ type: "proactive.state", id: "b", settings: { briefingTime: "08:30", quietHours: { start: "23:00", end: "07:00" } }, reminders: [] });
    expect(w.sent.some((m) => m.type === "proactive.state" && !("id" in m))).toBe(true);
  });
});

function hubFor(w: ReturnType<typeof world>, answer: "approve" | "reject" = "approve") {
  const requests: PermissionRequest[] = [];
  const desktop: Session = {
    id: "d",
    client: "desktop",
    close: () => {},
    send: (m: CoreMessage) => {
      if (m.type !== "permission.request") return;
      requests.push(m);
      queueMicrotask(() => broker.respond(desktop, { type: "permission.respond", id: "x", requestId: m.requestId, approved: answer === "approve", confirmations: answer === "approve" ? 1 : 0 }));
    },
  };
  const broker = new ConfirmationBroker({ sessions: () => [desktop] });
  const hub = new ToolHub(new PermissionEngine(), new AuditLog(w.db), undefined, broker);
  const deps = { store: w.store, briefing: () => w.proactive.briefingNow(), conversationOfTurn: () => undefined, now: () => w.clock.now };
  return { hub, requests, ready: hub.addInProcess(REMINDERS_SERVER, createRemindersServer(deps), REMINDERS_TOOLS, remindersPreviews(deps)) };
}

describe("reminder tools through the hub", () => {
  it("creates a reminder only with the owner's OK on the exact text and time", async () => {
    const w = world(at(10));
    const { hub, requests, ready } = hubFor(w);
    await ready;
    const r = await hub.call("reminders__create_reminder", { text: "Llamar a Juan por el presupuesto", when: at(9, 0, 21).toISOString() }, {});
    expect(r.content).toMatch(/^Listo: recordatorio #\d+ para mañana 09:00\./);
    expect(requests[0]).toMatchObject({ title: "Recordatorio para mañana 09:00", risk: "confirm" });
    expect(requests[0]?.detail).toContain("Llamar a Juan por el presupuesto");
    expect(w.store.pending()).toHaveLength(1);

    const list = await hub.call("reminders__list_reminders", {}, {});
    expect(list.content).toMatch(/#\d+ mañana 09:00: Llamar a Juan/);
    expect(requests).toHaveLength(1);
  });

  it("refuses past times, far-away dates and secrets before asking; a rejection creates nothing", async () => {
    const w = world(at(10));
    const { hub, requests, ready } = hubFor(w);
    await ready;
    const past = await hub.call("reminders__create_reminder", { text: "Algo de ayer", when: at(9, 0, 19).toISOString() }, {});
    expect(past.content).toMatch(/No lo hice: esa hora ya pasó/);
    const far = await hub.call("reminders__create_reminder", { text: "Algo lejano", when: new Date(2028, 0, 1).toISOString() }, {});
    expect(far.content).toMatch(/más de un año/);
    const secret = await hub.call("reminders__create_reminder", { text: "La clave del banco es hunter22", when: at(12).toISOString() }, {});
    expect(secret.content).toMatch(/No lo hice: no pongo eso/);
    expect(requests).toHaveLength(0);

    const rejected = hubFor(world(at(10)), "reject");
    await rejected.ready;
    const no = await rejected.hub.call("reminders__create_reminder", { text: "Pagar a Hosting Rápido", when: at(12).toISOString() }, {});
    expect(no.content).toMatch(/^Permiso denegado/);
  });

  it("cancelling needs the OK too, and the briefing is a read", async () => {
    const w = world(at(10));
    const rem = w.store.addReminder({ text: "Comprar café", dueAt: at(18).toISOString() });
    const { hub, requests, ready } = hubFor(w);
    await ready;
    const c = await hub.call("reminders__cancel_reminder", { id: rem.id }, {});
    expect(c.content).toBe(`Cancelé el recordatorio #${rem.id}.`);
    expect(requests[0]?.detail).toContain("hoy 18:00: Comprar café");
    const b = await hub.call("reminders__briefing", {}, {});
    expect(b.content).toMatch(/^Buen día\. Hoy es viernes, 20 de noviembre\./);
    expect(requests).toHaveLength(1);
  });
});
