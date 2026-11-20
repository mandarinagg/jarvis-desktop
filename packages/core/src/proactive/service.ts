/**
 * Proactivity with rules (Phase 7, ADR-026): fires due reminders and the daily briefing as
 * notifications, never during the owner's quiet hours and only when a desktop window can show
 * them (otherwise they wait). Nothing here calls a model or spends money.
 */
import type { CoreMessage, ProactiveMessage, ProactiveState } from "@jarvis/shared";
import type { DatabaseSync } from "node:sqlite";
import { localDay } from "../db.js";
import { type Logger, silentLogger } from "../log.js";
import type { Session } from "../server.js";
import { composeBriefing } from "./briefing.js";
import { briefingDue, inQuietHours, whenLabel } from "./schedule.js";
import type { ProactiveStore } from "./store.js";

export interface ProactiveOptions {
  db: DatabaseSync;
  store: ProactiveStore;
  broadcast: (m: CoreMessage) => void;
  /** True when a desktop client is connected to show notifications. */
  canNotify: () => boolean;
  dailyBudgetUsd: number;
  logger?: Logger;
  now?: () => Date;
}

/** A reminder shown this late says what time it was for. */
const LATE_MS = 5 * 60_000;

export class Proactive {
  private readonly now: () => Date;
  private readonly logger: Logger;

  constructor(private readonly o: ProactiveOptions) {
    this.now = o.now ?? (() => new Date());
    this.logger = o.logger ?? silentLogger;
  }

  /** Runs every 30 s: what is due now, unless it is quiet time or nobody can see it. */
  tick(): void {
    const now = this.now();
    const { store } = this.o;
    const settings = store.settings();
    if (inQuietHours(now, settings.quietHours) || !this.o.canNotify()) return;
    let changed = false;
    for (const r of store.due(now.toISOString())) {
      store.markFired(r.id);
      const late = now.getTime() - new Date(r.dueAt).getTime() > LATE_MS;
      this.o.broadcast({ type: "proactive.notify", kind: "reminder", title: "Recordatorio", body: late ? `${r.text}\n(era para ${whenLabel(r.dueAt, now)})` : r.text });
      this.logger.log("info", "proactive.reminder_fired", { id: r.id, late });
      changed = true;
    }
    const today = localDay(now);
    if (briefingDue(now, settings.briefingTime, store.briefing(today) !== undefined)) {
      const text = composeBriefing(this.o.db, store, now, this.o.dailyBudgetUsd);
      store.saveBriefing(today, text);
      this.o.broadcast({ type: "proactive.notify", kind: "briefing", title: "Briefing de hoy", body: text });
      this.logger.log("info", "proactive.briefing", { day: today });
      changed = true;
    }
    if (changed) this.o.broadcast(this.state());
  }

  state(id?: string): ProactiveState {
    const { store } = this.o;
    const briefing = store.briefing(localDay(this.now()));
    return {
      type: "proactive.state",
      ...(id ? { id } : {}),
      settings: store.settings(),
      reminders: store.pending(50).map((r) => ({ id: r.id, text: r.text, dueAt: r.dueAt })),
      ...(briefing ? { briefing } : {}),
    };
  }

  /** The briefing composed now (for Jarvis' `briefing` tool): not saved, not notified. */
  briefingNow(): string {
    return composeBriefing(this.o.db, this.o.store, this.now(), this.o.dailyBudgetUsd);
  }

  handle(session: Session, m: ProactiveMessage): void {
    const { store } = this.o;
    if (m.type === "proactive.set") {
      store.setSettings({
        ...(m.briefingTime !== undefined ? { briefingTime: m.briefingTime } : {}),
        ...(m.quietHours !== undefined ? { quietHours: m.quietHours } : {}),
      });
      this.logger.log("info", "proactive.settings", { briefing: store.settings().briefingTime ?? "off" });
    } else if (m.type === "reminders.cancel") {
      store.cancel(m.reminderId);
    }
    const state = this.state(m.id);
    session.send(state);
    if (m.type !== "proactive.get") {
      const { id: _id, ...broadcastState } = state;
      this.o.broadcast(broadcastState);
    }
  }
}
