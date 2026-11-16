/**
 * Workflow engine. A state transition function over an Office snapshot.
 *
 * `reduce` never mutates its input and has no side effects of its own. It is
 * asynchronous only because it waits for the agent runtime.
 *
 * Two ideas carry the whole thing:
 *
 *  1. A stage transition is an ordinary handoff. The task moves to the next
 *     room and is picked up by whoever is seated there and allowed to `act`.
 *     A permission block comes from somewhere else: an agent declaring, in the
 *     middle of its step, that it `needs` a scope on another room. If the
 *     access model denies that, the task stops and an escalation goes to a
 *     human.
 *
 *  2. Agent reasoning sits behind one interface, `AgentRuntime`, which returns
 *     five primitives: a status note, questions, assumptions, access needs and
 *     output. A playbook agent answers from steps a person wrote, an AI agent
 *     from a language model, and the engine cannot tell them apart.
 */

import {
  ANY_ROOM,
  canOwnWorkIn,
  canRead,
  resolveAccess,
  roleMay,
  type AccessContext,
  type AccessScope,
  type AccessDecision,
  type AssumptionMessage,
  type Message,
  type Office,
  type Participant,
  type ParticipantId,
  type QuestionMessage,
  type RoomId,
  type Task,
  type TaskId,
  type TaskStatus,
  type WorkflowStage,
} from "./model";
import {
  APPROVE,
  checkedFields,
  DECLINE,
  operationOf,
  roomsShowing,
  type ConnectedSystem,
  type SystemAction,
} from "./systems";

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface StageSpec {
  stage: WorkflowStage;
  label: string;
  /** Review is closed by a human decision, not by advancing. */
  humanGate: boolean;
  /** What the stage is for, so an agent knows where its own part ends. */
  purpose: string;
}

/** The stages in order. Which room hosts each one is set per office. */
export const PIPELINE: StageSpec[] = [
  {
    stage: "intake",
    label: "Intake",
    humanGate: false,
    purpose: "Record what is being asked and who it is for, and find out what is missing. Nothing is planned, priced, checked or carried out yet.",
  },
  {
    stage: "planning",
    label: "Planning",
    humanGate: false,
    purpose: "Decide how the work will be done: the steps, their order, and which room does each. The steps themselves are not carried out yet.",
  },
  {
    stage: "execution",
    label: "Execution",
    humanGate: false,
    purpose: "Carry the work out: look up what this room holds, act in its connected systems, and produce what was asked for.",
  },
  {
    stage: "review",
    label: "Review",
    humanGate: true,
    purpose: "Check the finished work against the request and against what this room holds, before a person decides.",
  },
  { stage: "done", label: "Complete", humanGate: false, purpose: "The work is closed." },
];

/** The room that hosts a stage, or null for the final stage. */
/** A room's name for notes people read, falling back to its id. */
const roomName = (office: Office, id: RoomId): string =>
  office.floorplan.rooms.find((r) => r.id === id)?.name ?? id;

/** A day as people write it: 7 December 2026. */
export const dayOf = (at: number): string =>
  new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Toronto" });

export const roomForStage = (office: Office, stage: WorkflowStage): RoomId | null =>
  stage === "done" ? null : office.stageRooms[stage];

export const stageSpec = (stage: WorkflowStage): StageSpec => {
  const found = PIPELINE.find((s) => s.stage === stage);
  if (!found) throw new Error(`Unknown stage ${stage}`);
  return found;
};

/**
 * The status of open, unblocked work at a stage. At a stage a person must
 * close, that is waiting for their decision. Anywhere else it is in progress.
 */
const openStatus = (stage: WorkflowStage): TaskStatus =>
  PIPELINE.find((s) => s.stage === stage)?.humanGate ? "in_review" : "in_progress";

export const nextStage = (stage: WorkflowStage): WorkflowStage | null => {
  const i = PIPELINE.findIndex((s) => s.stage === stage);
  return i >= 0 && i < PIPELINE.length - 1 ? PIPELINE[i + 1].stage : null;
};

// ---------------------------------------------------------------------------
// Agent runtime
// ---------------------------------------------------------------------------

/** What an agent knows about the office around it when it takes a step. */
export interface AgentSurroundings {
  /** The name of the office the agent works in. */
  officeName: string;
  /**
   * Every room, and whether this agent may read what is said and kept there.
   * `records` is empty for a room the agent cannot read.
   */
  rooms: { id: RoomId; name: string; purpose: string; readable: boolean; records: string[] }[];
  /** People the agent can address a question to. */
  people: { id: ParticipantId; displayName: string; title: string }[];
  /** The other agents in the office, whom it can leave a note for, and the room each works in. */
  colleagues: { id: ParticipantId; displayName: string; title: string; roomId: RoomId | null }[];
  /** The working stages in order, with the room that hosts each. */
  stages: { stage: WorkflowStage; label: string; purpose: string; roomId: RoomId | null }[];
  /**
   * Outside systems connected to rooms. `readable` and `mayAct` follow the
   * agent's access to the system's room.
   */
  systems: (ConnectedSystem & { readable: boolean; mayAct: boolean })[];
}

export interface AgentStepInput {
  task: Task;
  stage: WorkflowStage;
  participant: Participant;
  /**
   * What has been said about this task, oldest first, limited to the
   * messages this agent is allowed to read. An agent never receives a
   * message from a room it cannot read.
   */
  priorMessages: Message[];
  surroundings: AgentSurroundings;
  /** The office's time when the step is taken. */
  now?: number;
  /**
   * What the connected systems this agent may read hold right now, one line
   * per record. Fetched by the server just before the step; absent elsewhere.
   */
  liveRecords?: string[];
  /**
   * True when the agent is taking the step a second time because something it
   * asked for in a connected system was just carried out. The outcome is the
   * latest thing in the thread.
   */
  afterAction?: boolean;
  /**
   * Set when the agent does not own the task and is looking at it only
   * because someone left it a note. It may do its own part and answer with a
   * note. It does not take the task over.
   */
  attending?: { fromId: ParticipantId; body: string };
}

export interface DraftQuestion {
  body: string;
  toParticipantId: ParticipantId;
  blocking: boolean;
  options?: string[];
}

export interface DraftNote {
  toParticipantId: ParticipantId;
  body: string;
}

export interface DraftAssumption {
  assumed: string;
  because: string;
  confidence: "low" | "medium" | "high";
  body?: string;
}

/**
 * A room an agent must reach into to finish its current step. This is where
 * permission blocks actually come from: not from moving between stages, which
 * is an ordinary handoff, but from an agent needing data held somewhere it is
 * not allowed to look.
 */
export interface AccessNeed {
  room: RoomId;
  scope: AccessScope;
  /** Shown to the human in the escalation: why this access is needed. */
  purpose: string;
}

export interface AgentStepResult {
  statusNote?: string;
  questions: DraftQuestion[];
  /** Agents declare every guess they had to make. Non-negotiable. */
  assumptions: DraftAssumption[];
  needs?: AccessNeed[];
  /** Things to do in connected systems. Each needs `act` on the system's room. */
  actions?: SystemAction[];
  /** Things to tell one person or agent each. They block nothing. */
  notes?: DraftNote[];
  output?: { label: string; body: string };
  /**
   * The rest of this step has a date. `until` is a calendar day, YYYY-MM-DD.
   * The task stays where it is until then, and its owner takes the step again.
   */
  wait?: { until: string; reason: string };
}

/** One operation to carry out in a connected system, on behalf of a task. */
export interface SystemCall extends SystemAction {
  system: ConnectedSystem;
  taskId: TaskId;
}

/** What the system answered, in one sentence for the thread. */
export interface SystemOutcome {
  ok: boolean;
  summary: string;
}

/**
 * `step` is asynchronous because an AI agent takes time to answer. A playbook
 * agent resolves at once; an AI agent resolves when its model replies.
 */
export interface AgentRuntime {
  step(input: AgentStepInput): Promise<AgentStepResult>;
  /**
   * Carry out one operation in a connected system. The engine calls this only
   * after the access model has allowed it. Absent where nothing is connected.
   */
  perform?(call: SystemCall): Promise<SystemOutcome>;
}

// ---------------------------------------------------------------------------
// Engine state & actions
// ---------------------------------------------------------------------------

export interface EngineState {
  office: Office;
  now: number;
  seq: number;
  /** Minutes the clock advances per action, so timestamps read sensibly. */
  clockStepMinutes: number;
  /**
   * A short tag placed in every id this office generates, so that ids from
   * different offices in one database never collide. Empty for a lone office.
   */
  idScope?: string;
}

export type Action =
  | { type: "SUBMIT_REQUEST"; title: string; detail: string; requestedById: ParticipantId }
  | { type: "ADVANCE"; taskId: TaskId }
  | {
      type: "ANSWER_QUESTION";
      questionId: string;
      answeredById: ParticipantId;
      body: string;
      chosenOption?: string;
    }
  | {
      type: "GRANT_ACCESS";
      participantId: ParticipantId;
      room: RoomId;
      scopes: ("enter" | "read" | "act")[];
      effect: "allow" | "deny";
      reason: string;
      grantedBy: ParticipantId;
      expiresOnTaskId?: TaskId;
      expiresAt?: number;
    }
  | { type: "REVOKE_RULE"; ruleId: string; revokedBy: ParticipantId }
  | { type: "REASSIGN"; taskId: TaskId; toParticipantId: ParticipantId; byId: ParticipantId }
  | {
      type: "RESOLVE_ASSUMPTION";
      assumptionId: string;
      status: "confirmed" | "contradicted";
      byId: ParticipantId;
    }
  | {
      type: "DECIDE";
      taskId: TaskId;
      byId: ParticipantId;
      verdict: "approved" | "rejected" | "changes_requested";
      /** What has to change, when the work is sent back. */
      comment?: string;
    }
  /**
   * End a task's wait. Raised by the office when the day comes, or by a
   * person who does not want to wait for it.
   */
  | { type: "WAKE_TASK"; taskId: TaskId; byId?: ParticipantId }
  /** An agent takes its step again. Raised by the office, never by a person. */
  | { type: "AGENT_RESUME"; taskId: TaskId }
  /** An agent looks at a note left for it. Raised by the office, never by a person. */
  | { type: "AGENT_ATTEND"; taskId: TaskId; participantId: ParticipantId; noteId: string };

export interface StepResult {
  state: EngineState;
  /** Messages produced by this action, in order. */
  emitted: Message[];
  /** Plain-language trace for the activity feed and for debugging. */
  notes: string[];
  /**
   * Agents that now have something to pick up because of this action. The
   * engine only names them. Whoever runs the office decides when they go.
   */
  wake: Wake[];
}

/** An agent with something waiting for it. */
export type Wake =
  /** An answer to its question arrived, so it can take its step again. */
  | { kind: "resume"; taskId: TaskId; participantId: ParticipantId }
  /** Someone left it a note on a task it does not own. */
  | { kind: "attend"; taskId: TaskId; participantId: ParticipantId; noteId: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contextOf(state: EngineState): AccessContext {
  return {
    roles: state.office.roles,
    rules: state.office.rules,
    now: state.now,
    closedTaskIds: new Set(
      state.office.tasks.filter((t) => t.closedAt !== null).map((t) => t.id),
    ),
  };
}

const findParticipant = (o: Office, id: ParticipantId): Participant => {
  const p = o.participants.find((x) => x.id === id);
  if (!p) throw new Error(`No participant ${id}`);
  return p;
};

const findTask = (o: Office, id: TaskId): Task => {
  const t = o.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`No task ${id}`);
  return t;
};

/** The room a participant is seated in, or null if unseated. */
export function roomOf(office: Office, p: Participant): RoomId | null {
  if (!p.deskId) return null;
  const desk = office.floorplan.desks.find((d) => d.id === p.deskId);
  return desk ? desk.roomId : null;
}

/** Everyone who could legitimately own work in this room. Drives the "Hand to" buttons. */
export function eligibleOwners(
  office: Office,
  room: RoomId,
  ctx: AccessContext,
): Participant[] {
  return office.participants.filter(
    (p) => canOwnWorkIn(p, room, ctx).effect === "allow",
  );
}

/**
 * Who takes work that a reviewer sent back: whoever last had it in the room
 * that carries work out, if they may still work there, or else an agent or a
 * person who may.
 */
function ownerForRework(office: Office, task: Task, room: RoomId, ctx: AccessContext): Participant | null {
  const able = eligibleOwners(office, room, { ...ctx, forTask: task.id });
  const last = [...office.messages]
    .reverse()
    .find((m) => m.taskId === task.id && m.kind === "handoff" && m.toRoomId === room);
  const before = last?.kind === "handoff" ? able.find((p) => p.id === last.toParticipantId) : undefined;
  const seated = (p: Participant): number => (roomOf(office, p) === room ? 0 : 1);
  const agents = able.filter((p) => p.kind === "agent").sort((a, b) => seated(a) - seated(b));
  return before ?? agents[0] ?? able[0] ?? null;
}

function replaceTask(office: Office, updated: Task): Office {
  return { ...office, tasks: office.tasks.map((t) => (t.id === updated.id ? updated : t)) };
}

function replaceMessage(office: Office, updated: Message): Office {
  return {
    ...office,
    messages: office.messages.map((m) => (m.id === updated.id ? updated : m)),
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export async function reduce(
  state: EngineState,
  action: Action,
  runtime: AgentRuntime,
): Promise<StepResult> {
  const now = state.now + state.clockStepMinutes * 60_000;
  let seq = state.seq;
  const nextId = (prefix: string): string => `${prefix}-${state.idScope ?? ""}${++seq}`;
  const emitted: Message[] = [];
  const notes: string[] = [];
  let office = state.office;

  // Once a halt for access is cleared, the agent that was halted takes its
  // step again, now that it can see or do what it could not. Whatever it
  // already said is not said twice. If it cannot answer, the task stays
  // unblocked and a person can still move it on.
  const resume = async (unblocked: { taskId: TaskId; participantId: ParticipantId }[]): Promise<void> => {
    for (const { taskId, participantId } of unblocked) {
      const task = office.tasks.find((t) => t.id === taskId);
      const owner = office.participants.find((p) => p.id === task?.ownerId);
      if (!task || !owner || owner.kind !== "agent" || owner.id !== participantId) continue;
      try {
        const turn = await runAgent(office, task, task.stage, owner, runtime, now, nextId, true);
        office = turn.office;
        emitted.push(...turn.emitted);
        notes.push(...turn.notes);
      } catch (error) {
        notes.push(
          `${owner.displayName} could not take the step on ${task.id} again: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  const wake: Wake[] = [];
  const done = (): StepResult => {
    // A note for an AI agent that does not own the task is something for it
    // to look at. The owner reads its notes when it next takes a step anyway.
    for (const m of emitted) {
      if (m.kind !== "note" || m.audience.to !== "participant") continue;
      const reader = office.participants.find((p) => p.id === (m.audience as { id: string }).id);
      const task = office.tasks.find((t) => t.id === m.taskId);
      if (reader?.agentType === "ai" && task && task.closedAt === null && task.ownerId !== reader.id) {
        wake.push({ kind: "attend", taskId: task.id, participantId: reader.id, noteId: m.id });
      }
      // A colleague's answer to the task's owner lets the owner take its step
      // again with that answer, before the task moves on.
      const sender = office.participants.find((p) => p.id === m.fromId);
      if (
        reader?.agentType === "ai" &&
        sender?.kind === "agent" &&
        task &&
        task.closedAt === null &&
        task.ownerId === reader.id &&
        task.status === "in_progress"
      ) {
        wake.push({ kind: "resume", taskId: task.id, participantId: reader.id });
      }
    }
    return { state: { ...state, office, now, seq }, emitted, notes, wake };
  };

  switch (action.type) {
    // -- a human files new work ------------------------------------------
    case "SUBMIT_REQUEST": {
      const room = roomForStage(office, "intake")!;
      const ctx = contextOf({ ...state, office, now });
      const candidates = eligibleOwners(office, room, ctx).filter(
        (p) => p.kind === "agent",
      );
      const owner = candidates[0] ?? null;

      const task: Task = {
        id: nextId("T"),
        title: action.title,
        detail: action.detail,
        requestedById: action.requestedById,
        ownerId: owner ? owner.id : null,
        roomId: room,
        stage: "intake",
        status: owner ? "in_progress" : "requested",
        openQuestionIds: [],
        assumptionIds: [],
        history: [{ at: now, summary: `Request received in ${roomName(office, room)}` }],
        createdAt: now,
        closedAt: null,
      };

      const request: Message = {
        id: nextId("m"),
        kind: "request",
        taskId: task.id,
        fromId: action.requestedById,
        audience: { to: "room", id: room },
        roomId: room,
        at: now,
        body: action.detail,
      };
      emitted.push(request);
      office = { ...office, tasks: [...office.tasks, task], messages: [...office.messages, request] };
      notes.push(`${task.id} opened in ${roomName(office, room)}${owner ? `, owned by ${owner.displayName}` : " with no eligible owner"}`);

      if (owner) {
        const run = await runAgent(office, task, "intake", owner, runtime, now, nextId);
        office = run.office;
        emitted.push(...run.emitted);
        notes.push(...run.notes);
      }
      return done();
    }

    // -- move a task to the next stage ------------------------------------
    case "ADVANCE": {
      const task = findTask(office, action.taskId);

      if (task.status === "blocked_question") {
        notes.push(`${task.id} cannot advance: ${task.openQuestionIds.length} question(s) unanswered`);
        return done();
      }
      if (task.closedAt !== null) {
        notes.push(`${task.id} is already closed`);
        return done();
      }

      const current = stageSpec(task.stage);
      if (current.humanGate) {
        notes.push(`${task.id} is in ${current.label} and needs a human decision, not an advance`);
        return done();
      }

      const target = nextStage(task.stage);
      if (target === null) {
        notes.push(`${task.id} is already at the end of the pipeline`);
        return done();
      }
      const targetSpec = stageSpec(target);
      const targetRoom = roomForStage(office, target) ?? task.roomId;
      const ctx: AccessContext = { ...contextOf({ ...state, office, now }), forTask: task.id };

      // Moving between stages is an ordinary handoff: the work goes to whoever
      // is seated in the next room and allowed to act there. Keep the current
      // owner only when they qualify, which happens when two stages share a
      // room. A block here means nobody at all may work in that room.
      const owner = task.ownerId ? findParticipant(office, task.ownerId) : null;
      let carrier: Participant | null = null;
      let decision: AccessDecision | null = null;

      if (owner) {
        const d = canOwnWorkIn(owner, targetRoom, ctx);
        if (d.effect === "allow") {
          carrier = owner;
          decision = d;
        }
      }
      if (!carrier) {
        const seatedFirst = eligibleOwners(office, targetRoom, ctx)
          .filter((p) => p.kind === "agent")
          .sort((a, b) => {
            const aHere = roomOf(office, a) === targetRoom ? 0 : 1;
            const bHere = roomOf(office, b) === targetRoom ? 0 : 1;
            return aHere - bHere;
          });
        if (seatedFirst.length > 0) {
          carrier = seatedFirst[0];
          decision = canOwnWorkIn(carrier, targetRoom, ctx);
        }
      }

      if (!carrier) {
        const supervisor =
          office.participants.find((p) => p.kind === "human" && roleMay(office.roles[p.roleId], "manage_access")) ??
          office.participants.find((p) => p.kind === "human");
        const escalation: Message = {
          id: nextId("m"),
          kind: "escalation",
          taskId: task.id,
          fromId: owner ? owner.id : "system",
          audience: supervisor ? { to: "participant", id: supervisor.id } : { to: "everyone" },
          roomId: task.roomId,
          at: now,
          body: `${task.id} cannot move to ${targetSpec.label}: nobody may act in ${roomName(office, targetRoom)}.`,
          cause: "permission",
        };
        emitted.push(escalation);
        office = {
          ...replaceTask(office, {
            ...task,
            status: "blocked_permission",
            history: [
              ...task.history,
              { at: now, summary: `No eligible owner in ${roomName(office, targetRoom)}`, messageId: escalation.id },
            ],
          }),
          messages: [...office.messages, escalation],
        };
        notes.push(`${task.id} blocked: no eligible owner in ${roomName(office, targetRoom)}`);
        return done();
      }

      const changedHands = carrier.id !== owner?.id;
      if (changedHands) {
        const handoff: Message = {
          id: nextId("m"),
          kind: "handoff",
          taskId: task.id,
          fromId: owner ? owner.id : "system",
          audience: { to: "room", id: targetRoom },
          roomId: targetRoom,
          at: now,
          body: `${task.id} handed to ${carrier.displayName} for ${targetSpec.label}.`,
          fromParticipantId: owner ? owner.id : carrier.id,
          toParticipantId: carrier.id,
          toRoomId: targetRoom,
        };
        emitted.push(handoff);
        office = { ...office, messages: [...office.messages, handoff] };
      }

      // Whoever moves a task on has decided not to wait any longer.
      const { wait: _waited, ...moving } = task;
      const moved: Task = {
        ...moving,
        stage: target,
        roomId: targetRoom,
        ownerId: carrier.id,
        status: targetSpec.humanGate ? "in_review" : "in_progress",
        history: [
          ...task.history,
          {
            at: now,
            summary: `Moved to ${targetSpec.label} in ${roomName(office, targetRoom)}, owned by ${carrier.displayName}`,
            ...(decision ? { decision } : {}),
          },
        ],
      };
      office = replaceTask(office, moved);
      notes.push(
        `${task.id} moved to ${targetSpec.label} (${roomName(office, targetRoom)}), owner ${carrier.displayName}`,
      );

      const run = await runAgent(office, moved, target, carrier, runtime, now, nextId);
      office = run.office;
      emitted.push(...run.emitted);
      notes.push(...run.notes);
      return done();
    }

    // -- a human answers a blocking question -------------------------------
    case "ANSWER_QUESTION": {
      const question = office.messages.find(
        (m): m is QuestionMessage => m.id === action.questionId && m.kind === "question",
      );
      if (!question) {
        notes.push(`No question ${action.questionId}`);
        return done();
      }
      // One answer settles a question. A second click, or a second person,
      // changes nothing.
      if (office.messages.some((m) => m.kind === "answer" && m.questionId === question.id)) {
        notes.push(`${question.taskId}: that question was already answered`);
        return done();
      }

      const answer: Message = {
        id: nextId("m"),
        kind: "answer",
        taskId: question.taskId,
        fromId: action.answeredById,
        // A question raised by the system has no person to reply to, so its
        // answer goes to the room the question was asked in.
        audience:
          question.fromId === "system"
            ? { to: "room", id: question.roomId }
            : { to: "participant", id: question.fromId },
        roomId: question.roomId,
        at: now,
        inReplyTo: question.id,
        body: action.body,
        questionId: question.id,
        ...(action.chosenOption ? { chosenOption: action.chosenOption } : {}),
      };
      emitted.push(answer);
      office = replaceMessage(office, { ...question, answeredByMessageId: answer.id });
      office = { ...office, messages: [...office.messages, answer] };

      const task = findTask(office, question.taskId);
      const stillOpen = task.openQuestionIds.filter((id) => id !== question.id);
      const unblocked: Task = {
        ...task,
        openQuestionIds: stillOpen,
        status:
          stillOpen.length === 0 && task.status === "blocked_question"
            ? openStatus(task.stage)
            : task.status,
        history: [
          ...task.history,
          {
            at: now,
            summary: `Question answered by ${office.participants.find((p) => p.id === action.answeredById)?.displayName ?? action.answeredById}`,
            messageId: answer.id,
          },
        ],
      };
      office = replaceTask(office, unblocked);
      notes.push(
        `${task.id}: question answered` +
          (stillOpen.length === 0 ? ", unblocked" : `, ${stillOpen.length} still open`),
      );

      // The question was a request to act in a connected system. Approval
      // carries the action out, provided the agent may still act there.
      const held = question.heldAction;
      const asker = office.participants.find((p) => p.id === question.fromId);
      // An AI agent that asked an ordinary question has its answer now, and
      // can take the step again once nothing else is holding the task.
      if (!held && asker?.agentType === "ai" && unblocked.ownerId === asker.id && unblocked.status !== "blocked_question") {
        wake.push({ kind: "resume", taskId: task.id, participantId: asker.id });
      }
      const system = held ? office.systems.find((s) => s.id === held.systemId) : undefined;
      if (held && asker && asker.kind === "agent") {
        const say = (body: string): void => {
          const said: Message = {
            id: nextId("m"),
            kind: "status",
            taskId: task.id,
            fromId: asker.id,
            audience: { to: "room", id: task.roomId },
            roomId: task.roomId,
            at: now,
            body,
          };
          emitted.push(said);
          office = { ...office, messages: [...office.messages, said] };
        };
        const approver = findParticipant(office, action.answeredById).displayName;
        if (action.chosenOption !== APPROVE) {
          say(`${system?.name ?? "The system"}: not done, because ${approver} did not approve it.`);
          notes.push(`${approver} did not approve ${asker.displayName}'s action on ${task.id}`);
        } else if (!system) {
          say("The system is no longer connected, so the approved action was not carried out.");
        } else if (resolveAccess(asker, system.roomId, "act", { ...contextOf({ ...state, office, now }), forTask: task.id }).effect !== "allow") {
          say(`${system.name}: not done. ${asker.displayName} may no longer act in ${roomName(office, system.roomId)}.`);
        } else {
          const outcome: SystemOutcome = runtime.perform
            ? await runtime.perform({ ...held, system, taskId: task.id })
            : { ok: false, summary: "it is not reachable from here, so nothing was done" };
          say(`${system.name}: ${outcome.summary}`);
          notes.push(`${approver} approved, and ${asker.displayName} ${outcome.ok ? "used" : "was refused by"} ${system.name}: ${outcome.summary}`);
          // An AI agent takes the step once more, with the outcome in front of it.
          const current = findTask(office, task.id);
          if (asker.agentType === "ai" && current.ownerId === asker.id && current.status !== "blocked_question") {
            try {
              const turn = await runAgent(office, current, current.stage, asker, runtime, now, nextId, true, true);
              office = turn.office;
              emitted.push(...turn.emitted);
              notes.push(...turn.notes);
            } catch (error) {
              notes.push(
                `${asker.displayName} could not follow up on ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        }
      }
      // A colleague's question held the task while its owner had more to do.
      // With the task open again, the owner takes its step before it moves on.
      const settled = findTask(office, task.id);
      const owner = office.participants.find((p) => p.id === settled.ownerId);
      if (
        owner?.agentType === "ai" &&
        asker?.id !== owner.id &&
        settled.closedAt === null &&
        settled.status === openStatus(settled.stage) &&
        !stageSpec(settled.stage).humanGate
      ) {
        wake.push({ kind: "resume", taskId: task.id, participantId: owner.id });
      }
      return done();
    }

    // -- a supervisor grants or denies access -------------------------------
    case "GRANT_ACCESS": {
      const rule = {
        id: nextId("r"),
        participantId: action.participantId,
        room: action.room,
        scopes: action.scopes,
        effect: action.effect,
        reason: action.reason,
        grantedBy: action.grantedBy,
        grantedAt: now,
        ...(action.expiresOnTaskId ? { expiresOnTaskId: action.expiresOnTaskId } : {}),
        ...(action.expiresAt ? { expiresAt: action.expiresAt } : {}),
      };
      office = { ...office, rules: [...office.rules, rule] };

      const who = findParticipant(office, action.participantId);
      notes.push(
        `${rule.id}: ${action.effect} ${action.scopes.join("/")} on ${
          action.room === ANY_ROOM ? "every room" : roomName(office, action.room)
        } for ${who.displayName}` +
          (action.expiresOnTaskId ? ` (expires with ${action.expiresOnTaskId})` : ""),
      );

      const retried = retryBlocked(office, { ...state, office, now }, now, rule.id, rule.participantId);
      office = retried.office;
      notes.push(...retried.notes);
      await resume(retried.unblocked);
      return done();
    }

    case "REVOKE_RULE": {
      const rule = office.rules.find((r) => r.id === action.ruleId);
      if (!rule) {
        notes.push(`No rule ${action.ruleId}`);
        return done();
      }
      office = { ...office, rules: office.rules.filter((r) => r.id !== action.ruleId) };
      notes.push(
        `${action.ruleId} revoked by ${findParticipant(office, action.revokedBy).displayName}`,
      );
      const afterRevoke = retryBlocked(
        office,
        { ...state, office, now },
        now,
        `revocation of ${action.ruleId}`,
        rule.participantId,
      );
      office = afterRevoke.office;
      notes.push(...afterRevoke.notes);
      await resume(afterRevoke.unblocked);
      return done();
    }

    // -- hand the task to someone who is allowed ---------------------------
    case "REASSIGN": {
      const task = findTask(office, action.taskId);
      const to = findParticipant(office, action.toParticipantId);
      const target = nextStage(task.stage);
      const room = target ? (roomForStage(office, target) ?? task.roomId) : task.roomId;
      const ctx: AccessContext = { ...contextOf({ ...state, office, now }), forTask: task.id };
      const decision = canOwnWorkIn(to, room, ctx);

      if (decision.effect === "deny") {
        notes.push(`Cannot reassign ${task.id} to ${to.displayName}: ${decision.explanation}`);
        return done();
      }

      const handoff: Message = {
        id: nextId("m"),
        kind: "handoff",
        taskId: task.id,
        fromId: action.byId,
        audience: { to: "room", id: room },
        roomId: room,
        at: now,
        body: `${to.displayName} picks up ${task.id}.`,
        fromParticipantId: task.ownerId ?? action.byId,
        toParticipantId: to.id,
        toRoomId: room,
      };
      emitted.push(handoff);
      office = {
        ...replaceTask(office, {
          ...task,
          ownerId: to.id,
          status: task.status === "blocked_permission" ? openStatus(task.stage) : task.status,
          history: [
            ...task.history,
            { at: now, summary: `Reassigned to ${to.displayName}`, messageId: handoff.id, decision },
          ],
        }),
        messages: [...office.messages, handoff],
      };
      notes.push(`${task.id} reassigned to ${to.displayName}`);
      return done();
    }

    // -- a human rules on an assumption ------------------------------------
    case "RESOLVE_ASSUMPTION": {
      const assumption = office.messages.find(
        (m): m is AssumptionMessage =>
          m.id === action.assumptionId && m.kind === "assumption",
      );
      if (!assumption) {
        notes.push(`No assumption ${action.assumptionId}`);
        return done();
      }
      office = replaceMessage(office, { ...assumption, status: action.status });
      notes.push(`${assumption.id} marked ${action.status} by ${action.byId}`);

      if (action.status === "confirmed") return done();

      // Contradicted: work resting on it must stop and be re-asked.
      for (const taskId of assumption.affectsTaskIds) {
        const task = office.tasks.find((t) => t.id === taskId);
        if (!task || task.closedAt !== null) continue;

        const question: Message = {
          id: nextId("m"),
          kind: "question",
          taskId: task.id,
          fromId: "system",
          audience: task.ownerId
            ? { to: "participant", id: task.ownerId }
            : { to: "room", id: task.roomId },
          roomId: task.roomId,
          at: now,
          inReplyTo: assumption.id,
          body: `"${assumption.assumed}" was contradicted by ${action.byId}. What is the correct value?`,
          blocking: true,
        };
        emitted.push(question);
        office = {
          ...replaceTask(office, {
            ...task,
            status: "blocked_question",
            openQuestionIds: [...task.openQuestionIds, question.id],
            history: [
              ...task.history,
              {
                at: now,
                summary: `Halted: rested on a contradicted assumption (${assumption.id})`,
                messageId: question.id,
              },
            ],
          }),
          messages: [...office.messages, question],
        };
        notes.push(`${task.id} halted because it rested on ${assumption.id}`);
      }
      return done();
    }

    // -- the review gate ----------------------------------------------------
    case "WAKE_TASK": {
      const task = office.tasks.find((t) => t.id === action.taskId);
      if (!task || task.closedAt !== null || !task.wait) return done();
      const by = action.byId ? office.participants.find((p) => p.id === action.byId) : undefined;
      const { wait, ...rest } = task;
      const said: Message = {
        id: nextId("m"),
        kind: "status",
        taskId: task.id,
        fromId: by?.id ?? task.ownerId ?? "system",
        audience: { to: "room", id: task.roomId },
        roomId: task.roomId,
        at: now,
        body: by
          ? `${by.displayName} ended the wait early. It was waiting until ${dayOf(wait.until)}: ${wait.reason}`
          : `The wait until ${dayOf(wait.until)} is over: ${wait.reason}`,
      };
      emitted.push(said);
      office = {
        ...replaceTask(office, {
          ...rest,
          history: [...task.history, { at: now, summary: by ? `${by.displayName} ended the wait` : "The wait ended", messageId: said.id }],
        }),
        messages: [...office.messages, said],
      };
      notes.push(by ? `${by.displayName} ended the wait on ${task.id}` : `${task.id}: the wait until ${dayOf(wait.until)} is over`);
      const owner = office.participants.find((p) => p.id === task.ownerId);
      if (owner?.agentType === "ai" && task.status === openStatus(task.stage) && !stageSpec(task.stage).humanGate) {
        wake.push({ kind: "resume", taskId: task.id, participantId: owner.id });
      }
      return done();
    }

    case "AGENT_RESUME": {
      const task = office.tasks.find((t) => t.id === action.taskId);
      const owner = office.participants.find((p) => p.id === task?.ownerId);
      if (!task || task.closedAt !== null || !owner || owner.kind !== "agent" || task.status !== openStatus(task.stage)) {
        return done();
      }
      const turn = await runAgent(office, task, task.stage, owner, runtime, now, nextId, true);
      office = turn.office;
      emitted.push(...turn.emitted);
      notes.push(...turn.notes);
      return done();
    }

    case "AGENT_ATTEND": {
      const task = office.tasks.find((t) => t.id === action.taskId);
      const reader = office.participants.find((p) => p.id === action.participantId);
      const note = office.messages.find((m) => m.id === action.noteId);
      if (
        !task ||
        task.closedAt !== null ||
        !reader ||
        reader.agentType !== "ai" ||
        task.ownerId === reader.id ||
        !note ||
        note.kind !== "note" ||
        note.audience.to !== "participant" ||
        note.audience.id !== reader.id
      ) {
        return done();
      }
      const turn = await runAgent(office, task, task.stage, reader, runtime, now, nextId, true, false, note);
      office = turn.office;
      emitted.push(...turn.emitted);
      notes.push(...turn.notes);
      return done();
    }

    case "DECIDE": {
      const task = findTask(office, action.taskId);
      const by = findParticipant(office, action.byId);
      const ctx = contextOf({ ...state, office, now });
      const decision = resolveAccess(by, task.roomId, "act", ctx);

      if (decision.effect === "deny") {
        notes.push(`${by.displayName} may not decide in ${roomName(office, task.roomId)}: ${decision.explanation}`);
        return done();
      }

      // Work that is sent back returns to the room that carries it out, to
      // whoever had it there, and that room is where the reason is said.
      const comment = action.comment?.trim() ?? "";
      const workRoom = roomForStage(office, "execution");
      const reworker =
        action.verdict === "changes_requested" && workRoom ? ownerForRework(office, task, workRoom, ctx) : null;
      const saidIn = reworker && workRoom ? workRoom : task.roomId;

      const ruling: Message = {
        id: nextId("m"),
        kind: "decision",
        taskId: task.id,
        fromId: by.id,
        audience: { to: "room", id: saidIn },
        roomId: saidIn,
        at: now,
        body:
          action.verdict === "approved"
            ? "Approved."
            : action.verdict === "rejected"
              ? "Rejected."
              : comment
                ? `Sent back for changes: ${comment}`
                : "Sent back for changes.",
        verdict: action.verdict,
      };
      emitted.push(ruling);

      if (reworker && workRoom) {
        office = {
          ...replaceTask(office, {
            ...task,
            stage: "execution",
            roomId: workRoom,
            ownerId: reworker.id,
            status: "in_progress",
            history: [
              ...task.history,
              {
                at: now,
                summary: `${by.displayName} sent it back to ${roomName(office, workRoom)}, owned by ${reworker.displayName}`,
                messageId: ruling.id,
                decision,
              },
            ],
          }),
          messages: [...office.messages, ruling],
        };
        notes.push(
          `${task.id} sent back by ${by.displayName} to ${stageSpec("execution").label} (${roomName(office, workRoom)}), owner ${reworker.displayName}`,
        );
        if (reworker.agentType === "ai") wake.push({ kind: "resume", taskId: task.id, participantId: reworker.id });
        return done();
      }

      const closed = action.verdict === "approved" || action.verdict === "rejected";
      office = {
        ...replaceTask(office, {
          ...task,
          stage: action.verdict === "approved" ? "done" : task.stage,
          status:
            action.verdict === "approved"
              ? "completed"
              : action.verdict === "rejected"
                ? "rejected"
                : "in_progress",
          closedAt: closed ? now : null,
          history: [
            ...task.history,
            { at: now, summary: `${by.displayName}: ${action.verdict}`, messageId: ruling.id, decision },
          ],
        }),
        messages: [...office.messages, ruling],
      };
      notes.push(`${task.id} ${action.verdict} by ${by.displayName}`);
      return done();
    }
  }
}

/**
 * After any permission change, re-test every task that is blocked on one.
 * The thing to re-test is recorded on the task's most recent permission
 * escalation, so there is no guessing about what it was waiting for.
 */
function retryBlocked(
  office: Office,
  state: EngineState,
  now: number,
  cause: string,
  /** Whose access just changed. Other people's blocks are re-tested quietly. */
  changedFor: ParticipantId,
): { office: Office; notes: string[]; unblocked: { taskId: TaskId; participantId: ParticipantId }[] } {
  const ctx = contextOf(state);
  const notes: string[] = [];
  const unblocked: { taskId: TaskId; participantId: ParticipantId }[] = [];
  let next = office;

  for (const task of office.tasks) {
    if (task.status !== "blocked_permission") continue;

    const escalation = [...office.messages]
      .reverse()
      .find(
        (m): m is Message & { deniedDecision: AccessDecision } =>
          m.taskId === task.id &&
          m.kind === "escalation" &&
          (m as { deniedDecision?: AccessDecision }).deniedDecision !== undefined,
      );
    if (!escalation) continue;

    const { participantId, room, scope } = escalation.deniedDecision;
    const who = office.participants.find((p) => p.id === participantId);
    if (!who) continue;

    const verdict = resolveAccess(who, room, scope, { ...ctx, forTask: task.id });
    if (verdict.effect !== "allow") {
      if (participantId === changedFor) {
        notes.push(
          `${task.id} still blocked after ${cause}. ${verdict.explanation}`,
        );
      }
      continue;
    }

    next = replaceTask(next, {
      ...task,
      status: openStatus(task.stage),
      history: [
        ...task.history,
        { at: now, summary: `Unblocked by ${cause}`, decision: verdict },
      ],
    });
    unblocked.push({ taskId: task.id, participantId });
    notes.push(
      `${task.id} unblocked by ${cause}. ${
        openStatus(task.stage) === "in_review" ? "It is ready for a decision." : "Advance it to continue."
      }`,
    );
  }

  return { office: next, notes, unblocked };
}

// ---------------------------------------------------------------------------
// Agent turn
// ---------------------------------------------------------------------------

async function runAgent(
  office: Office,
  task: Task,
  stage: WorkflowStage,
  participant: Participant,
  runtime: AgentRuntime,
  now: number,
  nextId: (prefix: string) => string,
  /** True when the agent takes a step again after a halt was cleared. */
  resumed = false,
  /** True for the one further step an AI agent takes after acting in a system. */
  afterAction = false,
  /** The note that brought an agent to a task it does not own, when that is why it is here. */
  attending: Message | null = null,
): Promise<{ office: Office; emitted: Message[]; notes: string[] }> {
  if (participant.kind !== "agent") {
    return { office, emitted: [], notes: [] };
  }

  const ctx: AccessContext = {
    roles: office.roles,
    rules: office.rules,
    now,
    closedTaskIds: new Set(office.tasks.filter((t) => t.closedAt !== null).map((t) => t.id)),
    // Grants made for another task do not count for this one.
    forTask: task.id,
  };
  const prior = office.messages
    .filter((m) => m.taskId === task.id && canRead(m, participant, ctx))
    .sort((a, b) => a.at - b.at);
  const mayRead = (room: RoomId): boolean => resolveAccess(participant, room, "read", ctx).effect === "allow";
  const surroundings: AgentSurroundings = {
    officeName: office.name,
    rooms: office.floorplan.rooms.map((room) => ({
      id: room.id,
      name: room.name,
      purpose: room.purpose,
      readable: mayRead(room.id),
      records: mayRead(room.id) ? room.records : [],
    })),
    people: office.participants
      .filter((p) => p.kind === "human")
      .map((p) => ({ id: p.id, displayName: p.displayName, title: p.title })),
    colleagues: office.participants
      .filter((p) => p.kind === "agent" && p.id !== participant.id)
      .map((p) => ({ id: p.id, displayName: p.displayName, title: p.title, roomId: roomOf(office, p) })),
    stages: PIPELINE.filter((s) => s.stage !== "done").map((s) => ({
      stage: s.stage,
      label: s.label,
      purpose: s.purpose,
      roomId: roomForStage(office, s.stage),
    })),
    systems: office.systems.map((system) => ({
      ...system,
      readable: roomsShowing(system).some((room) => resolveAccess(participant, room, "read", ctx).effect === "allow"),
      mayAct: resolveAccess(participant, system.roomId, "act", ctx).effect === "allow",
    })),
  };

  const answered = await runtime.step({
    task,
    stage,
    participant,
    priorMessages: prior,
    surroundings,
    now,
    ...(afterAction ? { afterAction } : {}),
    ...(attending && attending.fromId !== "system" ? { attending: { fromId: attending.fromId, body: attending.body } } : {}),
  });
  // An agent attending to a note does its own part and may answer with one
  // note. It cannot halt or redirect a task that is not its own.
  const result: AgentStepResult = attending
    ? {
        ...(answered.statusNote ? { statusNote: answered.statusNote } : {}),
        questions: [],
        assumptions: [],
        ...(answered.actions ? { actions: answered.actions } : {}),
        notes: (answered.notes ?? []).slice(0, 1),
      }
    : answered;
  const emitted: Message[] = [];
  const notes: string[] = [];
  let updated: Task = task;

  // On a step taken again, a status note or question the agent already put on
  // this task is left out. Work that a reviewer sent back starts afresh: what
  // was said before then may have to be said, or asked for, again.
  const sentBackAt = office.messages.findLast(
    (m) => m.taskId === task.id && m.kind === "decision" && m.verdict === "changes_requested",
  )?.at ?? 0;
  const said = new Set(
    resumed
      ? office.messages.flatMap((m) =>
          m.taskId === task.id &&
          m.fromId === participant.id &&
          m.at >= sentBackAt &&
          (m.kind === "status" || m.kind === "question" || m.kind === "note")
            ? [`${m.kind}:${m.body}`]
            : [],
        )
      : [],
  );

  if (result.statusNote && !said.has(`status:${result.statusNote}`)) {
    const status: Message = {
      id: nextId("m"),
      kind: "status",
      taskId: task.id,
      fromId: participant.id,
      audience: { to: "room", id: task.roomId },
      roomId: task.roomId,
      at: now,
      body: result.statusNote,
    };
    emitted.push(status);
  }

  // An assumption already recorded on this task is not recorded again, however
  // often an agent repeats it from step to step.
  const wording = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const recorded = new Set(
    office.messages.flatMap((m) => (m.kind === "assumption" && m.taskId === task.id ? [wording(m.assumed)] : [])),
  );

  for (const draft of result.assumptions) {
    if (recorded.has(wording(draft.assumed))) continue;
    recorded.add(wording(draft.assumed));
    const assumption: Message = {
      id: nextId("m"),
      kind: "assumption",
      taskId: task.id,
      fromId: participant.id,
      audience: { to: "room", id: task.roomId },
      roomId: task.roomId,
      at: now,
      body: draft.body ?? `Assuming: ${draft.assumed}`,
      assumed: draft.assumed,
      because: draft.because,
      confidence: draft.confidence,
      status: "open",
      affectsTaskIds: [task.id],
    };
    emitted.push(assumption);
    updated = { ...updated, assumptionIds: [...updated.assumptionIds, assumption.id] };
    notes.push(`${participant.displayName} recorded an assumption: ${draft.assumed}`);
  }

  for (const draft of result.questions) {
    if (said.has(`question:${draft.body}`)) continue;
    const question: Message = {
      id: nextId("m"),
      kind: "question",
      taskId: task.id,
      fromId: participant.id,
      audience: { to: "participant", id: draft.toParticipantId },
      roomId: task.roomId,
      at: now,
      body: draft.body,
      blocking: draft.blocking,
      ...(draft.options ? { options: draft.options } : {}),
    };
    emitted.push(question);
    if (draft.blocking) {
      updated = {
        ...updated,
        openQuestionIds: [...updated.openQuestionIds, question.id],
        status: "blocked_question",
      };
      notes.push(`${participant.displayName} is waiting on an answer: ${draft.body}`);
    }
  }

  // Does this step need to reach into a room the agent may not touch?
  // Checked after the status and assumptions, because that is the order it
  // happens in: the agent works, records what it guessed, then hits the wall.
  let wallHit = false;

  // An action names a system and an operation that system has. Anything else
  // is dropped, as is an action with a field left empty.
  const calls: SystemCall[] = (result.actions ?? []).flatMap((action) => {
    const system = office.systems.find((s) => s.id === action.systemId);
    const fields = system ? checkedFields(system, action.operation, action.fields) : null;
    return system && fields ? [{ ...action, fields, system, taskId: task.id }] : [];
  });
  // Acting in a system the agent may not act in is a need like any other, and
  // halts the task the same way.
  const mayCall = (call: SystemCall): boolean =>
    resolveAccess(participant, call.system.roomId, "act", ctx).effect === "allow";
  // An agent attending to a note raises no need: what it may not do is left
  // undone, and whoever left the note is told.
  const allowedCalls = attending ? calls.filter(mayCall) : calls;
  const refusedCalls = attending ? calls.filter((call) => !mayCall(call)) : [];
  const actionNeeds: AccessNeed[] = (attending ? [] : calls)
    .filter((call) => !mayCall(call))
    .map((call) => ({
      room: call.system.roomId,
      scope: "act",
      purpose: `${operationOf(call.system, call.operation)?.label ?? call.operation} in ${call.system.name}`,
    }));

  // An AI agent that wants to read a room where another AI agent works does
  // not halt for it. What it wants is passed to that colleague as a note, the
  // colleague answers, and the agent takes its step again with the answer. A
  // playbook's need is written by a person and always halts, and so does any
  // need to enter or act.
  const colleagueIn = (roomId: RoomId): Participant | undefined =>
    office.participants.find(
      (p) =>
        p.agentType === "ai" &&
        p.id !== participant.id &&
        roomOf(office, p) === roomId &&
        resolveAccess(p, roomId, "read", ctx).effect === "allow",
    );
  const passedOn: { to: Participant; need: AccessNeed }[] = [];
  const haltingNeeds: AccessNeed[] = [];
  for (const need of result.needs ?? []) {
    const colleague = participant.agentType === "ai" && need.scope === "read" ? colleagueIn(need.room) : undefined;
    if (colleague && resolveAccess(participant, need.room, "read", ctx).effect !== "allow") {
      passedOn.push({ to: colleague, need });
    } else {
      haltingNeeds.push(need);
    }
  }

  for (const need of [...haltingNeeds, ...actionNeeds]) {
    const verdict = resolveAccess(participant, need.room, need.scope, ctx);
    if (verdict.effect === "allow") continue;

    const supervisor =
      office.participants.find((p) => p.kind === "human" && roleMay(office.roles[p.roleId], "manage_access")) ??
      office.participants.find((p) => p.kind === "human");
    // Someone to hand the work to must hold the access and be able to carry
    // the task into its next room, which is what a reassignment requires.
    const onward = nextStage(task.stage);
    const carryRoom = onward ? (roomForStage(office, onward) ?? task.roomId) : task.roomId;
    const alternatives = office.participants.filter(
      (p) =>
        p.id !== participant.id &&
        p.kind === "agent" &&
        resolveAccess(p, need.room, need.scope, ctx).effect === "allow" &&
        canOwnWorkIn(p, carryRoom, ctx).effect === "allow",
    );
    const neededRoom = roomName(office, need.room);
    const purpose = need.purpose.trim().replace(/[.\s]+$/, "");

    const escalation: Message = {
      id: nextId("m"),
      kind: "escalation",
      taskId: task.id,
      fromId: participant.id,
      audience: supervisor ? { to: "participant", id: supervisor.id } : { to: "everyone" },
      roomId: task.roomId,
      at: now,
      body:
        `I need ${need.scope} access to ${neededRoom}. Purpose: ${purpose}. ` +
        `${verdict.explanation}. ` +
        (alternatives.length > 0
          ? `Grant me scoped access, or hand this to ${alternatives.map((p) => p.displayName).join(" / ")}.`
          : `Grant me scoped access. No other agent who could take this over holds it.`),
      cause: "permission",
      deniedDecision: verdict,
    };
    emitted.push(escalation);
    updated = {
      ...updated,
      status: "blocked_permission",
      history: [
        ...updated.history,
        {
          at: now,
          summary: `Blocked: needs ${need.scope} on ${neededRoom}`,
          messageId: escalation.id,
          decision: verdict,
        },
      ],
    };
    notes.push(
      `${participant.displayName} blocked on ${need.scope} access to ${neededRoom}. ${verdict.explanation}`,
    );
    wallHit = true;
    break;
  }

  // Nothing is done in an outside system while the step is halted for access.
  // It is done when the halt is cleared and the agent takes the step again.
  // A note goes to one person or agent who is in the office. An agent's own
  // notes are written even when the step is halted, because they ask for nothing.
  const tell = (toId: ParticipantId, body: string): void => {
    const text = body.trim();
    if (!text || toId === participant.id || !office.participants.some((p) => p.id === toId)) return;
    if (said.has(`note:${text}`) || emitted.some((m) => m.kind === "note" && m.body === text)) return;
    emitted.push({
      id: nextId("m"),
      kind: "note",
      taskId: task.id,
      fromId: participant.id,
      audience: { to: "participant", id: toId },
      roomId: task.roomId,
      at: now,
      body: text,
    });
    notes.push(`${participant.displayName} left a note for ${findParticipant(office, toId).displayName} on ${task.id}`);
  };
  if (attending && attending.fromId !== "system") {
    for (const call of refusedCalls) {
      tell(
        attending.fromId,
        `I may not act in ${call.system.name}, so I did not ${(operationOf(call.system, call.operation)?.label ?? call.operation).toLowerCase()}.`,
      );
    }
  }

  let acted = false;
  if (!wallHit) {
    for (const call of allowedCalls) {
      // Where a system needs approval, being allowed to act is not enough: the
      // action is put to a person as a question and waits for their answer.
      if (call.system.needsApproval) {
        const operation = operationOf(call.system, call.operation);
        const details = (operation?.fields ?? []).map((f) => `${f.label}: ${call.fields[f.name]}`).join(". ");
        const body = `May I ${(operation?.label ?? call.operation).toLowerCase()} in ${call.system.name}? ${details}.`;
        if (said.has(`question:${body}`) || emitted.some((m) => m.kind === "question" && m.body === body)) continue;
        const approver =
          office.participants.find((p) => p.kind === "human" && roleMay(office.roles[p.roleId], "manage_access")) ??
          office.participants.find((p) => p.kind === "human");
        if (!approver) continue;
        const ask: Message = {
          id: nextId("m"),
          kind: "question",
          taskId: task.id,
          fromId: participant.id,
          audience: { to: "participant", id: approver.id },
          roomId: task.roomId,
          at: now,
          body,
          blocking: true,
          options: [APPROVE, DECLINE],
          heldAction: { systemId: call.systemId, operation: call.operation, fields: call.fields },
        };
        emitted.push(ask);
        updated = {
          ...updated,
          openQuestionIds: [...updated.openQuestionIds, ask.id],
          status: "blocked_question",
        };
        notes.push(`${participant.displayName} is waiting for approval to act in ${call.system.name}`);
        continue;
      }
      acted = true;
      const outcome: SystemOutcome = runtime.perform
        ? await runtime.perform(call)
        : { ok: false, summary: "it is not reachable from here, so nothing was done" };
      const done: Message = {
        id: nextId("m"),
        kind: "status",
        taskId: task.id,
        fromId: participant.id,
        // Said where the agent is working, so it and its colleagues on the
        // task can read what came of it.
        audience: { to: "room", id: task.roomId },
        roomId: task.roomId,
        at: now,
        body: `${call.system.name}: ${outcome.summary}`,
      };
      emitted.push(done);
      notes.push(
        `${participant.displayName} ${outcome.ok ? "used" : "was refused by"} ${call.system.name}: ${outcome.summary}`,
      );
      // Whoever asked for the work is told when a system did not do its part,
      // since the task carries on regardless.
      if (!outcome.ok) tell(task.requestedById, `${call.system.name} did not do what ${task.id} needed: ${outcome.summary}`);
    }
  }

  // Notes come after anything done in a system, so a note that speaks of an
  // order follows the order in the thread.
  // An AI agent that has just acted takes the step again with the system's
  // answer, and tells its colleagues then. A note written before the answer
  // could only say that something was asked for.
  const answerComing = acted && !afterAction && participant.agentType === "ai";
  if (!answerComing) for (const draft of (result.notes ?? []).slice(0, 2)) tell(draft.toParticipantId, draft.body);
  for (const { to, need } of passedOn.slice(0, 2)) {
    tell(
      to.id,
      `I cannot read ${roomName(office, need.room)}, where you work. I need this from it: ${need.purpose.trim().replace(/[.\s]+$/, "")}. Can you check it and answer with a note?`,
    );
  }

  // A playbook's output is written for a step that went through, so it only
  // lands when the step did. An AI agent's output was written knowing what it
  // could not see, so it is kept and marked as a draft.
  const asDraft = wallHit && participant.agentType === "ai";
  if (result.output && (!wallHit || asDraft)) {
    const output: Message = {
      id: nextId("m"),
      kind: "output",
      taskId: task.id,
      fromId: participant.id,
      audience: { to: "room", id: task.roomId },
      roomId: task.roomId,
      at: now,
      body: result.output.body,
      label: asDraft ? `Draft: ${result.output.label}` : result.output.label,
      // Only an AI agent's output comes from a model. A playbook's is canned.
      simulated: participant.agentType !== "ai",
    };
    emitted.push(output);
  }

  if (emitted.length > 0) {
    updated = {
      ...updated,
      history: [
        ...updated.history,
        {
          at: now,
          summary: attending
            ? `${participant.displayName} attended to a note`
            : `${participant.displayName} worked ${stageSpec(stage).label}`,
        },
      ],
    };
  }

  // The owner can set the task to wait for a day. A wait stays until that day
  // or until a person ends it: a later step that names no day leaves it be,
  // since the owner is also woken for a colleague's note in the meantime.
  // Nothing waits at a halt, at a stage a person closes, or on the word of an
  // agent that only came for a note.
  if (!attending) {
    const until = result.wait ? Date.parse(`${result.wait.until.trim()}T14:00:00Z`) : NaN;
    const reason = result.wait?.reason.trim().slice(0, 200) ?? "";
    const open = updated.status === openStatus(stage) && !stageSpec(stage).humanGate;
    if (open && reason && Number.isFinite(until) && until > now && until < now + 366 * 86_400_000) {
      updated = { ...updated, wait: { until, reason } };
      const body = `Waiting until ${dayOf(until)}: ${reason}`;
      if (!emitted.some((m) => m.body === body) && !office.messages.some((m) => m.taskId === task.id && m.body === body && m.at >= sentBackAt)) {
        emitted.push({
          id: nextId("m"),
          kind: "status",
          taskId: task.id,
          fromId: participant.id,
          audience: { to: "room", id: task.roomId },
          roomId: task.roomId,
          at: now,
          body,
        });
      }
      notes.push(`${task.id} waits until ${dayOf(until)}: ${reason}`);
    }
  }

  const after: Office = { ...replaceTask(office, updated), messages: [...office.messages, ...emitted] };

  // An AI agent that acted in a system takes the step once more, so it can use
  // what the system answered: an order number, a refusal, a cost. It gets one
  // such step. If the model cannot answer, what it already did stands.
  if (acted && !afterAction && participant.agentType === "ai" && updated.status !== "blocked_question") {
    try {
      const next = await runAgent(after, updated, stage, participant, runtime, now, nextId, true, true, attending);
      return { office: next.office, emitted: [...emitted, ...next.emitted], notes: [...notes, ...next.notes] };
    } catch (error) {
      notes.push(
        `${participant.displayName} could not follow up on ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { office: after, emitted, notes };
}
