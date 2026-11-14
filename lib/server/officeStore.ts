/**
 * Maps the in-memory office to the relational schema and back.
 *
 * `loadEngineState` rebuilds exactly the object the engine works on.
 * `saveEngineState` writes only what an action changed: the engine never
 * mutates, so anything that is still the same object as before is untouched.
 */
import {
  ALL_SCOPES,
  ANY_ROOM,
  type AccessDecision,
  type AccessScope,
  type DecisionSource,
  type Desk,
  type Door,
  type IndividualRule,
  type Message,
  type Office,
  type Participant,
  type Role,
  type Room,
  type RoomSelector,
  type StageRooms,
  type Task,
  type TaskEvent,
} from "../model";
import type { EngineState } from "../engine";
import { all, get, run, transaction, type Db } from "./db";

const flag = (value: boolean): number => (value ? 1 : 0);
const roomOrNull = (room: RoomSelector): string | null => (room === ANY_ROOM ? null : room);
const roomOrAny = (room: string | null): RoomSelector => (room === null ? ANY_ROOM : room);
const inScopeOrder = (scopes: AccessScope[]): AccessScope[] =>
  ALL_SCOPES.filter((s) => scopes.includes(s));

function nextPosition(db: Db, table: string): number {
  const row = get<{ next: number }>(db, `SELECT COALESCE(MAX(position), -1) + 1 AS next FROM ${table}`);
  return row?.next ?? 0;
}

// ---------------------------------------------------------------------------
// Access decisions
// ---------------------------------------------------------------------------

function writeDecision(db: Db, id: string, decision: AccessDecision): void {
  run(
    db,
    `INSERT INTO access_decisions (id, participant_id, room_id, scope, effect, explanation)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    decision.participantId,
    decision.room,
    decision.scope,
    decision.effect,
    decision.explanation,
  );
  [decision.decidedBy, ...decision.overrode].forEach((source, position) => {
    run(
      db,
      `INSERT INTO access_decision_sources
         (decision_id, position, kind, effect, rule_id, role_id, grant_position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      position,
      source.kind,
      source.effect,
      source.kind === "individual" ? source.ruleId : null,
      source.kind === "role" ? source.roleId : null,
      source.kind === "role" ? source.grantIndex : null,
    );
  });
}

function readDecision(db: Db, id: string): AccessDecision {
  const row = get<{
    participant_id: string;
    room_id: string;
    scope: AccessScope;
    effect: "allow" | "deny";
    explanation: string;
  }>(db, "SELECT * FROM access_decisions WHERE id = ?", id);
  if (!row) throw new Error(`Missing access decision ${id}`);

  const sources = all<{
    kind: "individual" | "role" | "default";
    effect: "allow" | "deny";
    rule_id: string | null;
    role_id: string | null;
    grant_position: number | null;
  }>(db, "SELECT * FROM access_decision_sources WHERE decision_id = ? ORDER BY position", id).map(
    (s): DecisionSource => {
      if (s.kind === "individual") return { kind: "individual", ruleId: s.rule_id!, effect: s.effect };
      if (s.kind === "role") {
        return { kind: "role", roleId: s.role_id!, grantIndex: s.grant_position!, effect: s.effect };
      }
      return { kind: "default", effect: "deny" };
    },
  );
  const [decidedBy, ...overrode] = sources;
  return {
    participantId: row.participant_id,
    room: row.room_id,
    scope: row.scope,
    effect: row.effect,
    decidedBy,
    overrode,
    explanation: row.explanation,
  };
}

const deleteDecisionsWithPrefix = (db: Db, prefix: string): void =>
  run(db, "DELETE FROM access_decisions WHERE substr(id, 1, length(?)) = ?", prefix, prefix);

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

function writeFloorplan(db: Db, office: Office): void {
  const plan = office.floorplan;
  run(
    db,
    "INSERT INTO floorplans (id, office_id, name, description) VALUES (?, ?, ?, ?)",
    plan.id,
    office.id,
    plan.name,
    plan.description,
  );
  plan.rooms.forEach((room, position) => {
    run(
      db,
      `INSERT INTO rooms (id, floorplan_id, position, name, purpose, x, z, width, depth)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      room.id,
      plan.id,
      position,
      room.name,
      room.purpose,
      room.bounds.x,
      room.bounds.z,
      room.bounds.w,
      room.bounds.d,
    );
  });
  for (const room of plan.rooms) {
    room.doors.forEach((door, position) => {
      run(
        db,
        `INSERT INTO doors (id, room_id, position, to_room_id, wall, along, width)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        door.id,
        room.id,
        position,
        door.toRoomId,
        door.wall,
        door.along,
        door.width,
      );
    });
  }
  plan.desks.forEach((desk) => writeDesk(db, desk));
}

export function writeDesk(db: Db, desk: Desk): void {
  run(
    db,
    "INSERT INTO desks (id, room_id, position, x, z, facing) VALUES (?, ?, ?, ?, ?, ?)",
    desk.id,
    desk.roomId,
    nextPosition(db, "desks"),
    desk.position.x,
    desk.position.z,
    desk.facing,
  );
}

function writeStageRooms(db: Db, office: Office): void {
  run(db, "DELETE FROM stage_rooms WHERE office_id = ?", office.id);
  for (const [stage, roomId] of Object.entries(office.stageRooms)) {
    run(db, "INSERT INTO stage_rooms (office_id, stage, room_id) VALUES (?, ?, ?)", office.id, stage, roomId);
  }
}

function writeRoles(db: Db, office: Office): void {
  Object.values(office.roles).forEach((role, position) => {
    run(
      db,
      `INSERT INTO roles (id, office_id, position, name, description, supervises)
       VALUES (?, ?, ?, ?, ?, ?)`,
      role.id,
      office.id,
      position,
      role.name,
      role.description,
      flag(role.supervises),
    );
    role.grants.forEach((grant, grantPosition) => {
      run(
        db,
        "INSERT INTO role_grants (role_id, position, room_id, effect) VALUES (?, ?, ?, ?)",
        role.id,
        grantPosition,
        roomOrNull(grant.room),
        grant.effect,
      );
      for (const scope of new Set(grant.scopes)) {
        run(
          db,
          "INSERT INTO role_grant_scopes (role_id, position, scope) VALUES (?, ?, ?)",
          role.id,
          grantPosition,
          scope,
        );
      }
    });
  });
}

export function writeParticipant(db: Db, officeId: string, p: Participant): void {
  const exists = get(db, "SELECT 1 AS found FROM participants WHERE id = ?", p.id);
  if (exists) {
    run(
      db,
      `UPDATE participants
          SET kind = ?, display_name = ?, title = ?, role_id = ?, desk_id = ?, color = ?
        WHERE id = ?`,
      p.kind,
      p.displayName,
      p.title,
      p.roleId,
      p.deskId,
      p.appearance.color,
      p.id,
    );
  } else {
    run(
      db,
      `INSERT INTO participants
         (id, office_id, position, kind, display_name, title, role_id, desk_id, color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.id,
      officeId,
      nextPosition(db, "participants"),
      p.kind,
      p.displayName,
      p.title,
      p.roleId,
      p.deskId,
      p.appearance.color,
    );
  }
  run(db, "DELETE FROM participant_capabilities WHERE participant_id = ?", p.id);
  p.capabilities.forEach((capability, position) => {
    run(
      db,
      "INSERT INTO participant_capabilities (participant_id, position, capability) VALUES (?, ?, ?)",
      p.id,
      position,
      capability,
    );
  });
  run(db, "DELETE FROM agent_backings WHERE participant_id = ?", p.id);
  if (p.backing) {
    run(
      db,
      "INSERT INTO agent_backings (participant_id, provider, model) VALUES (?, ?, ?)",
      p.id,
      p.backing.provider,
      p.backing.model,
    );
  }
}

function writeRule(db: Db, rule: IndividualRule): void {
  const exists = get(db, "SELECT 1 AS found FROM access_rules WHERE id = ?", rule.id);
  const values = [
    rule.participantId,
    roomOrNull(rule.room),
    rule.effect,
    rule.reason,
    rule.grantedBy,
    rule.grantedAt,
    rule.expiresAt ?? null,
    rule.expiresOnTaskId ?? null,
  ];
  if (exists) {
    run(
      db,
      `UPDATE access_rules
          SET participant_id = ?, room_id = ?, effect = ?, reason = ?, granted_by = ?,
              granted_at = ?, expires_at = ?, expires_on_task_id = ?
        WHERE id = ?`,
      ...values,
      rule.id,
    );
  } else {
    run(
      db,
      `INSERT INTO access_rules
         (participant_id, room_id, effect, reason, granted_by, granted_at, expires_at,
          expires_on_task_id, id, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...values,
      rule.id,
      nextPosition(db, "access_rules"),
    );
  }
  // Scopes are reconciled one by one so that tokens issued for a scope that is
  // still granted survive an update.
  const wanted = new Set(rule.scopes);
  const stored = all<{ scope: AccessScope }>(
    db,
    "SELECT scope FROM access_rule_scopes WHERE rule_id = ?",
    rule.id,
  ).map((r) => r.scope);
  for (const scope of stored) {
    if (!wanted.has(scope)) {
      run(db, "DELETE FROM access_rule_scopes WHERE rule_id = ? AND scope = ?", rule.id, scope);
    }
  }
  for (const scope of wanted) {
    if (!stored.includes(scope)) {
      run(db, "INSERT INTO access_rule_scopes (rule_id, scope) VALUES (?, ?)", rule.id, scope);
    }
  }
}

function writeTask(db: Db, officeId: string, task: Task): void {
  const exists = get(db, "SELECT 1 AS found FROM tasks WHERE id = ?", task.id);
  const values = [
    task.title,
    task.detail,
    task.requestedById,
    task.ownerId,
    task.roomId,
    task.stage,
    task.status,
    task.createdAt,
    task.closedAt,
  ];
  if (exists) {
    run(
      db,
      `UPDATE tasks
          SET title = ?, detail = ?, requested_by = ?, owner_id = ?, room_id = ?, stage = ?,
              status = ?, created_at = ?, closed_at = ?
        WHERE id = ?`,
      ...values,
      task.id,
    );
  } else {
    run(
      db,
      `INSERT INTO tasks
         (title, detail, requested_by, owner_id, room_id, stage, status, created_at, closed_at,
          id, office_id, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...values,
      task.id,
      officeId,
      nextPosition(db, "tasks"),
    );
  }

  const decisionPrefix = `task:${task.id}:`;
  run(db, "DELETE FROM task_events WHERE task_id = ?", task.id);
  deleteDecisionsWithPrefix(db, decisionPrefix);
  task.history.forEach((event, position) => {
    const decisionId = event.decision ? `${decisionPrefix}${position}` : null;
    if (event.decision && decisionId) writeDecision(db, decisionId, event.decision);
    run(
      db,
      `INSERT INTO task_events (task_id, position, at, summary, message_id, decision_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      task.id,
      position,
      event.at,
      event.summary,
      event.messageId ?? null,
      decisionId,
    );
  });

  run(db, "DELETE FROM task_open_questions WHERE task_id = ?", task.id);
  task.openQuestionIds.forEach((messageId, position) => {
    run(
      db,
      "INSERT INTO task_open_questions (task_id, position, message_id) VALUES (?, ?, ?)",
      task.id,
      position,
      messageId,
    );
  });

  run(db, "DELETE FROM task_assumptions WHERE task_id = ?", task.id);
  task.assumptionIds.forEach((messageId, position) => {
    run(
      db,
      "INSERT INTO task_assumptions (task_id, position, message_id) VALUES (?, ?, ?)",
      task.id,
      position,
      messageId,
    );
  });
}

const DETAIL_TABLES = [
  "message_assignments",
  "message_questions",
  "message_answers",
  "message_assumptions",
  "message_progress",
  "message_handoffs",
  "message_escalations",
  "message_verdicts",
  "message_outputs",
] as const;

function writeMessage(db: Db, officeId: string, m: Message): void {
  const exists = get(db, "SELECT 1 AS found FROM messages WHERE id = ?", m.id);
  const values = [
    m.kind,
    m.taskId,
    m.fromId === "system" ? null : m.fromId,
    m.audience.to,
    m.audience.to === "participant" ? m.audience.id : null,
    m.audience.to === "room" ? m.audience.id : null,
    m.roomId,
    m.at,
    m.inReplyTo ?? null,
    m.body,
  ];
  if (exists) {
    run(
      db,
      `UPDATE messages
          SET kind = ?, task_id = ?, from_participant_id = ?, audience = ?,
              audience_participant_id = ?, audience_room_id = ?, room_id = ?, at = ?,
              in_reply_to = ?, body = ?
        WHERE id = ?`,
      ...values,
      m.id,
    );
  } else {
    run(
      db,
      `INSERT INTO messages
         (kind, task_id, from_participant_id, audience, audience_participant_id,
          audience_room_id, room_id, at, in_reply_to, body, id, office_id, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...values,
      m.id,
      officeId,
      nextPosition(db, "messages"),
    );
  }

  for (const table of DETAIL_TABLES) run(db, `DELETE FROM ${table} WHERE message_id = ?`, m.id);
  const decisionId = `message:${m.id}`;
  run(db, "DELETE FROM access_decisions WHERE id = ?", decisionId);

  switch (m.kind) {
    case "assignment":
      run(
        db,
        "INSERT INTO message_assignments (message_id, to_participant_id) VALUES (?, ?)",
        m.id,
        m.toParticipantId,
      );
      break;
    case "question":
      run(
        db,
        "INSERT INTO message_questions (message_id, blocking, answered_by_message_id) VALUES (?, ?, ?)",
        m.id,
        flag(m.blocking),
        m.answeredByMessageId ?? null,
      );
      (m.options ?? []).forEach((label, position) => {
        run(
          db,
          "INSERT INTO message_question_options (message_id, position, label) VALUES (?, ?, ?)",
          m.id,
          position,
          label,
        );
      });
      break;
    case "answer":
      run(
        db,
        "INSERT INTO message_answers (message_id, question_id, chosen_option) VALUES (?, ?, ?)",
        m.id,
        m.questionId,
        m.chosenOption ?? null,
      );
      break;
    case "assumption":
      run(
        db,
        `INSERT INTO message_assumptions (message_id, assumed, because, confidence, status)
         VALUES (?, ?, ?, ?, ?)`,
        m.id,
        m.assumed,
        m.because,
        m.confidence,
        m.status,
      );
      [...new Set(m.affectsTaskIds)].forEach((taskId, position) => {
        run(
          db,
          "INSERT INTO message_assumption_tasks (message_id, position, task_id) VALUES (?, ?, ?)",
          m.id,
          position,
          taskId,
        );
      });
      break;
    case "status":
      if (m.progress !== undefined) {
        run(db, "INSERT INTO message_progress (message_id, progress) VALUES (?, ?)", m.id, m.progress);
      }
      break;
    case "handoff":
      run(
        db,
        `INSERT INTO message_handoffs (message_id, from_participant_id, to_participant_id, to_room_id)
         VALUES (?, ?, ?, ?)`,
        m.id,
        m.fromParticipantId,
        m.toParticipantId,
        m.toRoomId,
      );
      break;
    case "escalation":
      if (m.deniedDecision) writeDecision(db, decisionId, m.deniedDecision);
      run(
        db,
        "INSERT INTO message_escalations (message_id, cause, denied_decision_id) VALUES (?, ?, ?)",
        m.id,
        m.cause,
        m.deniedDecision ? decisionId : null,
      );
      break;
    case "decision":
      run(db, "INSERT INTO message_verdicts (message_id, verdict) VALUES (?, ?)", m.id, m.verdict);
      break;
    case "output":
      run(
        db,
        "INSERT INTO message_outputs (message_id, label, simulated) VALUES (?, ?, ?)",
        m.id,
        m.label,
        flag(m.simulated),
      );
      break;
    case "request":
      break;
  }
}

function writeClock(db: Db, state: EngineState): void {
  run(
    db,
    "UPDATE offices SET name = ?, clock_ms = ?, clock_step_minutes = ?, id_sequence = ? WHERE id = ?",
    state.office.name,
    state.now,
    state.clockStepMinutes,
    state.seq,
    state.office.id,
  );
}

// ---------------------------------------------------------------------------
// Seed and save
// ---------------------------------------------------------------------------

/** True once an office has been written to this database. */
export function hasOffice(db: Db): boolean {
  return get(db, "SELECT 1 AS found FROM offices LIMIT 1") !== undefined;
}

/** Write a whole office into an empty database. */
export function seedDatabase(db: Db, state: EngineState): void {
  const { office } = state;
  transaction(db, () => {
    run(
      db,
      "INSERT INTO offices (id, name, clock_ms, clock_step_minutes, id_sequence) VALUES (?, ?, ?, ?, ?)",
      office.id,
      office.name,
      state.now,
      state.clockStepMinutes,
      state.seq,
    );
    writeFloorplan(db, office);
    writeStageRooms(db, office);
    writeRoles(db, office);
    for (const p of office.participants) writeParticipant(db, office.id, p);
    for (const task of office.tasks) writeTask(db, office.id, task);
    for (const message of office.messages) writeMessage(db, office.id, message);
    for (const rule of office.rules) writeRule(db, rule);
  });
}

/** Remove the office and everything that belongs to it. Accounts go with it. */
export function clearDatabase(db: Db): void {
  transaction(db, () => {
    run(db, "DELETE FROM access_decisions");
    run(db, "DELETE FROM offices");
  });
}

function changed<T extends { id: string }>(before: T[], after: T[]): { written: T[]; removed: string[] } {
  const previous = new Map(before.map((item) => [item.id, item]));
  const written = after.filter((item) => previous.get(item.id) !== item);
  const kept = new Set(after.map((item) => item.id));
  const removed = before.filter((item) => !kept.has(item.id)).map((item) => item.id);
  return { written, removed };
}

/**
 * Persist the difference between two engine states. Call inside a
 * transaction when other writes (the audit entry) must land with it.
 */
export function saveEngineState(db: Db, before: EngineState, after: EngineState): void {
  const officeId = after.office.id;

  const participants = changed(before.office.participants, after.office.participants);
  for (const p of participants.written) writeParticipant(db, officeId, p);
  for (const id of participants.removed) run(db, "DELETE FROM participants WHERE id = ?", id);

  const tasks = changed(before.office.tasks, after.office.tasks);
  for (const task of tasks.written) writeTask(db, officeId, task);
  for (const id of tasks.removed) {
    deleteDecisionsWithPrefix(db, `task:${id}:`);
    run(db, "DELETE FROM tasks WHERE id = ?", id);
  }

  const messages = changed(before.office.messages, after.office.messages);
  for (const message of messages.written) writeMessage(db, officeId, message);
  for (const id of messages.removed) {
    run(db, "DELETE FROM access_decisions WHERE id = ?", `message:${id}`);
    run(db, "DELETE FROM messages WHERE id = ?", id);
  }

  const rules = changed(before.office.rules, after.office.rules);
  for (const rule of rules.written) writeRule(db, rule);
  for (const id of rules.removed) run(db, "DELETE FROM access_rules WHERE id = ?", id);

  writeClock(db, after);
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}

/** Rebuild the engine state from the database, or null when it is empty. */
export function loadEngineState(db: Db): EngineState | null {
  const officeRow = get<{
    id: string;
    name: string;
    clock_ms: number;
    clock_step_minutes: number;
    id_sequence: number;
  }>(db, "SELECT * FROM offices LIMIT 1");
  if (!officeRow) return null;

  // -- floorplan
  const planRow = get<{ id: string; name: string; description: string }>(
    db,
    "SELECT id, name, description FROM floorplans WHERE office_id = ?",
    officeRow.id,
  )!;
  const occupantByDesk = new Map(
    all<{ id: string; desk_id: string }>(
      db,
      "SELECT id, desk_id FROM participants WHERE desk_id IS NOT NULL",
    ).map((r) => [r.desk_id, r.id]),
  );
  const desks: Desk[] = all<{ id: string; room_id: string; x: number; z: number; facing: number }>(
    db,
    "SELECT id, room_id, x, z, facing FROM desks ORDER BY position",
  ).map((d) => ({
    id: d.id,
    roomId: d.room_id,
    position: { x: d.x, z: d.z },
    facing: d.facing,
    occupantId: occupantByDesk.get(d.id) ?? null,
  }));
  const doorsByRoom = groupBy(
    all<{
      id: string;
      room_id: string;
      to_room_id: string | null;
      wall: Door["wall"];
      along: number;
      width: number;
    }>(db, "SELECT * FROM doors ORDER BY room_id, position"),
    (d) => d.room_id,
  );
  const rooms: Room[] = all<{
    id: string;
    name: string;
    purpose: string;
    x: number;
    z: number;
    width: number;
    depth: number;
  }>(db, "SELECT * FROM rooms WHERE floorplan_id = ? ORDER BY position", planRow.id).map((r) => ({
    id: r.id,
    name: r.name,
    purpose: r.purpose,
    bounds: { x: r.x, z: r.z, w: r.width, d: r.depth },
    doors: (doorsByRoom.get(r.id) ?? []).map((d) => ({
      id: d.id,
      toRoomId: d.to_room_id,
      wall: d.wall,
      along: d.along,
      width: d.width,
    })),
    deskIds: desks.filter((d) => d.roomId === r.id).map((d) => d.id),
  }));

  const stageRooms = Object.fromEntries(
    all<{ stage: string; room_id: string }>(
      db,
      "SELECT stage, room_id FROM stage_rooms WHERE office_id = ?",
      officeRow.id,
    ).map((r) => [r.stage, r.room_id]),
  ) as StageRooms;

  // -- roles
  const grantScopes = groupBy(
    all<{ role_id: string; position: number; scope: AccessScope }>(
      db,
      "SELECT role_id, position, scope FROM role_grant_scopes",
    ),
    (s) => `${s.role_id}:${s.position}`,
  );
  const grantsByRole = groupBy(
    all<{ role_id: string; position: number; room_id: string | null; effect: "allow" | "deny" }>(
      db,
      "SELECT * FROM role_grants ORDER BY role_id, position",
    ),
    (g) => g.role_id,
  );
  const roles: Record<string, Role> = {};
  for (const r of all<{ id: string; name: string; description: string; supervises: number }>(
    db,
    "SELECT id, name, description, supervises FROM roles WHERE office_id = ? ORDER BY position",
    officeRow.id,
  )) {
    roles[r.id] = {
      id: r.id,
      name: r.name,
      description: r.description,
      supervises: r.supervises === 1,
      grants: (grantsByRole.get(r.id) ?? []).map((g) => ({
        room: roomOrAny(g.room_id),
        scopes: inScopeOrder((grantScopes.get(`${g.role_id}:${g.position}`) ?? []).map((s) => s.scope)),
        effect: g.effect,
      })),
    };
  }

  // -- participants
  const capabilities = groupBy(
    all<{ participant_id: string; capability: string }>(
      db,
      "SELECT participant_id, capability FROM participant_capabilities ORDER BY participant_id, position",
    ),
    (c) => c.participant_id,
  );
  const backings = new Map(
    all<{ participant_id: string; provider: string; model: string }>(
      db,
      "SELECT * FROM agent_backings",
    ).map((b) => [b.participant_id, { provider: b.provider, model: b.model }]),
  );
  const participants: Participant[] = all<{
    id: string;
    kind: Participant["kind"];
    display_name: string;
    title: string;
    role_id: string;
    desk_id: string | null;
    color: string;
  }>(db, "SELECT * FROM participants WHERE office_id = ? ORDER BY position", officeRow.id).map((p) => ({
    id: p.id,
    kind: p.kind,
    displayName: p.display_name,
    title: p.title,
    roleId: p.role_id,
    deskId: p.desk_id,
    capabilities: (capabilities.get(p.id) ?? []).map((c) => c.capability),
    backing: backings.get(p.id) ?? null,
    appearance: { color: p.color },
  }));

  // -- rules
  const ruleScopes = groupBy(
    all<{ rule_id: string; scope: AccessScope }>(db, "SELECT rule_id, scope FROM access_rule_scopes"),
    (s) => s.rule_id,
  );
  const rules: IndividualRule[] = all<{
    id: string;
    participant_id: string;
    room_id: string | null;
    effect: "allow" | "deny";
    reason: string;
    granted_by: string;
    granted_at: number;
    expires_at: number | null;
    expires_on_task_id: string | null;
  }>(db, "SELECT * FROM access_rules ORDER BY position").map((r) => ({
    id: r.id,
    participantId: r.participant_id,
    room: roomOrAny(r.room_id),
    scopes: inScopeOrder((ruleScopes.get(r.id) ?? []).map((s) => s.scope)),
    effect: r.effect,
    reason: r.reason,
    grantedBy: r.granted_by,
    grantedAt: r.granted_at,
    ...(r.expires_at !== null ? { expiresAt: r.expires_at } : {}),
    ...(r.expires_on_task_id !== null ? { expiresOnTaskId: r.expires_on_task_id } : {}),
  }));

  // -- tasks
  const events = groupBy(
    all<{
      task_id: string;
      at: number;
      summary: string;
      message_id: string | null;
      decision_id: string | null;
    }>(db, "SELECT * FROM task_events ORDER BY task_id, position"),
    (e) => e.task_id,
  );
  const openQuestions = groupBy(
    all<{ task_id: string; message_id: string }>(
      db,
      "SELECT task_id, message_id FROM task_open_questions ORDER BY task_id, position",
    ),
    (q) => q.task_id,
  );
  const taskAssumptions = groupBy(
    all<{ task_id: string; message_id: string }>(
      db,
      "SELECT task_id, message_id FROM task_assumptions ORDER BY task_id, position",
    ),
    (a) => a.task_id,
  );
  const tasks: Task[] = all<{
    id: string;
    title: string;
    detail: string;
    requested_by: string;
    owner_id: string | null;
    room_id: string;
    stage: Task["stage"];
    status: Task["status"];
    created_at: number;
    closed_at: number | null;
  }>(db, "SELECT * FROM tasks WHERE office_id = ? ORDER BY position", officeRow.id).map((t) => ({
    id: t.id,
    title: t.title,
    detail: t.detail,
    requestedById: t.requested_by,
    ownerId: t.owner_id,
    roomId: t.room_id,
    stage: t.stage,
    status: t.status,
    openQuestionIds: (openQuestions.get(t.id) ?? []).map((q) => q.message_id),
    assumptionIds: (taskAssumptions.get(t.id) ?? []).map((a) => a.message_id),
    history: (events.get(t.id) ?? []).map(
      (e): TaskEvent => ({
        at: e.at,
        summary: e.summary,
        ...(e.message_id !== null ? { messageId: e.message_id } : {}),
        ...(e.decision_id !== null ? { decision: readDecision(db, e.decision_id) } : {}),
      }),
    ),
    createdAt: t.created_at,
    closedAt: t.closed_at,
  }));

  // -- messages
  const one = <T extends { message_id: string }>(table: string): Map<string, T> =>
    new Map(all<T>(db, `SELECT * FROM ${table}`).map((row) => [row.message_id, row]));
  const assignments = one<{ message_id: string; to_participant_id: string }>("message_assignments");
  const questions = one<{
    message_id: string;
    blocking: number;
    answered_by_message_id: string | null;
  }>("message_questions");
  const options = groupBy(
    all<{ message_id: string; label: string }>(
      db,
      "SELECT message_id, label FROM message_question_options ORDER BY message_id, position",
    ),
    (o) => o.message_id,
  );
  const answers = one<{ message_id: string; question_id: string; chosen_option: string | null }>(
    "message_answers",
  );
  const assumptions = one<{
    message_id: string;
    assumed: string;
    because: string;
    confidence: "low" | "medium" | "high";
    status: "open" | "confirmed" | "contradicted";
  }>("message_assumptions");
  const affected = groupBy(
    all<{ message_id: string; task_id: string }>(
      db,
      "SELECT message_id, task_id FROM message_assumption_tasks ORDER BY message_id, position",
    ),
    (a) => a.message_id,
  );
  const progress = one<{ message_id: string; progress: number }>("message_progress");
  const handoffs = one<{
    message_id: string;
    from_participant_id: string;
    to_participant_id: string;
    to_room_id: string;
  }>("message_handoffs");
  const escalations = one<{
    message_id: string;
    cause: "permission" | "ambiguity" | "policy" | "error";
    denied_decision_id: string | null;
  }>("message_escalations");
  const verdicts = one<{
    message_id: string;
    verdict: "approved" | "rejected" | "changes_requested";
  }>("message_verdicts");
  const outputs = one<{ message_id: string; label: string; simulated: number }>("message_outputs");

  const messages: Message[] = all<{
    id: string;
    kind: Message["kind"];
    task_id: string;
    from_participant_id: string | null;
    audience: "participant" | "room" | "everyone";
    audience_participant_id: string | null;
    audience_room_id: string | null;
    room_id: string;
    at: number;
    in_reply_to: string | null;
    body: string;
  }>(db, "SELECT * FROM messages WHERE office_id = ? ORDER BY position", officeRow.id).map((m) => {
    const base = {
      id: m.id,
      taskId: m.task_id,
      fromId: m.from_participant_id ?? ("system" as const),
      audience:
        m.audience === "participant"
          ? { to: "participant" as const, id: m.audience_participant_id! }
          : m.audience === "room"
            ? { to: "room" as const, id: m.audience_room_id! }
            : { to: "everyone" as const },
      roomId: m.room_id,
      at: m.at,
      ...(m.in_reply_to !== null ? { inReplyTo: m.in_reply_to } : {}),
      body: m.body,
    };
    switch (m.kind) {
      case "request":
        return { ...base, kind: "request" };
      case "assignment":
        return { ...base, kind: "assignment", toParticipantId: assignments.get(m.id)!.to_participant_id };
      case "question": {
        const q = questions.get(m.id)!;
        const labels = options.get(m.id);
        return {
          ...base,
          kind: "question",
          blocking: q.blocking === 1,
          ...(labels ? { options: labels.map((o) => o.label) } : {}),
          ...(q.answered_by_message_id !== null
            ? { answeredByMessageId: q.answered_by_message_id }
            : {}),
        };
      }
      case "answer": {
        const a = answers.get(m.id)!;
        return {
          ...base,
          kind: "answer",
          questionId: a.question_id,
          ...(a.chosen_option !== null ? { chosenOption: a.chosen_option } : {}),
        };
      }
      case "assumption": {
        const a = assumptions.get(m.id)!;
        return {
          ...base,
          kind: "assumption",
          assumed: a.assumed,
          because: a.because,
          confidence: a.confidence,
          status: a.status,
          affectsTaskIds: (affected.get(m.id) ?? []).map((t) => t.task_id),
        };
      }
      case "status": {
        const p = progress.get(m.id);
        return { ...base, kind: "status", ...(p ? { progress: p.progress } : {}) };
      }
      case "handoff": {
        const h = handoffs.get(m.id)!;
        return {
          ...base,
          kind: "handoff",
          fromParticipantId: h.from_participant_id,
          toParticipantId: h.to_participant_id,
          toRoomId: h.to_room_id,
        };
      }
      case "escalation": {
        const e = escalations.get(m.id)!;
        return {
          ...base,
          kind: "escalation",
          cause: e.cause,
          ...(e.denied_decision_id !== null
            ? { deniedDecision: readDecision(db, e.denied_decision_id) }
            : {}),
        };
      }
      case "decision":
        return { ...base, kind: "decision", verdict: verdicts.get(m.id)!.verdict };
      case "output": {
        const o = outputs.get(m.id)!;
        return { ...base, kind: "output", label: o.label, simulated: o.simulated === 1 };
      }
    }
  });

  return {
    office: {
      id: officeRow.id,
      name: officeRow.name,
      floorplan: {
        id: planRow.id,
        name: planRow.name,
        description: planRow.description,
        rooms,
        desks,
      },
      stageRooms,
      participants,
      roles,
      rules,
      tasks,
      messages,
    },
    now: officeRow.clock_ms,
    seq: officeRow.id_sequence,
    clockStepMinutes: officeRow.clock_step_minutes,
  };
}
