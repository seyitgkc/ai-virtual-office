"use client";

import { useState } from "react";
import type { AdminOp } from "../lib/admin";
import type { Action } from "../lib/engine";
import {
  ALL_SCOPES,
  ANY_ROOM,
  PERMISSION_INFO,
  PERMISSIONS,
  type AccessScope,
  type Office,
  type Permission,
  type Role,
  type RoomSelector,
} from "../lib/model";
import { AccessGrid, ConfirmButton, SavedField, Section, TabBar, type CellEffect } from "./settingsParts";

const roomRows = (office: Office): { id: RoomSelector; label: string }[] => [
  { id: ANY_ROOM, label: "Every room" },
  ...office.floorplan.rooms.map((r) => ({ id: r.id, label: r.name })),
];

const roleEffect = (role: Role, room: RoomSelector, scope: AccessScope): CellEffect =>
  role.grants.find((g) => g.room === room && g.scopes.includes(scope))?.effect ?? "none";

/** Roles, what each role may do, and which rooms each role may use. */
export function RolesTab({
  office,
  ownPermissions,
  adminOp,
}: {
  office: Office;
  /** The viewer's permissions. A permission can only be given by someone who holds it. */
  ownPermissions: Permission[];
  adminOp: (op: AdminOp) => Promise<boolean>;
}) {
  const roles = Object.values(office.roles);
  const [selected, setSelected] = useState(roles[0]?.id ?? "");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const role = office.roles[selected] ?? roles[0];
  const holdersOf = (id: string) => office.participants.filter((p) => p.roleId === id);
  const heldByAgents = (id: string) => holdersOf(id).some((p) => p.kind === "agent");
  const [part, setPart] = useState<"roles" | "rooms" | "permissions">("roles");
  // Permissions are for people. A role an agent holds cannot carry any, so it
  // has no column of boxes that could never be ticked.
  const peopleRoles = roles.filter((r) => !heldByAgents(r.id));
  const agentRoles = roles.filter((r) => heldByAgents(r.id));

  return (
    <>
      <TabBar
        label="Roles and access"
        tabs={[
          { id: "roles", label: `Roles (${roles.length})` },
          { id: "rooms", label: "Room access" },
          { id: "permissions", label: "Permissions" },
        ]}
        active={part}
        onChange={setPart}
      />
      {part === "roles" && (
      <Section title="Roles" hint="A role is what a person or agent is here to do. A name or description is saved when you leave its field.">
        <div className="table-scroll">
          <table className="grid-table">
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col">Description</th>
                <th scope="col">Held by</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {roles.map((r) => {
                const holders = holdersOf(r.id);
                return (
                  <tr key={r.id}>
                    <td>
                      <SavedField
                        label={`Name of the role ${r.name}`}
                        value={r.name}
                        onSave={(next) => adminOp({ type: "UPDATE_ROLE", roleId: r.id, name: next })}
                      />
                    </td>
                    <td>
                      <SavedField
                        label={`Description of the role ${r.name}`}
                        value={r.description}
                        placeholder="What this role is for"
                        allowEmpty
                        onSave={(next) => adminOp({ type: "UPDATE_ROLE", roleId: r.id, description: next })}
                      />
                    </td>
                    <td className="muted">
                      {holders.length === 0 ? "Nobody" : holders.map((p) => p.displayName).join(", ")}
                    </td>
                    <td className="actions">
                      <ConfirmButton label="Remove" onConfirm={() => adminOp({ type: "REMOVE_ROLE", roleId: r.id })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <form
          className="form-inline add-row"
          onSubmit={(e) => {
            e.preventDefault();
            void adminOp({ type: "ADD_ROLE", name, description }).then((added) => {
              if (!added) return;
              setName("");
              setDescription("");
            });
          }}
        >
          <input
            aria-label="New role name"
            placeholder="New role name"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <input
            aria-label="New role description"
            placeholder="What it is for (optional)"
            value={description}
            maxLength={200}
            onChange={(e) => setDescription(e.target.value)}
          />
          <button type="submit" className="btn primary">
            Add role
          </button>
        </form>
      </Section>
      )}

      {part === "permissions" && (
      <Section
        title="Permissions"
        hint={
          "What a role may do to the office itself. You can only give a permission you hold yourself." +
          (agentRoles.length > 0
            ? ` Permissions are for people, so the roles agents hold are not listed: ${agentRoles.map((r) => r.name).join(", ")}.`
            : "")
        }
      >
        <div className="table-scroll">
          <table className="grid-table permission-grid">
            <thead>
              <tr>
                <th scope="col">Permission</th>
                {peopleRoles.map((r) => (
                  <th key={r.id} scope="col" className="narrow">
                    {r.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERMISSIONS.map((permission) => (
                <tr key={permission}>
                  <th scope="row">
                    {PERMISSION_INFO[permission].label}
                    <span className="cell-note">{PERMISSION_INFO[permission].description}</span>
                  </th>
                  {peopleRoles.map((r) => {
                    const on = r.permissions.includes(permission);
                    const blocked = !on && (!ownPermissions.includes(permission) || heldByAgents(r.id));
                    return (
                      <td key={r.id} className="narrow" data-on={on}>
                        <input
                          type="checkbox"
                          aria-label={`${PERMISSION_INFO[permission].label} for ${r.name}`}
                          checked={on}
                          disabled={blocked}
                          title={
                            blocked
                              ? heldByAgents(r.id)
                                ? "Agents hold this role, and permissions are for people."
                                : "You do not hold this permission yourself."
                              : undefined
                          }
                          onChange={(e) =>
                            adminOp({
                              type: "SET_ROLE_PERMISSION",
                              roleId: r.id,
                              permission,
                              allowed: e.target.checked,
                            })
                          }
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      )}

      {part === "rooms" && role && (
        <Section
          title="Room access by role"
          hint="Deny beats allow. A box left empty is not set, so the role falls back to Every room and then to no access. A rule on one person or agent outranks anything set here."
        >
          <TabBar
            small
            label="Role"
            tabs={roles.map((r) => ({ id: r.id, label: r.name }))}
            active={role.id}
            onChange={setSelected}
          />
          <AccessGrid
            caption={`Room access for the role ${role.name}`}
            wholeRows
            rows={roomRows(office)}
            effectOf={(room, scope) => roleEffect(role, room, scope)}
            onChange={(room, scope, effect) =>
              adminOp({ type: "SET_ROLE_GRANT", roleId: role.id, room, scope, effect })
            }
          />
        </Section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

/** Rules attached to one person or agent, which outrank their role. */
export function RulesTab({
  office,
  dispatch,
}: {
  office: Office;
  dispatch: (action: Action) => Promise<boolean>;
}) {
  const rooms = office.floorplan.rooms;
  const [participantId, setParticipantId] = useState(office.participants[0]?.id ?? "");
  const [cells, setCells] = useState<Record<string, CellEffect>>({});
  const [reason, setReason] = useState("");
  const who = (id: string): string => office.participants.find((p) => p.id === id)?.displayName ?? id;
  const where = (id: RoomSelector): string =>
    id === ANY_ROOM ? "Every room" : (rooms.find((r) => r.id === id)?.name ?? id);
  const chosen = Object.entries(cells).filter(([, effect]) => effect !== "none");

  const addRules = () => {
    // One rule per room and effect, each carrying the scopes ticked for it.
    const sent: Promise<boolean>[] = [];
    for (const row of roomRows(office)) {
      for (const effect of ["allow", "deny"] as const) {
        const scopes = ALL_SCOPES.filter((scope) => cells[`${row.id}|${scope}`] === effect);
        if (scopes.length > 0) {
          sent.push(
            dispatch({ type: "GRANT_ACCESS", participantId, room: row.id, scopes, effect, reason, grantedBy: "" }),
          );
        }
      }
    }
    // The ticks and the reason stay when any of them was refused.
    void Promise.all(sent).then((results) => {
      if (!results.every(Boolean)) return;
      setCells({});
      setReason("");
    });
  };

  return (
    <>
      <Section
        title="Individual rules"
        hint="A rule on one person or agent outranks their role. Among individual rules, deny beats allow."
      >
        <div className="table-scroll">
          <table className="grid-table">
            <thead>
              <tr>
                <th scope="col">Who</th>
                <th scope="col">Room</th>
                {ALL_SCOPES.map((scope) => (
                  <th key={scope} scope="col" className="narrow">
                    {scope}
                  </th>
                ))}
                <th scope="col">Reason</th>
                <th scope="col">Given by</th>
                <th scope="col">Ends</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {office.rules.length === 0 && (
                <tr>
                  <td colSpan={9} className="muted">
                    No individual rules.
                  </td>
                </tr>
              )}
              {office.rules.map((rule) => (
                <tr key={rule.id}>
                  <td>{who(rule.participantId)}</td>
                  <td>{where(rule.room)}</td>
                  {ALL_SCOPES.map((scope) => (
                    <td key={scope} className={`narrow ${rule.effect}`} data-on={rule.scopes.includes(scope)}>
                      {rule.scopes.includes(scope) ? rule.effect : ""}
                    </td>
                  ))}
                  <td>
                    {rule.reason}
                    <span className="cell-note">{rule.id}</span>
                  </td>
                  <td className="muted">{who(rule.grantedBy)}</td>
                  <td className="muted">
                    {rule.expiresOnTaskId ? `With ${rule.expiresOnTaskId}` : rule.expiresAt ? "Time-limited" : "Never"}
                  </td>
                  <td className="actions">
                    <ConfirmButton
                      label="Revoke"
                      onConfirm={() => dispatch({ type: "REVOKE_RULE", ruleId: rule.id, revokedBy: "" })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title="Add rules"
        hint="Choose who the rules are for, tick the cells, and give a reason. Each allowed scope also issues a permission token."
      >
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            if (chosen.length > 0) addRules();
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
            Reason (required, kept in the audit log)
            <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} required />
          </label>
          <div className="wide">
            <AccessGrid
              caption={`New rules for ${who(participantId)}`}
              rows={roomRows(office)}
              effectOf={(room, scope) => cells[`${room}|${scope}`] ?? "none"}
              onChange={(room, scope, effect) => setCells({ ...cells, [`${room}|${scope}`]: effect })}
            />
          </div>
          <button type="submit" className="btn primary" disabled={chosen.length === 0}>
            Add rules
          </button>
        </form>
      </Section>
    </>
  );
}
