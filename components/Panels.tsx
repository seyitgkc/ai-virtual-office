"use client";

import { useMemo, useState } from "react";
import {
  ALL_SCOPES,
  hasConflict,
  resolveAccess,
  type AccessContext,
  type AssumptionMessage,
  type EscalationMessage,
  type Message,
  type Office,
  type Participant,
  type QuestionMessage,
  type Task,
  type TaskStatus,
} from "../lib/model";
import { eligibleOwners, nextStage, stageSpec, type Action } from "../lib/engine";
import type { FeedEntry } from "../lib/useOffice";

const STATUS: Record<TaskStatus, { label: string; accent: string }> = {
  requested: { label: "requested", accent: "#8a93a0" },
  in_progress: { label: "in progress", accent: "#6ea9d9" },
  blocked_question: { label: "needs an answer", accent: "#e0a23f" },
  blocked_permission: { label: "needs access", accent: "#e0614f" },
  in_review: { label: "in review", accent: "#9b8ad9" },
  completed: { label: "completed", accent: "#5fa87a" },
  rejected: { label: "rejected", accent: "#8a8a8a" },
};

const time = (ms: number): string =>
  new Date(ms).toLocaleTimeString("en-CA", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Toronto",
  });

// ---------------------------------------------------------------------------

/** Says whether a participant is a person or an AI agent. */
export function KindBadge({ kind }: { kind: Participant["kind"] }) {
  return (
    <span className="kind-badge" data-kind={kind}>
      {kind === "agent" ? "AI" : "Human"}
    </span>
  );
}

export function TitleCard({
  mode,
  onToggleMode,
}: {
  mode: "overview" | "walk";
  onToggleMode: () => void;
}) {
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
          <span>Click someone to inspect</span>
        </div>
        <button className="btn mode" onClick={onToggleMode}>
          Back to overview
        </button>
      </div>
    );
  }
  return (
    <div className="panel" id="title">
      <h1>Virtual Office</h1>
      <p>
        Agents and people hold seats, roles and permissions. Work moves between
        rooms, and stops where someone lacks access or information.
      </p>
      <div className="legend">
        <span>
          <KindBadge kind="human" /> rounded figure
        </span>
        <span>
          <KindBadge kind="agent" /> faceted, with a ring
        </span>
      </div>
      <div className="sim">Every agent here is simulated. Their replies come from a fixed script.</div>
      <button className="btn primary mode" onClick={onToggleMode}>
        Walk the office
      </button>
    </div>
  );
}

const SAMPLE_REQUEST = {
  title: "Dealer order 4502: 4x multi-zone heads",
  detail:
    "Northline Mechanical asks for four multi-zone heads with dealer pricing and confirmed availability. No branch named.",
};

function RequestForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (title: string, detail: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(SAMPLE_REQUEST.title);
  const [detail, setDetail] = useState(SAMPLE_REQUEST.detail);
  const ready = title.trim().length > 0 && detail.trim().length > 0;

  return (
    <form
      className="request-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSubmit(title.trim(), detail.trim());
      }}
    >
      <label htmlFor="request-title">Title</label>
      <input
        id="request-title"
        value={title}
        maxLength={90}
        onChange={(e) => setTitle(e.target.value)}
      />
      <label htmlFor="request-detail">What the dealer asked for</label>
      <textarea
        id="request-detail"
        value={detail}
        rows={4}
        maxLength={400}
        onChange={(e) => setDetail(e.target.value)}
      />
      <div className="hint">
        Agents are scripted, so they handle every request as a dealer order for
        multi-zone heads.
      </div>
      <button type="submit" className="btn primary" disabled={!ready}>
        Send to Reception
      </button>
      <button type="button" className="btn" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

export function TaskList({
  tasks,
  selectedId,
  onSelect,
  onSubmit,
}: {
  tasks: Task[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSubmit: (title: string, detail: string) => void;
}) {
  const [composing, setComposing] = useState(false);

  return (
    <div className="panel" id="tasks">
      <div className="panel-head">
        <span>Work in the office</span>
        <span>{tasks.filter((t) => t.closedAt === null).length} open</span>
      </div>
      <div className="panel-body">
        {composing ? (
          <RequestForm
            onSubmit={(title, detail) => {
              onSubmit(title, detail);
              setComposing(false);
            }}
            onCancel={() => setComposing(false)}
          />
        ) : (
          <button className="btn new-request" onClick={() => setComposing(true)}>
            New request
          </button>
        )}
        {tasks.map((task) => {
          const s = STATUS[task.status];
          return (
            <button
              key={task.id}
              className="task"
              data-selected={selectedId === task.id}
              style={{ ["--accent" as string]: s.accent }}
              onClick={() => onSelect(task.id)}
            >
              <div className="id">{task.id}</div>
              <div className="t">{task.title}</div>
              <span className="chip" style={{ ["--accent" as string]: s.accent }}>
                {s.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Feed({ feed }: { feed: FeedEntry[] }) {
  return (
    <div className="panel" id="feed">
      <div className="panel-head">
        <span>Activity</span>
      </div>
      <div className="panel-body">
        {feed.length === 0 && <div className="empty">Nothing yet.</div>}
        {feed.map((e) => (
          <div key={e.id} className="feed-row">
            {e.text}
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
  dispatch,
  onClear,
}: {
  office: Office;
  ctx: AccessContext;
  task: Task | null;
  participant: Participant | null;
  dispatch: (a: Action) => void;
  onClear: () => void;
}) {
  if (task) {
    return (
      <TaskInspector
        office={office}
        ctx={ctx}
        task={task}
        dispatch={dispatch}
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
        onClear={onClear}
      />
    );
  }
  return (
    <div className="panel" id="inspector">
      <div className="panel-head">
        <span>Inspector</span>
      </div>
      <div className="panel-body">
        <div className="empty">
          Pick a task on the left, or click someone in the office.
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
  dispatch,
  onClear,
}: {
  office: Office;
  ctx: AccessContext;
  task: Task;
  dispatch: (a: Action) => void;
  onClear: () => void;
}) {
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

  const supervisor =
    office.participants.find((p) => p.roleId === "supervisor") ??
    office.participants[0];

  const target = nextStage(task.stage);
  const targetRoom = target ? (stageSpec(target).roomId ?? task.roomId) : null;
  const alternatives = targetRoom
    ? eligibleOwners(office, targetRoom, ctx).filter(
        (p) => p.kind === "agent" && p.id !== task.ownerId,
      )
    : [];

  const owner = office.participants.find((p) => p.id === task.ownerId) ?? null;

  const s = STATUS[task.status];
  const canAdvance =
    task.closedAt === null &&
    task.status !== "blocked_question" &&
    task.status !== "blocked_permission" &&
    task.status !== "in_review";

  return (
    <div className="panel" id="inspector">
      <div className="panel-head">
        <span>{task.id}</span>
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
          <div style={{ marginTop: 9 }}>
            <div className="kv">
              <span>Stage</span>
              <span>{stageSpec(task.stage).label}</span>
            </div>
            <div className="kv">
              <span>Room</span>
              <span>{task.roomId}</span>
            </div>
            <div className="kv">
              <span>Owner</span>
              <span>
                {owner && <KindBadge kind={owner.kind} />}{" "}
                {task.ownerId ? name(task.ownerId) : "Unassigned"}
              </span>
            </div>
            <div className="kv">
              <span>Requested by</span>
              <span>{name(task.requestedById)}</span>
            </div>
          </div>
        </div>

        {/* ---- what a human can do about it right now ---- */}
        <div className="sec">
          <h3>Your move</h3>

          {openQuestion && (
            <>
              <div className="note q">
                <div className="meta">{name(openQuestion.fromId as string)} is waiting</div>
                {openQuestion.body}
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
            </>
          )}

          {task.status === "blocked_permission" && escalation?.deniedDecision && (
            <>
              <div className="note esc">
                <div className="meta">{name(escalation.fromId as string)} is blocked</div>
                {escalation.body}
              </div>
              <button
                className="btn primary"
                onClick={() =>
                  dispatch({
                    type: "GRANT_ACCESS",
                    participantId: escalation.deniedDecision!.participantId,
                    room: escalation.deniedDecision!.room,
                    scopes: [escalation.deniedDecision!.scope],
                    effect: "allow",
                    reason: `Granted for ${task.id}`,
                    grantedBy: supervisor.id,
                    expiresOnTaskId: task.id,
                  })
                }
              >
                Grant {escalation.deniedDecision.scope} on{" "}
                {escalation.deniedDecision.room}, for this task only
              </button>
              {escalation.deniedDecision.overrode
                .filter((o) => o.kind === "individual" && o.effect === "deny")
                .map((o) => (
                  <button
                    key={o.kind === "individual" ? o.ruleId : "x"}
                    className="btn warn"
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
            </>
          )}

          {task.status === "in_review" && (
            <>
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
            </>
          )}

          <button
            className="btn"
            disabled={!canAdvance}
            onClick={() => dispatch({ type: "ADVANCE", taskId: task.id })}
          >
            {target ? `Advance to ${stageSpec(target).label}` : "Advance"}
          </button>

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
              {a.status === "open" && (
                <div style={{ marginTop: 6 }}>
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
                </div>
              )}
            </div>
          ))}
        </div>

        {/* ---- the conversation ---- */}
        <div className="sec">
          <h3>Thread</h3>
          {thread.map((m) => (
            <ThreadLine key={m.id} message={m} name={name} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ThreadLine({
  message,
  name,
}: {
  message: Message;
  name: (id: string) => string;
}) {
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
        {time(message.at)} · {message.fromId === "system" ? "system" : name(message.fromId)} ·{" "}
        {message.kind}
        {message.kind === "output" && message.simulated && (
          <span style={{ color: "#e0a23f" }}>simulated</span>
        )}
      </div>
      {message.body}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ParticipantInspector({
  office,
  ctx,
  participant,
  onClear,
}: {
  office: Office;
  ctx: AccessContext;
  participant: Participant;
  onClear: () => void;
}) {
  const role = office.roles[participant.roleId];
  const rooms = office.floorplan.rooms;

  const decisions = rooms.map((room) => ({
    room,
    scopes: ALL_SCOPES.map((scope) => resolveAccess(participant, room.id, scope, ctx)),
  }));
  const clashes = decisions.flatMap((d) => d.scopes.filter(hasConflict));

  return (
    <div className="panel" id="inspector">
      <div className="panel-head">
        <span>{participant.kind === "agent" ? "AI agent" : "Human"}</span>
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
            <span style={{ fontSize: 14 }}>{participant.displayName}</span>
            <KindBadge kind={participant.kind} />
          </div>
          <div style={{ fontSize: 11, opacity: 0.6 }}>{participant.title}</div>
          <div style={{ marginTop: 9 }}>
            <div className="kv">
              <span>Role</span>
              <span>{role ? role.name : participant.roleId}</span>
            </div>
            <div className="kv">
              <span>Backing</span>
              <span style={{ color: participant.backing ? undefined : "#e0a23f" }}>
                {participant.backing
                  ? `${participant.backing.provider} ${participant.backing.model}`
                  : "simulated"}
              </span>
            </div>
          </div>
        </div>

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
      </div>
    </div>
  );
}
