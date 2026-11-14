/**
 * The one place where a signed-in person's action meets the engine.
 *
 * For every action: read the office from the database, stamp the action with
 * the session's participant, check the policy, run the engine, then write the
 * changes and an audit entry in a single transaction.
 */
import { reduce, ScriptedRuntime, type Action, type AgentRuntime, type EngineState } from "../engine";
import { initialState } from "../initialState";
import type { Office, Participant } from "../model";
import { authorize, contextOf, mayRead, stampActor, supervises, viewFor } from "../policy";
import type { FeedEntry, OfficeView } from "../view";
import { listAccessTokens, syncAccessTokens, tokenProblem } from "./accessTokens";
import { createUser, listUsers, setCredentials, userByParticipant, type Session } from "./auth";
import { all, database, run, transaction, type Db } from "./db";
import { hasOffice, loadEngineState, saveEngineState, seedDatabase } from "./officeStore";

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

const boot = globalThis as unknown as { __officeBooted?: boolean };

/** Demo sign-in lets a visitor enter as a seeded person without a password. */
export const demoLoginEnabled = (): boolean => process.env.DEMO_LOGIN !== "0";

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "");

/** Every human participant gets an account. New ones start without a password. */
export function ensureAccounts(db: Db, office: Office): void {
  for (const p of office.participants) {
    if (p.kind !== "human" || userByParticipant(db, p.id)) continue;
    createUser(db, { participantId: p.id, email: `${slug(p.displayName)}@office.test`, password: null });
  }
}

/**
 * Optional first administrator, taken from the environment so that no
 * credential is ever written in the repository.
 */
function applyAdminFromEnvironment(db: Db, office: Office): void {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  const admin = office.participants.find((p) => p.kind === "human" && supervises(office, p));
  const user = admin ? userByParticipant(db, admin.id) : null;
  if (user) setCredentials(db, user.id, email, password);
}

/** Open the database, seed it on first run, and return the connection. */
export function officeDatabase(): Db {
  const db = database();
  if (boot.__officeBooted) return db;
  if (!hasOffice(db)) seedDatabase(db, initialState);
  const state = loadEngineState(db)!;
  transaction(db, () => {
    ensureAccounts(db, state.office);
    applyAdminFromEnvironment(db, state.office);
    syncAccessTokens(db);
  });
  boot.__officeBooted = true;
  return db;
}

// ---------------------------------------------------------------------------
// Agent runtime
// ---------------------------------------------------------------------------

const runtimeHolder = globalThis as unknown as { __officeRuntime?: AgentRuntime };

export function agentRuntime(): AgentRuntime {
  runtimeHolder.__officeRuntime ??= new ScriptedRuntime();
  return runtimeHolder.__officeRuntime;
}

export function useAgentRuntime(runtime: AgentRuntime): void {
  runtimeHolder.__officeRuntime = runtime;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export class OfficeError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

function viewerOf(office: Office, session: Session): Participant {
  const viewer = office.participants.find((p) => p.id === session.participantId);
  if (!viewer) throw new OfficeError(401, "Your account is no longer part of this office.");
  return viewer;
}

function feedFor(db: Db, state: EngineState, viewer: Participant): FeedEntry[] {
  const ctx = contextOf(state.office, state.now);
  const all_ = supervises(state.office, viewer);
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
        all_ ||
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
  const runtime = agentRuntime();

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
    feed: feedFor(db, state, viewer),
    hiddenMessages,
    runtime: runtime.kind,
    // Token details are for supervisors and for the holder's own tokens.
    accessTokens: listAccessTokens(db)
      .filter((t) => isSupervisor || t.participantId === viewer.id)
      .map((t) => ({ ...t, problem: tokenProblem(t, state.office, ctx) })),
    accounts: isSupervisor
      ? listUsers(db).map((u) => ({
          participantId: u.participantId,
          email: u.email,
          hasPassword: u.hasPassword,
        }))
      : [],
  };
}

export function getView(session: Session): OfficeView {
  const db = officeDatabase();
  const state = loadEngineState(db);
  if (!state) throw new OfficeError(404, "No office has been set up.");
  return buildView(db, state, session);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

// Actions are applied one at a time. A transition can wait on an agent, and a
// second action must start from the state the first one left behind.
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
    const before = loadEngineState(db);
    if (!before) throw new OfficeError(404, "No office has been set up.");

    const actor = viewerOf(before.office, session);
    const action = stampActor(requested, actor.id);
    const verdict = authorize(before.office, contextOf(before.office, before.now), actor, action);
    if (!verdict.allowed) throw new OfficeError(403, verdict.reason);

    let result;
    try {
      result = await reduce(before, action, agentRuntime());
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

/**
 * Put the demo work back: the seeded tasks, messages and rules, and the demo
 * clock. People, desks and accounts are kept.
 */
export function restoreDemo(session: Session): Promise<OfficeView> {
  return inTurn(async () => {
    const db = officeDatabase();
    const before = loadEngineState(db);
    if (!before) throw new OfficeError(404, "No office has been set up.");
    const actor = viewerOf(before.office, session);
    if (!supervises(before.office, actor)) {
      throw new OfficeError(403, "Only a supervising role can restore the demo.");
    }

    const after: EngineState = {
      ...initialState,
      office: {
        ...before.office,
        rules: initialState.office.rules.map((r) => ({ ...r })),
        tasks: initialState.office.tasks.map((t) => ({ ...t })),
        messages: initialState.office.messages.map((m) => ({ ...m })),
      },
    };
    transaction(db, () => {
      saveEngineState(db, before, after);
      syncAccessTokens(db);
      recordAudit(db, {
        officeId: before.office.id,
        officeClock: after.now,
        actorId: actor.id,
        actionType: "RESTORE_DEMO",
        subject: { taskId: null, subjectParticipantId: null, ruleId: null, roomId: null },
        notes: [`Demo work restored by ${actor.displayName}.`],
      });
    });
    return buildView(db, after, session);
  });
}
