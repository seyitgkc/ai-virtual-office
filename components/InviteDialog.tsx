"use client";

import { useState } from "react";
import { dayOf } from "../lib/engine";
import type { Office, Permission, Role } from "../lib/model";
import type { InvitationView } from "../lib/view";
import { ConfirmButton } from "./settingsParts";

async function post(body: unknown): Promise<{ ok: boolean; data: unknown }> {
  try {
    const response = await fetch("/api/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: response.ok, data: await response.json().catch(() => null) };
  } catch {
    return { ok: false, data: { error: "The office server could not be reached." } };
  }
}

const errorOf = (data: unknown, fallback: string): string =>
  data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : fallback;

/**
 * Invites a person into the office and keeps track of who has not accepted
 * yet. An invitation gives a single-use link that the invited person opens
 * to choose their own email and password. They are added to the office when
 * they accept. Until then the invitation waits here, where it can be given a
 * new link or withdrawn. The demo office has no passwords, so a person added
 * there is in at once and gets no link.
 */
export function InviteDialog({
  office,
  ownPermissions,
  entersFreely,
  invitations,
  onChanged,
  onClose,
}: {
  office: Office;
  /** The inviter's own permissions. Nobody can hand out more than they hold. */
  ownPermissions: Permission[];
  /** True in the demo office, where people enter without a password and get no link. */
  entersFreely: boolean;
  /** The invitations nobody has accepted yet. */
  invitations: InvitationView[];
  /** Called after an invitation is made, renewed or withdrawn, so the list is read again. */
  onChanged: () => void;
  onClose: () => void;
}) {
  const roles = Object.values(office.roles);
  const withinReach = (role: Role): boolean => role.permissions.every((p) => ownPermissions.includes(p));
  // A corridor holds no desk, so it is not offered as a place to sit.
  const rooms = office.floorplan.rooms.filter((r) => !r.corridor);
  const [displayName, setDisplayName] = useState("");
  const [title, setTitle] = useState("");
  const [roleId, setRoleId] = useState(roles.find((r) => r.permissions.length === 0)?.id ?? roles[0]?.id ?? "");
  const [roomId, setRoomId] = useState(rooms[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The link just made, and whose it is. It is shown once and never stored.
  const [link, setLink] = useState<{ url: string; name: string; renewed: boolean } | null>(null);
  // The name of a person just added to the demo office, which is entered without a link.
  const [added, setAdded] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const run = async (body: unknown, fallback: string): Promise<unknown | null> => {
    setBusy(true);
    setError(null);
    const { ok, data } = await post(body);
    setBusy(false);
    if (!ok) {
      setError(errorOf(data, fallback));
      return null;
    }
    onChanged();
    return data;
  };
  const show = (data: unknown, name: string, renewed: boolean): void => {
    const path = data && typeof data === "object" && "path" in data ? data.path : null;
    setCopied(false);
    if (typeof path === "string") setLink({ url: `${window.location.origin}${path}`, name, renewed });
    else setAdded(name);
  };

  const invite = async () => {
    const data = await run({ displayName, title, roleId, roomId }, "The invite could not be created.");
    if (!data) return;
    show(data, displayName.trim(), false);
    setDisplayName("");
    setTitle("");
  };
  const renew = async (invitation: InvitationView) => {
    const data = await run({ operation: "renew", inviteId: invitation.id }, "A new link could not be made.");
    if (data) show(data, invitation.displayName, true);
  };
  const withdraw = async (invitation: InvitationView) => {
    const data = await run({ operation: "withdraw", inviteId: invitation.id }, "The invitation could not be withdrawn.");
    if (data && link?.name === invitation.displayName) setLink(null);
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog invite"
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-heading"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="invite-heading">Invite a person</h2>

        {added ? (
          <>
            <p>
              {added} now has a desk in the office. Nobody needs a password in the demo office. Sign out, and {added} is
              among the people you can enter as on the sign-in page.
            </p>
            <div className="dialog-actions">
              <button className="btn primary" onClick={onClose}>
                Done
              </button>
              <button className="btn" onClick={() => setAdded(null)}>
                Add another
              </button>
            </div>
          </>
        ) : link ? (
          <>
            <p>
              {link.renewed
                ? `This is a new link for ${link.name}. The old one no longer works.`
                : `The invitation for ${link.name} is waiting. They get their desk when they accept.`}{" "}
              Send them this link. It works once and expires in seven days. It is shown only now: if it gets lost, make
              a new one from the list below.
            </p>
            <input readOnly aria-label={`Invite link for ${link.name}`} value={link.url} onFocus={(e) => e.target.select()} />
            <div className="dialog-actions">
              <button
                className="btn primary"
                onClick={() =>
                  navigator.clipboard.writeText(link.url).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  )
                }
              >
                {copied ? "Copied" : "Copy link"}
              </button>
              <button className="btn" onClick={() => setLink(null)}>
                Invite another
              </button>
              <button className="btn" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void invite();
            }}
          >
            <p>
              {entersFreely
                ? "They get a desk and a role. Their access follows from the role, like everyone else. In the demo office they enter without a password, from the sign-in page."
                : "They get a role and a desk once they accept. Their access follows from the role, like everyone else."}
            </p>
            <label htmlFor="invite-name">Name</label>
            <input
              id="invite-name"
              value={displayName}
              maxLength={60}
              onChange={(e) => setDisplayName(e.target.value)}
              required
            />
            <label htmlFor="invite-title">Job title</label>
            <input
              id="invite-title"
              value={title}
              maxLength={60}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
            <label htmlFor="invite-role">Role</label>
            <select id="invite-role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              {roles.map((role) => (
                <option key={role.id} value={role.id} disabled={!withinReach(role)}>
                  {role.name}
                  {role.permissions.length > 0
                    ? ` (${role.permissions.length} permission${role.permissions.length === 1 ? "" : "s"})`
                    : ""}
                </option>
              ))}
            </select>
            <label htmlFor="invite-room">Desk in</label>
            <select id="invite-room" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                </option>
              ))}
            </select>
            <div className="dialog-actions">
              <button type="submit" className="btn primary" disabled={busy}>
                {entersFreely ? "Add person" : "Create invite"}
              </button>
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {error && (
          <div className="login-error" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>
            {error}
          </div>
        )}

        {!entersFreely && (
          <section className="invite-waiting" aria-labelledby="invite-waiting-heading">
            <h3 id="invite-waiting-heading">Waiting to be accepted ({invitations.length})</h3>
            {invitations.length === 0 ? (
              <div className="empty">Nobody is waiting. An invitation is listed here until its person accepts.</div>
            ) : (
              <div className="table-scroll">
                <table className="grid-table">
                  <thead>
                    <tr>
                      <th scope="col">Person</th>
                      <th scope="col">Role and desk</th>
                      <th scope="col">Invited by</th>
                      <th scope="col">Link</th>
                      <th scope="col" aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {invitations.map((invitation) => (
                      <tr key={invitation.id}>
                        <td>
                          {invitation.displayName}
                          <div className="muted">{invitation.title}</div>
                        </td>
                        <td>
                          {invitation.roleName ?? "Role removed"}
                          <div className="muted">{invitation.roomName ?? "Room removed"}</div>
                        </td>
                        <td>{invitation.invitedBy}</td>
                        <td data-warn={invitation.problem !== null}>
                          {invitation.problem ?? `Valid until ${dayOf(invitation.expiresAt)}`}
                        </td>
                        <td className="actions">
                          {invitation.manageable ? (
                            <>
                              <button type="button" className="btn" disabled={busy} onClick={() => void renew(invitation)}>
                                New link
                              </button>
                              <ConfirmButton label="Withdraw" onConfirm={() => void withdraw(invitation)} />
                            </>
                          ) : (
                            <span className="muted">Its role holds more than yours</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
