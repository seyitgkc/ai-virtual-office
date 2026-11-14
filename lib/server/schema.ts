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

export const SCHEMA_VERSION = 1;

export const SCHEMA = /* sql */ `
CREATE TABLE schema_meta (
  version INTEGER NOT NULL
) STRICT;

-- ---------------------------------------------------------------- office
CREATE TABLE offices (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  clock_ms           INTEGER NOT NULL,
  clock_step_minutes INTEGER NOT NULL,
  id_sequence        INTEGER NOT NULL
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
  UNIQUE (floorplan_id, position)
) STRICT;

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

-- ----------------------------------------------------------------- roles
CREATE TABLE roles (
  id          TEXT PRIMARY KEY,
  office_id   TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  supervises  INTEGER NOT NULL CHECK (supervises IN (0, 1))
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

-- An agent with no row here is simulated.
CREATE TABLE agent_backings (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL
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
  closed_at    INTEGER
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
                            'assumption', 'status', 'handoff', 'escalation', 'decision', 'output')),
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
-- A user is the login for one human participant. A NULL password hash means
-- no password has been set, so password sign-in is refused for that account.
CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL UNIQUE REFERENCES participants(id) ON DELETE CASCADE,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT,
  created_at     INTEGER NOT NULL
) STRICT;

-- One row per issued session token. Signing out or revoking sets revoked_at.
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
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
CREATE INDEX sessions_by_user       ON sessions(user_id);
CREATE INDEX audit_by_office        ON audit_log(office_id, id);
CREATE INDEX tokens_by_rule         ON access_tokens(rule_id);
`;
