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
  PERMISSIONS,
  type AgentType,
  type Participant,
  type Permission,
  type PlaybookStep,
  type Role,
  type Room,
  type RoomSelector,
  type StageRooms,
  type Task,
  type TaskEvent,
} from "../model";
import type { EngineState } from "../engine";
import type { ConnectedSystem } from "../systems";
import { storedOperations, storedShownRooms } from "./systems";
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

function writeRoomRecords(db: Db, room: Room): void {
  run(db, "DELETE FROM room_records WHERE room_id = ?", room.id);
  room.records.forEach((body, position) => {
    run(db, "INSERT INTO room_records (room_id, position, body) VALUES (?, ?, ?)", room.id, position, body);
  });
}

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
      `INSERT INTO rooms (id, floorplan_id, position, name, purpose, x, z, width, depth, corridor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      room.id,
      plan.id,
      position,
      room.name,
      room.purpose,
      room.bounds.x,
      room.bounds.z,
      room.bounds.w,
      room.bounds.d,
      room.corridor ? 1 : 0,
    );
  });
  for (const room of plan.rooms) {
    writeRoomRecords(db, room);
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

function writeRolePermissions(db: Db, role: Role): void {
  run(db, "DELETE FROM role_permissions WHERE role_id = ?", role.id);
  for (const permission of new Set(role.permissions)) {
    run(db, "INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)", role.id, permission);
  }
}

function writeRoles(db: Db, office: Office): void {
  Object.values(office.roles).forEach((role, position) => {
    run(
      db,
      "INSERT INTO roles (id, office_id, position, name, description) VALUES (?, ?, ?, ?, ?)",
      role.id,
      office.id,
      position,
      role.name,
      role.description,
    );
    writeRolePermissions(db, role);
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
          SET kind = ?, display_name = ?, title = ?, role_id = ?, desk_id = ?, color = ?, left_at = ?
        WHERE id = ?`,
      p.kind,
      p.displayName,
      p.title,
      p.roleId,
      p.deskId,
      p.appearance.color,
      p.leftAt ?? null,
      p.id,
    );
  } else {
    run(
      db,
      `INSERT INTO participants
         (id, office_id, position, kind, display_name, title, role_id, desk_id, color, left_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.id,
      officeId,
      nextPosition(db, "participants"),
      p.kind,
      p.displayName,
      p.title,
      p.roleId,
      p.deskId,
      p.appearance.color,
      p.leftAt ?? null,
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
  run(db, "DELETE FROM agent_settings WHERE participant_id = ?", p.id);
  if (p.kind === "agent") {
    run(
      db,
      "INSERT INTO agent_settings (participant_id, agent_type, provider_id, model) VALUES (?, ?, ?, ?)",
      p.id,
      p.agentType ?? "playbook",
      p.providerId,
      p.model,
    );
  }

  // Deleting the steps removes their outputs, questions, assumptions, needs and actions.
  run(db, "DELETE FROM playbook_steps WHERE participant_id = ?", p.id);
  p.playbook.forEach((step, position) => {
    run(
      db,
      `INSERT INTO playbook_steps
         (id, participant_id, position, stage, request_contains, requested_by, status_note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      step.id,
      p.id,
      position,
      step.when.stage === "any" ? null : step.when.stage,
      step.when.requestContains,
      step.when.requestedBy === "anyone" ? null : step.when.requestedBy,
      step.then.statusNote,
    );
    const { output, question, assumption, need, action, note } = step.then;
    if (note) {
      run(
        db,
        "INSERT INTO playbook_notes (step_id, to_participant_id, body) VALUES (?, ?, ?)",
        step.id,
        note.to === "requester" ? null : note.to,
        note.body,
      );
    }
    if (action) {
      run(
        db,
        "INSERT INTO playbook_actions (step_id, system_id, operation) VALUES (?, ?, ?)",
        step.id,
        action.systemId,
        action.operation,
      );
      for (const [name, value] of Object.entries(action.fields)) {
        run(db, "INSERT INTO playbook_action_fields (step_id, name, value) VALUES (?, ?, ?)", step.id, name, value);
      }
    }
    if (output) {
      run(db, "INSERT INTO playbook_outputs (step_id, label, body) VALUES (?, ?, ?)", step.id, output.label, output.body);
    }
    if (question) {
      run(
        db,
        "INSERT INTO playbook_questions (step_id, body, to_participant_id, blocking) VALUES (?, ?, ?, ?)",
        step.id,
        question.body,
        question.to === "requester" ? null : question.to,
        flag(question.blocking),
      );
      question.options.forEach((label, optionPosition) => {
        run(
          db,
          "INSERT INTO playbook_question_options (step_id, position, label) VALUES (?, ?, ?)",
          step.id,
          optionPosition,
          label,
        );
      });
    }
    if (assumption) {
      run(
        db,
        "INSERT INTO playbook_assumptions (step_id, assumed, because, confidence) VALUES (?, ?, ?, ?)",
        step.id,
        assumption.assumed,
        assumption.because,
        assumption.confidence,
      );
    }
    if (need) {
      run(
        db,
        "INSERT INTO playbook_needs (step_id, room_id, scope, purpose) VALUES (?, ?, ?, ?)",
        step.id,
        need.room,
        need.scope,
        need.purpose,
      );
    }
  });
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
    task.wait?.until ?? null,
    task.wait?.reason ?? null,
    task.owed ? 1 : 0,
    task.urgent ? 1 : 0,
    task.windUp ? 1 : 0,
  ];
  if (exists) {
    run(
      db,
      `UPDATE tasks
          SET title = ?, detail = ?, requested_by = ?, owner_id = ?, room_id = ?, stage = ?,
              status = ?, created_at = ?, closed_at = ?, wait_until = ?, wait_reason = ?, step_owed = ?, urgent = ?,
              wind_up = ?
        WHERE id = ?`,
      ...values,
      task.id,
    );
  } else {
    run(
      db,
      `INSERT INTO tasks
         (title, detail, requested_by, owner_id, room_id, stage, status, created_at, closed_at,
          wait_until, wait_reason, step_owed, urgent, wind_up, id, office_id, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...values,
      task.id,
      officeId,
      nextPosition(db, "tasks"),
    );
  }

  // A task's documents only ever grow, so the ones not stored yet are added.
  const kept = new Set(all<{ id: string }>(db, "SELECT id FROM task_documents WHERE task_id = ?", task.id).map((d) => d.id));
  (task.documents ?? []).forEach((d, position) => {
    if (kept.has(d.id)) return;
    run(
      db,
      "INSERT INTO task_documents (id, task_id, position, name, body, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      d.id,
      task.id,
      position,
      d.name,
      d.body,
      d.addedById,
      d.at,
    );
  });

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
  "message_system_results",
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
      if (m.heldAction) {
        run(
          db,
          "INSERT INTO message_held_actions (message_id, system_id, operation) VALUES (?, ?, ?)",
          m.id,
          m.heldAction.systemId,
          m.heldAction.operation,
        );
        for (const [name, value] of Object.entries(m.heldAction.fields)) {
          run(db, "INSERT INTO message_held_action_fields (message_id, name, value) VALUES (?, ?, ?)", m.id, name, value);
        }
      }
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
      if (m.did) {
        run(
          db,
          "INSERT INTO message_system_results (message_id, system_id, operation, ok, record) VALUES (?, ?, ?, ?, ?)",
          m.id,
          m.did.systemId,
          m.did.operation,
          m.did.ok ? 1 : 0,
          m.did.record ?? null,
        );
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
    case "note":
      break;
  }
}

function writeClock(db: Db, state: EngineState): void {
  run(
    db,
    "UPDATE offices SET name = ?, clock_ms = ?, clock_step_minutes = ?, id_sequence = ?, auto_handoff = ? WHERE id = ?",
    state.office.name,
    state.now,
    state.clockStepMinutes,
    state.seq,
    flag(state.office.autoHandoff),
    state.office.id,
  );
}

// ---------------------------------------------------------------------------
// Seed and save
// ---------------------------------------------------------------------------

/** True when this office exists in the database. */
export function hasOffice(db: Db, officeId: string): boolean {
  return get(db, "SELECT 1 AS found FROM offices WHERE id = ?", officeId) !== undefined;
}

/** A short tag no other office uses, for the ids a new office will generate. */
export function freshIdScope(db: Db): string {
  for (;;) {
    const scope = `${Math.random().toString(36).slice(2, 6)}-`;
    if (!get(db, "SELECT 1 AS found FROM offices WHERE id_scope = ?", scope)) return scope;
  }
}

/** Write a whole office into an empty database. */
export function seedDatabase(db: Db, state: EngineState): void {
  transaction(db, () => writeWholeOffice(db, state));
}

/** The same, for a caller that is already inside a transaction. */
export function writeWholeOffice(db: Db, state: EngineState): void {
  const { office } = state;
  {
    run(
      db,
      `INSERT INTO offices (id, name, clock_ms, clock_step_minutes, id_sequence, id_scope, auto_handoff)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      office.id,
      office.name,
      state.now,
      state.clockStepMinutes,
      state.seq,
      state.idScope ?? "",
      flag(office.autoHandoff),
    );
    writeFloorplan(db, office);
    writeStageRooms(db, office);
    writeRoles(db, office);
    for (const p of office.participants) writeParticipant(db, office.id, p);
    for (const task of office.tasks) writeTask(db, office.id, task);
    for (const message of office.messages) writeMessage(db, office.id, message);
    for (const rule of office.rules) writeRule(db, rule);
  }
}

/**
 * Remove one office and everything that belongs to it: rooms, people, work,
 * rules, tokens, seats and its audit log. Sign-ins are kept. Call inside a
 * transaction.
 */
export function deleteOffice(db: Db, officeId: string): void {
  run(
    db,
    "DELETE FROM access_decisions WHERE participant_id IN (SELECT id FROM participants WHERE office_id = ?)",
    officeId,
  );
  run(db, "DELETE FROM offices WHERE id = ?", officeId);
}

function changed<T extends { id: string }>(before: T[], after: T[]): { written: T[]; removed: string[] } {
  const previous = new Map(before.map((item) => [item.id, item]));
  const written = after.filter((item) => previous.get(item.id) !== item);
  const kept = new Set(after.map((item) => item.id));
  const removed = before.filter((item) => !kept.has(item.id)).map((item) => item.id);
  return { written, removed };
}

/** Bring the stored rooms, doors and desks in line with a changed floorplan. */
function syncFloorplan(db: Db, before: Office, after: Office): void {
  const plan = after.floorplan;
  run(db, "UPDATE floorplans SET name = ?, description = ? WHERE id = ?", plan.name, plan.description, plan.id);

  // Room order is unique per floorplan, so park the old order out of the way
  // before writing the new one.
  run(db, "UPDATE rooms SET position = -1 - position WHERE floorplan_id = ?", plan.id);
  plan.rooms.forEach((room, position) => {
    run(
      db,
      `INSERT INTO rooms (id, floorplan_id, position, name, purpose, x, z, width, depth, corridor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         position = excluded.position, name = excluded.name, purpose = excluded.purpose,
         x = excluded.x, z = excluded.z, width = excluded.width, depth = excluded.depth,
         corridor = excluded.corridor`,
      room.id,
      plan.id,
      position,
      room.name,
      room.purpose,
      room.bounds.x,
      room.bounds.z,
      room.bounds.w,
      room.bounds.d,
      room.corridor ? 1 : 0,
    );
  });

  const earlier = new Map(before.floorplan.rooms.map((r) => [r.id, r.records]));
  for (const room of plan.rooms) {
    if (earlier.get(room.id) !== room.records) writeRoomRecords(db, room);
  }

  run(db, "DELETE FROM doors WHERE room_id IN (SELECT id FROM rooms WHERE floorplan_id = ?)", plan.id);
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

  const desks = changed(before.floorplan.desks, plan.desks);
  for (const desk of desks.written) {
    if (get(db, "SELECT 1 AS found FROM desks WHERE id = ?", desk.id)) {
      run(
        db,
        "UPDATE desks SET room_id = ?, x = ?, z = ?, facing = ? WHERE id = ?",
        desk.roomId,
        desk.position.x,
        desk.position.z,
        desk.facing,
        desk.id,
      );
    } else {
      writeDesk(db, desk);
    }
  }
  for (const id of desks.removed) run(db, "DELETE FROM desks WHERE id = ?", id);

  const kept = new Set(plan.rooms.map((r) => r.id));
  for (const room of before.floorplan.rooms) {
    if (!kept.has(room.id)) run(db, "DELETE FROM rooms WHERE id = ?", room.id);
  }
}

/** Bring the stored roles and their grants in line. Removed roles go last. */
function syncRoles(db: Db, after: Office): void {
  Object.values(after.roles).forEach((role, position) => {
    run(
      db,
      `INSERT INTO roles (id, office_id, position, name, description)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         position = excluded.position, name = excluded.name, description = excluded.description`,
      role.id,
      after.id,
      position,
      role.name,
      role.description,
    );
    writeRolePermissions(db, role);
    run(db, "DELETE FROM role_grants WHERE role_id = ?", role.id);
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

/**
 * Persist the difference between two engine states. Call inside a
 * transaction when other writes (the audit entry) must land with it.
 */
export function saveEngineState(db: Db, before: EngineState, after: EngineState): void {
  const officeId = after.office.id;

  // Set-up changes first: roles, rooms and stages rarely change, and people
  // and work may refer to what was just added.
  if (before.office.roles !== after.office.roles) syncRoles(db, after.office);
  if (before.office.floorplan !== after.office.floorplan) syncFloorplan(db, before.office, after.office);
  if (before.office.stageRooms !== after.office.stageRooms) writeStageRooms(db, after.office);

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

  for (const roleId of Object.keys(before.office.roles)) {
    if (!(roleId in after.office.roles)) run(db, "DELETE FROM roles WHERE id = ?", roleId);
  }
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

/** Rebuild one office's engine state from the database, or null when it is not there. */
export function loadEngineState(db: Db, officeId: string): EngineState | null {
  const officeRow = get<{
    id: string;
    name: string;
    clock_ms: number;
    clock_step_minutes: number;
    id_sequence: number;
    id_scope: string;
    auto_handoff: number;
  }>(db, "SELECT * FROM offices WHERE id = ?", officeId);
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
      "SELECT id, desk_id FROM participants WHERE desk_id IS NOT NULL AND office_id = ?",
      officeRow.id,
    ).map((r) => [r.desk_id, r.id]),
  );
  const desks: Desk[] = all<{ id: string; room_id: string; x: number; z: number; facing: number }>(
    db,
    `SELECT d.id, d.room_id, d.x, d.z, d.facing
       FROM desks d JOIN rooms r ON r.id = d.room_id
      WHERE r.floorplan_id = ?
      ORDER BY d.position`,
    planRow.id,
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
  const recordsByRoom = groupBy(
    all<{ room_id: string; body: string }>(db, "SELECT room_id, body FROM room_records ORDER BY room_id, position"),
    (r) => r.room_id,
  );
  const rooms: Room[] = all<{
    id: string;
    name: string;
    purpose: string;
    x: number;
    z: number;
    width: number;
    depth: number;
    corridor: number;
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
    records: (recordsByRoom.get(r.id) ?? []).map((record) => record.body),
    ...(r.corridor === 1 ? { corridor: true } : {}),
  }));
  const roomIds = new Set(rooms.map((r) => r.id));
  const operations = storedOperations(db);
  const shownRooms = storedShownRooms(db);
  const systems: ConnectedSystem[] = all<{
    id: string;
    name: string;
    description: string;
    room_id: string;
    needs_approval: number;
  }>(db, "SELECT id, name, description, room_id, needs_approval FROM connected_systems ORDER BY position")
    .filter((s) => roomIds.has(s.room_id))
    .map((s) => ({
      id: s.id,
      name: s.name,
      roomId: s.room_id,
      shownIn: shownRooms.get(s.id) ?? [],
      description: s.description,
      operations: operations.get(s.id) ?? [],
      needsApproval: s.needs_approval === 1,
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
  const rolePermissions = groupBy(
    all<{ role_id: string; permission: Permission }>(db, "SELECT role_id, permission FROM role_permissions"),
    (r) => r.role_id,
  );
  for (const r of all<{ id: string; name: string; description: string }>(
    db,
    "SELECT id, name, description FROM roles WHERE office_id = ? ORDER BY position",
    officeRow.id,
  )) {
    const held = (rolePermissions.get(r.id) ?? []).map((p) => p.permission);
    roles[r.id] = {
      id: r.id,
      name: r.name,
      description: r.description,
      permissions: PERMISSIONS.filter((p) => held.includes(p)),
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
  const settings = new Map(
    all<{
      participant_id: string;
      agent_type: AgentType;
      provider_id: string | null;
      model: string | null;
      provider_name: string | null;
      default_model: string | null;
    }>(
      db,
      `SELECT a.participant_id, a.agent_type, a.provider_id, a.model,
              v.name AS provider_name, v.default_model
         FROM agent_settings a LEFT JOIN ai_providers v ON v.id = a.provider_id`,
    ).map((a) => [a.participant_id, a]),
  );

  // Playbooks, assembled from the step rows and their detail tables.
  const byStep = <T extends { step_id: string }>(table: string): Map<string, T> =>
    new Map(all<T>(db, `SELECT * FROM ${table}`).map((row) => [row.step_id, row]));
  const stepOutputs = byStep<{ step_id: string; label: string; body: string }>("playbook_outputs");
  const stepQuestions = byStep<{
    step_id: string;
    body: string;
    to_participant_id: string | null;
    blocking: number;
  }>("playbook_questions");
  const stepOptions = groupBy(
    all<{ step_id: string; label: string }>(
      db,
      "SELECT step_id, label FROM playbook_question_options ORDER BY step_id, position",
    ),
    (o) => o.step_id,
  );
  const stepAssumptions = byStep<{
    step_id: string;
    assumed: string;
    because: string;
    confidence: "low" | "medium" | "high";
  }>("playbook_assumptions");
  const stepNeeds = byStep<{ step_id: string; room_id: string; scope: AccessScope; purpose: string }>(
    "playbook_needs",
  );
  const stepNotes = byStep<{ step_id: string; to_participant_id: string | null; body: string }>("playbook_notes");
  const stepActions = byStep<{ step_id: string; system_id: string; operation: string }>("playbook_actions");
  const stepActionFields = groupBy(
    all<{ step_id: string; name: string; value: string }>(db, "SELECT * FROM playbook_action_fields"),
    (f) => f.step_id,
  );
  const playbooks = groupBy(
    all<{
      id: string;
      participant_id: string;
      stage: PlaybookStep["when"]["stage"] | null;
      request_contains: string;
      requested_by: string | null;
      status_note: string;
    }>(db, "SELECT * FROM playbook_steps ORDER BY participant_id, position"),
    (row) => row.participant_id,
  );
  const playbookOf = (participantId: string): PlaybookStep[] =>
    (playbooks.get(participantId) ?? []).map((row) => {
      const output = stepOutputs.get(row.id);
      const question = stepQuestions.get(row.id);
      const assumption = stepAssumptions.get(row.id);
      const need = stepNeeds.get(row.id);
      const action = stepActions.get(row.id);
      const note = stepNotes.get(row.id);
      return {
        id: row.id,
        when: {
          stage: row.stage ?? "any",
          requestContains: row.request_contains,
          requestedBy: row.requested_by ?? "anyone",
        },
        then: {
          statusNote: row.status_note,
          output: output ? { label: output.label, body: output.body } : null,
          question: question
            ? {
                body: question.body,
                to: question.to_participant_id ?? "requester",
                blocking: question.blocking === 1,
                options: (stepOptions.get(row.id) ?? []).map((o) => o.label),
              }
            : null,
          assumption: assumption
            ? { assumed: assumption.assumed, because: assumption.because, confidence: assumption.confidence }
            : null,
          need: need ? { room: need.room_id, scope: need.scope, purpose: need.purpose } : null,
          action: action
            ? {
                systemId: action.system_id,
                operation: action.operation,
                fields: Object.fromEntries((stepActionFields.get(row.id) ?? []).map((f) => [f.name, f.value])),
              }
            : null,
          note: note ? { to: note.to_participant_id ?? "requester", body: note.body } : null,
        },
      };
    });
  // An AI agent is "backed" while the provider it names exists. A provider needs no key to be used.
  const agentFields = (
    id: string,
    kind: Participant["kind"],
  ): Pick<Participant, "backing" | "agentType" | "providerId" | "model"> => {
    if (kind !== "agent") return { backing: null, agentType: null, providerId: null, model: null };
    const a = settings.get(id);
    const agentType: AgentType = a?.agent_type ?? "playbook";
    const live = agentType === "ai" && a?.provider_name;
    return {
      backing: live ? { provider: a.provider_name!, model: a.model ?? a.default_model! } : null,
      agentType,
      providerId: agentType === "ai" ? (a?.provider_id ?? null) : null,
      model: agentType === "ai" ? (a?.model ?? null) : null,
    };
  };

  const participants: Participant[] = all<{
    id: string;
    kind: Participant["kind"];
    display_name: string;
    title: string;
    role_id: string;
    desk_id: string | null;
    color: string;
    left_at: number | null;
  }>(db, "SELECT * FROM participants WHERE office_id = ? ORDER BY position", officeRow.id).map((p) => ({
    id: p.id,
    kind: p.kind,
    displayName: p.display_name,
    title: p.title,
    roleId: p.role_id,
    deskId: p.desk_id,
    capabilities: (capabilities.get(p.id) ?? []).map((c) => c.capability),
    ...agentFields(p.id, p.kind),
    playbook: playbookOf(p.id),
    appearance: { color: p.color },
    ...(p.left_at !== null ? { leftAt: p.left_at } : {}),
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
  }>(
    db,
    `SELECT r.* FROM access_rules r JOIN participants p ON p.id = r.participant_id
      WHERE p.office_id = ?
      ORDER BY r.position`,
    officeRow.id,
  ).map((r) => ({
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
  const documents = groupBy(
    all<{ id: string; task_id: string; name: string; body: string; added_by: string; added_at: number }>(
      db,
      "SELECT id, task_id, name, body, added_by, added_at FROM task_documents ORDER BY task_id, position",
    ),
    (d) => d.task_id,
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
    wait_until: number | null;
    wait_reason: string | null;
    step_owed: number;
    urgent: number;
    wind_up: number;
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
    ...(t.wait_until !== null ? { wait: { until: t.wait_until, reason: t.wait_reason ?? "" } } : {}),
    ...(t.step_owed === 1 ? { owed: true } : {}),
    ...(t.urgent === 1 ? { urgent: true } : {}),
    ...(t.wind_up === 1 ? { windUp: true } : {}),
    ...(documents.has(t.id)
      ? { documents: documents.get(t.id)!.map((d) => ({ id: d.id, name: d.name, body: d.body, addedById: d.added_by, at: d.added_at })) }
      : {}),
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
  const heldActions = new Map(
    all<{ message_id: string; system_id: string; operation: string }>(db, "SELECT * FROM message_held_actions").map(
      (h) => [h.message_id, h],
    ),
  );
  const heldFields = groupBy(
    all<{ message_id: string; name: string; value: string }>(db, "SELECT * FROM message_held_action_fields"),
    (f) => f.message_id,
  );
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
  const deeds = one<{ message_id: string; system_id: string; operation: string; ok: number; record: string | null }>(
    "message_system_results",
  );
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
      case "note":
        return { ...base, kind: "note" };
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
          ...(heldActions.has(m.id)
            ? {
                heldAction: {
                  systemId: heldActions.get(m.id)!.system_id,
                  operation: heldActions.get(m.id)!.operation,
                  fields: Object.fromEntries((heldFields.get(m.id) ?? []).map((f) => [f.name, f.value])),
                },
              }
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
        const d = deeds.get(m.id);
        return {
          ...base,
          kind: "status",
          ...(p ? { progress: p.progress } : {}),
          ...(d
            ? { did: { systemId: d.system_id, operation: d.operation, ok: d.ok === 1, ...(d.record ? { record: d.record } : {}) } }
            : {}),
        };
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
      systems,
      autoHandoff: officeRow.auto_handoff === 1,
    },
    now: officeRow.clock_ms,
    seq: officeRow.id_sequence,
    clockStepMinutes: officeRow.clock_step_minutes,
    ...(officeRow.id_scope ? { idScope: officeRow.id_scope } : {}),
  };
}
