"use client";

import { useState } from "react";

interface DemoAccount {
  participantId: string;
  displayName: string;
  title: string;
  role: string;
  managesAccess: boolean;
}

async function post(url: string, body: unknown): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return null;
    const data: unknown = await response.json().catch(() => null);
    return data && typeof data === "object" && "error" in data && typeof data.error === "string"
      ? data.error
      : "Sign-in failed.";
  } catch {
    return "The office server could not be reached.";
  }
}

export function LoginForm({
  demoAccounts,
  canSignUp,
}: {
  demoAccounts: DemoAccount[];
  /** Whether a visitor may create an account here. */
  canSignUp: boolean;
}) {
  // The same card signs someone in or creates their account.
  const [creating, setCreating] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const enter = async (url: string, body: unknown) => {
    setBusy(true);
    const problem = await post(url, body);
    if (problem) {
      setError(problem);
      setBusy(false);
      return;
    }
    window.location.assign("/");
  };

  return (
    <main className="login">
      <div className="login-card">
        <h1>Virtual Office</h1>
        <p>
          {creating
            ? "Create an account to get an office of your own. It starts empty, with one room and you in it as its administrator."
            : "Sign in to enter the office. What you can see and do depends on your role and on the access rules that apply to you."}
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void enter(
              creating ? "/api/auth/register" : "/api/auth/login",
              creating ? { displayName, email, password } : { email, password },
            );
          }}
        >
          {creating && (
            <>
              <label htmlFor="display-name">Your name</label>
              <input
                id="display-name"
                autoComplete="name"
                maxLength={60}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </>
          )}
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <label htmlFor="password">{creating ? "Password, at least 10 characters" : "Password"}</label>
          <input
            id="password"
            type="password"
            autoComplete={creating ? "new-password" : "current-password"}
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
            {creating ? "Create account and enter" : "Sign in"}
          </button>
        </form>

        {canSignUp && (
          <button
            type="button"
            className="btn login-switch"
            disabled={busy}
            onClick={() => {
              setCreating(!creating);
              setError(null);
            }}
          >
            {creating ? "I already have an account" : "Create an account"}
          </button>
        )}

        {demoAccounts.length > 0 && (
          <div className="demo">
            <h2>Demo access</h2>
            <p>Enter as one of the people in the seeded office. No password is needed.</p>
            {demoAccounts.map((a) => (
              <button
                key={a.participantId}
                className="demo-account"
                disabled={busy}
                onClick={() => void enter("/api/auth/demo", { participantId: a.participantId })}
              >
                <strong>{a.displayName}</strong>
                <span>
                  {a.title} · {a.managesAccess ? "can change access and approve" : `${a.role} role`}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
