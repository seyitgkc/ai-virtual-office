/**
 * The briefing: a sentence or two at the top of the screen on what the
 * office is doing and what needs a person.
 *
 * It is written only from what every member of the office already sees in
 * the work list: a task's name, where it stands, who holds it, and the day
 * and reason it waits for. Nothing said in a room goes into it, so one
 * briefing serves everyone, whatever they may read.
 *
 * An office with an AI agent has its briefing written by that agent's model
 * once the work has gone quiet. Until then, and where no model is connected,
 * the briefing is composed here from the same facts.
 */
import { dayOf, stageSpec } from "./engine";
import { taskLabel } from "./taskLabels";
import { waitsForPerson, type AgentLoad } from "./agentState";
import type { Office, Task } from "./model";

export interface Briefing {
  text: string;
  /** The model that wrote it, or null when it was composed from the task list. */
  by: string | null;
  /** When it was written, for one written by a model. */
  at: number | null;
}

/** The parts of an office a briefing is written from. */
export type BriefedOffice = Pick<Office, "name" | "tasks" | "participants">;

/** How long a briefing may be, and how much of the office a model is shown for one. */
export const BRIEFING_WORDS = 34;
const BRIEFING_CHARACTERS = 300;
const OPEN_SHOWN = 12;
const CLOSED_SHOWN = 3;
const REASON_SHOWN = 160;

const nameOf = (office: BriefedOffice, id: string | null): string =>
  office.participants.find((p) => p.id === id)?.displayName ?? "nobody";

const stageOf = (task: Task): string => stageSpec(task.stage).label.toLowerCase();

/** Open tasks, with what needs a person first and urgent work ahead of the rest. */
function inOrder(office: BriefedOffice, load: AgentLoad): Task[] {
  const rank = (task: Task): number => (waitsForPerson(task, load) ? 0 : 2) + (task.urgent ? 0 : 1);
  return office.tasks.filter((t) => t.closedAt === null).sort((a, b) => rank(a) - rank(b));
}

/** What everything in a briefing depends on. Two offices in the same state give the same lines. */
export function briefingFacts(office: BriefedOffice, load: AgentLoad, wrap: (kind: string, text: string) => string): string[] {
  const open = inOrder(office, load);
  const closed = office.tasks.filter((t) => t.closedAt !== null).sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  const waiting = open.filter((t) => waitsForPerson(t, load)).length;
  const lines = [
    `Office: ${wrap("name", office.name)}.`,
    `Open tasks: ${open.length}. Of those, waiting for a person: ${waiting}. Closed tasks: ${closed.length}.`,
    "",
    "Open tasks, most pressing first:",
  ];
  if (open.length === 0) lines.push("(none)");
  for (const task of open.slice(0, OPEN_SHOWN)) {
    const label = `${taskLabel(office, task.id)}, ${wrap("title", task.title)}`;
    const owner = nameOf(office, task.ownerId);
    const urgent = task.urgent ? " Marked urgent." : "";
    if (!waitsForPerson(task, load) && task.wait && task.status === "in_progress") {
      const reason = task.wait.reason.length > REASON_SHOWN ? `${task.wait.reason.slice(0, REASON_SHOWN)}...` : task.wait.reason;
      lines.push(`- ${label}: held by ${owner}, waiting until ${dayOf(task.wait.until)}. Reason given: ${wrap("reason", reason)}.${urgent}`);
    } else if (!waitsForPerson(task, load)) {
      lines.push(`- ${label}: with ${owner} at the ${stageOf(task)} stage, in the hands of an agent, needs nobody yet.${urgent}`);
    } else if (task.status === "blocked_permission") {
      lines.push(`- ${label}: halted. ${owner} needs access it does not have, which a person must grant or refuse.${urgent}`);
    } else if (task.status === "blocked_question") {
      lines.push(`- ${label}: halted at the ${stageOf(task)} stage on a question that a person must answer.${urgent}`);
    } else {
      lines.push(`- ${label}: checked by ${owner} and waiting for a person to approve it, reject it or send it back.${urgent}`);
    }
  }
  if (open.length > OPEN_SHOWN) lines.push(`- and ${open.length - OPEN_SHOWN} more open tasks, none more pressing than these.`);
  lines.push("", "Closed most recently:");
  if (closed.length === 0) lines.push("(none)");
  for (const task of closed.slice(0, CLOSED_SHOWN)) {
    lines.push(`- ${taskLabel(office, task.id)}, ${wrap("title", task.title)}: ${task.status === "rejected" ? "rejected" : "completed"}.`);
  }
  return lines;
}

/** The instructions a model writes a briefing under. `rule` says how wrapped text is to be treated. */
export const briefingSystem = (rule: string): string =>
  [
    "You write the briefing shown at the top of an office's screen: what the office is doing right now, for someone who glances at it.",
    "",
    `- Write at most two sentences and ${BRIEFING_WORDS} words.`,
    "- Start with what needs a person, naming each such task by its label, such as T-4, and saying in a few words what it is and what it needs. If nothing needs a person, say so briefly.",
    "- Then say what else is open: in an agent's hands, or waiting for a day. Give the day when there is one.",
    "- Say what the work is. Do not just repeat the counts.",
    "- Use only the facts in the message. Never add a figure, a name, a date or a reason that is not there.",
    "- Plain sentences only: no lists, headings, emphasis marks, quotation marks or emoji, and no greeting or sign-off.",
    `- ${rule}`,
  ].join("\n");

/** Make a model's answer fit the line: one paragraph of plain text, within the length. */
export function tidyBriefing(reply: string): string {
  let text = reply
    .replace(/[*_#`>]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .trim();
  if (text.length > BRIEFING_CHARACTERS) {
    const cut = text.slice(0, BRIEFING_CHARACTERS);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    text = end > 80 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}...`;
  }
  return text;
}

/** The briefing as it reads with no model: the same facts, put in order. */
export function composeBriefing(office: BriefedOffice, load: AgentLoad): string {
  const open = inOrder(office, load);
  const count = office.tasks.length;
  if (count === 0) return "No work has been filed yet.";
  if (open.length === 0) return count === 1 ? "Nothing is open. The one task filed is closed." : `Nothing is open. All ${count} tasks are closed.`;

  const label = (task: Task): string => taskLabel(office, task.id);
  const waiting = open.filter((t) => waitsForPerson(t, load));
  const rest = open.filter((t) => !waitsForPerson(t, load));
  const sentences: string[] = [];

  if (waiting.length > 0) {
    const needs = (task: Task): string =>
      task.status === "blocked_permission"
        ? `${label(task)} needs access for ${nameOf(office, task.ownerId)}`
        : task.status === "blocked_question"
          ? `${label(task)} needs an answer`
          : `${label(task)} is ready for a decision`;
    const named = waiting.slice(0, 3).map(needs);
    const more = waiting.length - named.length;
    sentences.push(
      `${waiting.length === 1 ? "One task waits" : `${waiting.length} tasks wait`} for a person: ${named.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`,
    );
  } else {
    sentences.push("Nothing waits for a person.");
  }

  if (rest.length === 1) {
    const task = rest[0];
    sentences.push(
      task.wait && task.status === "in_progress"
        ? `${label(task)} waits until ${dayOf(task.wait.until)}.`
        : `${label(task)} is with ${nameOf(office, task.ownerId)} at the ${stageOf(task)} stage.`,
    );
  } else if (rest.length > 1) {
    const dated = rest.filter((t) => t.wait && t.status === "in_progress").length;
    const held = rest.length - dated;
    const parts = [
      ...(held > 0 ? [`${held} ${held === 1 ? "is" : "are"} with agents`] : []),
      ...(dated > 0 ? [`${dated} ${dated === 1 ? "waits" : "wait"} for a day`] : []),
    ];
    sentences.push(`Of the other ${rest.length}, ${parts.join(" and ")}.`);
  }
  return sentences.join(" ");
}
