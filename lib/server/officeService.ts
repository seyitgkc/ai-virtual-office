/**
 * The one place where a signed-in person meets an office.
 *
 * A database holds many offices. A session looks at one of them at a time,
 * through the seat its user holds there. For every action: read that office
 * from the database, stamp the action with the seat, check the policy, run
 * the engine, then write the changes and an audit entry in one transaction.
 */
import { randomUUID } from "node:crypto";
import { EVERY, nextAfter, type Every, type StandingView } from "../standing";
import { AdminError, applyAdminOp, blankOffice, permissionFor, type AdminOp } from "../admin";
import {
  nextStage,
  Postponed,
  reduce,
  stageSpec,
  type Action,
  type AgentRuntime,
  type AgentStepInput,
  type AgentStepResult,
  type EngineState,
  type SystemCall,
  type SystemOutcome,
  type Wake,
} from "../engine";
import { initialState } from "../initialState";
import { statusReply } from "../agentState";
import {
  may,
  inOffice,
  PERMISSION_INFO,
  resolveAccess,
  type AccessContext,
  type Office,
  type Participant,
  type Task,
  type Permission,
} from "../model";
import { runPlaybook } from "../playbook";
import { authorize, contextOf, mayRead, stampActor, viewFor } from "../policy";
import type { FeedEntry, OfficeView } from "../view";
import { listAccessTokens, syncAccessTokens, tokenProblem } from "./accessTokens";
import {
  addMembership,
  createUser,
  issueSession,
  passwordProblem,
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
import { invitationViews, settleEarlyArrivals } from "./inviteRows";
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
import { dataMarker, type ConversationRuntime } from "./modelRuntime";
import { briefingFacts, briefingSystem, tidyBriefing } from "../briefing";
import { briefedFingerprint, briefingFingerprint, briefingFor, saveBriefing } from "./briefings";
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
import { sampleOffice } from "../sampleOffice";
import {
  connectSampleServices,
  ensureDemoSystems,
  liveRecords,
  mockServiceNames,
  performInSystem,
  readSystem,
  rereadOperations,
  removeSystem,
  resetSampleServices,
  checkSystem,
  storeSystem,
  SystemError,
  systemRoom,
  systemViews,
  type SystemInput,
} from "./systems";
import { roomsShowing } from "../systems";
import { plainNames, type Named } from "../plainNames";
import { withTaskLabels } from "../taskLabels";

/** The seeded distributor. It exists only for password-free demo sign-in. */
export const DEMO_OFFICE_ID = initialState.office.id;
export const isDemoOffice = (officeId: string | null): boolean => officeId === DEMO_OFFICE_ID;

/** Demo sign-in lets a visitor enter the demo office as a seeded person. */
export const demoLoginEnabled = (): boolean => process.env.DEMO_LOGIN !== "0";

/** Sign-up lets a visitor create an account, which starts with an empty office of its own. */
export const signupEnabled = (): boolean => process.env.SIGNUP !== "0";

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
export function ensureDemoAccounts(db: Db, office: Office): void {
  for (const p of office.participants) {
    if (p.kind !== "human" || !inOffice(p) || userByParticipant(db, p.id)) continue;
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
 * Create an account for someone who signed up, with an empty office of their
 * own, and sign them in. The email is only a name to sign in with: nothing is
 * sent to it, so it is not checked beyond its shape.
 */
export function registerAccount(input: { displayName: string; email: string; password: string }): Promise<{ token: string }> {
  return inTurn(async () => {
    const db = officeDatabase();
    if (!signupEnabled()) throw new OfficeError(403, "Creating an account is turned off here. Ask someone in an office to invite you.");
    const displayName = input.displayName.trim().replace(/\s+/g, " ");
    if (displayName.length < 2 || displayName.length > 60) throw new OfficeError(400, "Enter your name (2 to 60 characters).");
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) {
      throw new OfficeError(400, "Enter a valid email address.");
    }
    const problem = passwordProblem(input.password);
    if (problem) throw new OfficeError(400, problem);
    if (userByEmail(db, email)) throw new OfficeError(409, "That email already has an account. Sign in with it.");

    const made = transaction(db, () => {
      const user = createUser(db, { email, displayName, password: input.password });
      const seat = createBlankOfficeFor(db, user, "My office");
      recordAudit(db, {
        officeId: seat.officeId,
        officeClock: Date.now(),
        actorId: seat.participantId,
        actionType: "CREATE_OFFICE",
        subject: NO_SUBJECT,
        notes: [`${displayName} created an account and this office.`],
      });
      return { user, participantId: seat.participantId };
    });
    return issueSession(db, made.user, made.participantId);
  });
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
  startClock();
  settleEarlyArrivals(db);
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
    agentLoad: agentLoad(office.id),
    // Written from the whole task list, which every member sees, and from nothing said in a room.
    briefing: briefingFor(db, state.office, agentLoad(office.id)),
    mockServices: mockServiceNames(db, office.id),
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
    standing: can("manage_office") ? standingViews(db, office) : [],
    standingEditable: can("manage_office") && !isDemoOffice(office.id),
    // Token details are for people who manage access and for the holder.
    accessTokens: listAccessTokens(db, office.id)
      .filter((t) => can("manage_access") || t.participantId === viewer.id)
      .map((t) => ({ ...t, problem: tokenProblem(t, state.office, ctx) })),
    invitations: can("invite_people") ? invitationViews(db, office, office.roles[viewer.roleId]?.permissions ?? [], Date.now()) : [],
    accounts: can("manage_people") || can("invite_people")
      ? usersInOffice(db, office.id).map((u) => ({
          participantId: u.participantId,
          email: u.email,
          hasPassword: u.hasPassword,
        }))
      : [],
  };
}

/**
 * The office as this person sees it. `brief` is set by the page that someone
 * is looking at: it lets a model write a new briefing when the last one no
 * longer fits the office.
 */
export function getView(session: Session, options: { brief?: boolean } = {}): OfficeView {
  const db = officeDatabase();
  const state = loadOffice(db, session);
  if (options.brief) considerBriefing(db, state.office);
  return buildView(db, state, session);
}

// ---------------------------------------------------------------------------
// The briefing
// ---------------------------------------------------------------------------

/** How long to leave an office alone after its model failed to write a briefing. */
const BRIEFING_RETRY_MS = 5 * 60_000;

interface BriefingWork {
  /** Offices a model is writing for now, and the state each is being written for. */
  writing: Map<string, string>;
  /** Offices where the last attempt failed, with the state it was for and when. */
  failed: Map<string, { fingerprint: string; at: number }>;
  /** For tests: answers in place of a model. */
  reply?: (system: string, facts: string) => Promise<string>;
}

const briefingWork = (): BriefingWork => {
  const held = globalThis as unknown as { __officeBriefings?: BriefingWork };
  return (held.__officeBriefings ??= { writing: new Map(), failed: new Map() });
};

/** For tests: write every briefing with this function, or with the office's model again. */
export function useBriefingReply(reply: BriefingWork["reply"]): void {
  briefingWork().reply = reply;
}

/** For tests: wait until no briefing is being written. */
export async function briefingsWritten(): Promise<void> {
  while (briefingWork().writing.size > 0) await new Promise((resolve) => setTimeout(resolve, 5));
}

/**
 * Have a model write the office's briefing if the stored one was written
 * for a different state of the office. Nothing is asked while agents are
 * still moving work, since the state would change under the answer, and
 * nothing is awaited here: the briefing appears on a later look.
 */
function considerBriefing(db: Db, office: Office): void {
  if (process.env.BRIEFING === "0" || office.tasks.length === 0 || agentsAtWork(office.id)) return;
  const work = briefingWork();
  if (work.writing.has(office.id)) return;
  const load = agentLoad(office.id);
  const fingerprint = briefingFingerprint(office, load);
  if (briefedFingerprint(db, office.id) === fingerprint) return;
  const failed = work.failed.get(office.id);
  if (failed && failed.fingerprint === fingerprint && Date.now() - failed.at < BRIEFING_RETRY_MS) return;

  // The model of the first AI agent that has a working provider writes it.
  let writer: { runtime: ConversationRuntime; model: string } | null = null;
  for (const agent of office.participants) {
    if (agent.kind !== "agent" || agent.agentType !== "ai") continue;
    try {
      const runtime = runtimeForAgent(db, office.id, agent);
      writer = { runtime, model: (runtime as { model?: string }).model ?? agent.model ?? "a model" };
      break;
    } catch {
      // This agent has no usable provider. Another may.
    }
  }
  if (!writer && !work.reply) return;

  work.writing.set(office.id, fingerprint);
  const marker = dataMarker();
  const system = briefingSystem(marker.rule);
  const facts = briefingFacts(office, load, marker.wrap).join("\n");
  const names: Named[] = office.participants.map((p): Named => [p.id, p.displayName]);
  void (async () => {
    try {
      const reply = work.reply
        ? await work.reply(system, facts)
        : await writer!.runtime.chat("The briefing", system, [{ role: "user", content: facts }]);
      const body = tidyBriefing(withTaskLabels(office, plainNames(reply, names)));
      if (!body) throw new Error("The briefing came back empty.");
      await inTurn(async () => saveBriefing(db, office.id, fingerprint, body, writer?.model ?? "a model", Date.now()));
      work.failed.delete(office.id);
    } catch {
      // The composed briefing stays up. The office is asked again later, or when its state changes.
      work.failed.set(office.id, { fingerprint, at: Date.now() });
    } finally {
      work.writing.delete(office.id);
    }
  })();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

// Changes are applied one at a time. A transition can wait on an agent, and a
// second change must start from the state the first one left behind.
let queue: Promise<unknown> = Promise.resolve();
export function inTurn<T>(work: () => Promise<T>): Promise<T> {
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
    case "WAKE_TASK":
    case "SET_URGENT":
    case "ADD_DOCUMENT":
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

/**
 * Apply one action on behalf of the signed-in person and return their view.
 *
 * The click does not wait for a model. An AI agent the action calls on is
 * given the work on its queue and takes it up in the background. Only what a
 * person has just approved in a connected system is carried out before the
 * click returns, and that too outside the turn in which the office changes.
 */
export async function applyAction(session: Session, requested: Action): Promise<OfficeView> {
  const fetched: Fetched = { performs: new Map() };
  for (let turn = 0; ; turn++) {
    const outcome = await inTurn(async (): Promise<{ view: OfficeView } | { needed: Needed; real: AgentRuntime }> => {
      const db = officeDatabase();
      const before = loadOffice(db, session);
      const actor = viewerOf(before.office, session);
      const action = stampActor(requested, actor.id);
      const verdict = authorize(before.office, contextOf(before.office, before.now), actor, action);
      if (!verdict.allowed) throw new OfficeError(403, verdict.reason);

      const real = runtimeFor(db, before.office.id);
      const { runtime, deferred } = turnRuntime(real, fetched, null, turn >= TURNS - 3);
      let result;
      try {
        result = await reduce(before, action, runtime);
      } catch (error) {
        if (error instanceof Needed && turn < TURNS) return { needed: error, real };
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
      carryOn(before.office.id, [...result.wake, ...deferred], changedTasks(before.office, result.state.office), true, true);
      return { view: buildView(db, result.state, session) };
    });
    if (!("needed" in outcome)) return outcome.view;
    try {
      await fetch(outcome.real, fetched, outcome.needed);
    } catch (error) {
      throw new OfficeError(409, error instanceof Error ? error.message : "That action could not be applied.");
    }
  }
}

// ---------------------------------------------------------------------------
// Agents carrying work forward
//
// An agent does not only act at the moment a person clicks. After each action
// the office looks at what agents now have in front of them: an answer to a
// question, a note from a colleague, a task handed to them. Each agent has a
// queue of its own and works through it one item at a time, the way a person
// at a desk does, while its colleagues work through theirs.
//
// The office itself is only ever changed by one thing at a time. What takes
// long, asking a model or calling a connected system, is done outside that
// turn: the office works out what has to be asked, lets go, asks, and then
// applies the answer to the office as it stands by then. So a slow model
// holds up the agent that is waiting for it, and nobody else.
//
// It is bounded. A task takes a limited number of steps between a person's
// actions, every halt stays a halt, and a step that fails is logged and left
// for a person.
// ---------------------------------------------------------------------------

/** One thing done without a person asking: an agent's wake, ending a wait, or handing a task on. */
type Pending =
  | Wake
  | { kind: "advance"; taskId: string }
  | { kind: "wake"; taskId: string }
  /** A rejected task whose agents have done what they were asked, for the office to take further. */
  | { kind: "windup"; taskId: string };

/** Steps a task may take in the background between a person's actions on it. */
const STEPS_PER_TASK = 40;

/** What is under way in one office. */
interface OfficeWork {
  /** What each agent has in front of it, in the order it arrived. */
  queues: Map<string, Wake[]>;
  /** The task each agent is working on right now. */
  current: Map<string, string>;
  /** Of those, the tasks an agent is on only because of a note. */
  attending: Map<string, string>;
  /** Agents that are working through their queue. Each has one worker, never two. */
  working: Set<string>;
  /** Things the office does itself, which take no time: ending a wait, a handoff. */
  desk: Pending[];
  /** Tasks the office hands on by itself once their agents have finished with them. */
  following: Set<string>;
  /** Tasks left for a person: a handoff went nowhere, a step failed, or the limit was reached. */
  stuck: Set<string>;
  /** Rejected tasks the office has looked at since anything last happened on them. */
  wound: Set<string>;
  /** Background steps taken on each task since a person last acted on it. */
  steps: Map<string, number>;
  settling: boolean;
  settleAgain: boolean;
}

const loop = globalThis as unknown as {
  __officeLoop?: { paused: boolean; offices: Map<string, OfficeWork>; idle: (() => void)[] };
};
const loopState = (): { paused: boolean; offices: Map<string, OfficeWork>; idle: (() => void)[] } =>
  (loop.__officeLoop ??= { paused: process.env.OFFICE_AGENTS_PAUSED === "1", offices: new Map(), idle: [] });

function workOf(officeId: string): OfficeWork {
  const state = loopState();
  let work = state.offices.get(officeId);
  if (!work) {
    work = {
      queues: new Map(),
      current: new Map(),
      attending: new Map(),
      working: new Set(),
      desk: [],
      following: new Set(),
      stuck: new Set(),
      wound: new Set(),
      steps: new Map(),
      settling: false,
      settleAgain: false,
    };
    state.offices.set(officeId, work);
  }
  return work;
}

const queued = (work: OfficeWork): number => [...work.queues.values()].reduce((sum, q) => sum + q.length, 0);
const busy = (work: OfficeWork | undefined): boolean =>
  work !== undefined && (work.current.size > 0 || work.desk.length > 0 || work.settling || queued(work) > 0);

/** For tests: stop agents carrying work forward, or let them again. */
export function pauseAgents(paused: boolean): void {
  loopState().paused = paused;
}

/** For tests: lose everything held in memory, as a restart of the server would. */
export function forgetQueues(): void {
  loopState().offices.clear();
}

/** Resolves once no agent is working in the background. */
export async function agentsIdle(): Promise<void> {
  const state = loopState();
  while ([...state.offices.values()].some(busy)) {
    await new Promise<void>((resolve) => state.idle.push(resolve));
  }
}

/** Let anyone waiting for quiet know that something has finished. */
function stirred(): void {
  const state = loopState();
  for (const resolve of state.idle.splice(0)) resolve();
}

/** Whether agents are working in the background in this office right now. */
const agentsAtWork = (officeId: string): boolean => busy(loopState().offices.get(officeId));

/** What each agent in an office is on, and what is waiting behind it. */
export function agentLoad(officeId: string): OfficeView["agentLoad"] {
  const work = loopState().offices.get(officeId);
  const load: OfficeView["agentLoad"] = {};
  if (!work) return load;
  for (const [agent, taskId] of work.current) {
    load[agent] = { taskId, forNote: work.attending.get(agent) === taskId, waiting: 0, queued: [] };
  }
  // The order an agent will take them in: urgent work first, then as it arrived.
  const urgent = urgentTasks(officeId);
  for (const [agent, queue] of work.queues) {
    if (queue.length === 0 && !load[agent]) continue;
    const now = load[agent];
    const waiting = queue.map((wake) => wake.taskId);
    load[agent] = {
      taskId: now?.taskId ?? null,
      forNote: now?.forNote ?? false,
      waiting: queue.length,
      queued: [...waiting.filter((id) => urgent.has(id)), ...waiting.filter((id) => !urgent.has(id))],
    };
  }
  return load;
}

/** Ids of tasks an action created or changed. */
function changedTasks(before: Office, after: Office): string[] {
  const earlier = new Map(before.tasks.map((t) => [t.id, t]));
  return after.tasks.filter((t) => earlier.get(t.id) !== t).map((t) => t.id);
}

/** A task that its agent has finished with at this stage and can pass on. */
function readyToHandOn(office: Office, taskIds: Set<string>, skip: Set<string>): string | null {
  if (!office.autoHandoff) return null;
  // Urgent tasks are handed on before the rest.
  const inOrder = [...office.tasks.filter((t) => t.urgent), ...office.tasks.filter((t) => !t.urgent)];
  for (const task of inOrder) {
    if (!taskIds.has(task.id) || skip.has(task.id)) continue;
    if (task.closedAt !== null || task.status !== "in_progress" || task.wait || task.owed || task.windUp) continue;
    if (stageSpec(task.stage).humanGate || nextStage(task.stage) === null) continue;
    if (office.participants.find((p) => p.id === task.ownerId)?.kind === "agent") return task.id;
  }
  return null;
}

/**
 * A rejected task that is waiting for the office: its agents have dealt with
 * what they were asked about, and nothing on it waits for a person.
 */
function readyToWindUp(office: Office, taskIds: Set<string>, skip: Set<string>): string | null {
  const task = office.tasks.find(
    (t) =>
      t.windUp &&
      t.closedAt === null &&
      t.status === "in_progress" &&
      t.openQuestionIds.length === 0 &&
      taskIds.has(t.id) &&
      !skip.has(t.id),
  );
  return task?.id ?? null;
}

/**
 * End every wait whose day has come, and let the owners carry on. Called on a
 * timer, and by the checks with a time of their own. The demo office keeps a
 * clock of its own that only moves with a click, so nothing in it is woken.
 */
export function wakeDueTasks(now: number = Date.now()): number {
  const db = officeDatabase();
  const due = all<{ id: string; office_id: string }>(
    db,
    "SELECT id, office_id FROM tasks WHERE wait_until IS NOT NULL AND wait_until <= ? AND closed_at IS NULL AND office_id <> ?",
    now,
    DEMO_OFFICE_ID,
  );
  const byOffice = new Map<string, string[]>();
  for (const task of due) byOffice.set(task.office_id, [...(byOffice.get(task.office_id) ?? []), task.id]);
  for (const [officeId, taskIds] of byOffice) {
    carryOn(officeId, taskIds.map((taskId) => ({ kind: "wake", taskId })), taskIds);
  }
  return due.length;
}

/**
 * Pick up work that nothing is carrying. A task an agent has finished with at
 * its stage should have been handed on at once. When it was not, because the
 * server restarted in the middle of things, it would sit until a person
 * noticed. Each task is given a few such pushes and then left for a person.
 */
export function carryOnIdleWork(): number {
  const db = officeDatabase();
  const state = loopState();
  if (state.paused) return 0;
  let picked = 0;
  for (const { id } of all<{ id: string }>(db, "SELECT id FROM offices WHERE id <> ?", DEMO_OFFICE_ID)) {
    // First whatever is written down and not in anyone's hands: a piece of
    // work that failed and has tries left, or that a restart interrupted.
    const back = recover(id, workOf(id));
    if (back > 0) {
      picked += back;
      stir(id);
    }
    if (busy(state.offices.get(id))) continue;
    const loaded = loadEngineState(db, id);
    if (!loaded) continue;
    // A task with anything still written down for an agent is left alone
    // here: either it was just put back above, or its tries have run out.
    const held = new Set(outstanding(id));
    const idle = loaded.office.tasks.filter((t) => !held.has(t.id) && (idlePushes.get(t.id) ?? 0) < IDLE_PUSHES);
    // An agent that owes a step and has nothing queued is asked again. This
    // is also how a step that failed for a passing reason gets another try.
    const owing = idle.find(
      (t) => t.owed && t.closedAt === null && loaded.office.participants.find((p) => p.id === t.ownerId)?.agentType === "ai",
    );
    const ready =
      owing?.id ??
      readyToHandOn(loaded.office, new Set(idle.map((t) => t.id)), new Set()) ??
      // A rejected task that a restart left between two of its steps.
      readyToWindUp(
        loaded.office,
        new Set(loaded.office.tasks.filter((t) => (idlePushes.get(t.id) ?? 0) < IDLE_PUSHES).map((t) => t.id)),
        new Set(outstanding(id, true)),
      );
    if (!ready) continue;
    idlePushes.set(ready, (idlePushes.get(ready) ?? 0) + 1);
    carryOn(id, owing?.ownerId ? [{ kind: "resume", taskId: owing.id, participantId: owing.ownerId }] : [], [ready], true);
    picked++;
  }
  return picked;
}

const IDLE_PUSHES = 3;
const idlePushes = new Map<string, number>();

const WAKE_EVERY_MS = 60_000;
const clock = globalThis as unknown as { __officeClock?: ReturnType<typeof setInterval> };

/** Start the timer that ends waits and picks up idle work, once per server process. */
function startClock(): void {
  if (clock.__officeClock || process.env.OFFICE_CLOCK_OFF === "1") return;
  clock.__officeClock = setInterval(() => {
    try {
      wakeDueTasks();
      carryOnIdleWork();
      void fileDueStanding();
      void rereadOperations(officeDatabase()).catch((error) => console.error("Reading the systems again failed.", error));
    } catch (error) {
      console.error("Waking waiting tasks failed.", error);
    }
  }, WAKE_EVERY_MS);
  clock.__officeClock.unref();
}

/**
 * Give an office's agents what an action left for them, and follow the tasks
 * it touched. `afresh` forgets whatever kept those tasks from moving and lets
 * them take their full number of steps again. `byAPerson` also gives work that
 * was given up on its tries back.
 */
function carryOn(officeId: string, wakes: Pending[], taskIds: string[], afresh = false, byAPerson = false): void {
  if (loopState().paused || (wakes.length === 0 && taskIds.length === 0)) return;
  const work = workOf(officeId);
  for (const id of taskIds) {
    work.following.add(id);
    work.wound.delete(id);
    if (afresh) {
      work.stuck.delete(id);
      work.steps.delete(id);
    }
    // A person has acted on the task, so whatever was given up on is tried
    // again. The office's own pushes do not earn that: they are the tries.
    if (byAPerson) run(officeDatabase(), "UPDATE pending_work SET tries = 0 WHERE task_id = ?", id);
  }
  for (const wake of wakes) hand(officeId, work, wake);
  if (byAPerson) recover(officeId, work);
  stir(officeId);
}

// What agents have been given is also written down, one row per item, until
// it is done. The queues above are how the work is carried out. The rows are
// how it is found again after a failure or a restart, and how the office
// knows that a task still has a colleague's part outstanding.

/** How often a piece of work is tried before it is left for a person. */
const TRIES = 3;

const rowKey = (wake: Wake): [string, string, string, string] => [
  wake.participantId,
  wake.taskId,
  wake.kind,
  wake.kind === "attend" ? wake.noteId : "",
];

function writeDown(officeId: string, wake: Wake): void {
  run(
    officeDatabase(),
    `INSERT OR IGNORE INTO pending_work (office_id, participant_id, task_id, kind, note_id, after_action, tries, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    officeId,
    ...rowKey(wake),
    wake.afterAction ? 1 : 0,
    Date.now(),
  );
}

function cross(wake: Wake, outcome: "done" | "failed"): void {
  run(
    officeDatabase(),
    outcome === "done"
      ? "DELETE FROM pending_work WHERE participant_id = ? AND task_id = ? AND kind = ? AND note_id = ?"
      : "UPDATE pending_work SET tries = tries + 1 WHERE participant_id = ? AND task_id = ? AND kind = ? AND note_id = ?",
    ...rowKey(wake),
  );
}

/**
 * Tasks that still have something written down for an agent, done or given
 * up on. With `live`, only work that still has tries left.
 */
function outstanding(officeId: string, live = false): string[] {
  return all<{ task_id: string }>(
    officeDatabase(),
    `SELECT DISTINCT task_id FROM pending_work WHERE office_id = ?${live ? " AND tries < ?" : ""}`,
    officeId,
    ...(live ? [TRIES] : []),
  ).map((r) => r.task_id);
}

/**
 * Put back on the queues whatever is written down and is neither queued nor
 * being worked on: work that failed and has tries left, and work that was in
 * hand when the server stopped. Returns how many pieces it put back.
 */
function recover(officeId: string, work: OfficeWork): number {
  const rows = all<{ participant_id: string; task_id: string; kind: "resume" | "attend"; note_id: string; after_action: number }>(
    officeDatabase(),
    "SELECT participant_id, task_id, kind, note_id, after_action FROM pending_work WHERE office_id = ? AND tries < ? ORDER BY created_at",
    officeId,
    TRIES,
  );
  let put = 0;
  for (const r of rows) {
    const wake: Wake =
      r.kind === "attend"
        ? { kind: "attend", taskId: r.task_id, participantId: r.participant_id, noteId: r.note_id, ...(r.after_action ? { afterAction: true } : {}) }
        : { kind: "resume", taskId: r.task_id, participantId: r.participant_id, ...(r.after_action ? { afterAction: true } : {}) };
    const queue = work.queues.get(wake.participantId) ?? [];
    if (work.current.get(wake.participantId) === wake.taskId || queue.some((w) => same(w, wake))) continue;
    queue.push(wake);
    work.queues.set(wake.participantId, queue);
    work.following.add(wake.taskId);
    put++;
  }
  return put;
}

const same = (a: Wake, b: Wake): boolean =>
  a.kind === b.kind && a.taskId === b.taskId && a.participantId === b.participantId && (a.kind !== "attend" || (b.kind === "attend" && a.noteId === b.noteId));

/** Put one piece of work where it belongs: on an agent's queue, or on the office's own desk. */
function hand(officeId: string, work: OfficeWork, next: Pending): void {
  work.following.add(next.taskId);
  // Anything new on a rejected task is a reason for the office to look at it again.
  work.wound.delete(next.taskId);
  if (next.kind === "advance" || next.kind === "wake" || next.kind === "windup") {
    work.desk.push(next);
    return;
  }
  // Something new for an agent to look at is a reason to try the task again.
  work.stuck.delete(next.taskId);
  writeDown(officeId, next);
  const queue = work.queues.get(next.participantId) ?? [];
  // Two answers arriving for the same agent are one reason to take the step
  // again, with both in front of it.
  if (!queue.some((w) => same(w, next))) queue.push(next);
  work.queues.set(next.participantId, queue);
}

/** Start every agent that has something waiting and is free, and let the office do its own part. */
function stir(officeId: string): void {
  const work = workOf(officeId);
  for (const [agentId, queue] of work.queues) {
    if (queue.length > 0 && !work.working.has(agentId)) void workThrough(officeId, agentId);
  }
  void settle(officeId);
}

/** One agent works through its queue, one item at a time. */
async function workThrough(officeId: string, agentId: string): Promise<void> {
  const work = workOf(officeId);
  if (work.working.has(agentId)) return;
  work.working.add(agentId);
  let did = false;
  try {
    for (;;) {
      const queue = work.queues.get(agentId) ?? [];
      // An owner does not take its step again while colleagues are still
      // looking at notes on that task: it waits and hears them all at once.
      const ready = (item: Wake): boolean => item.kind !== "resume" || !colleaguesAt(work, item.taskId, agentId);
      // Urgent work is taken first. Within each kind the order of arrival stands.
      const urgent = urgentTasks(officeId);
      const first = queue.findIndex((item) => ready(item) && urgent.has(item.taskId));
      const at = first !== -1 ? first : queue.findIndex(ready);
      if (at === -1) break;
      const [next] = queue.splice(at, 1);
      did = true;
      work.current.set(agentId, next.taskId);
      if (next.kind === "attend") work.attending.set(agentId, next.taskId);
      const outcome = await carryOut(officeId, next).catch((error): "failed" => {
        console.error("An agent's step failed.", error);
        return "failed";
      });
      // The same thing may have been asked for again while this was under
      // way. It stays written down until that one is done too.
      const again = (work.queues.get(agentId) ?? []).some((w) => same(w, next));
      if (outcome === "failed" || !again) cross(next, outcome);
      work.current.delete(agentId);
      work.attending.delete(agentId);
      stir2(officeId, work);
      void settle(officeId);
    }
  } finally {
    work.working.delete(agentId);
    work.current.delete(agentId);
    work.attending.delete(agentId);
    if ((work.queues.get(agentId)?.length ?? 0) === 0) work.queues.delete(agentId);
    // An agent that found nothing it could start has changed nothing, so
    // there is nothing for the office to settle. Calling it anyway would have
    // the two start each other without end while that agent waits.
    if (did) void settle(officeId);
    stirred();
  }
}

/** The open tasks of an office that a person has marked urgent. */
function urgentTasks(officeId: string): Set<string> {
  return new Set(
    all<{ id: string }>(
      officeDatabase(),
      "SELECT id FROM tasks WHERE office_id = ? AND urgent = 1 AND closed_at IS NULL",
      officeId,
    ).map((t) => t.id),
  );
}

/** Whether another agent is looking at a note on this task, or has one waiting. */
function colleaguesAt(work: OfficeWork, taskId: string, agentId: string): boolean {
  for (const [other, queue] of work.queues) {
    if (other !== agentId && queue.some((item) => item.kind === "attend" && item.taskId === taskId)) return true;
  }
  for (const [other, at] of work.attending) if (other !== agentId && at === taskId) return true;
  return false;
}

/**
 * The office's own part: ending waits, and handing on each followed task that
 * no agent has anything left to do on.
 */
async function settle(officeId: string): Promise<void> {
  const work = workOf(officeId);
  if (work.settling) {
    work.settleAgain = true;
    return;
  }
  work.settling = true;
  try {
    do {
      work.settleAgain = false;
      for (;;) {
        // Let the server answer whatever else is waiting between one piece of
        // its own work and the next.
        await new Promise<void>((resolve) => setImmediate(resolve));
        const next = work.desk.shift() ?? (await inTurn(async () => handOn(officeId, work)));
        if (!next) break;
        await carryOut(officeId, next);
      }
    } while (work.settleAgain);
  } catch (error) {
    console.error("The office could not settle its work.", error);
  } finally {
    work.settling = false;
    stirred();
  }
}

/** After the office's own part, agents may have new work. Start them without settling again. */
function stir2(officeId: string, work: OfficeWork): void {
  for (const [agentId, queue] of work.queues) {
    if (queue.length > 0 && !work.working.has(agentId)) void workThrough(officeId, agentId);
  }
}

/** The next task to hand on: one that is followed and that nobody is still busy with. */
function handOn(officeId: string, work: OfficeWork): Pending | null {
  const loaded = loadEngineState(officeDatabase(), officeId);
  if (!loaded) return null;
  // A task with anything outstanding for an agent stays where it is. That
  // covers a colleague's part that failed, until it is done or a person steps in.
  const busyWith = new Set<string>(work.current.values());
  for (const queue of work.queues.values()) for (const item of queue) busyWith.add(item.taskId);
  const inHand = new Set<string>([...busyWith, ...outstanding(officeId)]);
  const taskId = readyToHandOn(loaded.office, work.following, new Set([...work.stuck, ...inHand]));
  if (taskId) return { kind: "advance", taskId };
  // A rejected task does not wait on work that was given up on: what could
  // not be done is put to the person, who decides what happens next.
  const winding = readyToWindUp(loaded.office, work.following, new Set([...work.wound, ...busyWith, ...outstanding(officeId, true)]));
  if (!winding) return null;
  // It is looked at once for each thing that happens on it, so that a
  // winding up with nothing to do is not taken up again and again.
  work.wound.add(winding);
  return { kind: "windup", taskId: winding };
}

/** What a turn found it has to fetch before it can go on. */
class Needed extends Postponed {
  constructor(
    readonly need:
      | { kind: "step"; input: AgentStepInput; signature: string }
      | { kind: "perform"; call: SystemCall; key: string },
  ) {
    super("An answer has to be fetched first.");
  }
}

/** What has been fetched so far for one piece of work. */
interface Fetched {
  step?: { signature: string; result: AgentStepResult };
  performs: Map<string, SystemOutcome>;
}

/** What an agent was shown, reduced to what would make its answer out of date. */
const signatureOf = (input: AgentStepInput): string =>
  [
    input.task.id,
    input.participant.id,
    input.stage,
    input.task.status,
    input.afterAction ? "after" : "",
    input.attending?.noteId ?? "",
    input.priorMessages.length,
  ].join("|");

const performKey = (call: SystemCall): string =>
  JSON.stringify([call.taskId, call.systemId, call.operation, Object.entries(call.fields).sort()]);

/**
 * The runtime for one turn. It answers only from what has already been
 * fetched, and says what is missing otherwise, so a turn never waits on a
 * model or a connected system.
 *
 * `own` names the agent whose step this turn is for. Any other AI agent's
 * step that the turn would call for is put on that agent's queue.
 */
function turnRuntime(
  real: AgentRuntime,
  fetched: Fetched,
  own: { participantId: string; taskId: string } | null,
  /** Use what was fetched even if the office has moved on since. */
  lenient: boolean,
): { runtime: AgentRuntime; deferred: Wake[] } {
  const deferred: Wake[] = [];
  let ownTaken = false;
  return {
    deferred,
    runtime: {
      async step(input) {
        // A playbook agent answers at once from its written steps.
        if (input.participant.agentType !== "ai") return real.step(input);
        if (own && !ownTaken && input.participant.id === own.participantId && input.task.id === own.taskId) {
          ownTaken = true;
          const signature = signatureOf(input);
          if (fetched.step && (lenient || fetched.step.signature === signature)) return fetched.step.result;
          throw new Needed({ kind: "step", input, signature });
        }
        deferred.push(
          input.attending
            ? {
                kind: "attend",
                taskId: input.task.id,
                participantId: input.participant.id,
                noteId: input.attending.noteId,
                ...(input.afterAction ? { afterAction: true } : {}),
              }
            : {
                kind: "resume",
                taskId: input.task.id,
                participantId: input.participant.id,
                ...(input.afterAction ? { afterAction: true } : {}),
              },
        );
        return { questions: [], assumptions: [], later: true };
      },
      async perform(call) {
        const key = performKey(call);
        const outcome = fetched.performs.get(key);
        if (outcome) return outcome;
        throw new Needed({ kind: "perform", call, key });
      },
    },
  };
}

/** Fetch what a turn was missing. This is the slow part, and runs outside any turn. */
async function fetch(real: AgentRuntime, fetched: Fetched, needed: Needed): Promise<void> {
  const { need } = needed;
  if (need.kind === "step") {
    fetched.step = { signature: need.signature, result: await real.step(need.input) };
  } else {
    fetched.performs.set(
      need.key,
      real.perform ? await real.perform(need.call) : { ok: false, summary: "it is not reachable from here, so nothing was done" },
    );
  }
}

/** How many times a piece of work is tried again because the office moved on while it was fetched. */
const TURNS = 8;

/** Carry out one piece of background work, and pass on what it leaves for others. */
async function carryOut(officeId: string, next: Pending): Promise<"done" | "failed"> {
  const work = workOf(officeId);
  const fetched: Fetched = { performs: new Map() };
  const real = runtimeFor(officeDatabase(), officeId);

  for (let turn = 0; turn < TURNS; turn++) {
    const outcome = await inTurn(async () => takeTurn(officeId, work, next, real, fetched, turn >= TURNS - 3));
    // Work that no longer applies, such as a wake for a task since handed on, is done with.
    if (outcome === null) return "done";
    if (outcome === "failed") return "failed";
    if (!(outcome instanceof Needed)) {
      for (const id of outcome.taskIds) work.following.add(id);
      for (const wake of outcome.wake) hand(officeId, work, wake);
      stir2(officeId, work);
      return "done";
    }
    try {
      await fetch(real, fetched, outcome);
    } catch (error) {
      await inTurn(async () => leaveForAPerson(officeId, work, next, error));
      return "failed";
    }
  }
  return "failed";
}

/** The task and the one acting on it for a piece of background work, or null when it no longer applies. */
function subjectOf(office: Office, next: Pending): { task: Task; actor: Participant; action: Action } | null {
  const task = office.tasks.find((t) => t.id === next.taskId);
  if (!task) return null;
  if (next.kind === "windup") {
    // The office does this itself. It is recorded against whoever holds the task.
    const holder = office.participants.find((p) => p.id === task.ownerId) ?? office.participants.find((p) => p.id === task.requestedById);
    return holder ? { task, actor: holder, action: { type: "WIND_UP", taskId: task.id } } : null;
  }
  const actorId = next.kind === "advance" || next.kind === "wake" ? task.ownerId : next.participantId;
  // A wait ends whoever owns the task. Everything else here is an agent's doing.
  const actor = office.participants.find((p) => p.id === actorId && (p.kind === "agent" || next.kind === "wake"));
  if (!actor) return null;
  // A wake for an agent that has since handed the task on is not for whoever holds it now.
  if (next.kind === "resume" && task.ownerId !== next.participantId) return null;
  const action: Action =
    next.kind === "wake"
      ? { type: "WAKE_TASK", taskId: task.id }
      : next.kind === "advance"
        ? { type: "ADVANCE", taskId: task.id }
        : next.kind === "resume"
          ? { type: "AGENT_RESUME", taskId: task.id, ...(next.afterAction ? { afterAction: true } : {}) }
          : {
              type: "AGENT_ATTEND",
              taskId: task.id,
              participantId: actor.id,
              noteId: next.noteId,
              ...(next.afterAction ? { afterAction: true } : {}),
            };
  return { task, actor, action };
}

/**
 * One turn at a piece of background work: apply it to the office as it stands
 * and store the result, or say what has to be fetched first.
 */
async function takeTurn(
  officeId: string,
  work: OfficeWork,
  next: Pending,
  real: AgentRuntime,
  fetched: Fetched,
  lenient: boolean,
): Promise<{ wake: Wake[]; taskIds: string[] } | Needed | "failed" | null> {
  const db = officeDatabase();
  const loaded = loadEngineState(db, officeId);
  if (!loaded) return null;
  const before = loaded.clockStepMinutes === 0 ? { ...loaded, now: Date.now() } : loaded;
  const subject = subjectOf(before.office, next);
  if (!subject) return null;
  const { task, actor, action } = subject;
  if ((work.steps.get(task.id) ?? 0) >= STEPS_PER_TASK) {
    work.stuck.add(task.id);
    return null;
  }

  const own = next.kind === "resume" || next.kind === "attend" ? { participantId: actor.id, taskId: task.id } : null;
  const { runtime, deferred } = turnRuntime(real, fetched, own, lenient);
  let result;
  try {
    result = await reduce(before, action, runtime);
  } catch (error) {
    if (error instanceof Needed) return error;
    leaveForAPerson(officeId, work, next, error);
    return "failed";
  }
  work.steps.set(task.id, (work.steps.get(task.id) ?? 0) + 1);
  const moved = result.state.office.tasks.find((t) => t.id === task.id);
  // A handoff that went nowhere, for want of anyone to take it, is not repeated.
  if (next.kind === "advance" && moved?.stage === task.stage) work.stuck.add(task.id);

  transaction(db, () => {
    saveEngineState(db, before, result.state);
    syncAccessTokens(db);
    recordAudit(db, {
      officeId,
      officeClock: result.state.now,
      actorId: actor.id,
      actionType: action.type,
      subject: { ...NO_SUBJECT, taskId: task.id, subjectParticipantId: actor.id, roomId: task.roomId },
      notes: result.notes,
    });
    // What was given up on has been put to the person, so it is not tried
    // again behind their back when they answer.
    if (next.kind === "windup") run(db, "DELETE FROM pending_work WHERE task_id = ? AND tries >= ?", task.id, TRIES);
  });
  return { wake: [...result.wake, ...deferred], taskIds: changedTasks(before.office, result.state.office) };
}

/** A piece of work failed. The task is left where it is, and people are told why. */
function leaveForAPerson(officeId: string, work: OfficeWork, next: Pending, error: unknown): void {
  const db = officeDatabase();
  const loaded = loadEngineState(db, officeId);
  const subject = loaded ? subjectOf(loaded.office, next) : null;
  work.stuck.add(next.taskId);
  if (!loaded || !subject) return;
  const { task, actor, action } = subject;
  // This failure is about to be counted. One short of the limit means it is the last try.
  const tried =
    next.kind === "resume" || next.kind === "attend"
      ? (get<{ tries: number }>(
          db,
          "SELECT tries FROM pending_work WHERE participant_id = ? AND task_id = ? AND kind = ? AND note_id = ?",
          ...rowKey(next),
        )?.tries ?? 0) + 1
      : 0;
  recordAudit(db, {
    officeId,
    officeClock: loaded.clockStepMinutes === 0 ? Date.now() : loaded.now,
    actorId: actor.id,
    actionType: action.type,
    subject: { ...NO_SUBJECT, taskId: task.id, subjectParticipantId: actor.id, roomId: task.roomId },
    notes: [
      `${actor.displayName} could not carry ${task.id} forward: ${error instanceof Error ? error.message : String(error)}` +
        (tried >= TRIES
          ? ` That was try ${tried} of ${TRIES}, so the task stays where it is until a person acts on it.`
          : tried > 0
            ? " The office will ask again in a minute."
            : ""),
    ],
  });
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
      return after.participants.some((p) => p.id === op.participantId)
        ? `${who} removed ${quoted(before, op.participantId)} from the office. They stay in its record and can no longer sign in to it`
        : `${who} removed ${quoted(before, op.participantId)} from the office`;
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
    case "KEEP_ROOM_RECORD":
      return `${who} added a record to ${quoted(after, op.roomId)}`;
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
    if ((op.type === "SET_ROOM_RECORDS" || op.type === "KEEP_ROOM_RECORD") && !mayRead({ ...contextOf(before.office, before.now), forTask: null }, actor, op.roomId)) {
      throw new OfficeError(403, "You cannot read that room, so you cannot change its records.");
    }

    // Removing a person happens at a time the office sets, never the browser.
    const asked: AdminOp =
      op.type === "REMOVE_PARTICIPANT" ? { type: op.type, participantId: op.participantId, at: before.now } : op;
    try {
      changeSetup(db, session, before, actor, asked);
    } catch (error) {
      if (!(error instanceof StillReferred)) throw error;
      // The database keeps records the in-memory office does not see, such as
      // audit entries and conversations. A person one of them still names
      // leaves the office and stays in its record. Nothing else can be kept
      // that way.
      const person =
        asked.type === "REMOVE_PARTICIPANT" &&
        before.office.participants.some((p) => p.id === asked.participantId && p.kind === "human");
      if (!person) throw error.refusal();
      try {
        changeSetup(db, session, before, actor, { ...asked, keep: true });
      } catch (again) {
        throw again instanceof StillReferred ? again.refusal() : again;
      }
    }
    return buildView(db, loadOffice(db, session), session);
  });
}

/** Thrown when the database still holds a row that names what was being removed. */
class StillReferred extends Error {
  refusal(): OfficeError {
    return new OfficeError(409, "That cannot be removed: the office's audit log still refers to it.");
  }
}

/** Work out one change to the office's set-up and store it with its audit entry. */
function changeSetup(db: Db, session: Session, before: EngineState, actor: Participant, op: AdminOp): void {
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
  const wasPresent = new Set(before.office.participants.filter(inOffice).map((p) => p.id));

  try {
    transaction(db, () => {
      saveEngineState(db, before, after);
      // Someone who has just left can no longer sign in to this office, and
      // an invite link that was waiting for them stops working.
      for (const p of after.office.participants) {
        if (inOffice(p) || !wasPresent.has(p.id)) continue;
        run(db, "DELETE FROM memberships WHERE participant_id = ?", p.id);
        run(db, "DELETE FROM invites WHERE participant_id = ? AND accepted_at IS NULL", p.id);
      }
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
    if (error instanceof Error && /constraint/i.test(error.message)) throw new StillReferred(error.message);
    throw error;
  }
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
export async function sendDirectMessage(session: Session, toId: string, said: string): Promise<OfficeView> {
  // Checked in a turn, asked outside it, written in another: an agent that
  // takes its time to answer holds up nobody but the person waiting for it.
  const asked = await inTurn(async () => {
    const db = officeDatabase();
    const state = loadOffice(db, session);
    const { office } = state;
    const sender = viewerOf(office, session);
    const other = office.participants.find((p) => p.id === toId);
    if (!other) throw new OfficeError(404, "That person or agent is not in this office.");
    if (other.id === sender.id) throw new OfficeError(400, "You cannot send a message to yourself.");
    if (!inOffice(other)) throw new OfficeError(409, `${other.displayName} has left the office.`);
    const body = said.trim();
    if (body.length === 0 || body.length > 600) throw new OfficeError(400, "Write a message of up to 600 characters.");

    // A conversation is outside any task, so grants made for a task do not count.
    const ctx: AccessContext = { ...contextOf(office, state.now), forTask: null };
    const room = office.floorplan.rooms.find((r) => r.deskIds.includes(other.deskId ?? ""));
    if (other.kind === "agent" && room && resolveAccess(sender, room.id, "enter", ctx).effect !== "allow") {
      throw new OfficeError(403, `You cannot enter ${room.name}, so you cannot talk to ${other.displayName} at their desk.`);
    }
    const shared =
      other.agentType === "ai"
        ? office.systems
            .filter((s) => roomsShowing(s).some((r) => mayRead(ctx, other, r)) && roomsShowing(s).some((r) => mayRead(ctx, sender, r)))
            .map((s) => s.id)
        : [];
    return {
      db,
      state,
      sender,
      other,
      body,
      ctx,
      shared,
      // A playbook agent answers at once with where its work stands.
      ready: other.kind === "agent" && other.agentType !== "ai" ? statusReply(office, other, sender, ctx) : null,
      earlier: other.agentType === "ai" ? earlierTurns(db, other.id, sender.id) : [],
    };
  });
  const { db, state, sender, other, body, ctx, shared } = asked;
  const { office } = state;

  let reply: string | null = asked.ready;
  if (other.kind === "agent" && other.agentType === "ai") {
    const live = shared.length > 0 ? await liveRecords(db, office.id, shared) : [];
    const system = buildChatSystem(office, other, sender, ctx, live, dataMarker());
    const turns = [...asked.earlier, { role: "user" as const, content: body }];
    try {
      reply = overriddenChat.__officeChat
        ? await overriddenChat.__officeChat(system, turns)
        : await runtimeForAgent(db, office.id, other).chat(other.displayName, system, turns);
    } catch (error) {
      // Reported as 424 for the same reason as a failed connection test.
      throw new OfficeError(424, error instanceof Error ? error.message : `${other.displayName} could not answer.`);
    }
  }

  return inTurn(async () => {
    transaction(db, () => {
      recordDirect(db, sender.id, other.id, body, state.now);
      // An agent's answer names things the way people know them, as its work in a thread does.
      const plain = (text: string): string =>
        plainNames(text, [
          ...office.floorplan.rooms.map((r): Named => [r.id, r.name]),
          ...office.participants.map((p): Named => [p.id, p.displayName]),
          ...office.systems.map((y): Named => [y.id, y.name]),
        ]);
      if (reply !== null) recordDirect(db, other.id, sender.id, withTaskLabels(office, plain(reply)).slice(0, 2000), state.now);
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
// Standing work
//
// A request the office files by itself on a rhythm, in the name of the
// person who set it up. From there it is an ordinary task. One is not filed
// while the last one it filed is still open, so slow work does not pile up.
// ---------------------------------------------------------------------------

interface StandingRow {
  id: string;
  office_id: string;
  title: string;
  detail: string;
  urgent: number;
  every: Every;
  next_at: number;
  created_by: string;
  last_task_id: string | null;
  last_filed_at: number | null;
  active: number;
}

const STANDING_LIMIT = 20;

function standingViews(db: Db, office: Office): StandingView[] {
  return all<StandingRow>(db, "SELECT * FROM standing_requests WHERE office_id = ? ORDER BY position", office.id).map((r) => ({
    id: r.id,
    title: r.title,
    detail: r.detail,
    urgent: r.urgent === 1,
    every: r.every,
    nextAt: r.next_at,
    active: r.active === 1,
    filedAs: office.participants.find((p) => p.id === r.created_by)?.displayName ?? "Someone who has left",
    lastTaskId: r.last_task_id,
    lastFiledAt: r.last_filed_at,
  }));
}

export interface StandingInput {
  id?: string;
  title: string;
  detail: string;
  urgent: boolean;
  every: string;
  /** When it is first due. */
  firstAt: number;
}

/** The person and office for work on standing requests, or a refusal. */
function standingManager(db: Db, session: Session): { state: EngineState; actor: Participant } {
  const state = loadOffice(db, session);
  const actor = requirePermission(state, session, "manage_office");
  if (isDemoOffice(state.office.id)) throw new OfficeError(403, "The demo office is shared, so it has no standing work.");
  return { state, actor };
}

/** Add a standing request, or change one. It is filed in the name of whoever saved it. */
export function saveStandingRequest(session: Session, input: StandingInput): Promise<OfficeView> {
  return inTurn(async () => {
    const db = officeDatabase();
    const { state, actor } = standingManager(db, session);
    const title = input.title.trim();
    const detail = input.detail.trim();
    if (title.length < 2 || title.length > 120) throw new OfficeError(400, "Give it a title of 2 to 120 characters.");
    if (detail.length < 2 || detail.length > 2000) throw new OfficeError(400, "Say what is wanted, in up to 2,000 characters.");
    if (!EVERY.some((e) => e.id === input.every)) throw new OfficeError(400, "Choose how often it is filed.");
    const every = input.every as Every;
    if (!Number.isFinite(input.firstAt) || input.firstAt > Date.now() + 366 * 86_400_000) {
      throw new OfficeError(400, "Choose when it is first due, within the next year.");
    }
    // A first time that has already passed moves to its next turn, so saving
    // never files something at once by surprise.
    const nextAt = input.firstAt > Date.now() ? input.firstAt : nextAfter(input.firstAt, every, Date.now());

    const existing = input.id
      ? get<StandingRow>(db, "SELECT * FROM standing_requests WHERE id = ? AND office_id = ?", input.id, state.office.id)
      : undefined;
    if (input.id && !existing) throw new OfficeError(404, "That standing request does not exist in this office.");
    if (!existing) {
      const held = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM standing_requests WHERE office_id = ?", state.office.id)?.n ?? 0;
      if (held >= STANDING_LIMIT) throw new OfficeError(400, `An office can hold ${STANDING_LIMIT} standing requests.`);
    }
    transaction(db, () => {
      if (existing) {
        run(
          db,
          "UPDATE standing_requests SET title = ?, detail = ?, urgent = ?, every = ?, next_at = ?, created_by = ? WHERE id = ?",
          title,
          detail,
          input.urgent ? 1 : 0,
          every,
          nextAt,
          actor.id,
          existing.id,
        );
      } else {
        run(
          db,
          `INSERT INTO standing_requests (id, office_id, position, title, detail, urgent, every, next_at, created_by, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          `st-${randomUUID().slice(0, 8)}`,
          state.office.id,
          get<{ next: number }>(db, "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM standing_requests")?.next ?? 0,
          title,
          detail,
          input.urgent ? 1 : 0,
          every,
          nextAt,
          actor.id,
        );
      }
      recordAudit(db, {
        officeId: state.office.id,
        officeClock: state.now,
        actorId: actor.id,
        actionType: existing ? "UPDATE_STANDING" : "ADD_STANDING",
        subject: NO_SUBJECT,
        notes: [`${actor.displayName} ${existing ? "changed" : "set up"} the standing request "${title}"`],
      });
    });
    return buildView(db, loadOffice(db, session), session);
  });
}

/** Remove a standing request, or pause it and take it up again. */
export function changeStandingRequest(session: Session, id: string, change: "remove" | "pause" | "resume"): Promise<OfficeView> {
  return inTurn(async () => {
    const db = officeDatabase();
    const { state, actor } = standingManager(db, session);
    const row = get<StandingRow>(db, "SELECT * FROM standing_requests WHERE id = ? AND office_id = ?", id, state.office.id);
    if (!row) throw new OfficeError(404, "That standing request does not exist in this office.");
    transaction(db, () => {
      if (change === "remove") run(db, "DELETE FROM standing_requests WHERE id = ?", id);
      else if (change === "pause") run(db, "UPDATE standing_requests SET active = 0 WHERE id = ?", id);
      // Taken up again, it waits for its next turn. What it missed is not filed late.
      else run(db, "UPDATE standing_requests SET active = 1, next_at = ? WHERE id = ?", nextAfter(row.next_at, row.every, Date.now()), id);
      recordAudit(db, {
        officeId: state.office.id,
        officeClock: state.now,
        actorId: actor.id,
        actionType: "CHANGE_STANDING",
        subject: NO_SUBJECT,
        notes: [
          `${actor.displayName} ${change === "remove" ? "removed" : change === "pause" ? "paused" : "took up again"} the standing request "${row.title}"`,
        ],
      });
    });
    return buildView(db, loadOffice(db, session), session);
  });
}

/** File a standing request now, whatever its rhythm says. Its next turn stays where it was. */
export async function fileStandingNow(session: Session, id: string): Promise<OfficeView> {
  const db = officeDatabase();
  const officeId = await inTurn(async () => {
    const { state } = standingManager(db, session);
    const row = get<StandingRow>(db, "SELECT * FROM standing_requests WHERE id = ? AND office_id = ?", id, state.office.id);
    if (!row) throw new OfficeError(404, "That standing request does not exist in this office.");
    return state.office.id;
  });
  const filed = await fileStanding(officeId, id, Date.now(), true);
  if (!filed.ok) throw new OfficeError(409, `It was not filed: ${filed.reason}`);
  return getView(session);
}

/**
 * File every standing request whose turn has come. Called on the clock, and
 * by the checks with a time of their own. Returns how many it filed.
 */
export async function fileDueStanding(now: number = Date.now()): Promise<number> {
  const db = officeDatabase();
  const due = all<{ id: string; office_id: string }>(
    db,
    "SELECT id, office_id FROM standing_requests WHERE active = 1 AND next_at <= ? AND office_id <> ? ORDER BY next_at",
    now,
    DEMO_OFFICE_ID,
  );
  let filed = 0;
  for (const row of due) {
    const outcome = await fileStanding(row.office_id, row.id, now, false).catch((error) => {
      console.error("A standing request could not be filed.", error);
      return { ok: false as const, reason: "" };
    });
    if (outcome.ok) filed++;
  }
  return filed;
}

/**
 * File one standing request as a task, in its own turn. On the clock its
 * next turn is set whether or not it was filed, so nothing is tried twice.
 */
function fileStanding(
  officeId: string,
  id: string,
  now: number,
  byHand: boolean,
): Promise<{ ok: true; taskId: string } | { ok: false; reason: string }> {
  return inTurn(async (): Promise<{ ok: true; taskId: string } | { ok: false; reason: string }> => {
    const db = officeDatabase();
    const row = get<StandingRow>(db, "SELECT * FROM standing_requests WHERE id = ? AND office_id = ?", id, officeId);
    const loaded = loadEngineState(db, officeId);
    if (!row || !loaded) return { ok: false, reason: "that standing request no longer exists." };
    const before = loaded.clockStepMinutes === 0 ? { ...loaded, now: Date.now() } : loaded;
    const next = byHand ? row.next_at : nextAfter(row.next_at, row.every, now);
    const skip = (reason: string, deactivate = false): { ok: false; reason: string } => {
      transaction(db, () => {
        run(db, "UPDATE standing_requests SET next_at = ?, active = ? WHERE id = ?", next, deactivate ? 0 : row.active, id);
        recordAudit(db, {
          officeId,
          officeClock: before.now,
          actorId: row.created_by,
          actionType: "STANDING_SKIPPED",
          subject: NO_SUBJECT,
          notes: [`The standing request "${row.title}" was not filed: ${reason}`],
        });
      });
      return { ok: false, reason };
    };

    const last = row.last_task_id ? before.office.tasks.find((t) => t.id === row.last_task_id) : undefined;
    if (last && last.closedAt === null) return skip(`the last one, ${last.id}, is still open.`);
    const filer = before.office.participants.find((p) => p.id === row.created_by && p.kind === "human" && inOffice(p));
    if (!filer) return skip("the person it was filed for is no longer in the office. It has been paused.", true);
    const action: Action = {
      type: "SUBMIT_REQUEST",
      title: row.title,
      detail: row.detail,
      requestedById: filer.id,
      ...(row.urgent === 1 ? { urgent: true } : {}),
    };
    const verdict = authorize(before.office, contextOf(before.office, before.now), filer, action);
    if (!verdict.allowed) return skip(`${filer.displayName} may no longer file requests here. It has been paused.`, true);

    // No model is asked here. The agent that takes the request does so from its queue.
    const { runtime, deferred } = turnRuntime(runtimeFor(db, officeId), { performs: new Map() }, null, true);
    const result = await reduce(before, action, runtime);
    const known = new Set(before.office.tasks.map((t) => t.id));
    const task = result.state.office.tasks.find((t) => !known.has(t.id));
    if (!task) return skip("the office did not accept it.");
    transaction(db, () => {
      saveEngineState(db, before, result.state);
      syncAccessTokens(db);
      run(db, "UPDATE standing_requests SET next_at = ?, last_task_id = ?, last_filed_at = ? WHERE id = ?", next, task.id, before.now, id);
      recordAudit(db, {
        officeId,
        officeClock: result.state.now,
        actorId: filer.id,
        actionType: "STANDING_FILED",
        subject: { ...NO_SUBJECT, taskId: task.id, roomId: task.roomId },
        notes: [`The office filed the standing request "${row.title}" as ${task.id}, for ${filer.displayName}`, ...result.notes],
      });
    });
    carryOn(officeId, [...result.wake, ...deferred], changedTasks(before.office, result.state.office), true);
    return { ok: true, taskId: task.id };
  });
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
      // The system is asked about itself before anything is stored.
      const change = await checkSystem(db, state.office, input);
      transaction(db, () => {
        const name = storeSystem(db, change);
        const room = state.office.floorplan.rooms.find((r) => r.id === input.roomId)?.name ?? input.roomId;
        recordAudit(db, {
          officeId: state.office.id,
          officeClock: state.now,
          actorId: actor.id,
          actionType: input.id ? "UPDATE_SYSTEM" : "ADD_SYSTEM",
          subject: { ...NO_SUBJECT, roomId: input.roomId },
          notes: [`${actor.displayName} ${input.id ? "changed" : "connected"} the system ${name} in ${room}`],
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
      connectSampleServices(db, suffix);
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
    // The demo's orders, bookings and invoices live in the mock services, so
    // those are put back as well. Otherwise the next run of the same request
    // is told its order was already placed. One that cannot be reached keeps
    // what it held, and the office is reset all the same.
    await resetSampleServices();
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
