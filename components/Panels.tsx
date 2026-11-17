"use client";

import type { SetupStep, SetupTab } from "../lib/setup";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ALL_SCOPES,
  DOCUMENT_LIMITS,
  hasConflict,
  inOffice,
  may,
  resolveAccess,
  type AccessContext,
  type AssumptionMessage,
  type EscalationMessage,
  type Message,
  type Office,
  type Participant,
  type QuestionMessage,
  type Room,
  type Task,
  type TaskStatus,
} from "../lib/model";
import { dayOf, eligibleOwners, nextStage, roomForStage, stageSpec, type Action } from "../lib/engine";
import { authorize } from "../lib/policy";
import { atWorkOn, deskState, waitsForPerson, type AgentLoad, type OfficeSummary } from "../lib/agentState";
import { taskLabel, withTaskLabels } from "../lib/taskLabels";
import { TaskText } from "./TaskText";
import { KindBadge, statusOf, URGENT_ACCENT } from "./TaskCard";

export { KindBadge };
import type { DirectLine, FeedEntry, OfficeView, TokenView } from "../lib/view";

/** The work list offers search and these filters once it holds more tasks than this. */
const WORK_FILTER_FROM = 5;

type WorkFilter = "all" | "you" | "moving" | "done";

/** Ways to narrow the work list, by what a person would be looking for. */
const WORK_FILTERS: Record<WorkFilter, { label: string; hint: string; keeps: (task: Task, load: AgentLoad) => boolean }> = {
  all: { label: "All", hint: "Every task", keeps: () => true },
  you: {
    label: "Waiting",
    hint: "Tasks that wait for a person: a question, missing access or a review",
    keeps: waitsForPerson,
  },
  moving: {
    label: "Moving",
    hint: "Open tasks that agents are working on, or that wait for a day",
    keeps: (task, load) => task.closedAt === null && !waitsForPerson(task, load),
  },
  done: { label: "Closed", hint: "Tasks that were completed or rejected", keeps: (task) => task.closedAt !== null },
};

/**
 * The office at a glance, always in view: open work, what waits for a
 * person, who is at work and how much is closed.
 */
export function SummaryLine({ summary }: { summary: OfficeSummary }) {
  const { open, waiting, urgent, closed, agents, atWork } = summary;
  return (
    <div className="office-summary" role="group" aria-label="The office at a glance">
      <span data-zero={open === 0} title="Tasks that are not closed">
        <b>{open}</b> open
      </span>
      {urgent > 0 && (
        <span data-tone="urgent" title="Open tasks a person marked urgent">
          <b>{urgent}</b> urgent
        </span>
      )}
      <span data-zero={waiting === 0} data-tone={waiting > 0 ? "waiting" : undefined} title={WORK_FILTERS.you.hint}>
        <b>{waiting}</b> waiting for a person
      </span>
      {agents > 0 && (
        <span data-zero={atWork === 0} data-tone={atWork > 0 ? "working" : undefined} title="Agents taking a step or answering a note right now">
          <b>{atWork}</b> of {agents} {agents === 1 ? "agent" : "agents"} at work
        </span>
      )}
      <span data-zero={closed === 0} title={WORK_FILTERS.done.hint}>
        <b>{closed}</b> closed
      </span>
    </div>
  );
}

const time = (ms: number): string =>
  new Date(ms).toLocaleTimeString("en-CA", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Toronto",
  });

// ---------------------------------------------------------------------------

/** Says whether a participant is a person, an AI agent or a playbook agent. */
/** What kind of participant this is, in words. */
export const kindName = (p: Pick<Participant, "kind" | "agentType">): string =>
  p.kind === "human" ? "Human" : p.agentType === "ai" ? "AI agent" : "Playbook agent";

export function TitleCard({
  mode,
  onToggleMode,
  viewer,
  officeName,
  offices,
  onSwitchOffice,
  isDemoOffice,
  onSignOut,
  onSettings,
  onInvite,
  waitingInvites,
  onReport,
  inboxCount,
  onInbox,
}: {
  mode: "overview" | "walk";
  onToggleMode: () => void;
  viewer: OfficeView["viewer"];
  officeName: string;
  offices: OfficeView["offices"];
  onSwitchOffice: (officeId: string) => void;
  isDemoOffice: boolean;
  onSignOut: () => void;
  onSettings: () => void;
  onInvite: () => void;
  /** How many invitations nobody has accepted yet. */
  waitingInvites: number;
  /** Open the report on how the office is doing. */
  onReport: () => void;
  /** How many things in the inbox are waiting or unopened. */
  inboxCount: number;
  onInbox: () => void;
}) {
  const who = (
    <div className="who">
      <div>
        Signed in as <strong>{viewer.displayName}</strong>
        <span>{viewer.title}</span>
      </div>
      <div className="who-actions">
        <button className="btn" onClick={onInbox} data-count={inboxCount > 0}>
          Inbox{inboxCount > 0 ? ` (${inboxCount})` : ""}
        </button>
        {viewer.permissions.includes("invite_people") && (
          <button className="btn" onClick={onInvite} title={waitingInvites > 0 ? `${waitingInvites} waiting to be accepted` : undefined}>
            Invite{waitingInvites > 0 ? ` (${waitingInvites})` : ""}
          </button>
        )}
        {viewer.permissions.includes("see_everything") && (
          <button className="btn" onClick={onReport}>
            Report
          </button>
        )}
        <button className="btn" onClick={onSettings}>
          Settings
        </button>
        <button className="btn" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </div>
  );
  if (mode === "walk") {
    return (
      <div className="panel" id="title">
        <h1>Walking the office</h1>
        <div className="keys">
          <span>
            <kbd>W</kbd>
            <kbd>A</kbd>
            <kbd>S</kbd>
            <kbd>D</kbd> move
          </span>
          <span>
            <kbd>Shift</kbd> faster
          </span>
          <span>Drag to look around</span>
          <span>
            <kbd>F</kbd> talk to whoever you face
          </span>
          <span>Pick a place on the map to go there</span>
        </div>
        <button className="btn mode" onClick={onToggleMode}>
          Back to overview
        </button>
        {who}
      </div>
    );
  }
  return (
    <div className="panel" id="title">
      <h1>{officeName}</h1>
      {offices.length > 1 && (
        <select
          className="office-switch"
          aria-label="Switch office"
          value={offices.find((o) => o.active)?.officeId ?? ""}
          onChange={(e) => onSwitchOffice(e.target.value)}
        >
          {offices.map((o) => (
            <option key={o.officeId} value={o.officeId}>
              {o.name}
            </option>
          ))}
        </select>
      )}
      <p>
        Agents and people hold seats, roles and permissions. Work moves between
        rooms, and stops where someone lacks access or information.
      </p>
      <div className="legend">
        <span>
          <KindBadge kind="human" agentType={null} /> a person, rounded
        </span>
        <span>
          <KindBadge kind="agent" agentType="ai" /> an AI agent, faceted
        </span>
        <span>
          <KindBadge kind="agent" agentType="playbook" /> a playbook agent, faceted
        </span>
      </div>
      {isDemoOffice && (
        <div className="sim">The agents in this demo follow written playbooks. No model is connected.</div>
      )}
      <button className="btn primary mode" onClick={onToggleMode}>
        Walk the office
      </button>
      {who}
    </div>
  );
}

/** A typed answer to a question, for when none of the offered choices fits. */
function AnswerBox({ onSend }: { onSend: (body: string) => void }) {
  const [text, setText] = useState("");
  const ready = text.trim().length > 0;
  return (
    <form
      className="answer-box"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSend(text.trim());
      }}
    >
      <textarea
        aria-label="Your own answer"
        placeholder="Or write your own answer"
        rows={2}
        maxLength={600}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" className="btn" disabled={!ready}>
        Send answer
      </button>
    </form>
  );
}

/** The reason a reviewer gives when the work is not finished and goes back. */
function SendBackBox({ disabled, onSend }: { disabled: boolean; onSend: (comment: string) => void }) {
  const [text, setText] = useState("");
  const ready = !disabled && text.trim().length > 0;
  return (
    <form
      className="answer-box"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSend(text.trim());
      }}
    >
      <textarea
        aria-label="What has to change"
        placeholder="Or say what has to change"
        rows={2}
        maxLength={600}
        disabled={disabled}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" className="btn" disabled={!ready}>
        Send back
      </button>
    </form>
  );
}

/**
 * Read files a person picked as text. A file that is too long, empty or not
 * text is turned away with the reason, so nothing reaches the office cut or
 * garbled.
 */
async function readDocuments(files: FileList | null): Promise<{ read: { name: string; body: string }[]; problem: string | null }> {
  const read: { name: string; body: string }[] = [];
  for (const file of Array.from(files ?? [])) {
    const body = await file.text();
    const name = file.name.slice(0, DOCUMENT_LIMITS.name);
    if (body.trim().length === 0) return { read, problem: `${file.name} is empty.` };
    if (/[\u0000-\u0008\u000e-\u001f]/.test(body)) {
      return { read, problem: `${file.name} is not a text file. Text, CSV, Markdown and saved emails can be attached.` };
    }
    if (body.length > DOCUMENT_LIMITS.characters) {
      return { read, problem: `${file.name} is ${body.length.toLocaleString("en-CA")} characters long. The most a document can be is ${DOCUMENT_LIMITS.characters.toLocaleString("en-CA")}.` };
    }
    read.push({ name, body });
  }
  return { read, problem: null };
}

/** A control for picking text files, with whatever went wrong said beneath it. */
function DocumentPicker({
  label,
  room,
  onPicked,
}: {
  label: string;
  /** How many more documents can still be added. */
  room: number;
  onPicked: (documents: { name: string; body: string }[]) => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="document-picker">
      <label className="btn">
        {label}
        <input
          type="file"
          multiple
          accept=".txt,.csv,.md,.eml,.log,.json,.tsv,text/*"
          onChange={(e) => {
            const input = e.currentTarget;
            void readDocuments(input.files).then(({ read, problem: found }) => {
              const fits = read.slice(0, room);
              setProblem(found ?? (read.length > room ? `Only ${room} more can be attached, so the rest were left out.` : null));
              if (fits.length > 0) onPicked(fits);
              input.value = "";
            });
          }}
        />
      </label>
      {problem && <div className="document-problem">{problem}</div>}
    </div>
  );
}

const SAMPLE_REQUEST = {
  title: "Dealer order 4502: 4x multi-zone heads",
  detail:
    "Northline Mechanical asks for four multi-zone heads with dealer pricing and confirmed availability. No branch named.",
};

function RequestForm({
  sample,
  intakeRoomName,
  onSubmit,
  onCancel,
}: {
  /** Start from the demo's sample order. Only the demo office does. */
  sample: boolean;
  intakeRoomName: string;
  onSubmit: (title: string, detail: string, urgent: boolean, documents: { name: string; body: string }[]) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(sample ? SAMPLE_REQUEST.title : "");
  const [detail, setDetail] = useState(sample ? SAMPLE_REQUEST.detail : "");
  const [urgent, setUrgent] = useState(false);
  const [attached, setAttached] = useState<{ name: string; body: string }[]>([]);
  const ready = title.trim().length > 0 && detail.trim().length > 0;

  return (
    <form
      className="request-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSubmit(title.trim(), detail.trim(), urgent, attached);
      }}
    >
      <label htmlFor="request-title">Title</label>
      <input
        id="request-title"
        value={title}
        maxLength={90}
        placeholder={sample ? undefined : "A short name for the request"}
        onChange={(e) => setTitle(e.target.value)}
      />
      <label htmlFor="request-detail">{sample ? "What the dealer asked for" : "Details"}</label>
      <textarea
        id="request-detail"
        value={detail}
        rows={4}
        maxLength={2000}
        placeholder={sample ? undefined : "What is needed, and anything the office should know"}
        onChange={(e) => setDetail(e.target.value)}
      />
      {attached.length > 0 && (
        <ul className="document-list">
          {attached.map((d, index) => (
            <li key={`${d.name}-${index}`}>
              <span>
                {d.name}
                <span className="document-size">{d.body.length.toLocaleString("en-CA")} characters</span>
              </span>
              <button type="button" className="btn" onClick={() => setAttached(attached.filter((_, i) => i !== index))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {attached.length < DOCUMENT_LIMITS.perTask && (
        <DocumentPicker
          label="Attach a text document"
          room={DOCUMENT_LIMITS.perTask - attached.length}
          onPicked={(more) => setAttached([...attached, ...more])}
        />
      )}
      <label className="urgent-box">
        <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
        Urgent. Agents take it ahead of their other work.
      </label>
      {sample && (
        <div className="hint">
          The agents in this demo follow playbooks written for a dealer order like this one.
        </div>
      )}
      <button type="submit" className="btn primary" disabled={!ready}>
        Send to {intakeRoomName}
      </button>
      <button type="button" className="btn" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

export function TaskList({
  tasks,
  agentLoad,
  selectedId,
  onSelect,
  onSubmit,
  submitBlocked,
  isDemoOffice,
  intakeRoomName,
}: {
  /** What each agent is on now. A task an agent is on does not count as waiting for a person. */
  agentLoad: AgentLoad;
  isDemoOffice: boolean;
  /** The room new requests arrive in. */
  intakeRoomName: string;
  tasks: Task[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Resolves to whether the request was accepted. */
  onSubmit: (title: string, detail: string, urgent: boolean, documents: { name: string; body: string }[]) => Promise<boolean>;
  /** Why this viewer cannot file a request, or null when they can. */
  submitBlocked: string | null;
}) {
  const [composing, setComposing] = useState(false);
  const [search, setSearch] = useState("");
  const [show, setShow] = useState<WorkFilter>("all");
  const list = useRef<HTMLDivElement>(null);
  // A task opened from somewhere else is brought into view in the list. If
  // the search or the filter is hiding it, they are cleared first.
  useEffect(() => {
    if (!selectedId) return;
    const row = (): Element | null | undefined => list.current?.querySelector('.task[data-selected="true"]');
    if (!row() && tasks.some((t) => t.id === selectedId)) {
      setSearch("");
      setShow("all");
    }
    const shown = window.requestAnimationFrame(() => row()?.scrollIntoView({ block: "nearest" }));
    return () => window.cancelAnimationFrame(shown);
    // Only a change of task moves the list. New messages must not.
  }, [selectedId]);
  // A handful of tasks need no finding. The controls appear once there are more.
  const crowded = tasks.length > WORK_FILTER_FROM;
  const wanted = search.trim().toLowerCase();
  // Open urgent tasks lead the list. Everything else keeps the order it was filed in.
  const leading = (task: Task): number => (task.urgent && task.closedAt === null ? 0 : 1);
  const ordered = [...tasks].sort((a, b) => leading(a) - leading(b));
  const listed = crowded
    ? ordered.filter(
        (task) =>
          WORK_FILTERS[show].keeps(task, agentLoad) &&
          (wanted === "" || `${taskLabel({ tasks }, task.id)} ${task.title} ${task.detail}`.toLowerCase().includes(wanted)),
      )
    : ordered;

  return (
    <div className="panel" id="tasks">
      <div className="panel-head">
        <span>Work in the office</span>
        <span>{tasks.filter((t) => t.closedAt === null).length} open</span>
      </div>
      <div className="panel-body" ref={list}>
        {composing ? (
          <RequestForm
            sample={isDemoOffice}
            intakeRoomName={intakeRoomName}
            onSubmit={(title, detail, urgent, documents) => {
              // The form stays open with its text when the request is refused.
              void onSubmit(title, detail, urgent, documents).then((accepted) => {
                if (accepted) setComposing(false);
              });
            }}
            onCancel={() => setComposing(false)}
          />
        ) : (
          <button
            className="btn new-request"
            disabled={submitBlocked !== null}
            title={submitBlocked ?? undefined}
            onClick={() => setComposing(true)}
          >
            New request
          </button>
        )}
        {crowded && (
          <div className="work-find">
            <input
              type="search"
              aria-label="Find a task"
              placeholder="Find a task"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        )}
        {crowded && (
          // Its own child of the scrolling list, so that it stays in view while the tasks pass under it.
          <div className="work-filters" role="group" aria-label="Which tasks to list">
            {(Object.keys(WORK_FILTERS) as WorkFilter[]).map((id) => (
              <button key={id} type="button" title={WORK_FILTERS[id].hint} aria-pressed={show === id} onClick={() => setShow(id)}>
                {WORK_FILTERS[id].label} {tasks.filter((task) => WORK_FILTERS[id].keeps(task, agentLoad)).length}
              </button>
            ))}
          </div>
        )}
        {crowded && listed.length === 0 && <div className="empty">No task matches.</div>}
        {listed.map((task) => {
          const s = statusOf(task);
          return (
            <button
              key={task.id}
              className="task"
              data-selected={selectedId === task.id}
              style={{ ["--accent" as string]: s.accent }}
              onClick={() => onSelect(task.id)}
            >
              <div className="id">{taskLabel({ tasks }, task.id)}</div>
              <div className="t">{task.title}</div>
              <span className="chip" style={{ ["--accent" as string]: s.accent }}>
                {s.label}
              </span>
              {task.urgent && task.closedAt === null && (
                <span className="chip urgent" style={{ ["--accent" as string]: URGENT_ACCENT }}>
                  urgent
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Feed({ feed, office }: { feed: FeedEntry[]; office: Office }) {
  return (
    <div className="panel" id="feed">
      <div className="panel-head">
        <span>Activity</span>
      </div>
      <div className="panel-body">
        {feed.length === 0 && <div className="empty">Nothing yet.</div>}
        {feed.map((e) => (
          <div key={e.id} className="feed-row">
            <TaskText office={office} text={e.text} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Inspector({
  office,
  ctx,
  task,
  participant,
  viewer,
  hiddenMessages,
  tokens,
  accounts,
  directs,
  onTalk,
  talkFocus,
  pending,
  dispatch,
  onTokenOperation,
  setup,
  keepRecord,
  agentLoad,
  onClear,
}: {
  /** What each agent is on and has waiting, to say who is at work on a task. */
  agentLoad: OfficeView["agentLoad"];
  /** Adds a line to a room's records. Null when the viewer may not manage rooms. */
  keepRecord: KeepRecord | null;
  /** What a new office still needs, for whoever is setting it up. */
  setup: { steps: SetupStep[]; onOpen: (tab: SetupTab) => void } | null;
  office: Office;
  ctx: AccessContext;
  task: Task | null;
  participant: Participant | null;
  /** The signed-in person. Decides which controls are live. */
  viewer: Participant;
  hiddenMessages: OfficeView["hiddenMessages"];
  tokens: TokenView[];
  accounts: OfficeView["accounts"];
  /** The viewer's direct conversations. */
  directs: DirectLine[];
  onTalk: (toId: string, body: string) => Promise<boolean>;
  /** Changes each time the message box should take the keyboard. */
  talkFocus: number;
  pending: boolean;
  dispatch: (a: Action) => void;
  onTokenOperation: (tokenId: string, operation: "reveal" | "revoke") => void;
  onClear: () => void;
}) {
  if (task) {
    return (
      <TaskInspector
        // A task opened from elsewhere starts at its top, not where the last one was left.
        key={task.id}
        office={office}
        ctx={ctx}
        task={task}
        viewer={viewer}
        hidden={hiddenMessages[task.id] ?? 0}
        dispatch={dispatch}
        keepRecord={keepRecord}
        atWork={atWorkOn(task.id, agentLoad, (id) => office.participants.find((p) => p.id === id)?.displayName ?? "An agent")}
        onClear={onClear}
      />
    );
  }
  if (participant) {
    return (
      <ParticipantInspector
        office={office}
        ctx={ctx}
        participant={participant}
        viewer={viewer}
        tokens={tokens.filter((t) => t.participantId === participant.id)}
        account={accounts.find((a) => a.participantId === participant.id) ?? null}
        chat={directs.filter((line) => line.withId === participant.id)}
        onTalk={(body) => onTalk(participant.id, body)}
        talkFocus={talkFocus}
        pending={pending}
        onTokenOperation={onTokenOperation}
        onClear={onClear}
      />
    );
  }
  if (setup) {
    const left = setup.steps.filter((s) => !s.done && !s.optional).length;
    return (
      <div className="panel" id="inspector">
        <div className="panel-head">
          <span>Setting up this office</span>
        </div>
        <div className="panel-body">
          <p className="setup-lead">
            {left === 1
              ? "Everything is in place. File a request and the office starts work."
              : "Work runs once each stage has a room, a role that may work there and an agent to take it."}
          </p>
          <ol className="setup-steps">
            {setup.steps.map((step) => (
              <li key={step.id} data-done={step.done}>
                <div className="setup-label">
                  <span className="setup-mark" aria-hidden="true" />
                  <span>
                    <span className="visually-hidden">{step.done ? "Done: " : "To do: "}</span>
                    {step.label}
                    {step.optional && !step.done ? " (optional)" : ""}
                  </span>
                </div>
                <div className="setup-detail">{step.detail}</div>
                {step.tab && !step.done && (
                  <button className="btn" onClick={() => setup.onOpen(step.tab!)}>
                    Open in Settings
                  </button>
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>
    );
  }
  return (
    <div className="panel" id="inspector" data-empty="true">
      <div className="panel-head">
        <span>Inspector</span>
      </div>
      <div className="panel-body">
        <div className="empty">
          Pick a task from the work list, or click someone in the office.
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function TaskInspector({
  office,
  ctx,
  task,
  viewer,
  hidden,
  dispatch,
  keepRecord,
  atWork,
  onClear,
}: {
  office: Office;
  ctx: AccessContext;
  task: Task;
  viewer: Participant;
  /** Messages on this task the viewer is not allowed to read. */
  hidden: number;
  dispatch: (a: Action) => void;
  keepRecord: KeepRecord | null;
  /** Who is working on this task at the moment, one line each. */
  atWork: string[];
  onClear: () => void;
}) {
  // A record is kept in a room, so only rooms this person reads are offered.
  const recordRooms = useMemo(
    () =>
      keepRecord
        ? office.floorplan.rooms.filter((r) => !r.corridor && resolveAccess(viewer, r.id, "read", ctx).effect === "allow")
        : [],
    [keepRecord, office.floorplan.rooms, viewer, ctx],
  );
  const name = (id: string): string =>
    office.participants.find((p) => p.id === id)?.displayName ?? id;

  const thread = useMemo(
    () =>
      office.messages
        .filter((m) => m.taskId === task.id)
        .sort((a, b) => a.at - b.at),
    [office.messages, task.id],
  );

  const openQuestion = thread.find(
    (m): m is QuestionMessage =>
      m.kind === "question" && task.openQuestionIds.includes(m.id),
  );

  const escalation = [...thread]
    .reverse()
    .find(
      (m): m is EscalationMessage =>
        m.kind === "escalation" && m.cause === "permission",
    );

  const assumptions = thread.filter(
    (m): m is AssumptionMessage => m.kind === "assumption",
  );

  // Actions are sent as the signed-in person. The server stamps the real
  // actor, so these ids only keep the action well formed.
  const supervisor = viewer;
  const mayManageAccess = may(office, viewer, "manage_access");
  const mayReassign = may(office, viewer, "reassign_work");
  const mayDecide = may(office, viewer, "decide_reviews");
  const mayAdvance = authorize(office, ctx, viewer, { type: "ADVANCE", taskId: task.id });
  const mayMark = authorize(office, ctx, viewer, { type: "SET_URGENT", taskId: task.id, urgent: true, byId: viewer.id });
  const mayAttach = authorize(office, ctx, viewer, { type: "ADD_DOCUMENT", taskId: task.id, name: "-", body: "-", byId: viewer.id });

  const target = nextStage(task.stage);
  const targetRoom = target ? (roomForStage(office, target) ?? task.roomId) : null;
  const alternatives = targetRoom
    ? eligibleOwners(office, targetRoom, ctx).filter(
        (p) => p.kind === "agent" && p.id !== task.ownerId,
      )
    : [];

  const owner = office.participants.find((p) => p.id === task.ownerId) ?? null;

  const mayAnswer = openQuestion
    ? authorize(office, ctx, viewer, {
        type: "ANSWER_QUESTION",
        questionId: openQuestion.id,
        answeredById: viewer.id,
        body: "-",
      }).allowed
    : false;

  const s = statusOf(task);
  // Review is closed by a person's decision. Any open, unblocked task at
  // that stage is waiting for one.
  const awaitingDecision =
    task.closedAt === null &&
    !task.windUp &&
    task.stage !== "done" &&
    stageSpec(task.stage).humanGate === true &&
    (task.status === "in_review" || task.status === "in_progress");
  const canAdvance =
    mayAdvance.allowed &&
    task.closedAt === null &&
    task.status !== "blocked_question" &&
    task.status !== "blocked_permission" &&
    !task.windUp &&
    !awaitingDecision;
  const needsSupervisor =
    (task.status === "blocked_permission" && !mayManageAccess) || (awaitingDecision && !mayDecide);

  return (
    <div className="panel" id="inspector">
      <div className="panel-head">
        <span>{taskLabel(office, task.id)}</span>
        <button className="btn" style={{ padding: "2px 7px", margin: 0 }} onClick={onClear}>
          close
        </button>
      </div>
      <div className="panel-body">
        <div className="sec">
          <div style={{ fontSize: 13, marginBottom: 7, lineHeight: 1.35 }}>{task.title}</div>
          <span className="chip" style={{ ["--accent" as string]: s.accent }}>
            {s.label}
          </span>
          {task.urgent && task.closedAt === null && (
            <span className="chip urgent" style={{ ["--accent" as string]: URGENT_ACCENT }}>
              urgent
            </span>
          )}
          <div style={{ marginTop: 9 }}>
            <div className="kv">
              <span>Stage</span>
              <span>{stageSpec(task.stage).label}</span>
            </div>
            <div className="kv">
              <span>Room</span>
              <span>{office.floorplan.rooms.find((r) => r.id === task.roomId)?.name ?? task.roomId}</span>
            </div>
            <div className="kv">
              <span>Owner</span>
              <span>
                {owner && <KindBadge kind={owner.kind} agentType={owner.agentType} />}{" "}
                {task.ownerId ? name(task.ownerId) : "Unassigned"}
              </span>
            </div>
            <div className="kv">
              <span>Requested by</span>
              <span>
                {name(task.requestedById)}
                {office.participants.some((p) => p.id === task.requestedById && !inOffice(p)) ? " (left the office)" : ""}
              </span>
            </div>
          </div>
          {atWork.length > 0 && (
            <div className="at-work" aria-live="polite">
              {atWork.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          )}
        </div>

        {((task.documents?.length ?? 0) > 0 || (task.closedAt === null && mayAttach.allowed)) && (
          <div className="sec">
            <h3>Documents ({task.documents?.length ?? 0})</h3>
            {(task.documents ?? []).map((d) => (
              <details key={d.id} className="document">
                <summary>
                  {d.name}
                  <span className="document-size">
                    {d.body.length.toLocaleString("en-CA")} characters, from {name(d.addedById)}
                  </span>
                </summary>
                <pre>{d.body}</pre>
              </details>
            ))}
            {task.closedAt === null && mayAttach.allowed && (
              <DocumentPicker
                label="Attach a text document"
                room={DOCUMENT_LIMITS.perTask - (task.documents?.length ?? 0)}
                onPicked={(more) => {
                  for (const d of more) dispatch({ type: "ADD_DOCUMENT", taskId: task.id, name: d.name, body: d.body, byId: supervisor.id });
                }}
              />
            )}
          </div>
        )}

        {/* ---- what a human can do about it right now ---- */}
        <div className="sec">
          <h3>Your move</h3>

          {openQuestion && (
            <fieldset className="moves" disabled={!mayAnswer}>
              <div className="note q">
                <div className="meta">
                  {openQuestion.fromId === "system" ? "The office" : name(openQuestion.fromId as string)} is waiting
                </div>
                <TaskText office={office} text={openQuestion.body} />
              </div>
              {(openQuestion.options ?? ["Confirmed"]).map((opt) => (
                <button
                  key={opt}
                  className="btn primary"
                  onClick={() =>
                    dispatch({
                      type: "ANSWER_QUESTION",
                      questionId: openQuestion.id,
                      answeredById: supervisor.id,
                      body: opt,
                      chosenOption: opt,
                    })
                  }
                >
                  {opt}
                </button>
              ))}
              <AnswerBox
                key={openQuestion.id}
                onSend={(body) =>
                  dispatch({
                    type: "ANSWER_QUESTION",
                    questionId: openQuestion.id,
                    answeredById: supervisor.id,
                    body,
                  })
                }
              />
            </fieldset>
          )}

          {task.status === "blocked_permission" && escalation?.deniedDecision && (
            <fieldset className="moves" disabled={!mayManageAccess && !mayReassign}>
              <div className="note esc">
                <div className="meta">{name(escalation.fromId as string)} is blocked</div>
                <TaskText office={office} text={escalation.body} />
              </div>
              <button
                className="btn primary"
                disabled={!mayManageAccess}
                onClick={() =>
                  dispatch({
                    type: "GRANT_ACCESS",
                    participantId: escalation.deniedDecision!.participantId,
                    room: escalation.deniedDecision!.room,
                    scopes: [escalation.deniedDecision!.scope],
                    effect: "allow",
                    reason: `Granted for ${taskLabel(office, task.id)}`,
                    grantedBy: supervisor.id,
                    expiresOnTaskId: task.id,
                  })
                }
              >
                Grant {escalation.deniedDecision.scope} on{" "}
                {office.floorplan.rooms.find((r) => r.id === escalation.deniedDecision!.room)?.name ??
                  escalation.deniedDecision.room}
                , for this task only
              </button>
              {escalation.deniedDecision.overrode
                .filter((o) => o.kind === "individual" && o.effect === "deny")
                .map((o) => (
                  <button
                    key={o.kind === "individual" ? o.ruleId : "x"}
                    className="btn warn"
                    disabled={!mayManageAccess}
                    onClick={() =>
                      dispatch({
                        type: "REVOKE_RULE",
                        ruleId: o.kind === "individual" ? o.ruleId : "",
                        revokedBy: supervisor.id,
                      })
                    }
                  >
                    Revoke {o.kind === "individual" ? o.ruleId : ""}
                  </button>
                ))}
              {escalation.deniedDecision.decidedBy.kind === "individual" &&
                escalation.deniedDecision.decidedBy.effect === "deny" && (
                  <button
                    className="btn warn"
                    disabled={!mayManageAccess}
                    onClick={() =>
                      dispatch({
                        type: "REVOKE_RULE",
                        ruleId:
                          escalation.deniedDecision!.decidedBy.kind === "individual"
                            ? escalation.deniedDecision!.decidedBy.ruleId
                            : "",
                        revokedBy: supervisor.id,
                      })
                    }
                  >
                    Revoke the blocking rule
                  </button>
                )}
              {alternatives.map((p) => (
                <button
                  key={p.id}
                  className="btn"
                  disabled={!mayReassign}
                  onClick={() =>
                    dispatch({
                      type: "REASSIGN",
                      taskId: task.id,
                      toParticipantId: p.id,
                      byId: supervisor.id,
                    })
                  }
                >
                  Hand to {p.displayName}
                </button>
              ))}
            </fieldset>
          )}

          {awaitingDecision && (
            <fieldset className="moves" disabled={!mayDecide}>
              <button
                className="btn primary"
                onClick={() =>
                  dispatch({
                    type: "DECIDE",
                    taskId: task.id,
                    byId: supervisor.id,
                    verdict: "approved",
                  })
                }
              >
                Approve
              </button>
              <button
                className="btn warn"
                onClick={() =>
                  dispatch({
                    type: "DECIDE",
                    taskId: task.id,
                    byId: supervisor.id,
                    verdict: "rejected",
                  })
                }
              >
                Reject
              </button>
            </fieldset>
          )}
          {awaitingDecision && (
            <SendBackBox
              disabled={!mayDecide}
              onSend={(comment) =>
                dispatch({
                  type: "DECIDE",
                  taskId: task.id,
                  byId: supervisor.id,
                  verdict: "changes_requested",
                  comment,
                })
              }
            />
          )}

          {task.wait && task.closedAt === null && (
            <div className="waiting">
              <p>
                Waiting until {dayOf(task.wait.until)}. {task.wait.reason}
              </p>
              <button
                className="btn"
                disabled={!mayAdvance.allowed}
                title={mayAdvance.allowed ? undefined : mayAdvance.reason}
                onClick={() => dispatch({ type: "WAKE_TASK", taskId: task.id })}
              >
                Carry on now
              </button>
            </div>
          )}

          {task.closedAt === null && (
            <button
              className="btn"
              disabled={!mayMark.allowed}
              title={mayMark.allowed ? "Agents take urgent work ahead of everything else on their queues" : mayMark.reason}
              onClick={() => dispatch({ type: "SET_URGENT", taskId: task.id, urgent: !task.urgent, byId: supervisor.id })}
            >
              {task.urgent ? "Not urgent after all" : "Mark urgent"}
            </button>
          )}

          {task.windUp && task.closedAt === null && (
            <div className="waiting">
              <p>
                {task.status === "blocked_question"
                  ? "This task was rejected. It closes once what it had already done is settled, and that waits for an answer."
                  : "This task was rejected. The agents that acted on it are dealing with what it had already done, and it closes once that is settled."}
              </p>
            </div>
          )}

          {!task.windUp && (
            <button
              className="btn"
              disabled={!canAdvance}
              title={mayAdvance.allowed ? undefined : mayAdvance.reason}
              onClick={() => dispatch({ type: "ADVANCE", taskId: task.id })}
            >
              {target ? `Advance to ${stageSpec(target).label}` : "Advance"}
            </button>
          )}

          {needsSupervisor && (
            <div className="empty">This needs someone with a supervising role.</div>
          )}
          {!needsSupervisor && !mayAdvance.allowed && task.closedAt === null && (
            <div className="empty">{mayAdvance.reason}</div>
          )}

          {task.closedAt !== null && (
            <div className="empty">Closed at {time(task.closedAt)}. Nothing to do.</div>
          )}
        </div>

        {/* ---- assumptions ---- */}
        <div className="sec">
          <h3>Assumptions ({assumptions.length})</h3>
          {assumptions.length === 0 && <div className="empty">None recorded.</div>}
          {assumptions.map((a) => (
            <div key={a.id} className="note">
              <div className="meta">
                {name(a.fromId as string)} · {a.confidence} confidence ·{" "}
                <span
                  style={{
                    color:
                      a.status === "contradicted"
                        ? "#eba294"
                        : a.status === "confirmed"
                          ? "#7fc39a"
                          : undefined,
                  }}
                >
                  {a.status}
                </span>
              </div>
              <div style={{ marginBottom: 3 }}>{a.assumed}</div>
              <div style={{ fontSize: 10, opacity: 0.6 }}>because {a.because}</div>
              {a.status === "open" && task.closedAt === null && (
                <fieldset className="moves" disabled={!mayAdvance.allowed} style={{ marginTop: 6 }}>
                  <button
                    className="btn"
                    style={{ fontSize: 10, padding: "3px 7px" }}
                    onClick={() =>
                      dispatch({
                        type: "RESOLVE_ASSUMPTION",
                        assumptionId: a.id,
                        status: "confirmed",
                        byId: supervisor.id,
                      })
                    }
                  >
                    Confirm
                  </button>
                  <button
                    className="btn warn"
                    style={{ fontSize: 10, padding: "3px 7px" }}
                    onClick={() =>
                      dispatch({
                        type: "RESOLVE_ASSUMPTION",
                        assumptionId: a.id,
                        status: "contradicted",
                        byId: supervisor.id,
                      })
                    }
                  >
                    That's wrong
                  </button>
                </fieldset>
              )}
            </div>
          ))}
        </div>

        {/* ---- the conversation ---- */}
        <div className="sec">
          <h3>Thread</h3>
          {hidden > 0 && (
            <div className="withheld">
              {hidden} message{hidden === 1 ? "" : "s"} said in rooms you cannot read{" "}
              {hidden === 1 ? "is" : "are"} not shown.
            </div>
          )}
          {thread.map((m) => (
            <ThreadLine key={m.id} message={m} name={name} keepRecord={keepRecord} rooms={recordRooms} office={office} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Adds one line to a room's records and says whether it was taken. */
type KeepRecord = (roomId: string, record: string) => Promise<boolean>;

const RECORD_LENGTH = 300;

/**
 * Turns something said on a task into a record of a room, so that whoever
 * works there later is told it. The person chooses the words and the room.
 */
function KeepBox({
  message,
  rooms,
  office,
  keepRecord,
  onDone,
}: {
  office: Office;
  message: Message;
  rooms: Room[];
  keepRecord: KeepRecord;
  onDone: (keptIn: string | null) => void;
}) {
  const [text, setText] = useState(withTaskLabels(office, message.body).replace(/\s+/g, " ").trim().slice(0, RECORD_LENGTH));
  const [roomId, setRoomId] = useState(rooms.some((r) => r.id === message.roomId) ? message.roomId : (rooms[0]?.id ?? ""));
  const [saving, setSaving] = useState(false);
  const ready = !saving && roomId !== "" && text.trim().length > 0;
  return (
    <form
      className="answer-box keep-box"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setSaving(true);
        void keepRecord(roomId, text.trim()).then((kept) => {
          setSaving(false);
          if (kept) onDone(rooms.find((r) => r.id === roomId)?.name ?? null);
        });
      }}
    >
      <textarea
        aria-label="The record to keep"
        rows={3}
        maxLength={RECORD_LENGTH}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="keep-row">
        <label>
          Keep in{" "}
          <select aria-label="Room" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <span className="count">
          {text.length} of {RECORD_LENGTH}
        </span>
      </div>
      <div className="keep-row">
        <button type="submit" className="btn primary" disabled={!ready}>
          Keep record
        </button>
        <button type="button" className="btn" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
      <div className="hint">Everyone who reads that room, agents included, is shown its records while working there.</div>
    </form>
  );
}

function ThreadLine({
  message,
  name,
  keepRecord,
  rooms,
  office,
}: {
  message: Message;
  name: (id: string) => string;
  keepRecord: KeepRecord | null;
  /** The rooms a record can be kept in. */
  rooms: Room[];
  office: Office;
}) {
  const [keeping, setKeeping] = useState(false);
  const [keptIn, setKeptIn] = useState<string | null>(null);
  const keepable = keepRecord !== null && rooms.length > 0 && (message.kind === "output" || message.kind === "answer");
  // Kept earlier, word for word: say so in place of offering it again.
  const asRecord = withTaskLabels(office, message.body).replace(/\s+/g, " ").trim();
  const kept = keptIn ?? (keepable ? (rooms.find((r) => r.records.includes(asRecord))?.name ?? null) : null);
  const cls =
    message.kind === "question"
      ? "q"
      : message.kind === "answer"
        ? "a"
        : message.kind === "escalation"
          ? "esc"
          : message.kind === "output"
            ? "out"
            : "";
  return (
    <div className={`note ${cls}`}>
      <div className="meta">
        {time(message.at)} · {message.fromId === "system" ? "the office" : name(message.fromId)} ·{" "}
        {message.kind === "note" && message.audience.to === "participant"
          ? `note for ${name(message.audience.id)}`
          : message.kind}
        {message.kind === "output" && message.simulated && (
          <span style={{ color: "#e0a23f" }}>from a playbook</span>
        )}
        {keepable && !keeping && kept && <span className="kept">Kept in {kept}</span>}
        {keepable && !keeping && !kept && (
          <button type="button" className="keep" onClick={() => setKeeping(true)}>
            Keep as a record
          </button>
        )}
      </div>
      <TaskText office={office} text={message.body} />
      {keepable && keeping && keepRecord && (
        <KeepBox
          office={office}
          message={message}
          rooms={rooms}
          keepRecord={keepRecord}
          onDone={(room) => {
            setKeeping(false);
            if (room) setKeptIn(room);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * A direct conversation with one person or agent. With an agent it happens at
 * the agent's desk and the agent answers at once. It changes nothing else.
 */
function TalkBox({
  other,
  lines,
  cannotEnter,
  pending,
  focus,
  onSend,
}: {
  other: Participant;
  lines: DirectLine[];
  /** The room the viewer may not enter, when that stops them talking to an agent. */
  cannotEnter: string | null;
  pending: boolean;
  focus: number;
  onSend: (body: string) => Promise<boolean>;
}) {
  const gone = !inOffice(other);
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const ready = text.trim().length > 0 && !pending;
  const isAgent = other.kind === "agent";

  useEffect(() => {
    if (focus > 0) box.current?.focus();
  }, [focus]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [lines.length]);

  const send = () => {
    if (!ready) return;
    void onSend(text.trim()).then((sent) => {
      if (sent) setText("");
    });
  };

  return (
    <div className="sec">
      <h3>{isAgent ? `Talk to ${other.displayName}` : gone ? `Messages with ${other.displayName}` : `Message ${other.displayName}`}</h3>
      {isAgent && cannotEnter ? (
        <div className="empty">
          You cannot enter {cannotEnter}, so you cannot talk to {other.displayName} at their desk.
        </div>
      ) : (
        <>
          {lines.length === 0 ? (
            <div className="empty">
              {gone
                ? `You and ${other.displayName} did not write to each other.`
                : !isAgent
                ? `Write to ${other.displayName}. Only the two of you can read it.`
                : other.agentType === "ai"
                  ? `Ask ${other.displayName} about its work or what it can see. It answers from what you may both read, and changes nothing.`
                  : `${other.displayName} follows a playbook. Ask and it reports where its work stands.`}
            </div>
          ) : (
            <div className="talk-thread">
              {lines.map((line) => (
                <div key={line.id} className="talk-line" data-from={line.fromMe ? "you" : "other"}>
                  <span className="who">{line.fromMe ? "You" : other.displayName}</span>
                  {line.body}
                </div>
              ))}
              <div ref={end} />
            </div>
          )}
          {gone && <div className="empty">{other.displayName} has left the office, so nothing more can be sent.</div>}
          <form
            className="answer-box"
            hidden={gone}
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <textarea
              ref={box}
              aria-label={`Message to ${other.displayName}`}
              placeholder={isAgent ? `Say something to ${other.displayName}` : `Write to ${other.displayName}`}
              rows={2}
              maxLength={600}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button type="submit" className="btn" disabled={!ready}>
              {pending ? "Waiting..." : "Send"}
            </button>
          </form>
        </>
      )}
    </div>
  );
}

function ParticipantInspector({
  office,
  ctx,
  participant,
  viewer,
  tokens,
  account,
  chat,
  onTalk,
  talkFocus,
  pending,
  onTokenOperation,
  onClear,
}: {
  office: Office;
  ctx: AccessContext;
  participant: Participant;
  viewer: Participant;
  tokens: TokenView[];
  account: OfficeView["accounts"][number] | null;
  chat: DirectLine[];
  onTalk: (body: string) => Promise<boolean>;
  talkFocus: number;
  pending: boolean;
  onTokenOperation: (tokenId: string, operation: "reveal" | "revoke") => void;
  onClear: () => void;
}) {
  const viewerSupervises = may(office, viewer, "manage_access");
  const roomName = (id: string | null): string =>
    id === null ? "Every room" : (office.floorplan.rooms.find((r) => r.id === id)?.name ?? id);
  const role = office.roles[participant.roleId];
  const rooms = office.floorplan.rooms;

  const decisions = rooms.map((room) => ({
    room,
    scopes: ALL_SCOPES.map((scope) => resolveAccess(participant, room.id, scope, ctx)),
  }));
  const clashes = decisions.flatMap((d) => d.scopes.filter(hasConflict));
  const seatRoom = rooms.find((r) => r.deskIds.includes(participant.deskId ?? ""));
  const desk = deskState(office, participant);
  const cannotEnter =
    seatRoom && resolveAccess(viewer, seatRoom.id, "enter", ctx).effect !== "allow" ? seatRoom.name : null;
  // Notes this agent exchanged with other agents, newest first. Only the
  // notes the viewer may see reach the browser.
  const nameOf = (id: string): string => office.participants.find((p) => p.id === id)?.displayName ?? "someone";
  const isAgent = (id: string): boolean => office.participants.some((p) => p.id === id && p.kind === "agent");
  const agentNotes = office.messages
    .filter(
      (m) =>
        m.kind === "note" &&
        m.audience.to === "participant" &&
        isAgent(m.fromId) &&
        isAgent(m.audience.id) &&
        (m.fromId === participant.id || m.audience.id === participant.id),
    )
    .reverse();

  return (
    <div className="panel" id="inspector">
      <div className="panel-head">
        <span>{kindName(participant)}</span>
        <button className="btn" style={{ padding: "2px 7px", margin: 0 }} onClick={onClear}>
          close
        </button>
      </div>
      <div className="panel-body">
        <div className="sec">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                background: participant.appearance.color,
              }}
            />
            <span style={{ fontSize: 14 }}>
              {participant.displayName}
              {participant.id === viewer.id ? " (You)" : ""}
            </span>
            <KindBadge kind={participant.kind} agentType={participant.agentType} />
          </div>
          <div style={{ fontSize: 11, opacity: 0.6 }}>{participant.title}</div>
          <div style={{ marginTop: 9 }}>
            <div className="kv">
              <span>Role</span>
              <span>{role ? role.name : participant.roleId}</span>
            </div>
            {participant.leftAt !== undefined && (
              <div className="kv">
                <span>Left the office</span>
                <span>{dayOf(participant.leftAt)}</span>
              </div>
            )}
            {participant.kind === "agent" && participant.agentType === "ai" && (
              <div className="kv">
                <span>Model</span>
                <span style={{ color: participant.backing ? undefined : "#e0a23f" }}>
                  {participant.backing
                    ? `${participant.backing.provider} ${participant.backing.model}`
                    : "no working AI provider"}
                </span>
              </div>
            )}
            {participant.kind === "agent" && participant.agentType !== "ai" && (
              <div className="kv">
                <span>Works from</span>
                <span>
                  a playbook of {participant.playbook.length} step{participant.playbook.length === 1 ? "" : "s"}
                </span>
              </div>
            )}
          </div>
        </div>

        {inOffice(participant) && (
          <div className="sec">
            <h3>Right now</h3>
            <div className="desk-state" data-tone={desk.tone}>
              <strong>{desk.headline}</strong>
              {desk.task && <span> · {taskLabel(office, desk.task.id)}</span>}
            </div>
            <div style={{ fontSize: 11.5, opacity: 0.75, marginTop: 4 }}>{desk.detail}</div>
          </div>
        )}

        {participant.id !== viewer.id && (
          <TalkBox
            key={participant.id}
            other={participant}
            lines={chat}
            cannotEnter={cannotEnter}
            pending={pending}
            focus={talkFocus}
            onSend={onTalk}
          />
        )}

        {participant.kind === "agent" && agentNotes.length > 0 && (
          <div className="sec">
            <h3>Notes with other agents ({agentNotes.length})</h3>
            {agentNotes.slice(0, 12).map((note) => (
              <div key={note.id} className="note">
                <div className="meta">
                  {note.fromId === participant.id
                    ? `to ${nameOf(note.audience.to === "participant" ? note.audience.id : "")}`
                    : `from ${nameOf(note.fromId)}`}{" "}
                  · {taskLabel(office, note.taskId)}
                </div>
                {withTaskLabels(office, note.body)}
              </div>
            ))}
          </div>
        )}

        <div className="sec">
          <h3>Can do</h3>
          {participant.capabilities.map((c) => (
            <div key={c} className="cap">
              {c}
            </div>
          ))}
        </div>

        <div className="sec">
          <h3>Access</h3>
          {clashes.length > 0 && (
            <div className="conflict">
              <strong>
                {clashes.length} conflicting rule{clashes.length > 1 ? "s" : ""}.
              </strong>
              <br />
              {clashes[0].explanation}
            </div>
          )}
          <table className="matrix">
            <thead>
              <tr>
                <th>Room</th>
                {ALL_SCOPES.map((s) => (
                  <th key={s}>{s}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {decisions.map(({ room, scopes }) => (
                <tr key={room.id}>
                  <td>{room.name}</td>
                  {scopes.map((d) => (
                    <td
                      key={d.scope}
                      className={
                        hasConflict(d) ? "clash" : d.effect === "allow" ? "yes" : "no"
                      }
                      title={d.explanation}
                    >
                      {d.effect === "allow" ? "yes" : "no"}
                      {hasConflict(d) ? "*" : ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 9.5, opacity: 0.45, marginTop: 6 }}>
            * resolved against a competing rule. Hover for the reason.
          </div>
        </div>

        {(viewerSupervises || participant.id === viewer.id) && (
          <div className="sec">
            <h3>Permission tokens ({tokens.length})</h3>
            {tokens.length === 0 && (
              <div className="empty">None. A token is issued with each access grant.</div>
            )}
            {tokens.map((t) => (
              <div key={t.id} className="note" data-dead={t.problem !== null}>
                <div className="meta">
                  {t.scope} on {roomName(t.roomId)}
                  {t.taskId ? ` · ${taskLabel(office, t.taskId)} only` : ""} ·{" "}
                  <span style={{ color: t.problem ? "#eba294" : "#7fc39a" }}>
                    {t.problem ?? "usable"}
                  </span>
                </div>
                <div style={{ fontSize: 10.5, opacity: 0.7 }}>
                  Rule {t.ruleId}: {withTaskLabels(office, t.reason)}
                </div>
                <div style={{ marginTop: 6 }}>
                  <button
                    className="btn"
                    style={{ fontSize: 10, padding: "3px 7px" }}
                    onClick={() => onTokenOperation(t.id, "reveal")}
                  >
                    Copy token
                  </button>
                  {viewerSupervises && t.revokedAt === null && (
                    <button
                      className="btn warn"
                      style={{ fontSize: 10, padding: "3px 7px" }}
                      onClick={() => onTokenOperation(t.id, "revoke")}
                    >
                      Revoke token
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {account && (
          <div className="sec">
            <h3>Account</h3>
            <div className="kv">
              <span>Email</span>
              <span>{account.email}</span>
            </div>
            <div className="kv">
              <span>Sign-in</span>
              <span>{account.hasPassword ? "password" : "demo access, no password set"}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
