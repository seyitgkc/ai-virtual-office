/**
 * What the office already knows from work it has finished. When an agent
 * takes a step, the closed tasks that bear on the one in hand are found and
 * what was concluded on each is shown to it, as far as its rooms let it read.
 * Nothing is written or remembered separately: the record is the memory.
 */
import { canRead, type AccessContext, type Office, type Participant, type Task } from "./model";

export interface EarlierWork {
  taskId: string;
  title: string;
  outcome: "completed" | "rejected";
  closedAt: number;
  /** What was concluded, in the words of the last result the reader may see. */
  summary: string;
}

/** How many earlier tasks an agent is shown, and how much of each. */
const SHOWN = 3;
const SUMMARY = 500;

const textOf = (task: Task): string => `${task.title} ${task.detail}`;

/** Account numbers, part numbers, order numbers: anything with letters and a digit in it. */
const identifiers = (text: string): Set<string> =>
  new Set((text.match(/[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/g) ?? []).filter((t) => t.length >= 5 && /\d/.test(t)).map((t) => t.toUpperCase()));

/** Longer words, which carry names and subjects. */
const words = (text: string): Set<string> =>
  new Set((text.toLowerCase().match(/[a-z]{5,}/g) ?? []));

/**
 * Closed tasks that share something telling with this one, best match first.
 * A shared identifier counts for a great deal. A shared word counts only if
 * few of the office's tasks use it, so that the words every request here
 * contains do not make every task look related.
 */
export function earlierWork(office: Office, task: Task, reader: Participant, ctx: AccessContext): EarlierWork[] {
  const closed = office.tasks.filter(
    (t) => t.id !== task.id && t.closedAt !== null && (t.status === "completed" || t.status === "rejected"),
  );
  if (closed.length === 0) return [];

  const used = new Map<string, number>();
  for (const t of office.tasks) for (const w of words(textOf(t))) used.set(w, (used.get(w) ?? 0) + 1);
  const common = Math.max(2, office.tasks.length * 0.3);
  const mine = { ids: identifiers(textOf(task)), words: words(textOf(task)) };

  const scored = closed
    .map((t) => {
      const ids = identifiers(textOf(t));
      const theirs = words(textOf(t));
      let score = 0;
      for (const id of mine.ids) if (ids.has(id)) score += 3;
      for (const w of mine.words) if (theirs.has(w) && (used.get(w) ?? 0) <= common) score += 1;
      return { t, score };
    })
    .filter((x) => x.score >= 3)
    .sort((a, b) => b.score - a.score || (b.t.closedAt ?? 0) - (a.t.closedAt ?? 0));

  const found: EarlierWork[] = [];
  for (const { t } of scored) {
    if (found.length === SHOWN) break;
    // The reader's access is to the room each message was said in, as for any thread.
    const result = office.messages.findLast(
      (m) => m.taskId === t.id && m.kind === "output" && canRead(m, reader, { ...ctx, forTask: t.id }),
    );
    if (!result) continue;
    found.push({
      taskId: t.id,
      title: t.title,
      outcome: t.status === "rejected" ? "rejected" : "completed",
      closedAt: t.closedAt ?? 0,
      summary: result.body.length > SUMMARY ? `${result.body.slice(0, SUMMARY)}...` : result.body,
    });
  }
  return found;
}
