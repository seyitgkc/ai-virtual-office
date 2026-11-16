"use client";

import { useState } from "react";
import type { AdminOp } from "../lib/admin";
import { resolveAccess, type Participant, type Room } from "../lib/model";
import { contextOf } from "../lib/policy";
import type { SystemOp } from "../lib/useOffice";
import type { OfficeView, SystemView } from "../lib/view";
import { ConfirmButton, Section } from "./settingsParts";

const EMPTY_FORM = {
  id: "",
  name: "",
  description: "",
  roomId: "",
  baseUrl: "",
  apiKey: "",
  needsApproval: true,
  refresh: false,
};

/**
 * What each room holds: records written by hand, and outside systems whose
 * records are read live. Both follow the room's access rules.
 */
export function RecordsTab({
  view,
  viewer,
  adminOp,
  systemOp,
  readSystem,
}: {
  view: OfficeView;
  viewer: Participant;
  adminOp: (op: AdminOp) => Promise<boolean>;
  systemOp: (op: SystemOp) => Promise<boolean>;
  readSystem: (id: string) => Promise<string[] | null>;
}) {
  const { office, systems } = view;
  const ctx = contextOf(office, view.now);
  const readable = office.floorplan.rooms.filter(
    (room) => resolveAccess(viewer, room.id, "read", ctx).effect === "allow",
  );
  const closed = office.floorplan.rooms.length - readable.length;
  const roomName = (id: string): string => office.floorplan.rooms.find((r) => r.id === id)?.name ?? id;

  const [form, setForm] = useState(EMPTY_FORM);
  const [shown, setShown] = useState<{ id: string; records: string[] } | null>(null);
  const locked = !view.systemsEditable;
  const editing = systems.find((s) => s.id === form.id) ?? null;
  const formRoom = readable.some((r) => r.id === form.roomId) ? form.roomId : (readable[0]?.id ?? "");
  const keyState = (s: SystemView): string =>
    s.keyUnreadable ? "Stored but unreadable. Enter it again." : s.hasKey ? `Ends in ${s.keyHint}` : "None";

  return (
    <>
      <Section
        title="Records kept in each room"
        hint={
          "One record per line. A record is shown to the people and agents who can read its room, and to nobody else." +
          (closed > 0 ? ` ${closed} room${closed === 1 ? " is" : "s are"} not listed because you cannot read ${closed === 1 ? "it" : "them"}.` : "")
        }
      >
        {readable.map((room) => (
          <RoomRecords key={room.id} room={room} adminOp={adminOp} />
        ))}
      </Section>

      <Section
        title="Connected systems"
        hint={
          view.isDemoOffice
            ? "Sample services run beside this office. Their connections are fixed here, and an order in the storefront waits for approval. An office of your own connects its own."
            : locked
              ? "Sign in with a password account to connect a system."
              : "A system is connected to one room. Reading the room shows the system's live records. Acting in the room allows its operations, and a system can also hold each action until a person approves it. Agents are told when and how to use a system in the words of its description, which you can change."
        }
      >
        <div className="table-scroll">
          <table className="grid-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Room</th>
                <th scope="col">Agents are told</th>
                <th scope="col">With act access, agents can</th>
                <th scope="col">Each action</th>
                <th scope="col">API key</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {systems.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    No connected systems yet.
                  </td>
                </tr>
              )}
              {systems.map((s) => (
                <tr key={s.id} data-selected={s.id === editing?.id || s.id === shown?.id}>
                  <td>
                    {s.name}
                    <span className="cell-note">{s.baseUrl}</span>
                  </td>
                  <td>{roomName(s.roomId)}</td>
                  <td className="muted cell-long">{s.description}</td>
                  <td className="muted">{s.operations.join(", ") || "Nothing"}</td>
                  <td className="muted">{s.needsApproval ? "Waits for approval" : "Goes straight through"}</td>
                  <td className="muted" data-warn={s.keyUnreadable}>
                    {keyState(s)}
                  </td>
                  <td className="actions">
                    <button
                      type="button"
                      className="btn"
                      onClick={() =>
                        void readSystem(s.id).then((records) => setShown(records ? { id: s.id, records } : null))
                      }
                    >
                      Show live records
                    </button>
                    {!locked && (
                      <>
                        <button
                          type="button"
                          className="btn"
                          onClick={() =>
                            setForm({
                              id: s.id,
                              name: s.name,
                              description: s.description,
                              roomId: s.roomId,
                              baseUrl: s.baseUrl,
                              apiKey: "",
                              needsApproval: s.needsApproval,
                              refresh: false,
                            })
                          }
                        >
                          Edit
                        </button>
                        <ConfirmButton
                          label="Disconnect"
                          onConfirm={() => {
                            void systemOp({ operation: "remove", id: s.id });
                            if (form.id === s.id) setForm(EMPTY_FORM);
                            if (shown?.id === s.id) setShown(null);
                          }}
                        />
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {shown && (
          <div className="live-records" aria-live="polite">
            <p className="hint">
              {systems.find((s) => s.id === shown.id)?.name ?? "The system"} holds this right now. Agents who can read{" "}
              {roomName(systems.find((s) => s.id === shown.id)?.roomId ?? "")} are shown the same lines.
            </p>
            {shown.records.length === 0 ? (
              <p className="hint">It holds no records.</p>
            ) : (
              <ul>
                {shown.records.map((record, index) => (
                  <li key={index}>{record}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Section>

      {!locked && (
        <Section title={editing ? `Edit ${editing.name}` : "Connect a system"}>
          <form
            className="form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              void systemOp({
                operation: "save",
                ...(editing ? { id: editing.id } : {}),
                name: form.name,
                description: form.description,
                roomId: formRoom,
                baseUrl: form.baseUrl,
                needsApproval: form.needsApproval,
                ...(form.apiKey ? { apiKey: form.apiKey } : {}),
                ...(form.refresh ? { refresh: true } : {}),
              }).then((saved) => {
                if (saved) setForm(EMPTY_FORM);
              });
            }}
          >
            <label>
              Name
              <input
                value={form.name}
                maxLength={40}
                placeholder="Leave empty to use the system's own name"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label>
              Room
              <select value={formRoom} onChange={(e) => setForm({ ...form, roomId: e.target.value })}>
                {readable.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              API key
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={form.apiKey}
                placeholder={editing?.hasKey ? "Leave empty to keep the stored key" : "Paste the API key"}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                required={!editing}
              />
            </label>
            <label className="wide">
              Address
              <input
                type="url"
                value={form.baseUrl}
                placeholder="https://store.example.com"
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                required
              />
            </label>
            <label className="wide">
              When and how agents use it
              <textarea
                rows={5}
                maxLength={1200}
                value={form.description}
                placeholder="Leave empty to use the system's own description. Say what the system is for, when an agent should turn to it, and anything to check before acting in it."
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </label>
            <label className="wide check">
              <input
                type="checkbox"
                checked={form.needsApproval}
                onChange={(e) => setForm({ ...form, needsApproval: e.target.checked })}
              />
              Hold each action until a person approves it
            </label>
            {editing && (
              <label className="wide check">
                <input
                  type="checkbox"
                  checked={form.refresh}
                  onChange={(e) => setForm({ ...form, refresh: e.target.checked })}
                />
                Ask the system again what can be done in it
              </label>
            )}
            <div className="wide row-actions">
              <button type="submit" className="btn primary">
                {editing ? "Save changes" : "Connect"}
              </button>
              {editing && (
                <button type="button" className="btn" onClick={() => setForm(EMPTY_FORM)}>
                  Cancel
                </button>
              )}
            </div>
          </form>
        </Section>
      )}
    </>
  );
}

/** One room's records as a text box, saved as a whole. */
function RoomRecords({ room, adminOp }: { room: Room; adminOp: (op: AdminOp) => Promise<boolean> }) {
  const stored = room.records.join("\n");
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? stored;
  const count = room.records.length;
  return (
    <div className="room-records">
      <label>
        <span>
          {room.name}
          <span className="entity-meta">
            {" "}
            {count === 0 ? "no records" : `${count} record${count === 1 ? "" : "s"}`}
          </span>
        </span>
        <textarea
          rows={Math.min(8, Math.max(2, text.split("\n").length))}
          value={text}
          placeholder="Nothing is kept in this room yet."
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      {draft !== null && draft !== stored && (
        <div className="row-actions">
          <button
            type="button"
            className="btn primary"
            onClick={() =>
              void adminOp({ type: "SET_ROOM_RECORDS", roomId: room.id, records: draft.split("\n") }).then((saved) => {
                if (saved) setDraft(null);
              })
            }
          >
            Save records
          </button>
          <button type="button" className="btn" onClick={() => setDraft(null)}>
            Discard
          </button>
        </div>
      )}
    </div>
  );
}
