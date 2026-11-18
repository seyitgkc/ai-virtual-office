# Database

Part of the documentation of the [AI Virtual Office](../README.md).

SQLite, one file, 66 tables. One database holds many offices. The schema is in
third normal form:

- Every column holds one value. Lists such as scopes, capabilities and
  question options are rows in child tables. There are no JSON or delimited
  columns.
- Every fact is stored once. A desk's occupant lives only in
  `participants.desk_id`, and a room's desks only in `desks.room_id`, though
  the in-memory model carries both directions for convenience.
- No column depends on another non-key column. A permission token stores
  only its rule and scope. The holder and the room are read through the rule.
- Each message kind has its own table. The eleven kinds carry different
  fields, so the shared part lives in `messages` and the rest in a detail
  table keyed by the message id.
- A NULL room on a grant or rule means every room.
- Schema changes are migrations. An older database is brought forward on
  open, one version at a time, each step in its own transaction.
- `position` columns record order. Rules and grants are evaluated in
  sequence and threads are read in sequence, so order is data.

The store rebuilds the engine's state from these tables and writes back only
what an action changed. The engine never mutates, so anything that is still
the same object as before is left alone.

Two tables stand apart from the diagrams below. `schema_meta` holds one row,
the version of the schema, which is 23. `briefings` holds at most one row
per office: the briefing a model last wrote for it, the model's name, the
time, and a fingerprint of the work list it was written for. It is not part
of the engine's state. A briefing is shown only while the office's work list
still gives the same fingerprint.

The diagrams draw 48 of the tables and name the rest in the text beside
them. To stay readable they leave out some columns that only keep order or
time, such as `position`, `office_id` and `created_at`. The schema in
`lib/server/schema.ts` has every column.

## Office, people and access

```mermaid
erDiagram
  offices ||--|| floorplans : has
  floorplans ||--o{ rooms : contains
  rooms ||--o{ doors : has
  rooms ||--o{ room_records : keeps
  rooms ||--o{ connected_systems : "is connected to"
  connected_systems ||--o{ system_operations : offers
  connected_systems ||--o{ system_shown_rooms : "is also shown in"
  rooms ||--o{ system_shown_rooms : shows
  system_operations ||--o{ system_operation_fields : takes
  rooms ||--o{ desks : holds
  rooms ||--o{ stage_rooms : hosts
  offices ||--o{ stage_rooms : maps
  offices ||--o{ roles : defines
  roles ||--o{ role_permissions : carries
  roles ||--o{ role_grants : grants
  role_grants ||--|{ role_grant_scopes : covers
  rooms o|--o{ role_grants : "applies to"
  offices ||--o{ participants : employs
  roles ||--o{ participants : assigned
  desks o|--o| participants : seats
  participants ||--o{ participant_capabilities : lists
  participants ||--o{ access_rules : subject
  access_rules ||--|{ access_rule_scopes : covers
  rooms o|--o{ access_rules : "applies to"

  offices {
    text id PK
    text name
    int clock_ms
    int id_sequence
    int auto_handoff
  }
  rooms {
    text id PK
    text floorplan_id FK
    text name
    real x
    real z
    real width
    real depth
    integer corridor
  }
  desks {
    text id PK
    text room_id FK
    real x
    real z
    real facing
  }
  room_records {
    text room_id PK
    int position PK
    text body
  }
  connected_systems {
    text id PK
    text room_id FK
    text name
    text description
    text records_path
    text base_url
    text api_key_cipher
    text key_hint
    int needs_approval
  }
  system_operations {
    text system_id PK
    text operation PK
    text label
    text method
    text path
    text undoes
  }
  system_shown_rooms {
    text system_id PK
    text room_id PK
    integer position
  }
  system_operation_fields {
    text system_id PK
    text operation PK
    text name PK
    text label
    text hint
    text place
  }
  stage_rooms {
    text office_id PK
    text stage PK
    text room_id FK
  }
  roles {
    text id PK
    text name
    text description
  }
  role_permissions {
    text role_id PK
    text permission PK
  }
  role_grants {
    text role_id PK
    int position PK
    text room_id FK
    text effect
  }
  participants {
    text id PK
    text kind
    text display_name
    text role_id FK
    text desk_id FK
    int left_at "set when a person has left"
  }
  access_rules {
    text id PK
    text participant_id FK
    text room_id FK
    text effect
    text reason
    text granted_by FK
    int expires_at
    text expires_on_task_id FK
  }
  access_rule_scopes {
    text rule_id PK
    text scope PK
  }
```

## Agents, providers and playbooks

```mermaid
erDiagram
  offices ||--o{ ai_providers : connects
  participants ||--o| agent_settings : "configured by"
  ai_providers o|--o{ agent_settings : "answers for"
  participants ||--o{ playbook_steps : follows
  participants o|--o{ playbook_steps : "request is from"
  playbook_steps ||--o| playbook_outputs : posts
  playbook_steps ||--o| playbook_questions : asks
  playbook_questions ||--o{ playbook_question_options : offers
  participants o|--o{ playbook_questions : "is asked"
  playbook_steps ||--o| playbook_assumptions : records
  playbook_steps ||--o| playbook_needs : needs
  rooms ||--o{ playbook_needs : "access to"
  playbook_steps ||--o| playbook_actions : does
  playbook_steps ||--o| playbook_notes : tells
  participants o|--o{ playbook_notes : "is told"
  playbook_actions ||--o{ playbook_action_fields : "filled with"

  ai_providers {
    text id PK
    text office_id FK "set for an office's provider"
    text owner_user_id FK "set for an account's provider"
    int position
    text name
    text kind "the interface it speaks"
    text base_url "the address of its API, always set"
    text default_model
    text api_key_cipher
    text key_hint
  }
  agent_settings {
    text participant_id PK
    text agent_type
    text provider_id FK
    text model
  }
  playbook_steps {
    text id PK
    text participant_id FK
    int position
    text stage
    text request_contains
    text requested_by FK
    text status_note
  }
  playbook_outputs {
    text step_id PK
    text label
    text body
  }
  playbook_questions {
    text step_id PK
    text body
    text to_participant_id FK
    int blocking
  }
  playbook_question_options {
    text step_id PK
    int position PK
    text label
  }
  playbook_assumptions {
    text step_id PK
    text assumed
    text because
    text confidence
  }
  playbook_needs {
    text step_id PK
    text room_id FK
    text scope
    text purpose
  }
  playbook_notes {
    text step_id PK
    text to_participant_id FK
    text body
  }
  playbook_actions {
    text step_id PK
    text system_id
    text operation
  }
  playbook_action_fields {
    text step_id PK
    text name PK
    text value
  }
```

An agent's kind, provider and model live in `agent_settings`, one row per
agent. Removing a provider sets `provider_id` to NULL and leaves the agent in
place. A playbook step keeps its conditions on the step row, where a NULL
stage means any stage and a NULL `requested_by` means anyone. Each part of a
step's outcome has its own table and a row there only when the step does that
thing, so no step carries empty columns for parts it does not use. An action's
`system_id` is deliberately not a foreign key: a step keeps its action when the
system is disconnected, and skips it until a system with that id exists again.

## Work and messages

```mermaid
erDiagram
  tasks ||--o{ messages : about
  tasks ||--o{ task_events : history
  tasks ||--o{ task_open_questions : "waits on"
  tasks ||--o{ task_assumptions : "rests on"
  tasks ||--o{ task_documents : carries
  messages ||--o| message_system_results : "reports"
  tasks ||--o{ pending_work : "still owes"
  participants ||--o{ pending_work : "has been given"
  offices ||--o{ standing_requests : "files by itself"
  standing_requests o|--o| tasks : "last filed"
  messages ||--o| message_questions : is
  message_questions ||--o{ message_question_options : offers
  message_questions ||--o| message_held_actions : "asks approval for"
  message_held_actions ||--o{ message_held_action_fields : "filled with"
  messages ||--o| message_answers : is
  messages ||--o| message_assumptions : is
  message_assumptions ||--o{ message_assumption_tasks : affects
  messages ||--o| message_assignments : is
  messages ||--o| message_handoffs : is
  messages ||--o| message_escalations : is
  messages ||--o| message_verdicts : is
  messages ||--o| message_outputs : is
  messages ||--o| message_progress : has
  message_escalations o|--o| access_decisions : carries
  task_events o|--o| access_decisions : records
  access_decisions ||--|{ access_decision_sources : explains

  tasks {
    text id PK
    text title
    text requested_by FK
    text owner_id FK
    text room_id FK
    text stage
    text status
    int closed_at
    int wait_until
    text wait_reason
    integer step_owed
    integer urgent
    integer wind_up
  }
  message_system_results {
    text message_id PK
    text system_id
    text operation
    integer ok
    text record
  }
  task_documents {
    text id PK
    text task_id FK
    int position
    text name
    text body
    text added_by FK
    int added_at
  }
  pending_work {
    text participant_id PK
    text task_id PK
    text kind PK
    text note_id PK
    integer after_action
    int tries
    int created_at
  }
  standing_requests {
    text id PK
    text office_id FK
    text title
    text detail
    integer urgent
    text every
    int next_at
    text created_by FK
    text last_task_id FK
    integer active
  }
  messages {
    text id PK
    text kind
    text task_id FK
    text from_participant_id FK
    text audience
    text audience_participant_id FK
    text audience_room_id FK
    text room_id FK
    int at
    text body
  }
  message_questions {
    text message_id PK
    int blocking
    text answered_by_message_id FK
  }
  message_assumptions {
    text message_id PK
    text assumed
    text because
    text confidence
    text status
  }
  message_outputs {
    text message_id PK
    text label
    int simulated
  }
  task_events {
    text task_id PK
    int position PK
    int at
    text summary
    text decision_id FK
  }
  access_decisions {
    text id PK
    text participant_id FK
    text room_id FK
    text scope
    text effect
    text explanation
  }
  access_decision_sources {
    text decision_id PK
    int position PK
    text kind
    text effect
    text rule_id
  }
```

Position 0 in `access_decision_sources` is the rule that decided. The rest
lost, in precedence order. `rule_id` there has no foreign key on purpose: the
decision is kept as evidence after the rule it names has been revoked.

## Accounts, tokens and audit

```mermaid
erDiagram
  users ||--o{ memberships : holds
  participants ||--o| memberships : "is the seat of"
  users ||--o{ sessions : holds
  participants o|--o{ sessions : "currently viewing"
  participants ||--o| invites : "joined by accepting"
  access_rules ||--o{ access_tokens : issues
  access_rule_scopes ||--o| access_tokens : "one per scope"
  participants ||--o{ direct_messages : "writes or is written to"
  participants ||--o{ direct_reads : "has read up to"
  participants ||--o{ note_reads : "has opened"
  offices ||--o{ audit_log : records
  participants ||--o{ audit_log : acted
  audit_log ||--o{ audit_notes : describes

  users {
    text id PK
    text email UK
    text password_hash
    text display_name
  }
  memberships {
    text participant_id PK
    text user_id FK
  }
  sessions {
    text id PK
    text user_id FK
    text participant_id FK
    int issued_at
    int expires_at
    int revoked_at
  }
  invites {
    text id PK
    text token_hash UK
    text office_id FK
    text display_name
    text role_id FK "null if the role is removed"
    text room_id FK "null if the room is removed"
    text participant_id FK "set on acceptance"
    text created_by FK
    int expires_at
    int accepted_at
  }
  direct_messages {
    int id PK
    text from_id FK
    text to_id FK
    text body
    int at
  }
  direct_reads {
    text reader_id PK
    text other_id PK
    int last_read_id
  }
  note_reads {
    text reader_id PK
    text message_id PK
  }
  access_tokens {
    text id PK
    text rule_id FK
    text scope FK
    int expires_at
    int revoked_at
    int last_used_at
  }
  audit_log {
    int id PK
    int recorded_at
    text actor_participant_id FK
    text action_type
    text task_id
    text subject_participant_id
    text rule_id
    text room_id
  }
  audit_notes {
    int audit_id PK
    int position PK
    text note
  }
```

A user is a sign-in and exists apart from any office. A row in `memberships`
is that user's seat in one office: the human participant they are there. A
session points at one seat at a time, which is what selects the office a
request acts on.

The audit log is append-only. Its subject columns are plain text without
foreign keys, so an entry survives the task or rule it describes.
