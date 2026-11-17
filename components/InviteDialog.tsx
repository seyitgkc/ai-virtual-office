"use client";

import { useState } from "react";
import type { Office, Permission, Role } from "../lib/model";

/**
 * Adds a person to the office. The result is a single-use
 * link that the invited person opens to choose their own email and password.
 * The demo office has no passwords, so a person added there gets no link.
 */
export function InviteDialog({
  office,
  ownPermissions,
  entersFreely,
  onClose,
}: {
  office: Office;
  /** True in the demo office, where people enter without a password and get no link. */
  entersFreely: boolean;
  /** The inviter's own permissions. Nobody can hand out more than they hold. */
  ownPermissions: Permission[];
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
  const [link, setLink] = useState<string | null>(null);
  // True once a person was added to the demo office, which is entered without a link.
  const [added, setAdded] = useState(false);
  const [copied, setCopied] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName, title, roleId, roomId }),
      });
      const data: unknown = await response.json().catch(() => null);
      if (response.ok && data && typeof data === "object" && "path" in data) {
        if (typeof data.path === "string") setLink(`${window.location.origin}${data.path}`);
        else setAdded(true);
      } else {
        setError(
          data && typeof data === "object" && "error" in data && typeof data.error === "string"
            ? data.error
            : "The invite could not be created.",
        );
      }
    } catch {
      setError("The office server could not be reached.");
    }
    setBusy(false);
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-heading"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="invite-heading">Invite a person</h2>

        {added ? (
          <>
            <p>
              {displayName} now has a desk in the office. Nobody needs a password in the demo office. Sign out, and{" "}
              {displayName} is among the people you can enter as on the sign-in page.
            </p>
            <div className="dialog-actions">
              <button className="btn primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : link ? (
          <>
            <p>
              {displayName} now has a desk in the office. Send them this link. It works once and
              expires in seven days.
            </p>
            <input readOnly value={link} onFocus={(e) => e.target.select()} />
            <div className="dialog-actions">
              <button
                className="btn primary"
                onClick={() =>
                  navigator.clipboard.writeText(link).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  )
                }
              >
                {copied ? "Copied" : "Copy link"}
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
              void submit();
            }}
          >
            <p>
              They get a desk and a role. Their access follows from the role, like everyone else.
              {entersFreely ? " In the demo office they enter without a password, from the sign-in page." : ""}
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
            {error && (
              <div className="login-error" role="alert">
                {error}
              </div>
            )}
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
      </div>
    </div>
  );
}
