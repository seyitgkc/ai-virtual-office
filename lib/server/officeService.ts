/**
 * The one place where a signed-in person meets an office.
 *
 * A database holds many offices. A session looks at one of them at a time,
 * through the seat its user holds there. For every action: read that office
 * from the database, stamp the action with the seat, check the policy, run
 * the engine, then write the changes and an audit entry in one transaction.
 */
import { randomUUID } from "node:crypto";
import { AdminError, applyAdminOp, blankOffice, permissionFor, type AdminOp } from "../admin";
import { nextStage, reduce, stageSpec, type Action, type AgentRuntime, type EngineState, type Wake } from "../engine";
import { initialState } from "../initialState";
import { statusReply } from "../agentState";
import {
  may,
  PERMISSION_INFO,
  resolveAccess,
  type AccessContext,
  type Office,
  type Participant,
  type Permission,
} from "../model";
import { runPlaybook } from "../playbook";
import { authorize, contextOf, mayRead, stampActor, viewFor } from "../policy";
import type { FeedEntry, OfficeView } from "../view";
import { listAccessTokens, syncAccessTokens, tokenProblem } from "./accessTokens";
import {
  addMembership,
  createUser,
  seatsOf,
  setPassword,
  switchSeat,
  userByEmail,
  userByParticipant,
  usersInOffice,
  type Session,
  type User,
} from "./auth";
import { all, database, get, run, transaction, type Db } from "./db";
import {
  deleteOffice,
  freshIdScope,
  hasOffice,
  loadEngineState,
  saveEngineState,
  writeParticipant,
  writeWholeOffice,
} from "./officeStore";
import {
  ProviderError,
  accountProviderViews,
  providerIds,
  providerViews,
  removeProvider,
  runtimeForAgent,
  saveProvider,
  testStoredProvider,
  type ProviderInput,
  type ProviderOwner,
} from "./providers";
import { dataMarker } from "./modelRuntime";
import {
  buildChatSystem,
  directLines,
  earlierTurns,
  markDirectRead,
  markNoteRead,
  readNoteIds,
  recordDirect,
  unreadDirects,
} from "./chat";
import { sampleOffice, sampleSystemRooms } from "../sampleOffice";
import {
  connectSampleServices,
  ensureDemoSystems,
  liveRecords,
  performInSystem,
  readSystem,
  removeSystem,
  saveSystem,
  SystemError,
  systemRoom,
  systemViews,
  type SystemInput,
} from "./systems";

/** The seeded distributor. It exists only for password-free demo sign-in. */
export const DEMO_OFFICE_ID = initialState.office.id;
export const isDemoOffice = (officeId: string | null): boolean => officeId === DEMO_OFFICE_ID;

/** Demo sign-in lets a visitor enter the demo office as a seeded person. */
export const demoLoginEnabled = (): boolean => process.env.DEMO_LOGIN !== "0";

const MAX_OFFICES_PER_ACCOUNT = 12;

export class OfficeError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 424,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

const boot = globalThis as unknown as { __officeBooted?: boolean };

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "");

/** Every person in the demo office gets a password-free demo sign-in. */
function ensureDemoAccounts(db: Db, office: Office): void {
  for (const p of office.participants) {
    if (p.kind !== "human" || userByParticipant(db, p.id)) continue;
    const wanted = `${slug(p.displayName)}@office.test`;
    const email = userByEmail(db, wanted) ? `${slug(p.displayName)}.${randomUUID().slice(0, 6)}@office.test` : wanted;
    const user = createUser(db, { email, displayName: p.displayName, password: null });
    addMembership(db, user.id, p.id);
  }
}

const nameFromEmail = (email: string): string => {
  const local = email.split("@")[0].replace(/[._-]+/g, " ").trim();
  return local ? local.replace(/\b\w/g, (c) => c.toUpperCase()) : "Administrator";
};

/** Create an empty office and seat this user in it as its administrator. */
function createBlankOfficeFor(db: Db, user: User, name: string): { officeId: string; participantId: string } {
  const office = blankOffice({
    suffix: randomUUID().slice(0, 8),
    name,
    admin: { displayName: user.displayName, title: "Administrator" },
  });
  // A real office runs on the real clock: a step of zero tells the service to
  // stamp each action with the current time.
  writeWholeOffice(db, { office, now: Date.now(), seq: 0, clockStepMinutes: 0, idScope: freshIdScope(db) });
  const participantId = office.participants[0].id;
  addMembership(db, user.id, participantId);
  return { officeId: office.id, participantId };
}

/**
 * The administrator named in the environment. The account is separate from
 * the demo: it never holds a seat in the demo office, and it starts with an
 * empty office of its own.
 */
function ensureAdminAccount(db: Db): void {
  const email = process.env.ADMIN_EMAIL?.trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  const displayName = process.env.ADMIN_NAME?.trim() || nameFromEmail(email);

  let user = userByEmail(db, email);
  if (!user) {
    user = createUser(db, { email, displayName, password });
  } else {
    setPassword(db, user.id, password);
  }

  // An earlier version attached these credentials to the demo supervisor.
  // Give that seat back to the demo and the account its own name.
  const inDemo = seatsOf(db, user.id).filter((s) => isDemoOffice(s.officeId));
  for (const seat of inDemo) run(db, "DELETE FROM memberships WHERE participant_id = ?", seat.participantId);
  if (inDemo.length > 0 || process.env.ADMIN_NAME) {
    run(db, "UPDATE users SET display_name = ? WHERE id = ?", displayName, user.id);
    user = { ...user, displayName };
  }

  if (seatsOf(db, user.id).length === 0) createBlankOfficeFor(db, user, "My office");
}

/**
 * A demo office stored before agents had playbooks comes back with none. Give
 * its agents the seeded ones, so the demo scenario still plays out.
 */
function restoreDemoPlaybooks(db: Db, office: Office): void {
  const agents = office.participants.filter((p) => p.kind === "agent");
  if (agents.some((p) => p.agentType === "ai" || p.playbook.length > 0)) return;
  const rooms = new Set(office.floorplan.rooms.map((r) => r.id));
  const people = new Set(office.participants.map((p) => p.id));
  for (const agent of agents) {
    const seeded = initialState.office.participants.find((p) => p.id === agent.id)?.playbook ?? [];
    const playbook = seeded.filter(
      (step) =>
        (step.when.requestedBy === "anyone" || people.has(step.when.requestedBy)) &&
        (!step.then.need || rooms.has(step.then.need.room)) &&
        (!step.then.question || step.then.question.to === "requester" || people.has(step.then.question.to)),
    );
    if (playbook.length > 0) writeParticipant(db, office.id, { ...agent, agentType: "playbook", playbook });
  }
}

/** Open the database and make sure the demo office and the administrator exist. */
export function officeDatabase(): Db {
  const db = database();
  if (boot.__officeBooted) return db;
  transaction(db, () => {
    if (demoLoginEnabled() && !hasOffice(db, DEMO_OFFICE_ID)) writeWholeOffice(db, initialState);
    ensureAdminAccount(db);
    const demo = loadEngineState(db, DEMO_OFFICE_ID);
    if (demo) {
      ensureDemoAccounts(db, demo.office);
      restoreDemoPlaybooks(db, demo.office);
      ensureDemoSystems(db, demo.office);
    }
    syncAccessTokens(db);
  });
  boot.__officeBooted = true;
  return db;
}

// ---------------------------------------------------------------------------
// Agent runtimes
// ---------------------------------------------------------------------------

const overrides = globalThis as unknown as { __officeRuntime?: AgentRuntime };

/** For tests: answer every agent step with this runtime, in every office. */
export function useAgentRuntime(runtime: AgentRuntime | undefined): void {
  overrides.__officeRuntime = runtime;
}

/**
 * How an office's agents answer. Each agent answers for itself: a playbook
 * agent from its written steps, an AI agent through the provider it names.
 */
function runtimeFor(db: Db, officeId: string): AgentRuntime {
  const perform: AgentRuntime["perform"] = (call) => performInSystem(db, officeId, call);
  const override = overrides.__officeRuntime;
  if (override) return { step: (input) => override.step(input), perform: override.perform ?? perform };
  return {
    step: async (input) => {
      if (input.participant.agentType !== "ai") return runPlaybook(input);
      // An AI agent is shown what the systems it may read hold at this moment.
      const readable = input.surroundings.systems.filter((s) => s.readable).map((s) => s.id);
      const live = readable.length > 0 ? await liveRecords(db, officeId, readable) : [];
      return runtimeForAgent(db, officeId, input.participant).step({ ...input, liveRecords: live });
    },
    perform,
  };
}

// ---------------------------------------------------------------------------
// Reading an office
// ---------------------------------------------------------------------------

/** The office a session is looking at, with its clock set. */
function loadOffice(db: Db, session: Session): EngineState {
  if (!session.officeId) throw new OfficeError(409, "You are not in an office yet. Add one to continue.");
  const state = loadEngineState(db, session.officeId);
  if (!state) throw new OfficeError(404, "That office no longer exists.");
  // The demo keeps its fixed demo clock. Every other office uses real time.
  return state.clockStepMinutes === 0 ? { ...state, now: Date.now() } : state;
}

function viewerOf(office: Office, session: Session): Participant {
  const viewer = office.participants.find((p) => p.id === session.participantId);
  if (!viewer) throw new OfficeError(401, "Your seat in this office no longer exists.");
  return viewer;
}

/** The signed-in person, provided their role carries this permission. */
function requirePermission(state: EngineState, session: Session, permission: Permission): Participant {
  const actor = viewerOf(state.office, session);
  if (!may(state.office, actor, permission)) {
    throw new OfficeError(
      403,
      `Your role does not have the "${PERMISSION_INFO[permission].label}" permission in this office.`,
    );
  }
  return actor;
}

function feedFor(db: Db, state: EngineState, viewer: Participant): FeedEntry[] {
  const ctx = contextOf(state.office, state.now);
  const seesAll = may(state.office, viewer, "see_everything");
  const rows = all<{
    audit_id: number;
    position: number;
    note: string;
    office_clock_ms: number;
    actor_participant_id: string;
    room_id: string | null;
  }>(
    db,
    `SELECT n.audit_id, n.position, n.note, l.office_clock_ms, l.actor_participant_id, l.room_id
       FROM audit_notes n JOIN audit_log l ON l.id = n.audit_id
      WHERE l.office_id = ?
      ORDER BY n.audit_id DESC, n.position DESC
      LIMIT 200`,
    state.office.id,
  );
  return rows
    .filter(
      (r) =>
        seesAll ||
        r.actor_participant_id === viewer.id ||
        (r.room_id !== null && mayRead(ctx, viewer, r.room_id)),
    )
    .slice(0, 60)
    .map((r) => ({ id: r.audit_id * 100 + r.position, at: r.office_clock_ms, text: r.note }));
}

function buildView(db: Db, state: EngineState, session: Session): OfficeView {
  const viewer = viewerOf(state.office, session);
  const ctx = contextOf(state.office, state.now);
  const { office, hiddenMessages } = viewFor(state.office, ctx, viewer);
  const can = (permission: Permission): boolean => may(state.office, viewer, permission);
  const permissions = state.office.roles[viewer.roleId]?.permissions ?? [];

  return {
    office,
    now: state.now,
    viewer: {
      participantId: viewer.id,
      displayName: viewer.displayName,
      title: viewer.title,
      email: session.email,
      permissions,
    },
    account: { email: session.email, displayName: session.displayName, isDemo: !session.hasPassword },
    offices: seatsOf(db, session.userId).map((seat) => ({
      officeId: seat.officeId,
      name: seat.officeName,
      canRemove: seat.permissions.includes("manage_office") && !isDemoOffice(seat.officeId),
      isDemo: isDemoOffice(seat.officeId),
      active: seat.officeId === office.id,
    })),
    isDemoOffice: isDemoOffice(office.id),
    agentsAtWork: agentsAtWork(office.id),
    feed: feedFor(db, state, viewer),
    hiddenMessages,
    // Keys never leave the server. The list is for people who connect
    // providers or choose one for an agent.
    providers:
      can("manage_providers") || can("manage_people")
        ? providerViews(db, office.id, session.userId, can("use_shared_providers"))
        : [],
    ownProviders: session.hasPassword ? accountProviderViews(db, session.userId) : [],
    ownProvidersEditable: session.hasPassword,
    providersEditable: can("manage_providers") && session.hasPassword && !isDemoOffice(office.id),
    directs: directLines(db, viewer.id),
    unread: {
      directs: unreadDirects(db, viewer.id),
      notes: ((opened) =>
        state.office.messages
          .filter((m) => m.kind === "note" && m.audience.to === "participant" && m.audience.id === viewer.id && !opened.has(m.id))
          .map((m) => m.id))(readNoteIds(db, viewer.id)),
    },
    // Addresses are for people who manage rooms, and only for systems in
    // rooms they can read.
    systems: can("manage_rooms")
      ? systemViews(db, office.id).filter((s) => mayRead({ ...ctx, forTask: null }, viewer, s.roomId))
      : [],
    systemsEditable: can("manage_rooms") && session.hasPassword && !isDemoOffice(office.id),
    // Token details are for people who manage access and for the holder.
    accessTokens: listAccessTokens(db, office.id)
      .filter((t) => can("manage_access") || t.participantId === viewer.id)
      .map((t) => ({ ...t, problem: tokenProblem(t, state.office, ctx) })),
    accounts: can("manage_people") || can("invite_people")
      ? usersInOffice(db, office.id).map((u) => ({
          participantId: u.participantId,
          email: u.email,
          hasPassword: u.hasPassword,
        }))
      : [],
  };
}

export function getView(session: Session): OfficeView {
  const db = officeDatabase();
  return buildView(db, loadOffice(db, session), session);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

// Changes are applied one at a time. A transition can wait on an agent, and a
// second change must start from the state the first one left behind.
let queue: Promise<unknown> = Promise.resolve();
function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

interface AuditSubject {
  taskId: string | null;
  subjectParticipantId: string | null;
  ruleId: string | null;
  roomId: string | null;
}

const NO_SUBJECT: AuditSubject = { taskId: null, subjectParticipantId: null, ruleId: null, roomId: null };

/** Pull out the things an action was about, for the audit columns. */
function auditSubject(action: Action, before: Office, after: Office): AuditSubject {
  const messageTask = (id: string) => after.messages.find((m) => m.id === id)?.taskId ?? null;
  let taskId: string | null = null;
  let subjectParticipantId: string | null = null;
  let ruleId: string | null = null;
  let roomId: string | null = null;

  switch (action.type) {
    case "SUBMIT_REQUEST": {
      const known = new Set(before.tasks.map((t) => t.id));
      taskId = after.tasks.find((t) => !known.has(t.id))?.id ?? null;
      break;
    }
    case "ADVANCE":
    case "DECIDE":
      taskId = action.taskId;
      break;
    case "REASSIGN":
      taskId = action.taskId;
      subjectParticipantId = action.toParticipantId;
      break;
    case "ANSWER_QUESTION":
      taskId = messageTask(action.questionId);
      break;
    case "RESOLVE_ASSUMPTION":
      taskId = messageTask(action.assumptionId);
      break;
    case "GRANT_ACCESS": {
      const known = new Set(before.rules.map((r) => r.id));
      ruleId = after.rules.find((r) => !known.has(r.id))?.id ?? null;
      subjectParticipantId = action.participantId;
      roomId = action.room === "*" ? null : action.room;
      taskId = action.expiresOnTaskId ?? null;
      break;
    }
    case "REVOKE_RULE": {
      const rule = before.rules.find((r) => r.id === action.ruleId);
      ruleId = action.ruleId;
      subjectParticipantId = rule?.participantId ?? null;
      roomId = rule && rule.room !== "*" ? rule.room : null;
      break;
    }
  }
  // Where it happened: the room the task is in once the action has applied.
  roomId ??= after.tasks.find((t) => t.id === taskId)?.roomId ?? null;
  return { taskId, subjectParticipantId, ruleId, roomId };
}

export function recordAudit(
  db: Db,
  entry: {
    officeId: string;
    officeClock: number;
    actorId: string;
    actionType: string;
    subject: AuditSubject;
    notes: string[];
  },
): void {
  run(
    db,
    `INSERT INTO audit_log
       (office_id, recorded_at, office_clock_ms, actor_participant_id, action_type, task_id,
        subject_participant_id, rule_id, room_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    entry.officeId,
    Date.now(),
    entry.officeClock,
    entry.actorId,
    entry.actionType,
    entry.subject.taskId,
    entry.subject.subjectParticipantId,
    entry.subject.ruleId,
    entry.subject.roomId,
  );
  const { id } = db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
  entry.notes.forEach((note, position) => {
    run(db, "INSERT INTO audit_notes (audit_id, position, note) VALUES (?, ?, ?)", id, position, note);
  });
}

/** Apply one action on behalf of the signed-in person and return their view. */
export function applyAction(session: Session, requested: Action): Promise<OfficeView> {
  return inTurn(async () => {
    const db = officeDatabase();
    const before = loadOffice(db, session);
    const actor = viewerOf(before.office, session);
    const action = stampActor(requested, actor.id);
    const verdict = authorize(before.office, contextOf(before.office, before.now), actor, action);
    if (!verdict.allowed) throw new OfficeError(403, verdict.reason);

    let result;
    try {
      result = await reduce(before, action, runtimeFor(db, before.office.id));
    } catch (error) {
      throw new OfficeError(409, error instanceof Error ? error.message : "That action could not be applied.");
    }

    transaction(db, () => {
      saveEngineState(db, before, result.state);
      syncAccessTokens(db);
      recordAudit(db, {
        officeId: before.office.id,
        officeClock: result.state.now,
        actorId: actor.id,
        actionType: action.type,
        subject: auditSubject(action, before.office, result.state.office),
        notes: result.notes,
      });
    });
    carryOn(before.office.id, result.wake, changedTasks(before.office, result.state.office));
    return buildView(db, result.state, session);
  });
}

// ---------------------------------------------------------------------------
// Agents carrying work forward
//
// An agent does not only act at the moment a person clicks. After each action
// the office looks at what agents now have in front of them: an answer to a
// question, a note from a colleague, a finished step that can go to the next
// stage. That work runs in the background, one step at a time, in the same
// queue as people's actions, so a click returns at once and the office is
// never changed by two things at the same moment.
//
// It is bounded. A run takes a limited number of steps, every halt stays a
// halt, and a step that fails is logged and left for a person.
// ---------------------------------------------------------------------------

/** One thing an agent does without a person asking: a wake, or handing a task on. */
type Pending = Wake | { kind: "advance"; taskId: string };

const STEPS_PER_RUN = 12;

const loop = globalThis as unknown as {
  __officeLoop?: { paused: boolean; runs: Map<string, Promise<void>> };
};
const loopState = (): { paused: boolean; runs: Map<string, Promise<void>> } =>
  (loop.__officeLoop ??= { paused: process.env.OFFICE_AGENTS_PAUSED === "1", runs: new Map() });

/** For tests: stop agents carrying work forward, or let them again. */
export function pauseAgents(paused: boolean): void {
  loopState().paused = paused;
}

/** Resolves once no agent is working in the background. */
export async function agentsIdle(): Promise<void> {
  for (;;) {
    const runs = [...loopState().runs.values()];
    if (runs.length === 0) return;
    await Promise.allSettled(runs);
  }
}

/** Whether agents are working in the background in this office right now. */
const agentsAtWork = (officeId: string): boolean => loopState().runs.has(officeId);

/** Ids of tasks an action created or changed. */
function changedTasks(before: Office, after: Office): string[] {
  const earlier = new Map(before.tasks.map((t) => [t.id, t]));
  return after.tasks.filter((t) => earlier.get(t.id) !== t).map((t) => t.id);
}

/** A task that its agent has finished with at this stage and can pass on. */
function readyToHandOn(office: Office, taskIds: Set<string>, skip: Set<string>): string | null {
  if (!office.autoHandoff) return null;
  for (const task of office.tasks) {
    if (!taskIds.has(task.id) || skip.has(task.id)) continue;
    if (task.closedAt !== null || task.status !== "in_progress") continue;
    if (stageSpec(task.stage).humanGate || nextStage(task.stage) === null) continue;
    if (office.participants.find((p) => p.id === task.ownerId)?.kind === "agent") return task.id;
  }
  return null;
}

/** Start, or add to, the background run for an office. */
function carryOn(officeId: string, wakes: Wake[], taskIds: string[]): void {
  const state = loopState();
  if (state.paused || (wakes.length === 0 && taskIds.length === 0)) return;
  const earlier = state.runs.get(officeId) ?? Promise.resolve();
  const run: Promise<void> = earlier
    .then(() => runPending(officeId, wakes, new Set(taskIds)))
    .catch((error) => console.error("An agent run failed.", error))
    .finally(() => {
      if (state.runs.get(officeId) === run) state.runs.delete(officeId);
    });
  state.runs.set(officeId, run);
}

async function runPending(officeId: string, wakes: Wake[], taskIds: Set<string>): Promise<void> {
  const waiting: Pending[] = [...wakes];
  const stuck = new Set<string>();
  for (let step = 0; step < STEPS_PER_RUN; step++) {
    // Each step takes its own turn in the queue, so people's actions fit in between.
    const more = await inTurn(async () => {
      const db = officeDatabase();
      const loaded = loadEngineState(db, officeId);
      if (!loaded) return null;
      const before = loaded.clockStepMinutes === 0 ? { ...loaded, now: Date.now() } : loaded;
      const handOn = waiting.length === 0 ? readyToHandOn(before.office, taskIds, stuck) : null;
      const next: Pending | undefined = waiting.shift() ?? (handOn ? { kind: "advance", taskId: handOn } : undefined);
      if (!next) return null;
      return takeStep(db, before, next, stuck);
    });
    if (more === null) return;
    waiting.push(...more.wake);
    for (const id of more.taskIds) taskIds.add(id);
  }
}

/** Apply one background step and store it. A failure is logged for people to see. */
async function takeStep(
  db: Db,
  before: EngineState,
  next: Pending,
  stuck: Set<string>,
): Promise<{ wake: Wake[]; taskIds: string[] }> {
  const task = before.office.tasks.find((t) => t.id === next.taskId);
  const agentId = next.kind === "advance" ? task?.ownerId : next.participantId;
  const agent = before.office.participants.find((p) => p.id === agentId && p.kind === "agent");
  if (!task || !agent) return { wake: [], taskIds: [] };
  const action: Action =
    next.kind === "advance"
      ? { type: "ADVANCE", taskId: task.id }
      : next.kind === "resume"
        ? { type: "AGENT_RESUME", taskId: task.id }
        : { type: "AGENT_ATTEND", taskId: task.id, participantId: agent.id, noteId: next.noteId };
  const subject: AuditSubject = { ...NO_SUBJECT, taskId: task.id, subjectParticipantId: agent.id, roomId: task.roomId };

  let result;
  try {
    result = await reduce(before, action, runtimeFor(db, before.office.id));
  } catch (error) {
    // The task is left where it is, and is not tried again in this run.
    stuck.add(task.id);
    recordAudit(db, {
      officeId: before.office.id,
      officeClock: before.now,
      actorId: agent.id,
      actionType: action.type,
      subject,
      notes: [
        `${agent.displayName} could not carry ${task.id} forward: ${error instanceof Error ? error.message : String(error)}`,
      ],
    });
    return { wake: [], taskIds: [] };
  }
  const moved = result.state.office.tasks.find((t) => t.id === task.id);
  // A handoff that went nowhere, for want of anyone to take it, is not repeated.
  if (next.kind === "advance" && moved?.stage === task.stage) stuck.add(task.id);
  // After taking its step again, the task may be handed on, but not taken again.
  if (next.kind === "resume" && moved?.status !== "in_progress") stuck.add(task.id);

  transaction(db, () => {
    saveEngineState(db, before, result.state);
    syncAccessTokens(db);
    recordAudit(db, {
      officeId: before.office.id,
      officeClock: result.state.now,
      actorId: agent.id,
      actionType: action.type,
      subject,
      notes: result.notes,
    });
  });
  return { wake: result.wake, taskIds: changedTasks(before.office, result.state.office) };
}

// ---------------------------------------------------------------------------
// Set-up changes
// ---------------------------------------------------------------------------

const quoted = (office: Office, id: string): string =>
  office.floorplan.rooms.find((r) => r.id === id)?.name ??
  office.participants.find((p) => p.id === id)?.displayName ??
  office.roles[id]?.name ??
  id;

/** One plain sentence for the audit log and the activity feed. */
function describeAdminOp(op: AdminOp, before: Office, after: Office, actor: Participant): string {
  const who = actor.displayName;
  switch (op.type) {
    case "SET_AUTO_HANDOFF":
      return `${who} set agents to ${op.on ? "hand work on by themselves" : "wait for a person to move work on"}`;
    case "RENAME_OFFICE":
      return `${who} renamed the office to ${after.name}`;
    case "CLEAR_WORK":
      return `${who} cleared all work: ${before.tasks.length} tasks and ${before.messages.length} messages`;
    case "ADD_AGENT":
      return `${who} added the ${op.agentType === "ai" ? "AI" : "playbook"} agent ${op.displayName.trim()} with a desk in ${quoted(after, op.roomId)}`;
    case "UPDATE_PARTICIPANT":
      return `${who} updated ${quoted(after, op.participantId)}`;
    case "SET_PLAYBOOK":
      return `${who} changed the playbook of ${quoted(after, op.participantId)}: ${op.steps.length} step${op.steps.length === 1 ? "" : "s"}`;
    case "SET_ROLE_PERMISSION":
      return `${who} ${op.allowed ? "gave" : "took away"} the "${PERMISSION_INFO[op.permission].label}" permission ${op.allowed ? "to" : "from"} the role ${quoted(after, op.roleId)}`;
    case "REMOVE_PARTICIPANT":
      return `${who} removed ${quoted(before, op.participantId)} from the office`;
    case "ADD_ROLE":
      return `${who} added the role ${op.name.trim()}`;
    case "UPDATE_ROLE":
      return `${who} updated the role ${quoted(after, op.roleId)}`;
    case "REMOVE_ROLE":
      return `${who} removed the role ${quoted(before, op.roleId)}`;
    case "SET_ROLE_GRANT": {
      const room = op.room === "*" ? "every room" : quoted(after, op.room);
      const change = op.effect === "none" ? `cleared ${op.scope}` : `set ${op.scope} to ${op.effect}`;
      return `${who} ${change} on ${room} for the role ${quoted(after, op.roleId)}`;
    }
    case "ADD_ROOM":
      return `${who} added the room ${op.name.trim()} next to ${quoted(before, op.attachTo)}`;
    case "UPDATE_ROOM":
      return `${who} updated the room ${quoted(after, op.roomId)}`;
    case "SET_ROOM_RECORDS":
      return `${who} changed the records kept in ${quoted(after, op.roomId)}`;
    case "REMOVE_ROOM":
      return `${who} removed the room ${quoted(before, op.roomId)}`;
    case "SET_STAGE_ROOM":
      return `${who} moved the ${op.stage} stage to ${quoted(after, op.roomId)}`;
  }
}

/** Apply one change to how the office is set up, if the person's role allows it. */
export function applyAdminOperation(session: Session, op: AdminOp): Promise<OfficeView> {
  return inTurn(async () => {
    const db = officeDatabase();
    const before = loadOffice(db, session);
    const actor = requirePermission(before, session, permissionFor(op));
    if (op.type === "SET_ROOM_RECORDS" && !mayRead({ ...contextOf(before.office, before.now), forTask: null }, actor, op.roomId)) {
      throw new OfficeError(403, "You cannot read that room, so you cannot change its records.");
    }

    let office: Office;
    try {
      office = applyAdminOp(
        before.office,
        op,
        actor.id,
        () => randomUUID().slice(0, 8),
        // Providers this person may hand out, plus any an agent already runs
        // on, so an unrelated edit to that agent is not refused.
        new Set([
          ...providerIds(db, before.office.id, session.userId, may(before.office, actor, "use_shared_providers")),
          ...before.office.participants.flatMap((p) => (p.providerId ? [p.providerId] : [])),
        ]),
      );
    } catch (error) {
      if (error instanceof AdminError) throw new OfficeError(409, error.message);
      throw error;
    }
    const after: EngineState = { ...before, office };

    try {
      transaction(db, () => {
        saveEngineState(db, before, after);
        if (isDemoOffice(after.office.id)) ensureDemoAccounts(db, after.office);
        syncAccessTokens(db);
        recordAudit(db, {
          officeId: after.office.id,
          officeClock: after.now,
          actorId: actor.id,
          actionType: op.type,
          subject: { ...NO_SUBJECT, subjectParticipantId: "participantId" in op ? op.participantId : null },
          notes: [describeAdminOp(op, before.office, after.office, actor)],
        });
      });
    } catch (error) {
      // The database keeps records the in-memory office does not see, such as
      // audit entries. A constraint failure means one of them still refers to
      // what was being removed.
      if (error instanceof Error && /constraint/i.test(error.message)) {
        throw new OfficeError(409, "That cannot be removed: the office's audit log still refers to it.");
      }
      throw error;
    }
    return buildView(db, loadOffice(db, session), session);
  });
}

/** Where a provider is kept: in the office being viewed, or in the signed-in account. */
export type ProviderScope = "office" | "account";

/** The person and office for a change to the office's AI providers, or a refusal. */
function providerEditor(db: Db, session: Session): { state: EngineState; actor: Participant } {
  const state = loadOffice(db, session);
  const actor = requirePermission(state, session, "manage_providers");
  if (isDemoOffice(state.office.id)) {
    throw new OfficeError(403, "The demo office is shared, so no API key can be stored in it.");
  }
  if (!session.hasPassword) throw new OfficeError(403, "Sign in with a password account to connect a provider.");
  return { state, actor };
}

/** Whose providers a change is about. An account's own need no office permission. */
function providerOwner(db: Db, session: Session, scope: ProviderScope): { owner: ProviderOwner; state: EngineState; actor: Participant } {
  if (scope === "office") {
    const found = providerEditor(db, session);
    return { ...found, owner: { officeId: found.state.office.id } };
  }
  if (!session.hasPassword) throw new OfficeError(403, "Sign in with a password account to keep AI providers of your own.");
  const state = loadOffice(db, session);
  return { state, actor: viewerOf(state.office, session), owner: { userId: session.userId } };
}

/**
 * Add an AI provider, or change one, in the office or in the signed-in
 * account. The API key is stored encrypted and is never returned or logged.
 */
export function saveProviderSettings(
  session: Session,
  input: ProviderInput,
  scope: ProviderScope = "office",
): Promise<OfficeView> {
  return inTurn(async () => {
    const db = officeDatabase();
    const { state, actor, owner } = providerOwner(db, session, scope);
    try {
      transaction(db, () => {
        saveProvider(db, owner, input);
        const keyNote = input.removeKey ? " and removed its API key" : input.apiKey?.trim() ? " and stored its API key" : "";
        // A change to someone's own providers is theirs alone and is not office news.
        if (scope === "office") {
          recordAudit(db, {
            officeId: state.office.id,
            officeClock: state.now,
            actorId: actor.id,
            actionType: input.id ? "UPDATE_AI_PROVIDER" : "ADD_AI_PROVIDER",
            subject: NO_SUBJECT,
            notes: [
              `${actor.displayName} ${input.id ? "changed" : "added"} the AI provider ${input.name.trim()} (${input.defaultModel.trim()})${keyNote}`,
            ],
          });
        }
      });
    } catch (error) {
      if (error instanceof ProviderError) throw new OfficeError(400, error.message);
      throw error;
    }
    return buildView(db, loadOffice(db, session), session);
  });
}

/** Remove an AI provider. Agents that used it are left without one. */
export function removeProviderSettings(
  session: Session,
  providerId: string,
  scope: ProviderScope = "office",
): Promise<OfficeView> {
  return inTurn(async () => {
    const db = officeDatabase();
    const { state, actor, owner } = providerOwner(db, session, scope);
    try {
      transaction(db, () => {
        const name = removeProvider(db, owner, providerId);
        if (scope === "office") {
          recordAudit(db, {
            officeId: state.office.id,
            officeClock: state.now,
            actorId: actor.id,
            actionType: "REMOVE_AI_PROVIDER",
            subject: NO_SUBJECT,
            notes: [`${actor.displayName} removed the AI provider ${name}`],
          });
        }
      });
    } catch (error) {
      if (error instanceof ProviderError) throw new OfficeError(404, error.message);
      throw error;
    }
    return buildView(db, loadOffice(db, session), session);
  });
}

/** Check a stored provider with the service itself. Nothing is generated. */
export async function testProviderSettings(
  session: Session,
  providerId: string,
  scope: ProviderScope = "office",
): Promise<{ ok: true; model: string }> {
  const db = officeDatabase();
  const { owner } = providerOwner(db, session, scope);
  try {
    return { ok: true, model: await testStoredProvider(db, owner, providerId) };
  } catch (error) {
    if (error instanceof ProviderError) throw new OfficeError(400, error.message);
    // A provider's failure is reported as 424. A proxy in front of the server
    // replaces the body of a 5xx reply with its own page, which hides the reason.
    throw new OfficeError(424, error instanceof Error ? error.message : "The connection test failed.");
  }
}

// ---------------------------------------------------------------------------
// Talking to an agent
// ---------------------------------------------------------------------------

const overriddenChat = globalThis as unknown as { __officeChat?: (system: string, turns: { content: string }[]) => Promise<string> };

/** For tests: answer every AI agent's conversation with this function. */
export function useChatReply(reply: ((system: string, turns: { content: string }[]) => Promise<string>) | undefined): void {
  overriddenChat.__officeChat = reply;
}

/**
 * Send a direct message to someone in the office.
 *
 * To a person it is simply delivered: anyone may message anyone, and only the
 * two of them can read it. To an agent it is a conversation at the agent's
 * desk, so the sender must be allowed to enter the agent's room, and the
 * agent answers at once. An AI agent answers through its provider, shown only
 * what both of them may read. A playbook agent has no model and reports where
 * its work stands. Nothing else in the office changes.
 */
export function sendDirectMessage(session: Session, toId: string, said: string): Promise<OfficeView> {
  return inTurn(async () => {
    const db = officeDatabase();
    const state = loadOffice(db, session);
    const { office } = state;
    const sender = viewerOf(office, session);
    const other = office.participants.find((p) => p.id === toId);
    if (!other) throw new OfficeError(404, "That person or agent is not in this office.");
    if (other.id === sender.id) throw new OfficeError(400, "You cannot send a message to yourself.");
    const body = said.trim();
    if (body.length === 0 || body.length > 600) throw new OfficeError(400, "Write a message of up to 600 characters.");

    // A conversation is outside any task, so grants made for a task do not count.
    const ctx: AccessContext = { ...contextOf(office, state.now), forTask: null };
    const room = office.floorplan.rooms.find((r) => r.deskIds.includes(other.deskId ?? ""));
    let reply: string | null = null;
    if (other.kind === "agent") {
      if (room && resolveAccess(sender, room.id, "enter", ctx).effect !== "allow") {
        throw new OfficeError(403, `You cannot enter ${room.name}, so you cannot talk to ${other.displayName} at their desk.`);
      }
      if (other.agentType !== "ai") {
        reply = statusReply(office, other, sender, ctx);
      } else {
        const shared = office.systems
          .filter((s) => mayRead(ctx, other, s.roomId) && mayRead(ctx, sender, s.roomId))
          .map((s) => s.id);
        const live = shared.length > 0 ? await liveRecords(db, office.id, shared) : [];
        const system = buildChatSystem(office, other, sender, ctx, live, dataMarker());
        const turns = [...earlierTurns(db, other.id, sender.id), { role: "user" as const, content: body }];
        try {
          reply = overriddenChat.__officeChat
            ? await overriddenChat.__officeChat(system, turns)
            : await runtimeForAgent(db, office.id, other).chat(other.displayName, system, turns);
        } catch (error) {
          // Reported as 424 for the same reason as a failed connection test.
          throw new OfficeError(424, error instanceof Error ? error.message : `${other.displayName} could not answer.`);
        }
      }
    }

    transaction(db, () => {
      recordDirect(db, sender.id, other.id, body, state.now);
      if (reply !== null) recordDirect(db, other.id, sender.id, reply.slice(0, 2000), state.now);
      // The sender is looking at the conversation, so it is read up to here.
      markDirectRead(db, sender.id, other.id);
      recordAudit(db, {
        officeId: office.id,
        officeClock: state.now,
        actorId: sender.id,
        actionType: other.kind === "agent" ? "TALK_TO_AGENT" : "SEND_MESSAGE",
        subject: { ...NO_SUBJECT, subjectParticipantId: other.id },
        notes: [`${sender.displayName} ${other.kind === "agent" ? "talked to" : "sent a message to"} ${other.displayName}`],
      });
    });
    return buildView(db, loadOffice(db, session), session);
  });
}

/** Mark a conversation, or one note addressed to the viewer, as opened. */
export function markOpened(session: Session, target: { otherId?: string; noteId?: string }): OfficeView {
  const db = officeDatabase();
  const state = loadOffice(db, session);
  const viewer = viewerOf(state.office, session);
  if (target.otherId && state.office.participants.some((p) => p.id === target.otherId)) {
    markDirectRead(db, viewer.id, target.otherId);
  }
  const note = state.office.messages.find((m) => m.id === target.noteId);
  if (note && note.kind === "note" && note.audience.to === "participant" && note.audience.id === viewer.id) {
    markNoteRead(db, viewer.id, note.id);
  }
  return buildView(db, state, session);
}

// ---------------------------------------------------------------------------
// Connected systems
// ---------------------------------------------------------------------------

/** The person and office for work on a room's connected systems, or a refusal. */
function systemManager(db: Db, session: Session, roomId: string | null): { state: EngineState; actor: Participant } {
  const state = loadOffice(db, session);
  const actor = requirePermission(state, session, "manage_rooms");
  if (roomId === null) throw new OfficeError(404, "That connected system does not exist in this office.");
  if (!mayRead({ ...contextOf(state.office, state.now), forTask: null }, actor, roomId)) {
    throw new OfficeError(403, "You cannot read that room, so you cannot manage what is connected to it.");
  }
  return { state, actor };
}

function systemEditor(db: Db, session: Session, roomId: string | null): { state: EngineState; actor: Participant } {
  const found = systemManager(db, session, roomId);
  if (isDemoOffice(found.state.office.id)) {
    throw new OfficeError(403, "The demo office is shared, so its connected systems are fixed.");
  }
  if (!session.hasPassword) throw new OfficeError(403, "Sign in with a password account to connect a system.");
  return found;
}

/** Connect a system to a room, or change one. The API key is stored encrypted. */
export function saveSystemSettings(session: Session, input: SystemInput): Promise<OfficeView> {
  return inTurn(async () => {
    const db = officeDatabase();
    const { state, actor } = systemEditor(db, session, input.roomId);
    if (input.id) systemEditor(db, session, systemRoom(db, state.office.id, input.id));
    try {
      transaction(db, () => {
        saveSystem(db, state.office, input);
        const room = state.office.floorplan.rooms.find((r) => r.id === input.roomId)?.name ?? input.roomId;
        recordAudit(db, {
          officeId: state.office.id,
          officeClock: state.now,
          actorId: actor.id,
          actionType: input.id ? "UPDATE_SYSTEM" : "ADD_SYSTEM",
          subject: { ...NO_SUBJECT, roomId: input.roomId },
          notes: [`${actor.displayName} ${input.id ? "changed" : "connected"} the system ${input.name.trim()} in ${room}`],
        });
      });
    } catch (error) {
      if (error instanceof SystemError) throw new OfficeError(400, error.message);
      throw error;
    }
    return buildView(db, loadOffice(db, session), session);
  });
}

/** Disconnect a system from its room. */
export function removeSystemSettings(session: Session, systemId: string): Promise<OfficeView> {
  return inTurn(async () => {
    const db = officeDatabase();
    const { state, actor } = systemEditor(db, session, systemRoom(db, session.officeId ?? "", systemId));
    transaction(db, () => {
      const removed = removeSystem(db, state.office.id, systemId);
      recordAudit(db, {
        officeId: state.office.id,
        officeClock: state.now,
        actorId: actor.id,
        actionType: "REMOVE_SYSTEM",
        subject: { ...NO_SUBJECT, roomId: removed.roomId },
        notes: [`${actor.displayName} disconnected the system ${removed.name}`],
      });
    });
    return buildView(db, loadOffice(db, session), session);
  });
}

/** Read what a connected system holds right now, for someone who can read its room. */
export async function readSystemRecords(session: Session, systemId: string): Promise<{ name: string; records: string[] }> {
  const db = officeDatabase();
  systemManager(db, session, systemRoom(db, session.officeId ?? "", systemId));
  try {
    return await readSystem(db, session.officeId ?? "", systemId);
  } catch (error) {
    if (error instanceof SystemError) throw new OfficeError(404, error.message);
    // Reported as 424 for the same reason as a provider's failure.
    throw new OfficeError(424, error instanceof Error ? error.message : "The system gave no answer.");
  }
}

// ---------------------------------------------------------------------------
// Offices
// ---------------------------------------------------------------------------

/** Create a new, empty office for the signed-in account and switch to it. */
export function createOffice(session: Session, name: string): Promise<{ officeId: string }> {
  return inTurn(async () => {
    const db = officeDatabase();
    if (!session.hasPassword) {
      throw new OfficeError(403, "Demo access cannot add offices. Sign in with a password account.");
    }
    if (seatsOf(db, session.userId).length >= MAX_OFFICES_PER_ACCOUNT) {
      throw new OfficeError(409, `An account can hold up to ${MAX_OFFICES_PER_ACCOUNT} offices.`);
    }
    const user: User = {
      id: session.userId,
      email: session.email,
      displayName: session.displayName,
      hasPassword: true,
    };
    let created: { officeId: string; participantId: string };
    try {
      created = transaction(db, () => {
        const made = createBlankOfficeFor(db, user, name);
        recordAudit(db, {
          officeId: made.officeId,
          officeClock: Date.now(),
          actorId: made.participantId,
          actionType: "CREATE_OFFICE",
          subject: NO_SUBJECT,
          notes: [`${user.displayName} created this office.`],
        });
        return made;
      });
    } catch (error) {
      if (error instanceof AdminError) throw new OfficeError(400, error.message);
      throw error;
    }
    switchSeat(db, session, created.officeId);
    return { officeId: created.officeId };
  });
}

/**
 * Create a sample office for the signed-in account and switch to it: the
 * distributor from the demo, staffed by AI agents on one of the account's own
 * providers, with this person as its manager. It is theirs alone, unlike the
 * shared demo, so real model calls are spent only by people they let in.
 */
export function createSampleOffice(session: Session, providerId: string): Promise<{ officeId: string }> {
  return inTurn(async () => {
    const db = officeDatabase();
    if (!session.hasPassword) {
      throw new OfficeError(403, "Demo access cannot add offices. Sign in with a password account.");
    }
    if (seatsOf(db, session.userId).length >= MAX_OFFICES_PER_ACCOUNT) {
      throw new OfficeError(409, `An account can hold up to ${MAX_OFFICES_PER_ACCOUNT} offices.`);
    }
    const provider = accountProviderViews(db, session.userId).find((p) => p.id === providerId);
    if (!provider) throw new OfficeError(400, "Choose one of your own AI providers for the agents to run on.");
    if (!provider.usable) throw new OfficeError(400, `${provider.name} has no readable API key. Enter it again first.`);

    const suffix = randomUUID().slice(0, 8);
    const office = sampleOffice({
      suffix,
      name: "Sample distributor",
      manager: { displayName: session.displayName },
      providerId,
    });
    const managerId = office.participants.find((p) => p.kind === "human")!.id;
    transaction(db, () => {
      writeWholeOffice(db, { office, now: Date.now(), seq: 0, clockStepMinutes: 0, idScope: freshIdScope(db) });
      addMembership(db, session.userId, managerId);
      connectSampleServices(db, suffix, sampleSystemRooms(suffix));
      recordAudit(db, {
        officeId: office.id,
        officeClock: Date.now(),
        actorId: managerId,
        actionType: "CREATE_OFFICE",
        subject: NO_SUBJECT,
        notes: [`${session.displayName} created this sample office, with its agents on ${provider.name}.`],
      });
    });
    switchSeat(db, session, office.id);
    return { officeId: office.id };
  });
}

/** Look at another of the account's offices. */
export function switchOffice(session: Session, officeId: string): void {
  if (!switchSeat(officeDatabase(), session, officeId)) {
    throw new OfficeError(404, "You have no seat in that office.");
  }
}

/**
 * Put the demo office back as it first loaded: its seeded people, rules and
 * three tasks. Everything added there since is removed. People keep their
 * demo sign-ins, and whoever is signed in stays signed in.
 */
export function resetDemoOffice(session: Session): Promise<{ ok: true }> {
  return inTurn(async () => {
    const db = officeDatabase();
    const state = loadOffice(db, session);
    if (!isDemoOffice(state.office.id)) throw new OfficeError(403, "Only the demo office can be reset.");
    requirePermission(state, session, "manage_office");

    transaction(db, () => {
      // Seats and sessions point at people in the office, and are cleared when
      // those people are deleted. They are put back for the seeded people.
      const seeded = new Set(initialState.office.participants.map((p) => p.id));
      const inDemo = "(SELECT id FROM participants WHERE office_id = ?)";
      const seats = all<{ participant_id: string; user_id: string }>(
        db,
        `SELECT participant_id, user_id FROM memberships WHERE participant_id IN ${inDemo}`,
        DEMO_OFFICE_ID,
      ).filter((seat) => seeded.has(seat.participant_id));
      const sessions = all<{ id: string; participant_id: string }>(
        db,
        `SELECT id, participant_id FROM sessions WHERE participant_id IN ${inDemo}`,
        DEMO_OFFICE_ID,
      ).filter((s) => seeded.has(s.participant_id));

      deleteOffice(db, DEMO_OFFICE_ID);
      writeWholeOffice(db, initialState);
      for (const seat of seats) addMembership(db, seat.user_id, seat.participant_id);
      for (const s of sessions) run(db, "UPDATE sessions SET participant_id = ? WHERE id = ?", s.participant_id, s.id);
      ensureDemoAccounts(db, initialState.office);
      ensureDemoSystems(db, initialState.office);
      syncAccessTokens(db);
    });
    return { ok: true };
  });
}

/**
 * Delete an office and everything in it. The person's role there must allow
 * it, and the shared demo office cannot be deleted at all.
 */
export function removeOffice(session: Session, officeId: string): Promise<{ ok: true }> {
  return inTurn(async () => {
    const db = officeDatabase();
    if (isDemoOffice(officeId)) throw new OfficeError(403, "The demo office cannot be removed.");
    const seat = seatsOf(db, session.userId).find((s) => s.officeId === officeId);
    if (!seat) throw new OfficeError(404, "You have no seat in that office.");
    if (!seat.permissions.includes("manage_office")) {
      throw new OfficeError(403, `Your role there does not have the "${PERMISSION_INFO.manage_office.label}" permission.`);
    }
    transaction(db, () => deleteOffice(db, officeId));
    return { ok: true };
  });
}
