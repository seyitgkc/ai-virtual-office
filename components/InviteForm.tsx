"use client";

import { useState } from "react";

interface InviteDetails {
  displayName: string;
  title: string;
  roleName: string;
  roomName: string;
}

/** Shown to an invited person: they choose their own email and password. */
export function InviteForm({ token, invite }: { token: string; invite: InviteDetails }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/invites/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, email, password }),
      });
      if (response.ok) {
        window.location.assign("/");
        return;
      }
      const data: unknown = await response.json().catch(() => null);
      setError(
        data && typeof data === "object" && "error" in data && typeof data.error === "string"
          ? data.error
          : "The invite could not be accepted.",
      );
    } catch {
      setError("The office server could not be reached.");
    }
    setBusy(false);
  };

  return (
    <main className="login">
      <div className="login-card">
        <h1>Welcome, {invite.displayName}</h1>
        <p>
          You have been invited to the office as {invite.title}, with the {invite.roleName} role
          and a desk in {invite.roomName}. Choose how you will sign in.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="invite-email">Email</label>
          <input
            id="invite-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <label htmlFor="invite-password">Password, at least 10 characters</label>
          <input
            id="invite-password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && (
            <div className="login-error" role="alert">
              {error}
            </div>
          )}
          <button type="submit" className="btn primary" disabled={busy}>
            Create account and enter
          </button>
        </form>
      </div>
    </main>
  );
}
