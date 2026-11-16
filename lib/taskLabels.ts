/**
 * How a task is named to people and to agents. A task's id is unique across
 * every office in the database, which makes it long. What is shown is its
 * number within its own office: the first task filed there is T-1, the next
 * T-2. The id stays what the office works with underneath.
 */
import type { Office, Task } from "./model";

type Tasks = Pick<Office, "tasks">;

/** Anything in a text that could name a task: an id, or a number as shown. */
const REFERENCE = /\bT-(?:[A-Za-z0-9]{1,8}-)?\d{1,9}\b/g;

const numbers = new WeakMap<Task[], Map<string, number>>();

/** Each task's number in its office, from the order the tasks were filed in. */
function numbered(office: Tasks): Map<string, number> {
  let found = numbers.get(office.tasks);
  if (!found) {
    found = new Map(office.tasks.map((task, at) => [task.id, at + 1]));
    numbers.set(office.tasks, found);
  }
  return found;
}

/** A task as it is shown, such as T-12. An id the office does not know is left as it is. */
export function taskLabel(office: Tasks, taskId: string): string {
  const number = numbered(office).get(taskId);
  return number === undefined ? taskId : `T-${number}`;
}

/** The task a reference in a text points at: by its id, or else by its number. */
export function taskNamed(office: Tasks, reference: string): Task | undefined {
  const byId = office.tasks.find((task) => task.id === reference);
  if (byId) return byId;
  const number = /^T-(\d+)$/.exec(reference)?.[1];
  return number ? office.tasks[Number(number) - 1] : undefined;
}

/** A text with every task id in it replaced by the task's number as shown. */
export function withTaskLabels(office: Tasks, text: string): string {
  if (!text.includes("T-")) return text;
  const known = numbered(office);
  return text.replace(REFERENCE, (found) => (known.has(found) ? `T-${known.get(found)}` : found));
}

/** A text cut where it names tasks, so that each name can be made a link. */
export function splitAtTasks(office: Tasks, text: string): { text: string; task?: Task }[] {
  const parts: { text: string; task?: Task }[] = [];
  let from = 0;
  for (const match of text.matchAll(REFERENCE)) {
    const task = taskNamed(office, match[0]);
    if (!task) continue;
    if (match.index > from) parts.push({ text: text.slice(from, match.index) });
    parts.push({ text: taskLabel(office, task.id), task });
    from = match.index + match[0].length;
  }
  if (from < text.length) parts.push({ text: text.slice(from) });
  return parts;
}
