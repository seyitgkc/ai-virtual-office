"use client";

import { useState } from "react";
import { stageSpec } from "../lib/engine";
import type { Message, Office, Participant, Task } from "../lib/model";
import type { OfficeView } from "../lib/view";
import { KindBadge } from "./Panels";

/** Something in the office that is waiting on this person. */
export interface WaitingItem {
  id: string;
  task: Task;
  /** A few words on what is wanted: "Question from Iris". */
  label: string;
  body: string;
}

/** What is waiting on the viewer: questions, requests for access, and reviews to decide. */
export function waitingFor(office: Office, viewer: Participant, mayDecide: boolean): WaitingItem[] {
  const name = (id: string): string => office.participants.find((p) => p.id === id)?.displayName ?? "Someone";
  const mine = (m: Message): boolean => m.audience.to === "participant" && m.audience.id === viewer.id;
  const items: WaitingItem[] = [];
  for (const task of office.tasks) {
    if (task.closedAt !== null) continue;
    const thread = office.messages.filter((m) => m.taskId === task.id);
    for (const m of thread) {
      if (m.kind === "question" && mine(m) && task.openQuestionIds.includes(m.id)) {
        items.push({
          id: m.id,
          task,
          label: m.heldAction ? `${name(m.fromId)} asks for approval` : `Question from ${name(m.fromId)}`,
          body: m.body,
        });
      }
    }
    if (task.status === "blocked_permission") {
      const asked = [...thread].reverse().find((m) => m.kind === "escalation");
      if (asked && mine(asked)) {
        items.push({ id: asked.id, task, label: `${name(asked.fromId)} needs access`, body: asked.body });
      }
    }
    if (task.status === "in_review" && mayDecide) {
      items.push({
        id: `review:${task.id}`,
        task,
        label: "Waiting for your decision",
        body: `${task.title} is at ${stageSpec(task.stage).label.toLowerCase()} and needs approving or rejecting.`,
      });
    }
  }
  return items;
}

/** Notes in task threads addressed to the viewer, newest first. */
export const notesFor = (office: Office, viewer: Participant): Message[] =>
  office.messages
    .filter((m) => m.kind === "note" && m.audience.to === "participant" && m.audience.id === viewer.id)
    .reverse();

/**
 * Notes one agent left another, newest first. The office sends a person only
 * the notes they may see, so this is empty for someone who cannot see
 * everything.
 */
export const notesBetweenAgents = (office: Office): Message[] => {
  const agents = new Set(office.participants.filter((p) => p.kind === "agent").map((p) => p.id));
  return office.messages
    .filter((m) => m.kind === "note" && agents.has(m.fromId) && m.audience.to === "participant" && agents.has(m.audience.id))
    .reverse();
};

/** How many things in the inbox the viewer has not dealt with or opened. */
export function inboxCount(view: OfficeView, viewer: Participant): number {
  const waiting = waitingFor(view.office, viewer, view.viewer.permissions.includes("decide_reviews")).length;
  const unreadDirects = Object.values(view.unread.directs).reduce((sum, n) => sum + n, 0);
  return waiting + view.unread.notes.length + unreadDirects;
}

/**
 * Everything addressed to the signed-in person in one place: what is waiting
 * on them, notes agents left them, what agents wrote to each other, and
 * their conversations.
 */
export function Inbox({
  view,
  viewer,
  onOpenTask,
  onOpenPerson,
  onClose,
}: {
  view: OfficeView;
  viewer: Participant;
  /** Open a task. A note id is given when a note led there, so it is marked opened. */
  onOpenTask: (taskId: string, noteId?: string) => void;
  onOpenPerson: (participantId: string) => void;
  onClose: () => void;
}) {
  const { office } = view;
  const waiting = waitingFor(office, viewer, view.viewer.permissions.includes("decide_reviews"));
  const notes = notesFor(office, viewer).slice(0, 20);
  const unreadNotes = new Set(view.unread.notes);
  const between = notesBetweenAgents(office);
  const person = (id: string): Participant | undefined => office.participants.find((p) => p.id === id);

  // One row per conversation, the most recent first.
  const conversations = [...new Set([...view.directs].reverse().map((line) => line.withId))].flatMap((id) => {
    const other = person(id);
    const last = [...view.directs].reverse().find((line) => line.withId === id);
    return other && last ? [{ other, last, unread: view.unread.directs[id] ?? 0 }] : [];
  });
  const others = office.participants.filter((p) => p.id !== viewer.id);
  const [startWith, setStartWith] = useState(others[0]?.id ?? "");

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog inbox"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inbox-heading"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-head">
          <h2 id="inbox-heading">Inbox</h2>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>

        <section>
          <h3>Waiting for you ({waiting.length})</h3>
          {waiting.length === 0 && <div className="empty">Nothing is waiting on you.</div>}
          {waiting.map((item) => (
            <button key={item.id} type="button" className="inbox-row" onClick={() => onOpenTask(item.task.id)}>
              <span className="meta">
                {item.label} · {item.task.id}
              </span>
              <span className="body">{item.body}</span>
            </button>
          ))}
        </section>

        <section>
          <h3>Notes left for you ({notes.length})</h3>
          {notes.length === 0 && (
            <div className="empty">
              No notes. An agent leaves one when you should know something about a task that does not need an answer.
            </div>
          )}
          {notes.map((note) => (
            <button
              key={note.id}
              type="button"
              className="inbox-row"
              data-unread={unreadNotes.has(note.id)}
              onClick={() => onOpenTask(note.taskId, note.id)}
            >
              <span className="meta">
                {person(note.fromId)?.displayName ?? "Someone"} · {note.taskId}
              </span>
              <span className="body">{note.body}</span>
            </button>
          ))}
        </section>

        {(between.length > 0 || view.viewer.permissions.includes("see_everything")) && (
          <section>
            <h3>Between agents ({between.length})</h3>
            {between.length === 0 && (
              <div className="empty">
                No agent has written to another yet. An agent leaves a colleague a note when it needs something from
                them, or has something to add to a hand-over.
              </div>
            )}
            {between.slice(0, 40).map((note) => (
              <button key={note.id} type="button" className="inbox-row full" onClick={() => onOpenTask(note.taskId)}>
                <span className="meta">
                  {person(note.fromId)?.displayName ?? "An agent"} to{" "}
                  {note.audience.to === "participant" ? (person(note.audience.id)?.displayName ?? "an agent") : "an agent"} ·{" "}
                  {note.taskId}
                </span>
                <span className="body">{note.body}</span>
              </button>
            ))}
          </section>
        )}

        <section>
          <h3>Conversations ({conversations.length})</h3>
          {conversations.length === 0 && <div className="empty">You have not talked to anyone yet.</div>}
          {conversations.map(({ other, last, unread }) => (
            <button
              key={other.id}
              type="button"
              className="inbox-row"
              data-unread={unread > 0}
              onClick={() => onOpenPerson(other.id)}
            >
              <span className="meta">
                <KindBadge kind={other.kind} agentType={other.agentType} /> {other.displayName}
                {unread > 0 ? ` · ${unread} new` : ""}
              </span>
              <span className="body">
                {last.fromMe ? "You: " : ""}
                {last.body}
              </span>
            </button>
          ))}
          {others.length > 0 && (
            <form
              className="form-inline"
              onSubmit={(e) => {
                e.preventDefault();
                if (startWith) onOpenPerson(startWith);
              }}
            >
              <select aria-label="Who to write to" value={startWith} onChange={(e) => setStartWith(e.target.value)}>
                {others.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}, {p.title}
                  </option>
                ))}
              </select>
              <button type="submit" className="btn">
                Write to them
              </button>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
