/**
 * The one place where a signed-in person meets an office.
 *
 * A database holds many offices. A session looks at one of them at a time,
 * through the seat its user holds there. For every action: read that office
 * from the database, stamp the action with the seat, check the policy, run
 * the engine, then write the changes and an audit entry in one transaction.
 */
import { randomUUID } from "node:crypto";
import { AdminError, applyAdminOp, blankOffice, type AdminOp } from "../admin";
import { reduce, ScriptedRuntime, type Action, type AgentRuntime, type EngineState } from "../engine";
import { initialState } from "../initialState";
import type { Office, Participant } from "../model";
import { authorize, contextOf, mayRead, stampActor, supervises, viewFor } from "../policy";
import type { AiView, FeedEntry, OfficeView } from "../view";
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
import { DEFAULT_AGENT_MODEL, ModelRuntime, testProvider, validModelId } from "./modelRuntime";
import {
  deleteOffice,
  freshIdScope,
  hasOffice,
  loadEngineState,
  saveEngineState,
  writeParticipant,
  writeWholeOffice,
} from "./officeStore";
import { seal, unseal } from "./secrets";

/** The seeded distributor. It exists only for password-free demo sign-in. */
export const DEMO_OFFICE_ID = initialState.office.id;
export const isDemoOffice = (officeId: string | null): boolean => officeId === DEMO_OFFICE_ID;

/** Demo sign-in lets a visitor enter the demo office as a seeded person. */
export const demoLoginEnabled = (): boolean => process.env.DEMO_LOGIN !== "0";

const MAX_OFFICES_PER_ACCOUNT = 12;

export class OfficeError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 502,
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

/** Open the database and make sure the demo office and the administrator exist. */
export function officeDatabase(): Db {
  const db = database();
  if (boot.__officeBooted) return db;
  transaction(db, () => {
    if (demoLoginEnabled() && !hasOffice(db, DEMO_OFFICE_ID)) writeWholeOffice(db, initialState);
    ensureAdminAccount(db);
    const demo = loadEngineState(db, DEMO_OFFICE_ID);
    if (demo) ensureDemoAccounts(db, demo.office);
    syncAccessTokens(db);
  });
  boot.__officeBooted = true;
  return db;
}

// ---------------------------------------------------------------------------
// AI provider settings
// ---------------------------------------------------------------------------

interface AiRow {
  runtime: "scripted" | "model";
  provider: string;
  model: string;
  api_key_cipher: string | null;
  key_hint: string | null;
  updated_at: number;
}

const aiRow = (db: Db, officeId: string): AiRow | undefined =>
  get<AiRow>(db, "SELECT * FROM office_ai WHERE office_id = ?", officeId);

function aiView(db: Db, officeId: string, session: Session): AiView {
  const row = aiRow(db, officeId);
  const key = unseal(row?.api_key_cipher ?? null);
  return {
    runtime: row?.runtime === "model" && key ? "model" : "scripted",
    provider: "anthropic",
    model: row?.model ?? DEFAULT_AGENT_MODEL,
    hasKey: key !== null,
    keyHint: key !== null ? (row?.key_hint ?? null) : null,
    // A stored key that can no longer be read was encrypted under an older
    // signing key and has to be entered again.
    keyUnreadable: Boolean(row?.api_key_cipher) && key === null,
    editable: session.hasPassword && !isDemoOffice(officeId),
  };
}

const scripted = new ScriptedRuntime();
const runtimes = new Map<string, { stamp: number; runtime: AgentRuntime }>();
const overrides = globalThis as unknown as { __officeRuntime?: AgentRuntime };

/** For tests: answer every agent step with this runtime, in every office. */
export function useAgentRuntime(runtime: AgentRuntime | undefined): void {
  overrides.__officeRuntime = runtime;
}

/** The runtime an office's agents use: its connected model, or the script. */
function runtimeFor(db: Db, officeId: string): AgentRuntime {
  if (overrides.__officeRuntime) return overrides.__officeRuntime;
  const row = aiRow(db, officeId);
  if (!row || row.runtime !== "model") return scripted;
  const cached = runtimes.get(officeId);
  if (cached && cached.stamp === row.updated_at) return cached.runtime;
  const apiKey = unseal(row.api_key_cipher);
  const runtime = apiKey ? new ModelRuntime({ apiKey, model: row.model }) : scripted;
  runtimes.set(officeId, { stamp: row.updated_at, runtime });
  return runtime;
}

/**
 * Keep each agent's stored backing in step with the runtime in use, so the
 * interface labels an agent as live only when a model really answers for it.
 */
function recordAgentBacking(db: Db, office: Office): void {
  const runtime = runtimeFor(db, office.id);
  const wanted = runtime instanceof ModelRuntime ? { provider: "Anthropic", model: runtime.model } : null;
  for (const p of office.participants) {
    if (p.kind !== "agent") continue;
    const same = wanted === null ? p.backing === null : p.backing?.model === wanted.model;
    if (!same) writeParticipant(db, office.id, { ...p, backing: wanted });
  }
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

function requireSupervisor(state: EngineState, session: Session, what: string): Participant {
  const actor = viewerOf(state.office, session);
  if (!supervises(state.office, actor)) throw new OfficeError(403, `Only a supervising role can ${what}.`);
  return actor;
}

function feedFor(db: Db, state: EngineState, viewer: Participant): FeedEntry[] {
  const ctx = contextOf(state.office, state.now);
  const seesAll = supervises(state.office, viewer);
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
  const isSupervisor = supervises(state.office, viewer);
  const ai = aiView(db, office.id, session);

  return {
    office,
    now: state.now,
    viewer: {
      participantId: viewer.id,
      displayName: viewer.displayName,
      title: viewer.title,
      email: session.email,
      supervises: isSupervisor,
    },
    account: { email: session.email, displayName: session.displayName, isDemo: !session.hasPassword },
    offices: seatsOf(db, session.userId).map((seat) => ({
      officeId: seat.officeId,
      name: seat.officeName,
      supervises: seat.supervises,
      isDemo: isDemoOffice(seat.officeId),
      active: seat.officeId === office.id,
    })),
    isDemoOffice: isDemoOffice(office.id),
    feed: feedFor(db, state, viewer),
    hiddenMessages,
    runtime: ai.runtime,
    ai: isSupervisor ? ai : null,
    // Token details are for supervisors and for the holder's own tokens.
    accessTokens: listAccessTokens(db, office.id)
      .filter((t) => isSupervisor || t.participantId === viewer.id)
      .map((t) => ({ ...t, problem: tokenProblem(t, state.office, ctx) })),
    accounts: isSupervisor
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
      return `${who} added the agent ${op.displayName.trim()} with a desk in ${quoted(after, op.roomId)}`;
    case "UPDATE_PARTICIPANT":
      return `${who} updated ${quoted(after, op.participantId)}`;
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

/** Apply one change to how the office is set up, on behalf of a supervisor. */
export function applyAdminOperation(session: Session, op: AdminOp): Promise<OfficeView> {
  return inTurn(async () => {
    const db = officeDatabase();
    const before = loadOffice(db, session);
    const actor = requireSupervisor(before, session, "change how the office is set up");

    let office: Office;
    try {
      office = applyAdminOp(before.office, op, actor.id, () => randomUUID().slice(0, 8));
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
        recordAgentBacking(db, after.office);
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

/**
 * Change how an office's agents think: scripted, or a model reached with the
 * given API key. The key is stored encrypted and is never returned.
 */
export function saveAiSettings(
  session: Session,
  input: { runtime: "scripted" | "model"; model: string; apiKey?: string; removeKey?: boolean },
): Promise<OfficeView> {
  return inTurn(async () => {
    const db = officeDatabase();
    const state = loadOffice(db, session);
    const actor = requireSupervisor(state, session, "change the AI provider");
    const officeId = state.office.id;
    if (isDemoOffice(officeId)) {
      throw new OfficeError(403, "The demo office is shared, so no API key can be stored in it.");
    }
    if (!session.hasPassword) throw new OfficeError(403, "Sign in with a password account to connect a model.");

    const model = input.model.trim();
    if (!validModelId(model)) throw new OfficeError(400, "Enter a model id such as claude-opus-5-5.");
    const existing = aiRow(db, officeId);
    const typed = input.apiKey?.trim();
    if (typed !== undefined && typed !== "" && (typed.length < 20 || typed.length > 300 || /\s/.test(typed))) {
      throw new OfficeError(400, "That does not look like an API key.");
    }
    const cipher = input.removeKey ? null : typed ? seal(typed) : (existing?.api_key_cipher ?? null);
    const hint = input.removeKey ? null : typed ? typed.slice(-4) : (existing?.key_hint ?? null);
    if (input.runtime === "model" && unseal(cipher) === null) {
      throw new OfficeError(400, "Enter an API key before switching the agents to a live model.");
    }

    transaction(db, () => {
      run(
        db,
        `INSERT INTO office_ai (office_id, runtime, provider, model, api_key_cipher, key_hint, updated_at)
         VALUES (?, ?, 'anthropic', ?, ?, ?, ?)
         ON CONFLICT(office_id) DO UPDATE SET
           runtime = excluded.runtime, model = excluded.model,
           api_key_cipher = excluded.api_key_cipher, key_hint = excluded.key_hint,
           updated_at = excluded.updated_at`,
        officeId,
        input.runtime,
        model,
        cipher,
        hint,
        Date.now(),
      );
      recordAgentBacking(db, state.office);
      const what = input.runtime === "model" ? `a live model (${model})` : "the fixed script";
      const keyNote = input.removeKey ? " and removed the stored API key" : typed ? " and stored a new API key" : "";
      recordAudit(db, {
        officeId,
        officeClock: state.now,
        actorId: actor.id,
        actionType: "SET_AI_PROVIDER",
        subject: NO_SUBJECT,
        // The key itself is never written to the log.
        notes: [`${actor.displayName} set the agents to ${what}${keyNote}`],
      });
    });
    return buildView(db, loadOffice(db, session), session);
  });
}

/** Check the stored key and model against the provider. Nothing is generated. */
export async function testAiSettings(session: Session): Promise<{ ok: true; model: string }> {
  const db = officeDatabase();
  const state = loadOffice(db, session);
  requireSupervisor(state, session, "test the AI provider");
  const row = aiRow(db, state.office.id);
  const apiKey = unseal(row?.api_key_cipher ?? null);
  if (!row || !apiKey) throw new OfficeError(400, "No API key is stored for this office yet.");
  try {
    return { ok: true, model: await testProvider(apiKey, row.model) };
  } catch (error) {
    throw new OfficeError(502, error instanceof Error ? error.message : "The connection test failed.");
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
 * Delete an office and everything in it. Only someone who supervises it may,
 * and the shared demo office cannot be deleted at all.
 */
export function removeOffice(session: Session, officeId: string): Promise<{ ok: true }> {
  return inTurn(async () => {
    const db = officeDatabase();
    if (isDemoOffice(officeId)) throw new OfficeError(403, "The demo office cannot be removed.");
    const seat = seatsOf(db, session.userId).find((s) => s.officeId === officeId);
    if (!seat) throw new OfficeError(404, "You have no seat in that office.");
    if (!seat.supervises) throw new OfficeError(403, "Only someone who supervises an office can remove it.");
    transaction(db, () => deleteOffice(db, officeId));
    runtimes.delete(officeId);
    return { ok: true };
  });
}
