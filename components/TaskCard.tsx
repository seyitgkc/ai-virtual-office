"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { atWorkOn, type AgentLoad } from "../lib/agentState";
import { dayOf, stageSpec } from "../lib/engine";
import { inOffice, type Office, type Participant, type Task, type TaskStatus } from "../lib/model";
import { taskLabel, withTaskLabels } from "../lib/taskLabels";

/**
 * What a task card needs from the screen it is on: the office, what each
 * agent is busy with, how to open a task, and which task is open already.
 */
export const TaskContext = createContext<{
  office: Office;
  agentLoad: AgentLoad;
  openTask: (taskId: string) => void;
  openTaskId: string | null;
} | null>(null);

export const STATUS: Record<TaskStatus, { label: string; accent: string }> = {
  requested: { label: "requested", accent: "#8a93a0" },
  in_progress: { label: "in progress", accent: "#6ea9d9" },
  blocked_question: { label: "needs an answer", accent: "#e0a23f" },
  blocked_permission: { label: "needs access", accent: "#e0614f" },
  in_review: { label: "in review", accent: "#9b8ad9" },
  completed: { label: "completed", accent: "#5fa87a" },
  rejected: { label: "rejected", accent: "#8a8a8a" },
};

/** The colour of the mark on urgent work. */
export const URGENT_ACCENT = "#e0614f";

/** How a task's state is shown. One that waits for a day says so in place of "in progress". */
export const statusOf = (task: Task): { label: string; accent: string } =>
  task.wait && task.closedAt === null && task.status === "in_progress"
    ? { label: `waiting until ${dayOf(task.wait.until)}`, accent: "#8a93a0" }
    : task.windUp && task.closedAt === null
      ? { label: task.status === "blocked_question" ? "rejected, needs an answer" : "rejected, winding up", accent: task.status === "blocked_question" ? "#e0a23f" : "#8a8a8a" }
      : STATUS[task.status];

export function KindBadge({ kind, agentType }: Pick<Participant, "kind" | "agentType">) {
  const playbook = kind === "agent" && agentType !== "ai";
  return (
    <span className="kind-badge" data-kind={kind} data-playbook={playbook}>
      {kind === "human" ? "Human" : playbook ? "Playbook" : "AI"}
    </span>
  );
}

const when = (ms: number): string =>
  new Date(ms).toLocaleString("en-CA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

const clipped = (text: string, max: number): string => {
  const plain = text.replace(/\s+/g, " ").trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}...` : plain;
};

/** The kinds of line that say where a task has got to. */
const TELLING = new Set(["status", "output", "handoff", "decision", "question", "answer", "escalation"]);

/**
 * A task at a glance: what was asked, where it stands, who has it, what it
 * waits for and the last thing said on it. Shown wherever a task is named.
 */
export function TaskCard({
  task,
  office,
  agentLoad,
  isOpen,
  onOpen,
}: {
  task: Task;
  office: Office;
  agentLoad: AgentLoad;
  /** True when this task is the one already open on the screen. */
  isOpen: boolean;
  onOpen: () => void;
}) {
  const name = (id: string): string => {
    if (id === "system") return "The office";
    const person = office.participants.find((p) => p.id === id);
    // Someone who has left keeps their name on what they took part in.
    return person ? `${person.displayName}${inOffice(person) ? "" : " (left the office)"}` : "Someone";
  };
  const owner = office.participants.find((p) => p.id === task.ownerId);
  const status = statusOf(task);
  const thread = office.messages.filter((m) => m.taskId === task.id);
  const question = thread.find((m) => m.kind === "question" && task.openQuestionIds.includes(m.id));
  const latest = thread.findLast((m) => TELLING.has(m.kind) && m.id !== question?.id);
  const atWork = atWorkOn(task.id, agentLoad, name);

  return (
    <div className="task-card-body">
      <div className="task-card-head">
        <span className="id">{taskLabel(office, task.id)}</span>
        <span className="chip" style={{ ["--accent" as string]: status.accent }}>
          {status.label}
        </span>
        {task.urgent && task.closedAt === null && (
          <span className="chip urgent" style={{ ["--accent" as string]: URGENT_ACCENT }}>
            urgent
          </span>
        )}
      </div>
      <div className="task-card-title">{task.title}</div>
      <p className="task-card-request">{clipped(withTaskLabels(office, task.detail), 240)}</p>

      <div className="kv">
        <span>Stage</span>
        <span>
          {stageSpec(task.stage).label}, in {office.floorplan.rooms.find((r) => r.id === task.roomId)?.name ?? "a room that is gone"}
        </span>
      </div>
      <div className="kv">
        <span>Owner</span>
        <span>
          {owner && <KindBadge kind={owner.kind} agentType={owner.agentType} />} {owner ? owner.displayName : "Unassigned"}
        </span>
      </div>
      <div className="kv">
        <span>Requested by</span>
        <span>
          {name(task.requestedById)}, {when(task.createdAt)}
        </span>
      </div>
      {task.closedAt !== null && (
        <div className="kv">
          <span>Closed</span>
          <span>{when(task.closedAt)}</span>
        </div>
      )}
      {(task.documents?.length ?? 0) > 0 && (
        <div className="kv">
          <span>Documents</span>
          <span>{task.documents!.map((d) => d.name).join(", ")}</span>
        </div>
      )}

      {atWork.length > 0 && (
        <div className="at-work">
          {atWork.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}
      {question && (
        <div className="note q">
          <div className="meta">{name(question.fromId)} is waiting for an answer</div>
          {clipped(withTaskLabels(office, question.body), 220)}
        </div>
      )}
      {task.wait && task.closedAt === null && (
        <div className="note">
          <div className="meta">Waiting until {dayOf(task.wait.until)}</div>
          {clipped(task.wait.reason, 200)}
        </div>
      )}
      {latest && (
        <div className={`note ${latest.kind === "output" ? "out" : latest.kind === "escalation" ? "esc" : ""}`}>
          <div className="meta">
            Latest · {name(latest.fromId)} · {when(latest.at)}
          </div>
          {clipped(withTaskLabels(office, latest.body), 220)}
        </div>
      )}

      {isOpen ? (
        <div className="task-card-foot">This task is the one open on the right.</div>
      ) : (
        <button type="button" className="btn primary task-card-open" onClick={onOpen}>
          Open this task
        </button>
      )}
    </div>
  );
}

const CARD_WIDTH = 320;

/**
 * A task named in running text. It reads as the task's number, and pressing
 * it shows the task's card beside it.
 */
export function TaskRef({ task, label }: { task: Task; label: string }) {
  const screen = useContext(TaskContext);
  const anchor = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number } | null>(null);

  useEffect(() => {
    if (!place) return;
    const close = (): void => setPlace(null);
    const outside = (event: Event): void => {
      const target = event.target as Node | null;
      if (target && (card.current?.contains(target) || anchor.current?.contains(target))) return;
      close();
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", outside, true);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", outside, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", close);
    };
  }, [place]);

  if (!screen) return <span>{label}</span>;

  const toggle = (): void => {
    if (place) return setPlace(null);
    const box = anchor.current?.getBoundingClientRect();
    if (!box) return;
    const left = Math.max(8, Math.min(box.left, window.innerWidth - CARD_WIDTH - 8));
    // Below the number where there is room, above it otherwise.
    setPlace(
      box.bottom + 340 < window.innerHeight || box.top < window.innerHeight / 2
        ? { left, top: box.bottom + 6 }
        : { left, bottom: window.innerHeight - box.top + 6 },
    );
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="task-ref"
        title={task.title}
        aria-expanded={place !== null}
        onClick={(event) => {
          event.stopPropagation();
          toggle();
        }}
      >
        {label}
      </button>
      {place &&
        createPortal(
          <div
            ref={card}
            className="task-card"
            role="dialog"
            aria-label={`${label}: ${task.title}`}
            style={{ left: place.left, top: place.top, bottom: place.bottom, width: CARD_WIDTH }}
          >
            <TaskCard
              task={task}
              office={screen.office}
              agentLoad={screen.agentLoad}
              isOpen={screen.openTaskId === task.id}
              onOpen={() => {
                setPlace(null);
                screen.openTask(task.id);
              }}
            />
          </div>,
          document.body,
        )}
    </>
  );
}
