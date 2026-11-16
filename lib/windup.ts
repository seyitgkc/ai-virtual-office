/**
 * Winding up a rejected task. A task that is rejected after it has done
 * things in connected systems does not simply close: an order it placed is
 * still an order. The office works out from the thread what the task did
 * that still stands, asks whoever rejected it what should happen to that,
 * has the agents that did each thing carry the answer out, and closes the
 * task only once nothing is left standing or a person says to leave it.
 *
 * Everything here is read from the record. Nothing is recalled by a model.
 */
import type { Message, Office, Participant, StatusMessage, Task } from "./model";
import { operationOf, type ConnectedSystem, type SystemOperation } from "./systems";

/** The answers offered when a task is rejected after it has acted in a system. */
export const UNDO_ALL = "Undo all of them";
export const LEAVE_ALL = "Leave them as they are";
/** The answers offered when not everything could be taken back. */
export const TRY_AGAIN = "Try again";
export const CLOSE_AS_IS = "Close it as it stands";

/** One thing a task did in a connected system. */
export interface Deed {
  /** The line in the thread that reports it. */
  message: StatusMessage & { did: NonNullable<StatusMessage["did"]> };
  /** The system it was done in, when that system is still connected. */
  system: ConnectedSystem | undefined;
  /** Who did it. */
  byId: string;
  /** What the system said it did. */
  summary: string;
  /** The operation of that system that takes it back, when it has one. */
  undo: SystemOperation | undefined;
}

const reported = (message: Message): message is Deed["message"] =>
  message.kind === "status" && message.did !== undefined;

/** What the system said, without the system's name in front of it. */
function summaryOf(message: StatusMessage, system: ConnectedSystem | undefined): string {
  const lead = system ? `${system.name}: ` : "";
  const said = lead && message.body.startsWith(lead) ? message.body.slice(lead.length) : message.body.replace(/^[^:]{1,40}: /, "");
  return said.trim().replace(/\.+$/, "");
}

/**
 * What was done, without what the system added about how things stood right
 * after: a balance quoted when an invoice was raised is out of date by the
 * time anyone reads the list.
 */
const firstSentence = (said: string): string => (/^(.*?[.!?])\s+[A-Z]/.exec(said)?.[1] ?? said).replace(/\.+$/, "");

/**
 * What a task did in connected systems, split into what still stands and
 * what has since been taken back, each oldest first. An operation that takes
 * another back removes the thing it names. Where a system gives no record
 * number, the latest thing of that kind is the one taken back.
 */
export function deedsOf(office: Office, taskId: string): { standing: Deed[]; undone: Deed[] } {
  const standing: Deed[] = [];
  const undone: Deed[] = [];
  for (const message of office.messages) {
    if (message.taskId !== taskId || !reported(message) || !message.did.ok) continue;
    const system = office.systems.find((s) => s.id === message.did.systemId);
    const operation = system ? operationOf(system, message.did.operation) : undefined;
    if (operation?.undoes) {
      const same = (d: Deed): boolean => d.message.did.systemId === message.did.systemId && d.message.did.operation === operation.undoes;
      const named = message.did.record?.toUpperCase();
      const at = named
        ? standing.findLastIndex((d) => same(d) && d.message.did.record?.toUpperCase() === named)
        : standing.findLastIndex(same);
      const fallback = at === -1 && named ? standing.findLastIndex((d) => same(d) && !d.message.did.record) : at;
      if (fallback !== -1) undone.push(...standing.splice(fallback, 1));
      continue;
    }
    standing.push({
      message,
      system,
      byId: message.fromId,
      summary: firstSentence(summaryOf(message, system)),
      undo: system?.operations.find((o) => o.undoes === message.did.operation),
    });
  }
  return { standing, undone };
}

/** One deed in a sentence, for a person: who, where, what. */
export function describeDeed(office: Office, deed: Deed): string {
  const who = office.participants.find((p) => p.id === deed.byId)?.displayName ?? "Someone";
  return `${who}, in ${deed.system?.name ?? "a system that is no longer connected"}: ${deed.summary}`;
}

/** Deeds as a numbered run of sentences, newest last. */
export const listDeeds = (office: Office, deeds: Deed[]): string =>
  deeds.map((d, i) => `(${i + 1}) ${describeDeed(office, d)}.`).join(" ");

/** The decision that rejected a task which is being wound up. */
export function rejectionOf(office: Office, task: Task): Extract<Message, { kind: "decision" }> | undefined {
  return office.messages.findLast(
    (m): m is Extract<Message, { kind: "decision" }> => m.taskId === task.id && m.kind === "decision" && m.verdict === "rejected",
  );
}

/** Whether a question is the one that asks what to do with what a rejected task did. */
export const asksAboutDeeds = (task: Task, question: Message): boolean =>
  task.windUp === true && question.kind === "question" && !question.heldAction && task.openQuestionIds.includes(question.id);

/**
 * The answers a person has given about what a rejected task did, oldest
 * first. The last one opens the round the agents are on now.
 */
export function answersGiven(office: Office, task: Task): Extract<Message, { kind: "answer" }>[] {
  // The order of the thread decides what came after what. Clock times can tie.
  const rejection = rejectionOf(office, task);
  const since = rejection ? office.messages.indexOf(rejection) : office.messages.length;
  return office.messages.slice(since).filter((m): m is Extract<Message, { kind: "answer" }> => {
    if (m.taskId !== task.id || m.kind !== "answer") return false;
    const question = office.messages.find((q) => q.id === m.questionId);
    return question?.kind === "question" && !question.heldAction;
  });
}

/** Everything said on a task after a given message, in the order it was said. */
const after = (office: Office, task: Task, message: Message | undefined): Message[] =>
  message ? office.messages.slice(office.messages.indexOf(message) + 1).filter((m) => m.taskId === task.id) : [];

/**
 * What the person said is to happen, for the round the agents are on. "Try
 * again" repeats whatever was said before it.
 */
export function instructionOf(office: Office, task: Task): string {
  const given = answersGiven(office, task).map((a) => a.chosenOption ?? a.body);
  return given.findLast((said) => said !== TRY_AGAIN) ?? UNDO_ALL;
}

/** The deeds an agent has been asked about since the person last answered. */
export function askedThisRound(office: Office, task: Task): Set<string> {
  return new Set(
    after(office, task, answersGiven(office, task).at(-1)).flatMap((m) => (m.kind === "note" && m.inReplyTo ? [m.inReplyTo] : [])),
  );
}

/**
 * Why a deed that an agent was asked about still stands: the system's
 * refusal if there was one, else what the agent answered, else nothing.
 */
export function whyStanding(office: Office, task: Task, deed: Deed, doer: Participant | undefined, undoAll: boolean): string {
  if (!deed.system) return "its system is no longer connected, so nobody can reach it from here";
  if (undoAll && !deed.undo) return `${deed.system.name} has no way to take this back`;
  if (!doer) return "whoever did it is no longer in the office";
  const asked = office.messages.findLast((m) => m.taskId === task.id && m.kind === "note" && m.inReplyTo === deed.message.id);
  if (!asked) return doer.kind === "agent" ? `${doer.displayName} could not be asked to do this` : "a person did it";
  const since = after(office, task, asked);
  const refusal = since.findLast((m) => reported(m) && !m.did.ok && m.did.systemId === deed.message.did.systemId && m.fromId === doer.id);
  if (refusal) return `${deed.system.name} ${summaryOf(refusal as StatusMessage, deed.system)}`;
  const held = since.findLast((m) => m.kind === "status" && m.fromId === doer.id && m.body.startsWith(`${deed.system?.name}: not done`));
  if (held) return `it was ${summaryOf(held as StatusMessage, deed.system)}`;
  const answer = since.findLast((m) => m.kind === "note" && m.fromId === doer.id);
  if (answer) return `${doer.displayName} said: ${answer.body.replace(/\s+/g, " ").trim().replace(/\.+$/, "")}`;
  return `${doer.displayName} did not act on it`;
}

/**
 * Whether an action an agent wants to take while winding up is one it may
 * take. Taking something back has to name a record this task made, so that
 * an agent cannot cancel another task's order by mistake. When the person
 * asked only for things to be undone, nothing else is done.
 */
export function allowedInWindUp(
  standing: Deed[],
  system: ConnectedSystem,
  operation: string,
  fields: Record<string, string>,
  undoAll: boolean,
): { ok: true } | { ok: false; why: string } {
  const wanted = operationOf(system, operation);
  if (!wanted?.undoes) {
    return undoAll
      ? { ok: false, why: `only taking things back was asked for, and "${wanted?.label ?? operation}" does not take anything back` }
      : { ok: true };
  }
  const targets = standing.filter((d) => d.message.did.systemId === system.id && d.message.did.operation === wanted.undoes);
  if (targets.length === 0) return { ok: false, why: `this task has nothing in ${system.name} left for "${wanted.label}" to take back` };
  const values = Object.values(fields).map((v) => v.trim().toUpperCase());
  const records = targets.flatMap((d) => (d.message.did.record ? [d.message.did.record.toUpperCase()] : []));
  // A system that gives no record numbers leaves nothing to check against.
  if (records.length === 0 || records.some((r) => values.includes(r))) return { ok: true };
  return { ok: false, why: `it named ${values.filter(Boolean).join(", ") || "nothing"}, and what this task made in ${system.name} is ${records.join(", ")}` };
}
