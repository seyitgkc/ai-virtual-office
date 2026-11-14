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
import { reduce, type Action, type AgentRuntime, type EngineState } from "../engine";
import { initialState } from "../initialState";
import { may, PERMISSION_INFO, type Office, type Participant, type Permission } from "../model";
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
  providerIds,
  providerViews,
  removeProvider,
  runtimeForAgent,
  saveProvider,
  testStoredProvider,
  type ProviderInput,
} from "./providers";

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
  if (overrides.__officeRuntime) return overrides.__officeRuntime;
  return {
    step: async (input) =>
      input.participant.agentType === "ai"
        ? runtimeForAgent(db, officeId, input.participant).step(input)
        : runPlaybook(input),
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
    feed: feedFor(db, state, viewer),
    hiddenMessages,
    // Keys never leave the server. The list is for people who connect
    // providers or choose one for an agent.
    providers: can("manage_providers") || can("manage_people") ? providerViews(db, office.id) : [],
    providersEditable: can("manage_providers") && session.hasPassword && !isDemoOffice(office.id),
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
    return buildView(db, result.state, session);
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

    let office: Office;
    try {
      office = applyAdminOp(
        before.office,
        op,
        actor.id,
        () => randomUUID().slice(0, 8),
        providerIds(db, before.office.id),
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

/** The person and office for a change to AI providers, or a refusal. */
function providerEditor(db: Db, session: Session): { state: EngineState; actor: Participant } {
  const state = loadOffice(db, session);
  const actor = requirePermission(state, session, "manage_providers");
  if (isDemoOffice(state.office.id)) {
    throw new OfficeError(403, "The demo office is shared, so no API key can be stored in it.");
  }
  if (!session.hasPassword) throw new OfficeError(403, "Sign in with a password account to connect a provider.");
  return { state, actor };
}

/**
 * Add an AI provider to the office, or change one. The API key is stored
 * encrypted and is never returned or written to the log.
 */
export function saveProviderSettings(session: Session, input: ProviderInput): Promise<OfficeView> {
  return inTurn(async () => {
    const db = officeDatabase();
    const { state, actor } = providerEditor(db, session);
    try {
      transaction(db, () => {
        saveProvider(db, state.office.id, input);
        const keyNote = input.removeKey ? " and removed its API key" : input.apiKey?.trim() ? " and stored its API key" : "";
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
      });
    } catch (error) {
      if (error instanceof ProviderError) throw new OfficeError(400, error.message);
      throw error;
    }
    return buildView(db, loadOffice(db, session), session);
  });
}

/** Remove an AI provider. Agents that used it are left without one. */
export function removeProviderSettings(session: Session, providerId: string): Promise<OfficeView> {
  return inTurn(async () => {
    const db = officeDatabase();
    const { state, actor } = providerEditor(db, session);
    try {
      transaction(db, () => {
        const name = removeProvider(db, state.office.id, providerId);
        recordAudit(db, {
          officeId: state.office.id,
          officeClock: state.now,
          actorId: actor.id,
          actionType: "REMOVE_AI_PROVIDER",
          subject: NO_SUBJECT,
          notes: [`${actor.displayName} removed the AI provider ${name}`],
        });
      });
    } catch (error) {
      if (error instanceof ProviderError) throw new OfficeError(404, error.message);
      throw error;
    }
    return buildView(db, loadOffice(db, session), session);
  });
}

/** Check a stored provider with the service itself. Nothing is generated. */
export async function testProviderSettings(session: Session, providerId: string): Promise<{ ok: true; model: string }> {
  const db = officeDatabase();
  providerEditor(db, session);
  try {
    return { ok: true, model: await testStoredProvider(db, session.officeId ?? "", providerId) };
  } catch (error) {
    if (error instanceof ProviderError) throw new OfficeError(400, error.message);
    // A provider's failure is reported as 424. A proxy in front of the server
    // replaces the body of a 5xx reply with its own page, which hides the reason.
    throw new OfficeError(424, error instanceof Error ? error.message : "The connection test failed.");
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

/** Look at another of the account's offices. */
export function switchOffice(session: Session, officeId: string): void {
  if (!switchSeat(officeDatabase(), session, officeId)) {
    throw new OfficeError(404, "You have no seat in that office.");
  }
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
