/**
 * Database schema, in third normal form.
 *
 * Rules followed throughout:
 *  - Every column holds one value. Lists (scopes, capabilities, options) are
 *    rows in a child table, never a delimited or JSON column.
 *  - Every non-key column depends on the whole key and on nothing else. Facts
 *    that the in-memory model repeats for convenience are stored once here:
 *    a desk's occupant lives only in `participants.desk_id`, and a room's
 *    desks only in `desks.room_id`.
 *  - Message kinds carry different fields, so each kind has its own table
 *    keyed by the message id, next to the shared `messages` row.
 *  - A NULL room on a grant or rule means "every room".
 *  - `position` columns record order within a parent. Order is data: rules
 *    and grants are evaluated in sequence and threads are read in sequence.
 */

import { CARRIER, STOREFRONT } from "../../services/manifests.ts";
import type { ServiceManifest } from "../systems";

export const SCHEMA_VERSION = 19;

const quoted = (text: string): string => `'${text.replace(/'/g, "''")}'`;

/** Rows giving every stored system of one former kind the operations that kind had. */
function operationsForKind(kind: string, manifest: ServiceManifest): string {
  return manifest.operations
    .flatMap((operation, position) => [
      `INSERT INTO system_operations (system_id, operation, position, label, method, path)
SELECT id, ${quoted(operation.id)}, ${position}, ${quoted(operation.label)}, ${quoted(operation.method)}, ${quoted(operation.path)}
  FROM connected_systems WHERE kind = ${quoted(kind)};`,
      ...operation.fields.map(
        (field, at) => `INSERT INTO system_operation_fields (system_id, operation, name, position, label, hint, place)
SELECT id, ${quoted(operation.id)}, ${quoted(field.name)}, ${at}, ${quoted(field.label)}, ${quoted(field.hint)}, ${quoted(field.place)}
  FROM connected_systems WHERE kind = ${quoted(kind)};`,
      ),
    ])
    .join("\n");
}

export const SCHEMA = /* sql */ `
CREATE TABLE schema_meta (
  version INTEGER NOT NULL
) STRICT;

-- ---------------------------------------------------------------- office
-- One database holds many offices. id_scope is a short tag, unique per
-- office, that prefixes the ids an office generates for its tasks, messages
-- and rules, so that ids never collide between offices.
CREATE TABLE offices (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  clock_ms           INTEGER NOT NULL,
  clock_step_minutes INTEGER NOT NULL,
  id_sequence        INTEGER NOT NULL,
  id_scope           TEXT NOT NULL DEFAULT '',
  -- 1 when agents hand a finished step on to the next stage by themselves.
  auto_handoff       INTEGER NOT NULL DEFAULT 0 CHECK (auto_handoff IN (0, 1))
) STRICT;

CREATE UNIQUE INDEX offices_by_scope ON offices(id_scope);

-- AI providers. One belongs either to an office, or to an account, whose
-- owner can use it in every office they manage providers in. The API key is
-- stored encrypted and is never sent back to a browser; key_hint keeps its
-- last characters for display.
CREATE TABLE ai_providers (
  id             TEXT PRIMARY KEY,
  office_id      TEXT REFERENCES offices(id) ON DELETE CASCADE,
  owner_user_id  TEXT REFERENCES users(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('anthropic', 'openai_compatible')),
  base_url       TEXT,
  default_model  TEXT NOT NULL,
  api_key_cipher TEXT,
  key_hint       TEXT,
  updated_at     INTEGER NOT NULL,
  CHECK ((office_id IS NULL) <> (owner_user_id IS NULL))
) STRICT;

CREATE TABLE floorplans (
  id          TEXT PRIMARY KEY,
  office_id   TEXT NOT NULL UNIQUE REFERENCES offices(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL
) STRICT;

CREATE TABLE rooms (
  id           TEXT PRIMARY KEY,
  floorplan_id TEXT NOT NULL REFERENCES floorplans(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  name         TEXT NOT NULL,
  purpose      TEXT NOT NULL,
  x            REAL NOT NULL,
  z            REAL NOT NULL,
  width        REAL NOT NULL CHECK (width > 0),
  depth        REAL NOT NULL CHECK (depth > 0),
  -- 1 for a room people only walk through, which other rooms open onto.
  corridor     INTEGER NOT NULL DEFAULT 0 CHECK (corridor IN (0, 1)),
  UNIQUE (floorplan_id, position)
) STRICT;

-- Facts kept in a room, one sentence each, in the order they are listed.
CREATE TABLE room_records (
  room_id  TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  body     TEXT NOT NULL,
  PRIMARY KEY (room_id, position)
) STRICT;

-- An outside system connected to a room. The room's access rules cover it:
-- read on the room shows its records, act on the room allows its operations.
-- The API key is stored encrypted, as for AI providers. The description says
-- when to use the system and how. It starts as the system's own and a person
-- can reword it.
CREATE TABLE connected_systems (
  id             TEXT PRIMARY KEY,
  room_id        TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL,
  records_path   TEXT NOT NULL,
  base_url       TEXT NOT NULL,
  api_key_cipher TEXT,
  key_hint       TEXT,
  updated_at     INTEGER NOT NULL,
  -- 1 when each action an agent takes here waits for a person's approval.
  needs_approval INTEGER NOT NULL DEFAULT 0 CHECK (needs_approval IN (0, 1))
) STRICT;

-- Further rooms whose readers are shown a system's records. Acting in the
-- system still takes the room it is operated from.
CREATE TABLE system_shown_rooms (
  system_id TEXT NOT NULL REFERENCES connected_systems(id) ON DELETE CASCADE,
  room_id   TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  PRIMARY KEY (system_id, room_id)
) STRICT;

-- What can be done in a system, as the system itself lists it.
CREATE TABLE system_operations (
  system_id TEXT NOT NULL REFERENCES connected_systems(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  position  INTEGER NOT NULL,
  label     TEXT NOT NULL,
  method    TEXT NOT NULL CHECK (method IN ('POST', 'PUT', 'DELETE')),
  path      TEXT NOT NULL,
  -- The operation of the same system that this one takes back, if any.
  undoes    TEXT,
  PRIMARY KEY (system_id, operation)
) STRICT;

-- The values an operation takes. Each travels in the path or in the body.
CREATE TABLE system_operation_fields (
  system_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  name      TEXT NOT NULL,
  position  INTEGER NOT NULL,
  label     TEXT NOT NULL,
  hint      TEXT NOT NULL,
  place     TEXT NOT NULL CHECK (place IN ('path', 'body')),
  PRIMARY KEY (system_id, operation, name),
  FOREIGN KEY (system_id, operation) REFERENCES system_operations(system_id, operation) ON DELETE CASCADE
) STRICT;

CREATE INDEX systems_by_room ON connected_systems(room_id);

CREATE TABLE doors (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  to_room_id TEXT REFERENCES rooms(id),
  wall       TEXT NOT NULL CHECK (wall IN ('north', 'south', 'east', 'west')),
  along      REAL NOT NULL CHECK (along >= 0 AND along <= 1),
  width      REAL NOT NULL CHECK (width > 0),
  UNIQUE (room_id, position)
) STRICT;

CREATE TABLE desks (
  id       TEXT PRIMARY KEY,
  room_id  TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  x        REAL NOT NULL,
  z        REAL NOT NULL,
  facing   REAL NOT NULL
) STRICT;

-- Which room hosts each working stage of the pipeline.
CREATE TABLE stage_rooms (
  office_id TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  stage     TEXT NOT NULL CHECK (stage IN ('intake', 'planning', 'execution', 'review')),
  room_id   TEXT NOT NULL REFERENCES rooms(id),
  PRIMARY KEY (office_id, stage)
) STRICT;

-- ----------------------------------------------------------------- roles
CREATE TABLE roles (
  id          TEXT PRIMARY KEY,
  office_id   TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL
) STRICT;

-- What a role may do beyond working in rooms. One row per permission held.
CREATE TABLE role_permissions (
  role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('manage_access', 'reassign_work', 'decide_reviews', 'see_everything', 'invite_people',
                 'manage_people', 'manage_rooms', 'manage_roles', 'manage_providers', 'use_shared_providers',
                 'manage_office')),
  PRIMARY KEY (role_id, permission)
) STRICT;

CREATE TABLE role_grants (
  role_id  TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  room_id  TEXT REFERENCES rooms(id),
  effect   TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  PRIMARY KEY (role_id, position)
) STRICT;

CREATE TABLE role_grant_scopes (
  role_id  TEXT NOT NULL,
  position INTEGER NOT NULL,
  scope    TEXT NOT NULL CHECK (scope IN ('enter', 'read', 'act')),
  PRIMARY KEY (role_id, position, scope),
  FOREIGN KEY (role_id, position) REFERENCES role_grants(role_id, position) ON DELETE CASCADE
) STRICT;

-- ---------------------------------------------------------- participants
CREATE TABLE participants (
  id           TEXT PRIMARY KEY,
  office_id    TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  display_name TEXT NOT NULL,
  title        TEXT NOT NULL,
  role_id      TEXT NOT NULL REFERENCES roles(id),
  desk_id      TEXT UNIQUE REFERENCES desks(id),
  color        TEXT NOT NULL
) STRICT;

CREATE TABLE participant_capabilities (
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  capability     TEXT NOT NULL,
  PRIMARY KEY (participant_id, position)
) STRICT;

-- How each agent decides what to do: by asking a model through one of the
-- office's providers, or by following its playbook.
CREATE TABLE agent_settings (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  agent_type     TEXT NOT NULL CHECK (agent_type IN ('ai', 'playbook')),
  provider_id    TEXT REFERENCES ai_providers(id) ON DELETE SET NULL,
  model          TEXT
) STRICT;

-- A playbook is an ordered list of when-then steps. The when part lives on
-- the step. Each kind of then has its own table, present only when the step
-- does that thing. A NULL stage means any stage. A NULL requested_by means
-- anyone.
CREATE TABLE playbook_steps (
  id               TEXT PRIMARY KEY,
  participant_id   TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  stage            TEXT CHECK (stage IN ('intake', 'planning', 'execution', 'review')),
  request_contains TEXT NOT NULL,
  requested_by     TEXT REFERENCES participants(id) ON DELETE SET NULL,
  status_note      TEXT NOT NULL
) STRICT;

CREATE TABLE playbook_outputs (
  step_id TEXT PRIMARY KEY REFERENCES playbook_steps(id) ON DELETE CASCADE,
  label   TEXT NOT NULL,
  body    TEXT NOT NULL
) STRICT;

-- A NULL to_participant_id addresses the question to whoever filed the request.
CREATE TABLE playbook_questions (
  step_id           TEXT PRIMARY KEY REFERENCES playbook_steps(id) ON DELETE CASCADE,
  body              TEXT NOT NULL,
  to_participant_id TEXT REFERENCES participants(id) ON DELETE SET NULL,
  blocking          INTEGER NOT NULL CHECK (blocking IN (0, 1))
) STRICT;

CREATE TABLE playbook_question_options (
  step_id  TEXT NOT NULL REFERENCES playbook_questions(step_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  label    TEXT NOT NULL,
  PRIMARY KEY (step_id, position)
) STRICT;

CREATE TABLE playbook_assumptions (
  step_id    TEXT PRIMARY KEY REFERENCES playbook_steps(id) ON DELETE CASCADE,
  assumed    TEXT NOT NULL,
  because    TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high'))
) STRICT;

CREATE TABLE playbook_needs (
  step_id TEXT PRIMARY KEY REFERENCES playbook_steps(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  scope   TEXT NOT NULL CHECK (scope IN ('enter', 'read', 'act')),
  purpose TEXT NOT NULL
) STRICT;

CREATE INDEX playbook_by_agent ON playbook_steps(participant_id, position);

-- What a playbook step does in a connected system. system_id is not a foreign
-- key: a step keeps its action when the system is disconnected, and the
-- action is skipped until a system with that id exists again.
CREATE TABLE playbook_actions (
  step_id   TEXT PRIMARY KEY REFERENCES playbook_steps(id) ON DELETE CASCADE,
  system_id TEXT NOT NULL,
  operation TEXT NOT NULL
) STRICT;

CREATE TABLE playbook_action_fields (
  step_id TEXT NOT NULL REFERENCES playbook_actions(step_id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (step_id, name)
) STRICT;

-- What a playbook step tells one participant. A NULL recipient means whoever
-- filed the request.
CREATE TABLE playbook_notes (
  step_id           TEXT PRIMARY KEY REFERENCES playbook_steps(id) ON DELETE CASCADE,
  to_participant_id TEXT REFERENCES participants(id) ON DELETE CASCADE,
  body              TEXT NOT NULL
) STRICT;

-- ------------------------------------------------------------------ work
CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  office_id    TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  title        TEXT NOT NULL,
  detail       TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES participants(id),
  owner_id     TEXT REFERENCES participants(id),
  room_id      TEXT NOT NULL REFERENCES rooms(id),
  stage        TEXT NOT NULL CHECK (stage IN ('intake', 'planning', 'execution', 'review', 'done')),
  status       TEXT NOT NULL CHECK (status IN ('requested', 'in_progress', 'blocked_permission',
                 'blocked_question', 'in_review', 'completed', 'rejected')),
  created_at   INTEGER NOT NULL,
  closed_at    INTEGER,
  -- Set while the task waits for a day: when it ends, and what it waits for.
  wait_until   INTEGER,
  wait_reason  TEXT,
  -- 1 while the owner has been given the task and has not yet taken its step.
  step_owed    INTEGER NOT NULL DEFAULT 0 CHECK (step_owed IN (0, 1)),
  -- 1 when a person marked the task urgent, which puts it ahead on every queue.
  urgent       INTEGER NOT NULL DEFAULT 0 CHECK (urgent IN (0, 1)),
  -- 1 from a rejection until the task closes, while what it did in connected
  -- systems is being taken back or left on a person's word.
  wind_up      INTEGER NOT NULL DEFAULT 0 CHECK (wind_up IN (0, 1)),
  CHECK ((wait_until IS NULL) = (wait_reason IS NULL))
) STRICT;

-- Text documents attached to a task, in the order they were added.
CREATE TABLE task_documents (
  id        TEXT PRIMARY KEY,
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  name      TEXT NOT NULL,
  body      TEXT NOT NULL,
  added_by  TEXT NOT NULL REFERENCES participants(id),
  added_at  INTEGER NOT NULL,
  UNIQUE (task_id, position)
) STRICT;

-- Requests the office files by itself on a rhythm, in the name of whoever set
-- them up. last_task_id is the task it filed last, kept so that it is not
-- filed again while that one is still open.
CREATE TABLE standing_requests (
  id            TEXT PRIMARY KEY,
  office_id     TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  title         TEXT NOT NULL,
  detail        TEXT NOT NULL,
  urgent        INTEGER NOT NULL DEFAULT 0 CHECK (urgent IN (0, 1)),
  every         TEXT NOT NULL CHECK (every IN ('day', 'weekday', 'week')),
  next_at       INTEGER NOT NULL,
  created_by    TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  last_task_id  TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  last_filed_at INTEGER,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
) STRICT;

-- What an agent has been given and has not finished: taking its step on a
-- task, or looking at a note. A row is written when the work is handed out
-- and removed when it is done, so it can be found again after a failure or a
-- restart. A task with a row here is not handed on to the next stage.
CREATE TABLE pending_work (
  office_id      TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('resume', 'attend')),
  -- The note an agent is to look at. Empty when it takes its own step.
  note_id        TEXT NOT NULL DEFAULT '',
  after_action   INTEGER NOT NULL DEFAULT 0 CHECK (after_action IN (0, 1)),
  tries          INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (participant_id, task_id, kind, note_id)
) STRICT;

-- ---------------------------------------------------------------- access
CREATE TABLE access_rules (
  id                 TEXT PRIMARY KEY,
  participant_id     TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  position           INTEGER NOT NULL,
  room_id            TEXT REFERENCES rooms(id),
  effect             TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  reason             TEXT NOT NULL CHECK (length(reason) > 0),
  granted_by         TEXT NOT NULL REFERENCES participants(id),
  granted_at         INTEGER NOT NULL,
  expires_at         INTEGER,
  expires_on_task_id TEXT REFERENCES tasks(id)
) STRICT;

CREATE TABLE access_rule_scopes (
  rule_id TEXT NOT NULL REFERENCES access_rules(id) ON DELETE CASCADE,
  scope   TEXT NOT NULL CHECK (scope IN ('enter', 'read', 'act')),
  PRIMARY KEY (rule_id, scope)
) STRICT;

-- A resolved access decision, kept as evidence on escalations and task events.
CREATE TABLE access_decisions (
  id             TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL REFERENCES participants(id),
  room_id        TEXT NOT NULL REFERENCES rooms(id),
  scope          TEXT NOT NULL CHECK (scope IN ('enter', 'read', 'act')),
  effect         TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  explanation    TEXT NOT NULL
) STRICT;

-- Position 0 is the source that decided. The rest lost, in precedence order.
-- rule_id has no foreign key on purpose: the rule may have been revoked since.
CREATE TABLE access_decision_sources (
  decision_id    TEXT NOT NULL REFERENCES access_decisions(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('individual', 'role', 'default')),
  effect         TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  rule_id        TEXT,
  role_id        TEXT REFERENCES roles(id),
  grant_position INTEGER,
  PRIMARY KEY (decision_id, position)
) STRICT;

-- -------------------------------------------------------------- messages
CREATE TABLE messages (
  id                      TEXT PRIMARY KEY,
  office_id               TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  position                INTEGER NOT NULL,
  kind                    TEXT NOT NULL CHECK (kind IN ('request', 'assignment', 'question', 'answer',
                            'assumption', 'status', 'handoff', 'escalation', 'decision', 'output', 'note')),
  task_id                 TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_participant_id     TEXT REFERENCES participants(id),
  audience                TEXT NOT NULL CHECK (audience IN ('participant', 'room', 'everyone')),
  audience_participant_id TEXT REFERENCES participants(id),
  audience_room_id        TEXT REFERENCES rooms(id),
  room_id                 TEXT NOT NULL REFERENCES rooms(id),
  at                      INTEGER NOT NULL,
  in_reply_to             TEXT REFERENCES messages(id),
  body                    TEXT NOT NULL,
  CHECK ((audience = 'participant') = (audience_participant_id IS NOT NULL)),
  CHECK ((audience = 'room') = (audience_room_id IS NOT NULL))
) STRICT;

CREATE TABLE message_assignments (
  message_id        TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  to_participant_id TEXT NOT NULL REFERENCES participants(id)
) STRICT;

CREATE TABLE message_questions (
  message_id             TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  blocking               INTEGER NOT NULL CHECK (blocking IN (0, 1)),
  answered_by_message_id TEXT REFERENCES messages(id)
) STRICT;

CREATE TABLE message_question_options (
  message_id TEXT NOT NULL REFERENCES message_questions(message_id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  label      TEXT NOT NULL,
  PRIMARY KEY (message_id, position)
) STRICT;

-- The action a question asks approval for. Present only on such questions.
CREATE TABLE message_held_actions (
  message_id TEXT PRIMARY KEY REFERENCES message_questions(message_id) ON DELETE CASCADE,
  system_id  TEXT NOT NULL,
  operation  TEXT NOT NULL
) STRICT;

CREATE TABLE message_held_action_fields (
  message_id TEXT NOT NULL REFERENCES message_held_actions(message_id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  value      TEXT NOT NULL,
  PRIMARY KEY (message_id, name)
) STRICT;

CREATE TABLE message_answers (
  message_id    TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  question_id   TEXT NOT NULL REFERENCES messages(id),
  chosen_option TEXT
) STRICT;

CREATE TABLE message_assumptions (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  assumed    TEXT NOT NULL,
  because    TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  status     TEXT NOT NULL CHECK (status IN ('open', 'confirmed', 'contradicted'))
) STRICT;

-- Tasks that rest on an assumption and halt if it is contradicted.
CREATE TABLE message_assumption_tasks (
  message_id TEXT NOT NULL REFERENCES message_assumptions(message_id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, task_id)
) STRICT;

CREATE TABLE message_progress (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  progress   REAL NOT NULL CHECK (progress >= 0 AND progress <= 1)
) STRICT;

-- What a connected system answered to an action, on the status line that
-- reports it. system_id is not a reference: the record of what was done has
-- to outlive the connection. record is the number the system gave.
CREATE TABLE message_system_results (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  system_id  TEXT NOT NULL,
  operation  TEXT NOT NULL,
  ok         INTEGER NOT NULL CHECK (ok IN (0, 1)),
  record     TEXT
) STRICT;

CREATE TABLE message_handoffs (
  message_id          TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  from_participant_id TEXT NOT NULL REFERENCES participants(id),
  to_participant_id   TEXT NOT NULL REFERENCES participants(id),
  to_room_id          TEXT NOT NULL REFERENCES rooms(id)
) STRICT;

CREATE TABLE message_escalations (
  message_id         TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  cause              TEXT NOT NULL CHECK (cause IN ('permission', 'ambiguity', 'policy', 'error')),
  denied_decision_id TEXT REFERENCES access_decisions(id)
) STRICT;

CREATE TABLE message_verdicts (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  verdict    TEXT NOT NULL CHECK (verdict IN ('approved', 'rejected', 'changes_requested'))
) STRICT;

CREATE TABLE message_outputs (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  simulated  INTEGER NOT NULL CHECK (simulated IN (0, 1))
) STRICT;

-- ---------------------------------------------------- task detail tables
CREATE TABLE task_events (
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  summary     TEXT NOT NULL,
  message_id  TEXT REFERENCES messages(id),
  decision_id TEXT REFERENCES access_decisions(id),
  PRIMARY KEY (task_id, position)
) STRICT;

CREATE TABLE task_open_questions (
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id),
  PRIMARY KEY (task_id, message_id)
) STRICT;

CREATE TABLE task_assumptions (
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id),
  PRIMARY KEY (task_id, message_id)
) STRICT;

-- -------------------------------------------------------------- accounts
-- A user is a sign-in. It is separate from any office. A NULL password hash
-- means no password has been set, so password sign-in is refused: that is
-- what a demo account is.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  display_name  TEXT NOT NULL,
  created_at    INTEGER NOT NULL
) STRICT;

-- A user's seat in an office: the human participant they are there. A user
-- may hold a seat in many offices. A participant belongs to at most one user.
CREATE TABLE memberships (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX memberships_by_user ON memberships(user_id);

-- One row per issued session token. Signing out or revoking sets revoked_at.
-- participant_id is the seat, and so the office, the session is looking at.
CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_at      INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  revoked_at     INTEGER,
  participant_id TEXT REFERENCES participants(id) ON DELETE SET NULL
) STRICT;

CREATE TABLE invites (
  id             TEXT PRIMARY KEY,
  token_hash     TEXT NOT NULL UNIQUE,
  participant_id TEXT NOT NULL UNIQUE REFERENCES participants(id) ON DELETE CASCADE,
  created_by     TEXT NOT NULL REFERENCES participants(id),
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  accepted_at    INTEGER
) STRICT;

-- A scoped permission token: proof that one participant may use one scope on
-- one room, issued when an access rule is granted and dead when it is revoked.
CREATE TABLE access_tokens (
  id             TEXT PRIMARY KEY,
  rule_id        TEXT NOT NULL REFERENCES access_rules(id) ON DELETE CASCADE,
  scope          TEXT NOT NULL CHECK (scope IN ('enter', 'read', 'act')),
  issued_at      INTEGER NOT NULL,
  expires_at     INTEGER,
  revoked_at     INTEGER,
  last_used_at   INTEGER,
  FOREIGN KEY (rule_id, scope) REFERENCES access_rule_scopes(rule_id, scope) ON DELETE CASCADE
) STRICT;

-- ----------------------------------------------------------------- audit
-- Every action anyone takes, in order. Never updated, never deleted.
CREATE TABLE audit_log (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  office_id              TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  recorded_at            INTEGER NOT NULL,
  office_clock_ms        INTEGER NOT NULL,
  actor_participant_id   TEXT NOT NULL REFERENCES participants(id),
  action_type            TEXT NOT NULL,
  task_id                TEXT,
  subject_participant_id TEXT,
  rule_id                TEXT,
  room_id                TEXT
) STRICT;

CREATE TABLE audit_notes (
  audit_id INTEGER NOT NULL REFERENCES audit_log(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  note     TEXT NOT NULL,
  PRIMARY KEY (audit_id, position)
) STRICT;

CREATE INDEX messages_by_task       ON messages(task_id, position);
CREATE INDEX rules_by_participant   ON access_rules(participant_id);
-- What two participants have said to each other directly: a person to a
-- person, or a person and an agent at the agent's desk. Not part of any task,
-- and readable only by the two of them.
CREATE TABLE direct_messages (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  to_id   TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  body    TEXT NOT NULL,
  at      INTEGER NOT NULL,
  CHECK (from_id <> to_id)
) STRICT;

CREATE INDEX direct_by_sender    ON direct_messages(from_id, id);
CREATE INDEX direct_by_recipient ON direct_messages(to_id, id);

-- How far each participant has read in each of their conversations.
CREATE TABLE direct_reads (
  reader_id    TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  other_id     TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL,
  PRIMARY KEY (reader_id, other_id)
) STRICT;

-- Notes in task threads that the person they were addressed to has opened.
CREATE TABLE note_reads (
  reader_id  TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY (reader_id, message_id)
) STRICT;

CREATE INDEX sessions_by_user       ON sessions(user_id);
CREATE INDEX audit_by_office        ON audit_log(office_id, id);
CREATE INDEX tokens_by_rule         ON access_tokens(rule_id);
`;

/**
 * Steps that bring an older database up to date. Entry N turns a version N
 * database into version N + 1. A new database is created at the current
 * version directly and runs none of these.
 */
export const MIGRATIONS: Record<number, string> = {
  // Version 2 moved the stage-to-room mapping out of the code. Offices created
  // before that all used the seeded rooms, so they keep the same mapping.
  1: /* sql */ `
CREATE TABLE stage_rooms (
  office_id TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  stage     TEXT NOT NULL CHECK (stage IN ('intake', 'planning', 'execution', 'review')),
  room_id   TEXT NOT NULL REFERENCES rooms(id),
  PRIMARY KEY (office_id, stage)
) STRICT;

INSERT INTO stage_rooms (office_id, stage, room_id)
SELECT o.id, m.stage, m.room_id
  FROM offices o
  JOIN (SELECT 'intake' AS stage, 'reception' AS room_id
        UNION ALL SELECT 'planning', 'planning'
        UNION ALL SELECT 'execution', 'fulfilment'
        UNION ALL SELECT 'review', 'finance') m
  JOIN rooms r ON r.id = m.room_id;
`,

  // Version 3 made room for many offices. A sign-in is no longer tied to one
  // participant: users lose that column and gain a display name, each seat
  // becomes a row in memberships, and a session remembers which seat it is
  // looking at. Offices gain an id scope and their own AI settings.
  2: /* sql */ `
CREATE TABLE users_new (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  display_name  TEXT NOT NULL,
  created_at    INTEGER NOT NULL
) STRICT;

INSERT INTO users_new (id, email, password_hash, display_name, created_at)
SELECT u.id, u.email, u.password_hash, COALESCE(p.display_name, u.email), u.created_at
  FROM users u LEFT JOIN participants p ON p.id = u.participant_id;

CREATE TABLE memberships (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
) STRICT;

INSERT INTO memberships (participant_id, user_id) SELECT participant_id, id FROM users;

ALTER TABLE sessions ADD COLUMN participant_id TEXT REFERENCES participants(id) ON DELETE SET NULL;
UPDATE sessions
   SET participant_id = (SELECT u.participant_id FROM users u WHERE u.id = sessions.user_id);

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE INDEX memberships_by_user ON memberships(user_id);

ALTER TABLE offices ADD COLUMN id_scope TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX offices_by_scope ON offices(id_scope);

CREATE TABLE office_ai (
  office_id      TEXT PRIMARY KEY REFERENCES offices(id) ON DELETE CASCADE,
  runtime        TEXT NOT NULL CHECK (runtime IN ('scripted', 'model')),
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  api_key_cipher TEXT,
  key_hint       TEXT,
  updated_at     INTEGER NOT NULL
) STRICT;
`,

  // Version 4 made agents configurable. Roles trade the single supervising
  // flag for a row per permission. An office gets a list of AI providers in
  // place of one setting, each agent records whether it asks a model or
  // follows a playbook, and playbooks get their own tables.
  3: /* sql */ `
CREATE TABLE roles_new (
  id          TEXT PRIMARY KEY,
  office_id   TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL
) STRICT;
INSERT INTO roles_new (id, office_id, position, name, description)
SELECT id, office_id, position, name, description FROM roles;

-- What a role may do beyond working in rooms. One row per permission held.
CREATE TABLE role_permissions (
  role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('manage_access', 'reassign_work', 'decide_reviews', 'see_everything', 'invite_people',
                 'manage_people', 'manage_rooms', 'manage_roles', 'manage_providers', 'manage_office')),
  PRIMARY KEY (role_id, permission)
) STRICT;

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
  FROM roles r
  JOIN (SELECT 'manage_access' AS permission UNION ALL SELECT 'reassign_work'
        UNION ALL SELECT 'decide_reviews' UNION ALL SELECT 'see_everything'
        UNION ALL SELECT 'invite_people' UNION ALL SELECT 'manage_people'
        UNION ALL SELECT 'manage_rooms' UNION ALL SELECT 'manage_roles'
        UNION ALL SELECT 'manage_providers' UNION ALL SELECT 'manage_office') p
 WHERE r.supervises = 1;

DROP TABLE roles;
ALTER TABLE roles_new RENAME TO roles;

-- The AI providers an office has connected. An office may have several. The
-- API key is stored encrypted and is never sent back to a browser; key_hint
-- keeps its last characters for display.
CREATE TABLE ai_providers (
  id             TEXT PRIMARY KEY,
  office_id      TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('anthropic', 'openai_compatible')),
  base_url       TEXT,
  default_model  TEXT NOT NULL,
  api_key_cipher TEXT,
  key_hint       TEXT,
  updated_at     INTEGER NOT NULL
) STRICT;

INSERT INTO ai_providers
  (id, office_id, position, name, kind, base_url, default_model, api_key_cipher, key_hint, updated_at)
SELECT 'prov-' || office_id, office_id, 0, 'Anthropic', 'anthropic', NULL, model,
       api_key_cipher, key_hint, updated_at
  FROM office_ai
 WHERE api_key_cipher IS NOT NULL;

-- How each agent decides what to do: by asking a model through one of the
-- office's providers, or by following its playbook.
CREATE TABLE agent_settings (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  agent_type     TEXT NOT NULL CHECK (agent_type IN ('ai', 'playbook')),
  provider_id    TEXT REFERENCES ai_providers(id) ON DELETE SET NULL,
  model          TEXT
) STRICT;

-- A playbook is an ordered list of when-then steps. The when part lives on
-- the step. Each kind of then has its own table, present only when the step
-- does that thing. A NULL stage means any stage. A NULL requested_by means
-- anyone.
CREATE TABLE playbook_steps (
  id               TEXT PRIMARY KEY,
  participant_id   TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  stage            TEXT CHECK (stage IN ('intake', 'planning', 'execution', 'review')),
  request_contains TEXT NOT NULL,
  requested_by     TEXT REFERENCES participants(id) ON DELETE SET NULL,
  status_note      TEXT NOT NULL
) STRICT;

CREATE TABLE playbook_outputs (
  step_id TEXT PRIMARY KEY REFERENCES playbook_steps(id) ON DELETE CASCADE,
  label   TEXT NOT NULL,
  body    TEXT NOT NULL
) STRICT;

-- A NULL to_participant_id addresses the question to whoever filed the request.
CREATE TABLE playbook_questions (
  step_id           TEXT PRIMARY KEY REFERENCES playbook_steps(id) ON DELETE CASCADE,
  body              TEXT NOT NULL,
  to_participant_id TEXT REFERENCES participants(id) ON DELETE SET NULL,
  blocking          INTEGER NOT NULL CHECK (blocking IN (0, 1))
) STRICT;

CREATE TABLE playbook_question_options (
  step_id  TEXT NOT NULL REFERENCES playbook_questions(step_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  label    TEXT NOT NULL,
  PRIMARY KEY (step_id, position)
) STRICT;

CREATE TABLE playbook_assumptions (
  step_id    TEXT PRIMARY KEY REFERENCES playbook_steps(id) ON DELETE CASCADE,
  assumed    TEXT NOT NULL,
  because    TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high'))
) STRICT;

CREATE TABLE playbook_needs (
  step_id TEXT PRIMARY KEY REFERENCES playbook_steps(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  scope   TEXT NOT NULL CHECK (scope IN ('enter', 'read', 'act')),
  purpose TEXT NOT NULL
) STRICT;

CREATE INDEX playbook_by_agent ON playbook_steps(participant_id, position);

INSERT INTO agent_settings (participant_id, agent_type, provider_id, model)
SELECT p.id,
       CASE WHEN a.runtime = 'model' AND a.api_key_cipher IS NOT NULL THEN 'ai' ELSE 'playbook' END,
       CASE WHEN a.runtime = 'model' AND a.api_key_cipher IS NOT NULL THEN 'prov-' || p.office_id END,
       NULL
  FROM participants p LEFT JOIN office_ai a ON a.office_id = p.office_id
 WHERE p.kind = 'agent';

DROP TABLE office_ai;
DROP TABLE agent_backings;
`,
  // Version 5 added room records, connected systems and playbook actions.
  4: /* sql */ `
-- Facts kept in a room, one sentence each, in the order they are listed.
CREATE TABLE room_records (
  room_id  TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  body     TEXT NOT NULL,
  PRIMARY KEY (room_id, position)
) STRICT;

-- An outside system connected to a room. The room's access rules cover it:
-- read on the room shows its records, act on the room allows its operations.
-- The API key is stored encrypted, as for AI providers.
CREATE TABLE connected_systems (
  id             TEXT PRIMARY KEY,
  room_id        TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('storefront', 'carrier')),
  base_url       TEXT NOT NULL,
  api_key_cipher TEXT,
  key_hint       TEXT,
  updated_at     INTEGER NOT NULL
) STRICT;

CREATE INDEX systems_by_room ON connected_systems(room_id);

-- What a playbook step does in a connected system. system_id is not a foreign
-- key: a step keeps its action when the system is disconnected, and the
-- action is skipped until a system with that id exists again.
CREATE TABLE playbook_actions (
  step_id   TEXT PRIMARY KEY REFERENCES playbook_steps(id) ON DELETE CASCADE,
  system_id TEXT NOT NULL,
  operation TEXT NOT NULL
) STRICT;

CREATE TABLE playbook_action_fields (
  step_id TEXT NOT NULL REFERENCES playbook_actions(step_id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (step_id, name)
) STRICT;
`,
  // Version 6 added conversations between a person and an agent.
  5: /* sql */ `
-- What a person and an agent have said to each other at the agent's desk.
-- A conversation belongs to that pair and is not part of any task.
CREATE TABLE chat_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  person_id  TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  from_agent INTEGER NOT NULL CHECK (from_agent IN (0, 1)),
  body       TEXT NOT NULL,
  at         INTEGER NOT NULL
) STRICT;

CREATE INDEX chat_by_pair ON chat_messages(person_id, agent_id, id);
`,
  // Version 7 added notes, direct messages between any two participants, and read state.
  6: /* sql */ `
-- A message kind is added, which means rebuilding the table to change its check.
CREATE TABLE messages_new (
  id                      TEXT PRIMARY KEY,
  office_id               TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  position                INTEGER NOT NULL,
  kind                    TEXT NOT NULL CHECK (kind IN ('request', 'assignment', 'question', 'answer',
                            'assumption', 'status', 'handoff', 'escalation', 'decision', 'output', 'note')),
  task_id                 TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_participant_id     TEXT REFERENCES participants(id),
  audience                TEXT NOT NULL CHECK (audience IN ('participant', 'room', 'everyone')),
  audience_participant_id TEXT REFERENCES participants(id),
  audience_room_id        TEXT REFERENCES rooms(id),
  room_id                 TEXT NOT NULL REFERENCES rooms(id),
  at                      INTEGER NOT NULL,
  in_reply_to             TEXT REFERENCES messages(id),
  body                    TEXT NOT NULL,
  CHECK ((audience = 'participant') = (audience_participant_id IS NOT NULL)),
  CHECK ((audience = 'room') = (audience_room_id IS NOT NULL))
) STRICT;
INSERT INTO messages_new SELECT * FROM messages;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE INDEX messages_by_task ON messages(task_id, position);

-- What two participants have said to each other directly: a person to a
-- person, or a person and an agent at the agent's desk. Not part of any task,
-- and readable only by the two of them.
CREATE TABLE direct_messages (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  to_id   TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  body    TEXT NOT NULL,
  at      INTEGER NOT NULL,
  CHECK (from_id <> to_id)
) STRICT;

CREATE INDEX direct_by_sender    ON direct_messages(from_id, id);
CREATE INDEX direct_by_recipient ON direct_messages(to_id, id);

-- How far each participant has read in each of their conversations.
CREATE TABLE direct_reads (
  reader_id    TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  other_id     TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL,
  PRIMARY KEY (reader_id, other_id)
) STRICT;

-- Notes in task threads that the person they were addressed to has opened.
CREATE TABLE note_reads (
  reader_id  TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY (reader_id, message_id)
) STRICT;

INSERT INTO direct_messages (from_id, to_id, body, at)
SELECT CASE WHEN from_agent = 1 THEN agent_id ELSE person_id END,
       CASE WHEN from_agent = 1 THEN person_id ELSE agent_id END,
       body, at
  FROM chat_messages ORDER BY id;
DROP TABLE chat_messages;

-- Those conversations were all read when they were held.
INSERT INTO direct_reads (reader_id, other_id, last_read_id)
SELECT to_id, from_id, MAX(id) FROM direct_messages GROUP BY to_id, from_id;

-- What a playbook step tells one participant. A NULL recipient means whoever
-- filed the request.
CREATE TABLE playbook_notes (
  step_id           TEXT PRIMARY KEY REFERENCES playbook_steps(id) ON DELETE CASCADE,
  to_participant_id TEXT REFERENCES participants(id) ON DELETE CASCADE,
  body              TEXT NOT NULL
) STRICT;
`,
  // Version 8 added approval for actions in a connected system.
  7: /* sql */ `
ALTER TABLE connected_systems ADD COLUMN needs_approval INTEGER NOT NULL DEFAULT 0 CHECK (needs_approval IN (0, 1));

-- The action a question asks approval for. Present only on such questions.
CREATE TABLE message_held_actions (
  message_id TEXT PRIMARY KEY REFERENCES message_questions(message_id) ON DELETE CASCADE,
  system_id  TEXT NOT NULL,
  operation  TEXT NOT NULL
) STRICT;

CREATE TABLE message_held_action_fields (
  message_id TEXT NOT NULL REFERENCES message_held_actions(message_id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  value      TEXT NOT NULL,
  PRIMARY KEY (message_id, name)
) STRICT;
`,
  // Version 9 added the hand-on setting, a permission, and providers that belong to an account.
  8: /* sql */ `
ALTER TABLE offices ADD COLUMN auto_handoff INTEGER NOT NULL DEFAULT 0 CHECK (auto_handoff IN (0, 1));
UPDATE offices SET auto_handoff = 1 WHERE id = 'office-distributor-demo';

-- A permission is added, which means rebuilding the table to change its check.
CREATE TABLE role_permissions_new (
  role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('manage_access', 'reassign_work', 'decide_reviews', 'see_everything', 'invite_people',
                 'manage_people', 'manage_rooms', 'manage_roles', 'manage_providers', 'use_shared_providers',
                 'manage_office')),
  PRIMARY KEY (role_id, permission)
) STRICT;
INSERT INTO role_permissions_new SELECT * FROM role_permissions;
DROP TABLE role_permissions;
ALTER TABLE role_permissions_new RENAME TO role_permissions;
-- Whoever could manage providers could already give any of them to an agent.
INSERT INTO role_permissions (role_id, permission)
SELECT role_id, 'use_shared_providers' FROM role_permissions WHERE permission = 'manage_providers';

-- A provider may now belong to an account in place of an office.
CREATE TABLE ai_providers_new (
  id             TEXT PRIMARY KEY,
  office_id      TEXT REFERENCES offices(id) ON DELETE CASCADE,
  owner_user_id  TEXT REFERENCES users(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('anthropic', 'openai_compatible')),
  base_url       TEXT,
  default_model  TEXT NOT NULL,
  api_key_cipher TEXT,
  key_hint       TEXT,
  updated_at     INTEGER NOT NULL,
  CHECK ((office_id IS NULL) <> (owner_user_id IS NULL))
) STRICT;
INSERT INTO ai_providers_new
  (id, office_id, owner_user_id, position, name, kind, base_url, default_model, api_key_cipher, key_hint, updated_at)
SELECT id, office_id, NULL, position, name, kind, base_url, default_model, api_key_cipher, key_hint, updated_at
  FROM ai_providers;
DROP TABLE ai_providers;
ALTER TABLE ai_providers_new RENAME TO ai_providers;
`,
  // Version 10 lets a connected system describe itself, in place of a fixed list of kinds.
  9: /* sql */ `
CREATE TABLE system_operations (
  system_id TEXT NOT NULL REFERENCES connected_systems(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  position  INTEGER NOT NULL,
  label     TEXT NOT NULL,
  method    TEXT NOT NULL CHECK (method IN ('POST', 'PUT', 'DELETE')),
  path      TEXT NOT NULL,
  PRIMARY KEY (system_id, operation)
) STRICT;

CREATE TABLE system_operation_fields (
  system_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  name      TEXT NOT NULL,
  position  INTEGER NOT NULL,
  label     TEXT NOT NULL,
  hint      TEXT NOT NULL,
  place     TEXT NOT NULL CHECK (place IN ('path', 'body')),
  PRIMARY KEY (system_id, operation, name),
  FOREIGN KEY (system_id, operation) REFERENCES system_operations(system_id, operation) ON DELETE CASCADE
) STRICT;

-- Systems already connected were one of two kinds. Each gets what that kind could do.
${operationsForKind("storefront", STOREFRONT)}
${operationsForKind("carrier", CARRIER)}

CREATE TABLE connected_systems_new (
  id             TEXT PRIMARY KEY,
  room_id        TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL,
  records_path   TEXT NOT NULL,
  base_url       TEXT NOT NULL,
  api_key_cipher TEXT,
  key_hint       TEXT,
  updated_at     INTEGER NOT NULL,
  needs_approval INTEGER NOT NULL DEFAULT 0 CHECK (needs_approval IN (0, 1))
) STRICT;
INSERT INTO connected_systems_new
  (id, room_id, position, name, description, records_path, base_url, api_key_cipher, key_hint, updated_at, needs_approval)
SELECT id, room_id, position, name,
       CASE kind WHEN 'storefront' THEN ${quoted(STOREFRONT.description)} ELSE ${quoted(CARRIER.description)} END,
       CASE kind WHEN 'storefront' THEN ${quoted(STOREFRONT.recordsPath)} ELSE ${quoted(CARRIER.recordsPath)} END,
       base_url, api_key_cipher, key_hint, updated_at, needs_approval
  FROM connected_systems;
DROP TABLE connected_systems;
ALTER TABLE connected_systems_new RENAME TO connected_systems;
CREATE INDEX systems_by_room ON connected_systems(room_id);
`,
  // Version 11 marks corridors. The demo's hall, and the hall of every office
  // made from it, was one all along.
  10: /* sql */ `
ALTER TABLE rooms ADD COLUMN corridor INTEGER NOT NULL DEFAULT 0 CHECK (corridor IN (0, 1));
UPDATE rooms SET corridor = 1 WHERE id = 'hall' OR id LIKE 'hall-%';
`,
  // Version 12 lets a system's records be shown in rooms other than the one
  // it is operated from.
  11: /* sql */ `
-- Further rooms whose readers are shown a system's records. Acting in the
-- system still takes the room it is operated from.
CREATE TABLE system_shown_rooms (
  system_id TEXT NOT NULL REFERENCES connected_systems(id) ON DELETE CASCADE,
  room_id   TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  PRIMARY KEY (system_id, room_id)
) STRICT;
`,
  // Version 13 lets a task wait for a day.
  12: /* sql */ `
ALTER TABLE tasks ADD COLUMN wait_until INTEGER;
ALTER TABLE tasks ADD COLUMN wait_reason TEXT;
`,
  // Version 14 records that a task's owner still owes its step.
  13: /* sql */ `
ALTER TABLE tasks ADD COLUMN step_owed INTEGER NOT NULL DEFAULT 0 CHECK (step_owed IN (0, 1));
`,
  // Version 15 lets a person mark a task urgent.
  14: /* sql */ `
ALTER TABLE tasks ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0 CHECK (urgent IN (0, 1));
`,
  // Version 16 writes down what each agent has been given, until it is done.
  15: /* sql */ `
-- What an agent has been given and has not finished: taking its step on a
-- task, or looking at a note. A row is written when the work is handed out
-- and removed when it is done, so it can be found again after a failure or a
-- restart. A task with a row here is not handed on to the next stage.
CREATE TABLE pending_work (
  office_id      TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('resume', 'attend')),
  -- The note an agent is to look at. Empty when it takes its own step.
  note_id        TEXT NOT NULL DEFAULT '',
  after_action   INTEGER NOT NULL DEFAULT 0 CHECK (after_action IN (0, 1)),
  tries          INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (participant_id, task_id, kind, note_id)
) STRICT;
`,
  // Version 17 lets a task carry text documents.
  16: /* sql */ `
-- Text documents attached to a task, in the order they were added.
CREATE TABLE task_documents (
  id        TEXT PRIMARY KEY,
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  name      TEXT NOT NULL,
  body      TEXT NOT NULL,
  added_by  TEXT NOT NULL REFERENCES participants(id),
  added_at  INTEGER NOT NULL,
  UNIQUE (task_id, position)
) STRICT;
`,
  // Version 18 adds requests the office files by itself on a rhythm.
  17: /* sql */ `
-- Requests the office files by itself on a rhythm, in the name of whoever set
-- them up. last_task_id is the task it filed last, kept so that it is not
-- filed again while that one is still open.
CREATE TABLE standing_requests (
  id            TEXT PRIMARY KEY,
  office_id     TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  title         TEXT NOT NULL,
  detail        TEXT NOT NULL,
  urgent        INTEGER NOT NULL DEFAULT 0 CHECK (urgent IN (0, 1)),
  every         TEXT NOT NULL CHECK (every IN ('day', 'weekday', 'week')),
  next_at       INTEGER NOT NULL,
  created_by    TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  last_task_id  TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  last_filed_at INTEGER,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
) STRICT;
`,
  // Version 19 records what each system action did, so that a rejected task
  // can have what it did taken back.
  18: /* sql */ `
ALTER TABLE system_operations ADD COLUMN undoes TEXT;
ALTER TABLE tasks ADD COLUMN wind_up INTEGER NOT NULL DEFAULT 0 CHECK (wind_up IN (0, 1));
-- What a connected system answered to an action, on the status line that
-- reports it. system_id is not a reference: the record of what was done has
-- to outlive the connection. record is the number the system gave.
CREATE TABLE message_system_results (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  system_id  TEXT NOT NULL,
  operation  TEXT NOT NULL,
  ok         INTEGER NOT NULL CHECK (ok IN (0, 1)),
  record     TEXT
) STRICT;
`,
};
