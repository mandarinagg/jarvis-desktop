/** Pure time rules for proactivity (ADR-026). Clocks are local "HH:MM"; windows may cross midnight. */
import type { Clock, QuietHours } from "./store.js";

export const minutes = (c: Clock): number => Number(c.slice(0, 2)) * 60 + Number(c.slice(3, 5));
const minuteOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

export function inQuietHours(now: Date, q: QuietHours | null): boolean {
  if (!q) return false;
  const m = minuteOfDay(now);
  const s = minutes(q.start);
  const e = minutes(q.end);
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** The daily briefing is due once the local clock passed its time, unless today's already exists. */
export function briefingDue(now: Date, time: Clock | null, alreadyToday: boolean): boolean {
  return time !== null && !alreadyToday && minuteOfDay(now) >= minutes(time);
}

/** "viernes 21/11 09:00" (or "hoy 09:00" / "mañana 09:00") in local time, for dialogs and notifications. */
export function whenLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86_400_000);
  if (diff === 0) return `hoy ${time}`;
  if (diff === 1) return `mañana ${time}`;
  if (diff === -1) return `ayer ${time}`;
  const weekday = d.toLocaleDateString("es-AR", { weekday: "long" });
  const year = d.getFullYear() !== now.getFullYear() ? `/${d.getFullYear()}` : "";
  return `${weekday} ${d.getDate()}/${d.getMonth() + 1}${year} ${time}`;
}

/** The current local date and time, with the UTC offset, for the model (it has no clock of its own). */
export function nowLine(now: Date): string {
  const off = -now.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const date = now.toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const time = now.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `Ahora es ${date}, ${time} (hora local del owner, UTC${sign}${pad(off / 60)}:${pad(off % 60)}).`;
}
