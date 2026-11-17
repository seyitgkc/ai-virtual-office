/**
 * What someone at a desk is doing right now, worked out from the office's
 * tasks and messages. The desk screens show it, and an agent uses it to
 * answer when a person walks up and asks.
 */
import { stageSpec } from "./engine";
import { taskLabel, withTaskLabels } from "./taskLabels";
import { canRead, type AccessContext, type Message, type Office, type Participant, type Task } from "./model";

export type DeskTone = "idle" | "working" | "question" | "permission" | "review";

export interface DeskState {
  tone: DeskTone;
  /** A few words: "Working", "Waiting for access". */
  headline: string;
  /** The task in front of them, when there is one. */
  task: Task | null;
  /** That task as it is shown, such as T-12. */
  taskLabel?: string;
  /** One sentence on what they are waiting for or last did. */
  detail: string;
  /** How many open tasks they own. */
  openTasks: number;
}

const TONE_ORDER: DeskTone[] = ["permission", "question", "review", "working"];

const toneOf = (task: Task): DeskTone =>
  task.status === "blocked_permission"
    ? "permission"
    : task.status === "blocked_question"
      ? "question"
      : task.status === "in_review"
        ? "review"
        : "working";

const HEADLINE: Record<DeskTone, string> = {
  idle: "Nothing on the desk",
  working: "Working",
  question: "Waiting on an answer",
  permission: "Waiting for access",
  review: "Waiting for a decision",
};

/**
 * The state of one person or agent. `visible` limits the detail to messages
 * a given onlooker may read; without it every message counts.
 */
export function deskState(office: Office, who: Participant, visible?: (message: Message) => boolean): DeskState {
  const owned = office.tasks.filter((t) => t.closedAt === null && t.ownerId === who.id);
  // The most pressing task is the one shown: a halt before ordinary work.
  const task = [...owned].sort((a, b) => TONE_ORDER.indexOf(toneOf(a)) - TONE_ORDER.indexOf(toneOf(b)))[0] ?? null;

  if (!task) {
    // A person may have nothing of their own and still be asked something.
    const asked = office.tasks.filter(
      (t) =>
        t.closedAt === null &&
        office.messages.some(
          (m) =>
            m.taskId === t.id &&
            ((m.kind === "question" && t.openQuestionIds.includes(m.id)) ||
              (m.kind === "escalation" && t.status === "blocked_permission")) &&
            m.audience.to === "participant" &&
            m.audience.id === who.id,
        ),
    );
    if (asked.length > 0) {
      return {
        tone: "question",
        headline: asked.length === 1 ? "Asked for a decision" : `Asked for ${asked.length} decisions`,
        task: asked[0],
        detail: `${asked[0].id} is waiting on them.`,
        openTasks: 0,
      };
    }
    return { tone: "idle", headline: HEADLINE.idle, task: null, detail: "No open work.", openTasks: 0 };
  }

  const tone = toneOf(task);
  const mine = office.messages.filter((m) => m.taskId === task.id && m.fromId === who.id && (!visible || visible(m)));
  const last = (kinds: Message["kind"][]): Message | undefined =>
    [...mine].reverse().find((m) => kinds.includes(m.kind));
  const said =
    tone === "permission"
      ? last(["escalation"])
      : tone === "question"
        ? last(["question"])
        : last(["status", "output", "handoff"]);
  return {
    tone,
    headline: HEADLINE[tone],
    task,
    taskLabel: taskLabel(office, task.id),
    detail: said ? withTaskLabels(office, said.body) : `${stageSpec(task.stage).label} on ${taskLabel(office, task.id)}.`,
    openTasks: owned.length,
  };
}

/** May both of these two read this message? */
export const bothRead = (ctx: AccessContext, a: Participant, b: Participant) => (message: Message): boolean =>
  canRead(message, a, ctx) && canRead(message, b, ctx);

/** A task someone has written on and no longer holds open, with the last thing they said on it. */
export interface HandledWork {
  task: Task;
  last: Message;
}

/**
 * The work someone has had a hand in and does not hold open now, most recent
 * first. `visible` limits it to tasks on which a given onlooker may read at
 * least one of their lines.
 */
export function handledWork(office: Office, who: Participant, visible?: (message: Message) => boolean): HandledWork[] {
  const lastOn = new Map<string, Message>();
  for (const m of office.messages) {
    if (m.fromId !== who.id || (visible && !visible(m))) continue;
    const seen = lastOn.get(m.taskId);
    if (!seen || m.at >= seen.at) lastOn.set(m.taskId, m);
  }
  return office.tasks
    .filter((t) => lastOn.has(t.id) && !(t.closedAt === null && t.ownerId === who.id))
    .map((task) => ({ task, last: lastOn.get(task.id)! }))
    .sort((a, b) => b.last.at - a.last.at);
}

/** Where a task stands now, as the end of a sentence: "is completed", "is with Arlo at the planning stage". */
export function standingOf(office: Office, task: Task): string {
  if (task.status === "rejected") return "was rejected";
  if (task.closedAt !== null) return "is completed";
  const owner = office.participants.find((p) => p.id === task.ownerId);
  const stage = `at the ${stageSpec(task.stage).label.toLowerCase()} stage`;
  return owner ? `is with ${owner.displayName} ${stage}` : `is open ${stage} with nobody holding it`;
}

/**
 * What a playbook agent says when someone asks it something. It follows
 * written steps and has no model, so it reports where its work stands.
 */
export function statusReply(office: Office, agent: Participant, asker: Participant, ctx: AccessContext): string {
  const state = deskState(office, agent, bothRead(ctx, agent, asker));
  const intro = "I follow a playbook, so I cannot hold a conversation, but I can tell you where my work stands.";
  if (!state.task || state.openTasks === 0) {
    const [recent] = handledWork(office, agent, bothRead(ctx, agent, asker));
    const before = recent
      ? ` The last work I had a hand in was ${taskLabel(office, recent.task.id)}, "${recent.task.title}", which ${standingOf(office, recent.task)}.`
      : "";
    return `${intro} I have no open work at the moment.${before} File a request and it will reach me when it gets to my stage.`;
  }
  const task = state.task;
  const others = state.openTasks > 1 ? ` I have ${state.openTasks - 1} more open besides.` : "";
  const where = `${taskLabel(office, task.id)}, "${task.title}", is with me at the ${stageSpec(task.stage).label.toLowerCase()} stage.`;
  switch (state.tone) {
    case "permission":
      return `${intro} ${where} It is halted because I need access I do not have. ${state.detail}${others}`;
    case "question":
      return `${intro} ${where} I am waiting on an answer to this: ${state.detail}${others}`;
    case "review":
      return `${intro} ${where} My part is done and it is waiting for a person to decide.${others}`;
    default:
      return `${intro} ${where} The last thing I did: ${state.detail}${others}`;
  }
}

/** The office at a glance: how much work is open, what waits for a person, and who is at work. */
export interface OfficeSummary {
  open: number;
  /** Open tasks halted on a person: a question, missing access or a review. */
  waiting: number;
  /** Open tasks a person marked urgent. */
  urgent: number;
  closed: number;
  agents: number;
  /** Agents taking a step or answering a note right now. */
  atWork: number;
}

/**
 * Is this task halted on a person: a question, missing access, or a review
 * that is theirs to decide? A task an agent is taking a step on is not, even
 * in review, where an agent checks the work before a person decides.
 */
export function waitsForPerson(task: Task, load: AgentLoad): boolean {
  if (task.closedAt !== null) return false;
  if (task.status !== "blocked_question" && task.status !== "blocked_permission" && task.status !== "in_review") return false;
  return !Object.values(load).some((l) => l.taskId === task.id && !l.forNote);
}

export function summaryOf(office: Pick<Office, "tasks" | "participants">, load: AgentLoad): OfficeSummary {
  const open = office.tasks.filter((t) => t.closedAt === null);
  const agents = office.participants.filter((p) => p.kind === "agent");
  return {
    open: open.length,
    waiting: open.filter((t) => waitsForPerson(t, load)).length,
    urgent: open.filter((t) => t.urgent).length,
    closed: office.tasks.length - open.length,
    agents: agents.length,
    atWork: agents.filter((p) => (load[p.id]?.taskId ?? null) !== null).length,
  };
}

/** What each agent is on and has waiting, as the office reports it. */
export type AgentLoad = Record<string, { taskId: string | null; forNote: boolean; waiting: number; queued: string[] }>;

/**
 * Who is at work on a task right now: the agent taking its step, colleagues
 * answering a note on it, and those who have it waiting behind other work.
 */
export function atWorkOn(taskId: string, load: AgentLoad, name: (id: string) => string): string[] {
  const lines: string[] = [];
  for (const [id, l] of Object.entries(load)) {
    if (l.taskId === taskId) lines.push(`${name(id)} is ${l.forNote ? "answering a note on this" : "working on this"} now.`);
  }
  for (const [id, l] of Object.entries(load)) {
    const place = l.queued.indexOf(taskId);
    if (place < 0 || l.taskId === taskId) continue;
    const ahead = place + (l.taskId === null ? 0 : 1);
    lines.push(
      ahead === 0
        ? `${name(id)} is about to take this up.`
        : `${name(id)} takes this up after ${ahead} other ${ahead === 1 ? "task" : "tasks"}.`,
    );
  }
  return lines;
}
