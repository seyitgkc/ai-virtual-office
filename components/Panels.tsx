"use client";

import { useMemo, useState } from "react";
import {
  ALL_SCOPES,
  hasConflict,
  may,
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
import { eligibleOwners, nextStage, roomForStage, stageSpec, type Action } from "../lib/engine";
import { authorize } from "../lib/policy";
import type { FeedEntry, OfficeView, TokenView } from "../lib/view";

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

/** Says whether a participant is a person, an AI agent or a playbook agent. */
export function KindBadge({ kind, agentType }: Pick<Participant, "kind" | "agentType">) {
  const playbook = kind === "agent" && agentType !== "ai";
  return (
    <span className="kind-badge" data-kind={kind} data-playbook={playbook}>
      {kind === "human" ? "Human" : playbook ? "Playbook" : "AI"}
    </span>
  );
}

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
          <KindBadge kind="human" agentType={null} /> rounded figure
        </span>
        <span>
          <KindBadge kind="agent" agentType="ai" /> <KindBadge kind="agent" agentType="playbook" /> faceted,
          with a ring
        </span>
      </div>
      {isDemoOffice && (
        <div className="sim">The agents in this demo follow written playbooks. No model is connected.</div>
      )}
      <button className="btn primary mode" onClick={onToggleMode}>
        Walk the office
      </button>
      <div className="who">
        <div>
          Signed in as <strong>{viewer.displayName}</strong>
          <span>{viewer.title}</span>
        </div>
        <div className="who-actions">
          {viewer.permissions.includes("invite_people") && (
            <button className="btn" onClick={onInvite}>
              Invite
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
  onSubmit: (title: string, detail: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(sample ? SAMPLE_REQUEST.title : "");
  const [detail, setDetail] = useState(sample ? SAMPLE_REQUEST.detail : "");
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
        placeholder={sample ? undefined : "A short name for the request"}
        onChange={(e) => setTitle(e.target.value)}
      />
      <label htmlFor="request-detail">{sample ? "What the dealer asked for" : "Details"}</label>
      <textarea
        id="request-detail"
        value={detail}
        rows={4}
        maxLength={400}
        placeholder={sample ? undefined : "What is needed, and anything the office should know"}
        onChange={(e) => setDetail(e.target.value)}
      />
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
  selectedId,
  onSelect,
  onSubmit,
  submitBlocked,
  isDemoOffice,
  intakeRoomName,
}: {
  isDemoOffice: boolean;
  /** The room new requests arrive in. */
  intakeRoomName: string;
  tasks: Task[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Resolves to whether the request was accepted. */
  onSubmit: (title: string, detail: string) => Promise<boolean>;
  /** Why this viewer cannot file a request, or null when they can. */
  submitBlocked: string | null;
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
            sample={isDemoOffice}
            intakeRoomName={intakeRoomName}
            onSubmit={(title, detail) => {
              // The form stays open with its text when the request is refused.
              void onSubmit(title, detail).then((accepted) => {
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
  viewer,
  hiddenMessages,
  tokens,
  accounts,
  dispatch,
  onTokenOperation,
  onClear,
}: {
  office: Office;
  ctx: AccessContext;
  task: Task | null;
  participant: Participant | null;
  /** The signed-in person. Decides which controls are live. */
  viewer: Participant;
  hiddenMessages: OfficeView["hiddenMessages"];
  tokens: TokenView[];
  accounts: OfficeView["accounts"];
  dispatch: (a: Action) => void;
  onTokenOperation: (tokenId: string, operation: "reveal" | "revoke") => void;
  onClear: () => void;
}) {
  if (task) {
    return (
      <TaskInspector
        office={office}
        ctx={ctx}
        task={task}
        viewer={viewer}
        hidden={hiddenMessages[task.id] ?? 0}
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
        viewer={viewer}
        tokens={tokens.filter((t) => t.participantId === participant.id)}
        account={accounts.find((a) => a.participantId === participant.id) ?? null}
        onTokenOperation={onTokenOperation}
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
  onClear,
}: {
  office: Office;
  ctx: AccessContext;
  task: Task;
  viewer: Participant;
  /** Messages on this task the viewer is not allowed to read. */
  hidden: number;
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

  // Actions are sent as the signed-in person. The server stamps the real
  // actor, so these ids only keep the action well formed.
  const supervisor = viewer;
  const mayManageAccess = may(office, viewer, "manage_access");
  const mayReassign = may(office, viewer, "reassign_work");
  const mayDecide = may(office, viewer, "decide_reviews");
  const mayAdvance = authorize(office, ctx, viewer, { type: "ADVANCE", taskId: task.id });

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

  const s = STATUS[task.status];
  // Review is closed by a person's decision. Any open, unblocked task at
  // that stage is waiting for one.
  const awaitingDecision =
    task.closedAt === null &&
    task.stage !== "done" &&
    stageSpec(task.stage).humanGate === true &&
    (task.status === "in_review" || task.status === "in_progress");
  const canAdvance =
    mayAdvance.allowed &&
    task.closedAt === null &&
    task.status !== "blocked_question" &&
    task.status !== "blocked_permission" &&
    !awaitingDecision;
  const needsSupervisor =
    (task.status === "blocked_permission" && !mayManageAccess) || (awaitingDecision && !mayDecide);

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
              <span>{name(task.requestedById)}</span>
            </div>
          </div>
        </div>

        {/* ---- what a human can do about it right now ---- */}
        <div className="sec">
          <h3>Your move</h3>

          {openQuestion && (
            <fieldset className="moves" disabled={!mayAnswer}>
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
                {escalation.body}
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
                    reason: `Granted for ${task.id}`,
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

          <button
            className="btn"
            disabled={!canAdvance}
            title={mayAdvance.allowed ? undefined : mayAdvance.reason}
            onClick={() => dispatch({ type: "ADVANCE", taskId: task.id })}
          >
            {target ? `Advance to ${stageSpec(target).label}` : "Advance"}
          </button>

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
          <span style={{ color: "#e0a23f" }}>from a playbook</span>
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
  viewer,
  tokens,
  account,
  onTokenOperation,
  onClear,
}: {
  office: Office;
  ctx: AccessContext;
  participant: Participant;
  viewer: Participant;
  tokens: TokenView[];
  account: OfficeView["accounts"][number] | null;
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
                  {t.taskId ? ` · ${t.taskId} only` : ""} ·{" "}
                  <span style={{ color: t.problem ? "#eba294" : "#7fc39a" }}>
                    {t.problem ?? "usable"}
                  </span>
                </div>
                <div style={{ fontSize: 10.5, opacity: 0.7 }}>
                  Rule {t.ruleId}: {t.reason}
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
