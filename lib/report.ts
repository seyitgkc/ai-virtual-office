/**
 * How the office has been doing, worked out from its tasks and what was said
 * on them. Nothing here is stored: the report is the record, counted.
 */
import { PIPELINE } from "./engine";
import type { Office, Task, WorkflowStage } from "./model";

export interface WorkReport {
  filed: number;
  open: number;
  completed: number;
  rejected: number;
  /** Open tasks that wait for a person: a question, missing access or a review. */
  waitingOnAPerson: number;
  /** Open tasks set to wait for a day. */
  waitingForADay: number;
  urgentOpen: number;
  /** From filed to closed, for tasks that closed. Null when none has. */
  medianToClose: number | null;
  /** Completed tasks where no person was asked anything before the review. */
  straightThrough: number;
  halts: { questions: number; approvals: number; access: number; sentBack: number };
  /** From a question being asked to its answer. Null when none was answered. */
  medianToAnswer: number | null;
  stages: { stage: WorkflowStage; label: string; now: number; median: number | null }[];
  agents: {
    id: string;
    name: string;
    title: string;
    openTasks: number;
    updates: number;
    actions: number;
    questions: number;
    notes: number;
  }[];
  people: { id: string; name: string; title: string; filed: number; answers: number; decisions: number }[];
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** The stage a line of a task's history says the task entered, if it says so. */
function stageEntered(summary: string): WorkflowStage | null {
  if (summary.startsWith("Request received")) return "intake";
  if (summary.includes("sent it back")) return "execution";
  const moved = summary.match(/^Moved to (\w+)/);
  if (!moved) return null;
  return PIPELINE.find((s) => s.label === moved[1])?.stage ?? null;
}

/**
 * How long a task spent at each stage it has left. Time at the stage it is
 * still in is not counted, since it has not finished there.
 */
function timeByStage(task: Task): Map<WorkflowStage, number> {
  const spent = new Map<WorkflowStage, number>();
  let at: { stage: WorkflowStage; since: number } | null = null;
  for (const event of task.history) {
    const entered = stageEntered(event.summary);
    if (!entered) continue;
    if (at) spent.set(at.stage, (spent.get(at.stage) ?? 0) + (event.at - at.since));
    at = { stage: entered, since: event.at };
  }
  if (at && task.closedAt !== null) spent.set(at.stage, (spent.get(at.stage) ?? 0) + (task.closedAt - at.since));
  return spent;
}

export function workReport(office: Office): WorkReport {
  const { tasks, messages, participants } = office;
  const open = tasks.filter((t) => t.closedAt === null);
  const completed = tasks.filter((t) => t.status === "completed");
  const systems = new Set(office.systems.map((s) => s.name));
  // What a system answered is written to the thread as "<system>: <what it did>".
  const fromSystem = (body: string): boolean => {
    const colon = body.indexOf(": ");
    return colon > 0 && systems.has(body.slice(0, colon));
  };

  const questions = messages.filter((m) => m.kind === "question");
  const answers = messages.filter((m) => m.kind === "answer");
  const askedAt = new Map(questions.map((q) => [q.id, q.at]));
  const halted = new Set<string>();
  for (const m of messages) {
    const sentBack = m.kind === "decision" && m.verdict === "changes_requested";
    if (m.kind === "question" || m.kind === "escalation" || sentBack) halted.add(m.taskId);
  }

  const spent = tasks.map(timeByStage);
  const stages = PIPELINE.filter((s) => s.stage !== "done").map((s) => ({
    stage: s.stage,
    label: s.label,
    now: open.filter((t) => t.stage === s.stage).length,
    median: median(spent.flatMap((byStage) => (byStage.has(s.stage) ? [byStage.get(s.stage)!] : []))),
  }));

  return {
    filed: tasks.length,
    open: open.length,
    completed: completed.length,
    rejected: tasks.filter((t) => t.status === "rejected").length,
    waitingOnAPerson: open.filter(
      (t) => t.status === "blocked_question" || t.status === "blocked_permission" || t.status === "in_review",
    ).length,
    waitingForADay: open.filter((t) => t.wait).length,
    urgentOpen: open.filter((t) => t.urgent).length,
    medianToClose: median(tasks.flatMap((t) => (t.closedAt !== null ? [t.closedAt - t.createdAt] : []))),
    straightThrough: completed.filter((t) => !halted.has(t.id)).length,
    halts: {
      questions: questions.filter((q) => q.kind === "question" && !q.heldAction).length,
      approvals: questions.filter((q) => q.kind === "question" && q.heldAction).length,
      access: messages.filter((m) => m.kind === "escalation" && m.cause === "permission").length,
      sentBack: messages.filter((m) => m.kind === "decision" && m.verdict === "changes_requested").length,
    },
    medianToAnswer: median(
      answers.flatMap((a) => {
        const asked = a.kind === "answer" ? askedAt.get(a.questionId) : undefined;
        return asked === undefined ? [] : [a.at - asked];
      }),
    ),
    stages,
    agents: participants
      .filter((p) => p.kind === "agent")
      .map((p) => {
        const said = messages.filter((m) => m.fromId === p.id);
        const outcomes = said.filter((m) => m.kind === "status" && fromSystem(m.body));
        return {
          id: p.id,
          name: p.displayName,
          title: p.title,
          openTasks: open.filter((t) => t.ownerId === p.id).length,
          updates: said.filter((m) => m.kind === "status" || m.kind === "output").length - outcomes.length,
          actions: outcomes.length,
          questions: said.filter((m) => m.kind === "question").length,
          notes: said.filter((m) => m.kind === "note").length,
        };
      }),
    people: participants
      .filter((p) => p.kind === "human")
      .map((p) => ({
        id: p.id,
        name: p.displayName,
        title: p.title,
        filed: tasks.filter((t) => t.requestedById === p.id).length,
        answers: answers.filter((a) => a.fromId === p.id).length,
        decisions: messages.filter((m) => m.kind === "decision" && m.fromId === p.id).length,
      })),
  };
}

/** A length of time as people say it: 40 seconds, 12 minutes, 3 h 20 min, 2 days. */
export function span(ms: number | null): string {
  if (ms === null) return "none yet";
  const seconds = Math.max(Math.round(ms / 1000), 1);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}
