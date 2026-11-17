"use client";

import { useEffect, useRef, useState } from "react";
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
  shownIn: [] as string[],
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
  part,
  view,
  viewer,
  adminOp,
  systemOp,
  readSystem,
}: {
  /** Which of the two pages this is: the rooms' own records, or the connected systems. */
  part: "records" | "systems";
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
  // Nothing is kept in a corridor, so a system is neither operated from one
  // nor shown in one.
  const homes = readable.filter((r) => !r.corridor);
  const formRoom = homes.some((r) => r.id === form.roomId) ? form.roomId : (homes[0]?.id ?? "");
  const alsoShown = form.shownIn.filter((id) => id !== formRoom && homes.some((r) => r.id === id));
  // Editing a system brings its form into view, wherever the table was scrolled to.
  const formRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (form.id) formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [form.id]);
  const keyState = (s: SystemView): string =>
    s.keyUnreadable ? "Stored but unreadable. Enter it again." : s.hasKey ? `Ends in ${s.keyHint}` : "None";

  if (part === "records") {
    return (
      <Section
        title="Records kept in each room"
        hint={
          "One record per line. Each is a fact an agent working in that room can rely on, such as a policy or an account's terms." +
          (closed > 0 ? ` ${closed} room${closed === 1 ? " is" : "s are"} not listed because you cannot read ${closed === 1 ? "it" : "them"}.` : "")
        }
      >
        {homes.map((room) => (
          <RoomRecords key={room.id} room={room} adminOp={adminOp} />
        ))}
      </Section>
    );
  }

  return (
    <>
      <Section
        title="Connected systems"
        hint={
          view.isDemoOffice
            ? "Mock services run beside this office. Their connections are fixed here, and an order in the storefront waits for approval. An office of your own connects its own."
            : locked
              ? "Sign in with a password account to connect a system."
              : "Whoever may read the room a system is operated from sees its live records. Whoever may act there can use it."
        }
      >
        <div className="table-scroll">
          <table className="grid-table">
            <thead>
              <tr>
                <th scope="col">System</th>
                <th scope="col">Operated from</th>
                <th scope="col">Agents can</th>
                <th scope="col">Each action</th>
                <th scope="col">API key</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {systems.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    No connected systems yet.
                  </td>
                </tr>
              )}
              {systems.map((s) => (
                <tr key={s.id} data-selected={s.id === editing?.id || s.id === shown?.id}>
                  <td className="cell-system">
                    {s.name}
                    <span className="cell-note">{s.baseUrl}</span>
                    <span className="cell-note cell-clamp" title={s.description}>
                      {s.description}
                    </span>
                  </td>
                  <td>
                    {roomName(s.roomId)}
                    {s.shownIn.length > 0 && (
                      <span className="cell-note">Records also shown in {s.shownIn.map(roomName).join(", ")}</span>
                    )}
                  </td>
                  <td className="muted cell-operations">{s.operations.join(", ") || "Nothing"}</td>
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
                      Live records
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
                              shownIn: s.shownIn,
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
              {[...new Set([systems.find((s) => s.id === shown.id)?.roomId ?? "", ...(systems.find((s) => s.id === shown.id)?.shownIn ?? [])])]
                .map(roomName)
                .join(" or ")}{" "}
              are shown the same lines.
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
        <div ref={formRef}>
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
                shownIn: alsoShown,
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
              Operated from
              <select value={formRoom} onChange={(e) => setForm({ ...form, roomId: e.target.value })}>
                {homes.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="wide hint">
              Whoever may read this room is shown the system&apos;s records. Whoever may act in this room can use the
              system. Who that is follows the roles and access rules, as for everything else in the room.
            </p>
            {homes.length > 1 && (
              <fieldset className="wide scopes">
                <legend>Records also shown in</legend>
                {homes
                  .filter((room) => room.id !== formRoom)
                  .map((room) => (
                    <label key={room.id} className="check">
                      <input
                        type="checkbox"
                        checked={alsoShown.includes(room.id)}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            shownIn: e.target.checked ? [...alsoShown, room.id] : alsoShown.filter((id) => id !== room.id),
                          })
                        }
                      />
                      {room.name}
                    </label>
                  ))}
                <p className="hint">
                  Readers of these rooms see the records too. Nobody can use the system from them.
                </p>
              </fieldset>
            )}
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
        </div>
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
