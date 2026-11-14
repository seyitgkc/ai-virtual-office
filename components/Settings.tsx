"use client";

import { useState, type ReactNode } from "react";
import { CONFIGURABLE_STAGES, type AdminOp } from "../lib/admin";
import { stageSpec, type Action } from "../lib/engine";
import {
  ALL_SCOPES,
  ANY_ROOM,
  type AccessScope,
  type Effect,
  type Office,
  type Participant,
  type Role,
  type RoomSelector,
  type Wall,
} from "../lib/model";
import type { OfficeView } from "../lib/view";
import { KindBadge } from "./Panels";

type Tab = "office" | "people" | "roles" | "rooms" | "rules";
const TABS: { id: Tab; label: string }[] = [
  { id: "office", label: "Office" },
  { id: "rooms", label: "Rooms" },
  { id: "people", label: "People and agents" },
  { id: "roles", label: "Roles" },
  { id: "rules", label: "Access rules" },
];

/** A button that asks for a second click before doing something drastic. */
function ConfirmButton({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      className="btn warn"
      onClick={() => {
        if (armed) onConfirm();
        setArmed(!armed);
      }}
      onBlur={() => setArmed(false)}
    >
      {armed ? "Click again to confirm" : label}
    </button>
  );
}

/** A text field that saves when you leave it, if the value changed. */
function SavedField({
  value,
  label,
  onSave,
}: {
  value: string;
  label: string;
  onSave: (next: string) => void;
}) {
  return (
    <input
      key={value}
      aria-label={label}
      defaultValue={value}
      onBlur={(e) => {
        const next = e.target.value.trim();
        if (next && next !== value) onSave(next);
        else e.target.value = value;
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {hint && <p className="hint">{hint}</p>}
      {children}
    </section>
  );
}

/** Where each wall is, as the overview shows the plan. */
const SIDES: { wall: Wall; label: string }[] = [
  { wall: "east", label: "to the right of" },
  { wall: "west", label: "to the left of" },
  { wall: "north", label: "in front of (nearer the camera)" },
  { wall: "south", label: "behind (further from the camera)" },
];

/**
 * Where a supervisor sets the office up: its name, rooms, people, agents,
 * roles and access rules. Every change is checked and stored on the server.
 */
export function Settings({
  view,
  viewer,
  adminOp,
  dispatch,
  startOver,
  onClose,
}: {
  view: OfficeView;
  viewer: Participant;
  adminOp: (op: AdminOp) => void;
  dispatch: (action: Action) => void;
  startOver: (kind: "empty" | "demo") => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("office");
  const office = view.office;

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-heading"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-head">
          <h2 id="settings-heading">Settings</h2>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="settings-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className="settings-tab"
              data-active={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="settings-body">
          {tab === "office" && <OfficeTab view={view} adminOp={adminOp} startOver={startOver} />}
          {tab === "rooms" && <RoomsTab office={office} adminOp={adminOp} />}
          {tab === "people" && <PeopleTab office={office} viewer={viewer} adminOp={adminOp} />}
          {tab === "roles" && <RolesTab office={office} adminOp={adminOp} />}
          {tab === "rules" && <RulesTab office={office} dispatch={dispatch} />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function OfficeTab({
  view,
  adminOp,
  startOver,
}: {
  view: OfficeView;
  adminOp: (op: AdminOp) => void;
  startOver: (kind: "empty" | "demo") => void;
}) {
  const { office } = view;
  return (
    <>
      <Section title="Name">
        <SavedField
          label="Office name"
          value={office.name}
          onSave={(name) => adminOp({ type: "RENAME_OFFICE", name })}
        />
      </Section>

      <Section
        title="Where each stage happens"
        hint="A task moves through these stages in order. Each stage is hosted by one room."
      >
        {CONFIGURABLE_STAGES.map((stage) => (
          <label key={stage} className="row">
            <span>{stageSpec(stage).label}</span>
            <select
              value={office.stageRooms[stage]}
              onChange={(e) => adminOp({ type: "SET_STAGE_ROOM", stage, roomId: e.target.value })}
            >
              {office.floorplan.rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </Section>

      <Section title="Agents">
        <p className="hint">
          {view.runtime === "model"
            ? `Agents answer through a live language model (${view.agentModel}).`
            : "Agents follow a fixed script. A live model is switched on in the server's configuration, where its API key is kept. The key is never entered here."}
        </p>
      </Section>

      <Section
        title="Start over"
        hint="These cannot be undone. Your own sign-in is kept in every case."
      >
        <div className="row-actions">
          <ConfirmButton label="Clear all work" onConfirm={() => adminOp({ type: "CLEAR_WORK" })} />
          <ConfirmButton label="Start an empty office" onConfirm={() => startOver("empty")} />
          <ConfirmButton label="Load the demo office" onConfirm={() => startOver("demo")} />
        </div>
        <p className="hint">
          Clearing work removes tasks and messages and keeps rooms, people and roles. An empty
          office has one room and you in it. The demo office is the seeded distributor.
        </p>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------

function RoomsTab({ office, adminOp }: { office: Office; adminOp: (op: AdminOp) => void }) {
  const rooms = office.floorplan.rooms;
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [width, setWidth] = useState(8);
  const [depth, setDepth] = useState(8);
  const [attachTo, setAttachTo] = useState(rooms[rooms.length - 1]?.id ?? "");
  const [side, setSide] = useState<Wall>("east");
  const target = rooms.some((r) => r.id === attachTo) ? attachTo : (rooms[0]?.id ?? "");

  return (
    <>
      <Section title="Rooms" hint="Each room is a permission boundary. Names and purposes save when you leave the field.">
        {rooms.map((room) => {
          const stages = CONFIGURABLE_STAGES.filter((s) => office.stageRooms[s] === room.id);
          const seated = office.floorplan.desks.filter((d) => d.roomId === room.id).length;
          return (
            <div key={room.id} className="entity">
              <div className="entity-fields">
                <SavedField
                  label={`Name of ${room.name}`}
                  value={room.name}
                  onSave={(next) => adminOp({ type: "UPDATE_ROOM", roomId: room.id, name: next })}
                />
                <SavedField
                  label={`Purpose of ${room.name}`}
                  value={room.purpose || "No purpose given"}
                  onSave={(next) => adminOp({ type: "UPDATE_ROOM", roomId: room.id, purpose: next })}
                />
              </div>
              <div className="entity-meta">
                {room.bounds.w} by {room.bounds.d} m · {seated} desk{seated === 1 ? "" : "s"}
                {stages.length > 0 ? ` · hosts ${stages.map((s) => stageSpec(s).label).join(", ")}` : ""}
              </div>
              <ConfirmButton
                label="Remove"
                onConfirm={() => adminOp({ type: "REMOVE_ROOM", roomId: room.id })}
              />
            </div>
          );
        })}
      </Section>

      <Section
        title="Add a room"
        hint="The new room is built against one wall of an existing room, with a door between them."
      >
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            adminOp({ type: "ADD_ROOM", name, purpose, width, depth, attachTo: target, side });
            setName("");
            setPurpose("");
          }}
        >
          <label>
            Name
            <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            Purpose
            <input value={purpose} maxLength={120} onChange={(e) => setPurpose(e.target.value)} />
          </label>
          <label>
            Width (m)
            <input type="number" min={4} max={24} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
          </label>
          <label>
            Depth (m)
            <input type="number" min={4} max={24} value={depth} onChange={(e) => setDepth(Number(e.target.value))} />
          </label>
          <label>
            Place it
            <select value={side} onChange={(e) => setSide(e.target.value as Wall)}>
              {SIDES.map((s) => (
                <option key={s.wall} value={s.wall}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Which room
            <select value={target} onChange={(e) => setAttachTo(e.target.value)}>
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn primary">
            Add room
          </button>
        </form>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------

function PeopleTab({
  office,
  viewer,
  adminOp,
}: {
  office: Office;
  viewer: Participant;
  adminOp: (op: AdminOp) => void;
}) {
  const roles = Object.values(office.roles);
  const rooms = office.floorplan.rooms;
  const agentRoles = roles.filter((r) => !r.supervises);
  const [displayName, setDisplayName] = useState("");
  const [title, setTitle] = useState("");
  const [roleId, setRoleId] = useState(agentRoles[0]?.id ?? "");
  const [roomId, setRoomId] = useState(rooms[0]?.id ?? "");
  const [capabilities, setCapabilities] = useState("");
  const role = agentRoles.some((r) => r.id === roleId) ? roleId : (agentRoles[0]?.id ?? "");
  const room = rooms.some((r) => r.id === roomId) ? roomId : (rooms[0]?.id ?? "");

  return (
    <>
      <Section
        title="People and agents"
        hint="Changing the room moves the desk. People join through Invite on the main screen."
      >
        {office.participants.map((p) => {
          const desk = office.floorplan.desks.find((d) => d.id === p.deskId);
          return (
            <div key={p.id} className="entity">
              <div className="entity-fields">
                <span className="entity-name">
                  <KindBadge kind={p.kind} />
                  <SavedField
                    label={`Name of ${p.displayName}`}
                    value={p.displayName}
                    onSave={(next) => adminOp({ type: "UPDATE_PARTICIPANT", participantId: p.id, displayName: next })}
                  />
                </span>
                <SavedField
                  label={`Title of ${p.displayName}`}
                  value={p.title}
                  onSave={(next) => adminOp({ type: "UPDATE_PARTICIPANT", participantId: p.id, title: next })}
                />
              </div>
              <div className="entity-selects">
                <select
                  aria-label={`Role of ${p.displayName}`}
                  value={p.roleId}
                  onChange={(e) => adminOp({ type: "UPDATE_PARTICIPANT", participantId: p.id, roleId: e.target.value })}
                >
                  {roles
                    .filter((r) => p.kind === "human" || !r.supervises)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                </select>
                <select
                  aria-label={`Room of ${p.displayName}`}
                  value={desk?.roomId ?? ""}
                  onChange={(e) => adminOp({ type: "UPDATE_PARTICIPANT", participantId: p.id, roomId: e.target.value })}
                >
                  {!desk && <option value="">No desk</option>}
                  {rooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
              {p.id === viewer.id ? (
                <span className="entity-meta">You</span>
              ) : (
                <ConfirmButton
                  label="Remove"
                  onConfirm={() => adminOp({ type: "REMOVE_PARTICIPANT", participantId: p.id })}
                />
              )}
            </div>
          );
        })}
      </Section>

      <Section title="Add an agent" hint="An agent gets a desk and a role, and its access follows from the role.">
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            adminOp({
              type: "ADD_AGENT",
              displayName,
              title,
              roleId: role,
              roomId: room,
              capabilities: capabilities.split("\n"),
            });
            setDisplayName("");
            setTitle("");
            setCapabilities("");
          }}
        >
          <label>
            Name
            <input value={displayName} maxLength={60} onChange={(e) => setDisplayName(e.target.value)} required />
          </label>
          <label>
            Title
            <input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} required />
          </label>
          <label>
            Role
            <select value={role} onChange={(e) => setRoleId(e.target.value)}>
              {agentRoles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Desk in
            <select value={room} onChange={(e) => setRoomId(e.target.value)}>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label className="wide">
            What it can do, one per line
            <textarea rows={3} value={capabilities} onChange={(e) => setCapabilities(e.target.value)} />
          </label>
          <button type="submit" className="btn primary">
            Add agent
          </button>
        </form>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------

const cellEffect = (role: Role, room: RoomSelector, scope: AccessScope): Effect | "none" =>
  role.grants.find((g) => g.room === room && g.scopes.includes(scope))?.effect ?? "none";

function RolesTab({ office, adminOp }: { office: Office; adminOp: (op: AdminOp) => void }) {
  const roles = Object.values(office.roles);
  const [selected, setSelected] = useState(roles[0]?.id ?? "");
  const [name, setName] = useState("");
  const role = office.roles[selected] ?? roles[0];
  if (!role) return null;
  const holders = office.participants.filter((p) => p.roleId === role.id);
  const rows: { id: RoomSelector; label: string }[] = [
    { id: ANY_ROOM, label: "Every room" },
    ...office.floorplan.rooms.map((r) => ({ id: r.id, label: r.name })),
  ];

  return (
    <>
      <Section title="Role">
        <div className="chips">
          {roles.map((r) => (
            <button
              key={r.id}
              className="settings-tab"
              data-active={r.id === role.id}
              onClick={() => setSelected(r.id)}
            >
              {r.name}
            </button>
          ))}
        </div>
        <div className="entity">
          <div className="entity-fields">
            <SavedField
              label="Role name"
              value={role.name}
              onSave={(next) => adminOp({ type: "UPDATE_ROLE", roleId: role.id, name: next })}
            />
            <SavedField
              label="Role description"
              value={role.description || "No description"}
              onSave={(next) => adminOp({ type: "UPDATE_ROLE", roleId: role.id, description: next })}
            />
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={role.supervises}
              onChange={(e) => adminOp({ type: "UPDATE_ROLE", roleId: role.id, supervises: e.target.checked })}
            />
            Supervises
          </label>
          <ConfirmButton label="Remove" onConfirm={() => adminOp({ type: "REMOVE_ROLE", roleId: role.id })} />
        </div>
        <p className="hint">
          Held by {holders.length === 0 ? "nobody" : holders.map((p) => p.displayName).join(", ")}. A
          role that supervises may change access, hand work over and decide reviews.
        </p>
      </Section>

      <Section
        title="What this role may do in each room"
        hint="Deny beats allow. An individual rule on a person or agent outranks anything set here."
      >
        <table className="matrix settings-matrix">
          <thead>
            <tr>
              <th>Room</th>
              {ALL_SCOPES.map((s) => (
                <th key={s}>{s}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.label}</td>
                {ALL_SCOPES.map((scope) => {
                  const effect = cellEffect(role, row.id, scope);
                  return (
                    <td key={scope}>
                      <select
                        aria-label={`${scope} on ${row.label}`}
                        data-effect={effect}
                        value={effect}
                        onChange={(e) =>
                          adminOp({
                            type: "SET_ROLE_GRANT",
                            roleId: role.id,
                            room: row.id,
                            scope,
                            effect: e.target.value as Effect | "none",
                          })
                        }
                      >
                        <option value="none">not set</option>
                        <option value="allow">allow</option>
                        <option value="deny">deny</option>
                      </select>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Add a role">
        <form
          className="form-inline"
          onSubmit={(e) => {
            e.preventDefault();
            adminOp({ type: "ADD_ROLE", name, description: "", supervises: false });
            setName("");
          }}
        >
          <input
            aria-label="New role name"
            placeholder="Role name"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <button type="submit" className="btn primary">
            Add role
          </button>
        </form>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------

function RulesTab({ office, dispatch }: { office: Office; dispatch: (action: Action) => void }) {
  const rooms = office.floorplan.rooms;
  const [participantId, setParticipantId] = useState(office.participants[0]?.id ?? "");
  const [room, setRoom] = useState(rooms[0]?.id ?? "");
  const [scopes, setScopes] = useState<AccessScope[]>(["read"]);
  const [effect, setEffect] = useState<Effect>("allow");
  const [reason, setReason] = useState("");
  const who = (id: string): string => office.participants.find((p) => p.id === id)?.displayName ?? id;
  const where = (id: RoomSelector): string =>
    id === ANY_ROOM ? "every room" : (rooms.find((r) => r.id === id)?.name ?? id);

  return (
    <>
      <Section
        title="Individual rules"
        hint="A rule on one person or agent outranks their role. Among individual rules, deny beats allow."
      >
        {office.rules.length === 0 && <p className="hint">No individual rules.</p>}
        {office.rules.map((rule) => (
          <div key={rule.id} className="entity">
            <div className="entity-fields">
              <span>
                <strong data-effect={rule.effect}>{rule.effect}</strong> {rule.scopes.join(", ")} on{" "}
                {where(rule.room)} for {who(rule.participantId)}
              </span>
              <span className="entity-meta">
                {rule.id} · {rule.reason} · by {who(rule.grantedBy)}
                {rule.expiresOnTaskId ? ` · ends with ${rule.expiresOnTaskId}` : ""}
                {rule.expiresAt ? " · time-limited" : ""}
              </span>
            </div>
            <ConfirmButton
              label="Revoke"
              onConfirm={() => dispatch({ type: "REVOKE_RULE", ruleId: rule.id, revokedBy: "" })}
            />
          </div>
        ))}
      </Section>

      <Section title="Add a rule" hint="An allow rule also issues a permission token for each scope.">
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            if (scopes.length === 0) return;
            dispatch({
              type: "GRANT_ACCESS",
              participantId,
              room,
              scopes,
              effect,
              reason,
              grantedBy: "",
            });
            setReason("");
          }}
        >
          <label>
            Who
            <select value={participantId} onChange={(e) => setParticipantId(e.target.value)}>
              {office.participants.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Room
            <select value={room} onChange={(e) => setRoom(e.target.value)}>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Effect
            <select value={effect} onChange={(e) => setEffect(e.target.value as Effect)}>
              <option value="allow">allow</option>
              <option value="deny">deny</option>
            </select>
          </label>
          <fieldset className="scopes">
            <legend>Scopes</legend>
            {ALL_SCOPES.map((s) => (
              <label key={s} className="check">
                <input
                  type="checkbox"
                  checked={scopes.includes(s)}
                  onChange={(e) =>
                    setScopes(e.target.checked ? ALL_SCOPES.filter((x) => x === s || scopes.includes(x)) : scopes.filter((x) => x !== s))
                  }
                />
                {s}
              </label>
            ))}
          </fieldset>
          <label className="wide">
            Reason (required, kept in the audit log)
            <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} required />
          </label>
          <button type="submit" className="btn primary" disabled={scopes.length === 0}>
            Add rule
          </button>
        </form>
      </Section>
    </>
  );
}
