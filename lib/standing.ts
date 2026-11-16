/**
 * Standing work: a request the office files by itself, again and again. It is
 * how work starts without anyone asking on the day, such as a stock check
 * every morning or a look at overdue invoices every Monday.
 */

export type Every = "day" | "weekday" | "week";

export const EVERY: { id: Every; label: string }[] = [
  { id: "day", label: "Every day" },
  { id: "weekday", label: "Every weekday" },
  { id: "week", label: "Every week" },
];

/** A standing request as people who manage the office see it. */
export interface StandingView {
  id: string;
  title: string;
  detail: string;
  urgent: boolean;
  every: Every;
  /** When it is next due. */
  nextAt: number;
  active: boolean;
  /** Whose name the requests are filed in. */
  filedAs: string;
  /** The last task it filed, if that task still exists. */
  lastTaskId: string | null;
  lastFiledAt: number | null;
}

const DAY = 86_400_000;

/** The office keeps one time zone for its working week. */
const ZONE = "America/Toronto";

const isWeekend = (at: number): boolean => {
  const day = new Date(at).toLocaleDateString("en-CA", { weekday: "short", timeZone: ZONE });
  return day === "Sat" || day === "Sun";
};

/**
 * The first time after `now` that something due at `at` falls due again. It
 * steps a day or a week at a time from `at`, so the time of day never drifts,
 * and a weekday rhythm passes over Saturday and Sunday.
 */
export function nextAfter(at: number, every: Every, now: number): number {
  const step = every === "week" ? 7 * DAY : DAY;
  let next = at;
  // Bounded, so a time far in the past cannot keep the office busy counting.
  for (let i = 0; i < 4000 && (next <= now || (every === "weekday" && isWeekend(next))); i++) next += step;
  if (next <= now) next = now + step;
  return next;
}
