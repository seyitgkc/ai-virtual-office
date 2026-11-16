"use client";

import { useState } from "react";
import { CONFIGURABLE_STAGES, type AdminOp } from "../lib/admin";
import { stageSpec, type Action } from "../lib/engine";
import type { Office, Participant, Permission, Wall } from "../lib/model";
import type { OfficeOp, ProviderOp, SystemOp } from "../lib/useOffice";
import type { OfficeView } from "../lib/view";
import { RolesTab, RulesTab } from "./SettingsAccess";
import { PeopleTab, ProvidersTab } from "./SettingsAgents";
import { RecordsTab } from "./SettingsRecords";
import { ConfirmButton, SavedField, Section, TabBar } from "./settingsParts";

type Tab = "offices" | "own-providers" | "office" | "rooms" | "records" | "people" | "roles" | "rules" | "providers";

/** Each tab and the permission that opens it. Offices is open to everyone. */
const TABS: { id: Tab; label: string; needs: Permission | null }[] = [
  { id: "offices", label: "Offices", needs: null },
  { id: "office", label: "This office", needs: "manage_office" },
  { id: "rooms", label: "Rooms", needs: "manage_rooms" },
  { id: "records", label: "Records and systems", needs: "manage_rooms" },
  { id: "people", label: "People and agents", needs: "manage_people" },
  { id: "roles", label: "Roles and permissions", needs: "manage_roles" },
  { id: "rules", label: "Access rules", needs: "manage_access" },
  { id: "providers", label: "Office AI providers", needs: "manage_providers" },
  { id: "own-providers", label: "My AI providers", needs: null },
];

/** Where each wall is, as the overview shows the plan. */
const SIDES: { wall: Wall; label: string }[] = [
  { wall: "east", label: "to the right of" },
  { wall: "west", label: "to the left of" },
  { wall: "north", label: "in front of (nearer the camera)" },
  { wall: "south", label: "behind (further from the camera)" },
];

/**
 * Settings. Everyone sees their offices here. The other tabs set up the
 * office a person is in, and each one shows only when their role carries the
 * matching permission. Every change is checked and stored on the server.
 */
export function Settings({
  view,
  viewer,
  adminOp,
  dispatch,
  officeOp,
  providerOp,
  systemOp,
  readSystem,
  initialTab,
  onClose,
}: {
  /** The tab to open on, when the person was sent here for one thing. */
  initialTab?: string;
  view: OfficeView;
  viewer: Participant;
  adminOp: (op: AdminOp) => Promise<boolean>;
  dispatch: (action: Action) => Promise<boolean>;
  officeOp: (op: OfficeOp) => void;
  providerOp: (op: ProviderOp) => Promise<boolean>;
  systemOp: (op: SystemOp) => Promise<boolean>;
  readSystem: (id: string) => Promise<string[] | null>;
  onClose: () => void;
}) {
  const own = view.viewer.permissions;
  // Providers of one's own need a password account, which demo access is not.
  const tabs = TABS.filter(
    (t) => (t.needs === null || own.includes(t.needs)) && (t.id !== "own-providers" || view.ownProvidersEditable),
  );
  const [tab, setTab] = useState<Tab>(
    tabs.find((t) => t.id === initialTab)?.id ?? tabs.find((t) => t.needs !== null)?.id ?? "offices",
  );
  const open = tabs.some((t) => t.id === tab) ? tab : "offices";
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
        <TabBar label="Settings" tabs={tabs} active={open} onChange={setTab} />
        <div className="settings-body" role="tabpanel">
          {open === "offices" && <OfficesTab view={view} officeOp={officeOp} />}
          {open === "office" && <OfficeTab view={view} adminOp={adminOp} officeOp={officeOp} />}
          {open === "rooms" && <RoomsTab office={office} adminOp={adminOp} />}
          {open === "records" && (
            <RecordsTab view={view} viewer={viewer} adminOp={adminOp} systemOp={systemOp} readSystem={readSystem} />
          )}
          {open === "people" && (
            <PeopleTab office={office} viewer={viewer} providers={view.providers} adminOp={adminOp} />
          )}
          {open === "roles" && <RolesTab office={office} ownPermissions={own} adminOp={adminOp} />}
          {open === "rules" && <RulesTab office={office} dispatch={dispatch} />}
          {open === "providers" && <ProvidersTab view={view} providerOp={providerOp} scope="office" />}
          {open === "own-providers" && <ProvidersTab view={view} providerOp={providerOp} scope="account" />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function OfficesTab({ view, officeOp }: { view: OfficeView; officeOp: (op: OfficeOp) => void }) {
  const [name, setName] = useState("");
  return (
    <>
      <Section
        title="Your offices"
        hint={`Signed in as ${view.account.displayName} (${view.account.email}). Each office is separate, with its own rooms, people, work, rules and AI providers.`}
      >
        {view.offices.map((o) => (
          <div key={o.officeId} className="entity">
            <div className="entity-fields">
              <span>
                <strong>{o.name}</strong>
                {o.active ? " · you are here" : ""}
              </span>
              <span className="entity-meta">
                {o.isDemo ? "Shared demo office" : o.canRemove ? "You manage this office" : "You are a member"}
              </span>
            </div>
            {!o.active && (
              <button className="btn" onClick={() => officeOp({ operation: "switch", officeId: o.officeId })}>
                Open
              </button>
            )}
            {o.canRemove && (
              <ConfirmButton
                label="Remove"
                onConfirm={() => officeOp({ operation: "remove", officeId: o.officeId })}
              />
            )}
          </div>
        ))}
      </Section>

      <Section
        title="Add a new office"
        hint={
          view.account.isDemo
            ? "Demo access cannot add offices. Sign in with a password account to have offices of your own."
            : "A new office starts empty: one room with you in it, no agents, no work and no rules."
        }
      >
        <form
          className="form-inline"
          onSubmit={(e) => {
            e.preventDefault();
            officeOp({ operation: "create", name });
          }}
        >
          <input
            aria-label="New office name"
            placeholder="Office name"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            disabled={view.account.isDemo}
            required
          />
          <button type="submit" className="btn primary" disabled={view.account.isDemo}>
            Add a new office
          </button>
        </form>
        <p className="hint">Removing an office deletes everything in it for everyone, and cannot be undone.</p>
      </Section>

      {view.ownProvidersEditable && <SampleOffice view={view} officeOp={officeOp} />}
    </>
  );
}

/** Adds the demo's distributor as an office of one's own, staffed by AI agents. */
function SampleOffice({ view, officeOp }: { view: OfficeView; officeOp: (op: OfficeOp) => void }) {
  const usable = view.ownProviders.filter((p) => p.usable);
  const [providerId, setProviderId] = useState(usable[0]?.id ?? "");
  const chosen = usable.some((p) => p.id === providerId) ? providerId : (usable[0]?.id ?? "");
  return (
    <Section
      title="Add a sample office with AI agents"
      hint={
        usable.length === 0
          ? "This adds the distributor from the demo as an office of your own, with five AI agents in place of the playbook agents. It needs an AI provider from your account: add one under My AI providers first."
          : "This adds the distributor from the demo as an office of your own: the same rooms, roles and records, five AI agents on the provider you choose, and you as its manager. It starts with no work. Every step an agent takes is a call to that provider."
      }
    >
      <form
        className="form-inline"
        onSubmit={(e) => {
          e.preventDefault();
          if (chosen) officeOp({ operation: "create_sample", providerId: chosen });
        }}
      >
        <select
          aria-label="AI provider for the sample office's agents"
          value={chosen}
          onChange={(e) => setProviderId(e.target.value)}
          disabled={usable.length === 0}
        >
          {usable.length === 0 && <option value="">No usable provider in your account</option>}
          {usable.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}: {p.defaultModel}
            </option>
          ))}
        </select>
        <button type="submit" className="btn primary" disabled={usable.length === 0}>
          Add the sample office
        </button>
      </form>
    </Section>
  );
}

// ---------------------------------------------------------------------------

function OfficeTab({
  view,
  adminOp,
  officeOp,
}: {
  view: OfficeView;
  adminOp: (op: AdminOp) => void;
  officeOp: (op: OfficeOp) => void;
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

      {view.isDemoOffice && (
        <Section
          title="Reset the demo"
          hint="Puts this office back as it first loaded: the same people, rules and three tasks, with the dealer order halted at the Finance door. Everything added since is removed, for every visitor."
        >
          <div className="row-actions">
            <ConfirmButton label="Reset the demo" onConfirm={() => officeOp({ operation: "reset_demo" })} />
          </div>
        </Section>
      )}

      <Section
        title="How work moves"
        hint="Halts are the same either way: a question, missing access, an approval and the review decision always wait for a person."
      >
        <label className="check">
          <input
            type="checkbox"
            checked={office.autoHandoff}
            onChange={(e) => adminOp({ type: "SET_AUTO_HANDOFF", on: e.target.checked })}
          />
          Agents hand a finished step on to the next stage by themselves
        </label>
        <p className="hint">
          {office.autoHandoff
            ? "A task moves from stage to stage without anyone clicking, until it reaches a halt or the review."
            : "A person moves each task on with the Advance button once an agent has finished its step."}
        </p>
      </Section>

      <Section title="Danger zone" hint="These cannot be undone.">
        <div className="row-actions">
          <ConfirmButton label="Clear all work" onConfirm={() => adminOp({ type: "CLEAR_WORK" })} />
          {!view.isDemoOffice && (
            <ConfirmButton
              label="Remove this office"
              onConfirm={() => officeOp({ operation: "remove", officeId: office.id })}
            />
          )}
        </div>
        <p className="hint">
          Clearing work removes tasks and messages and keeps rooms, people and roles. Removing the
          office deletes all of it, for everyone in it.
        </p>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------

function RoomsTab({ office, adminOp }: { office: Office; adminOp: (op: AdminOp) => Promise<boolean> }) {
  const rooms = office.floorplan.rooms;
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [width, setWidth] = useState(8);
  const [depth, setDepth] = useState(8);
  const [attachTo, setAttachTo] = useState(rooms[rooms.length - 1]?.id ?? "");
  const hasCorridor = rooms.some((r) => r.corridor);
  const [side, setSide] = useState<Wall | "along">(hasCorridor ? "along" : "east");
  const [corridor, setCorridor] = useState(false);
  const target = rooms.some((r) => r.id === attachTo) ? attachTo : (rooms[0]?.id ?? "");
  const place = side === "along" && !hasCorridor ? "east" : side;

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
                {room.bounds.w} by {room.bounds.d} m ·{" "}
                {room.corridor ? "corridor" : `${seated} desk${seated === 1 ? "" : "s"}`}
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
              {rooms
                .filter((room) => !room.corridor)
                .map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.name}
                  </option>
                ))}
            </select>
          </label>
        ))}
      </Section>

      <Section
        title="Add a room"
        hint="A new room takes the next free place along the corridor, which lengthens to make space. It can also be built against one wall of a room you choose. Either way a door joins the two."
      >
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void adminOp({
              type: "ADD_ROOM",
              name,
              purpose,
              width,
              depth,
              attachTo: place === "along" ? "" : target,
              side: place,
              ...(corridor ? { corridor: true } : {}),
            }).then((added) => {
              if (!added) return;
              setName("");
              setPurpose("");
              setCorridor(false);
            });
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
            <input type="number" min={corridor ? 2 : 4} max={24} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
          </label>
          <label>
            Depth (m)
            <input type="number" min={corridor ? 2 : 4} max={24} value={depth} onChange={(e) => setDepth(Number(e.target.value))} />
          </label>
          <label>
            Place it
            <select value={place} onChange={(e) => setSide(e.target.value as Wall | "along")}>
              {hasCorridor && <option value="along">along the corridor</option>}
              {SIDES.map((s) => (
                <option key={s.wall} value={s.wall}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          {place !== "along" && (
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
          )}
          <label className="wide check">
            <input type="checkbox" checked={corridor} onChange={(e) => setCorridor(e.target.checked)} />
            This room is a corridor. People walk through it and nobody has a desk there.
          </label>
          <button type="submit" className="btn primary">
            Add room
          </button>
        </form>
      </Section>
    </>
  );
}
