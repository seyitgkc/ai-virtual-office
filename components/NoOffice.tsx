"use client";

import { useState } from "react";

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
      : "That did not work.";
  } catch {
    return "The office server could not be reached.";
  }
}

/** Shown to a signed-in account that has no office yet, or has removed its last one. */
export function NoOffice({ displayName, canCreate }: { displayName: string; canCreate: boolean }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <main className="login">
      <div className="login-card">
        <h1>Welcome, {displayName}</h1>
        <p>
          You are not in an office yet.{" "}
          {canCreate
            ? "Add one to get started. It begins empty, with one room and you in it."
            : "Ask someone in an office to invite you."}
        </p>
        {canCreate && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              const problem = await post("/api/offices", { operation: "create", name });
              if (problem) {
                setError(problem);
                setBusy(false);
              } else {
                window.location.assign("/");
              }
            }}
          >
            <label htmlFor="office-name">Office name</label>
            <input id="office-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} required />
            {error && (
              <div className="login-error" role="alert">
                {error}
              </div>
            )}
            <button type="submit" className="btn primary" disabled={busy}>
              Add a new office
            </button>
          </form>
        )}
        <button
          className="btn"
          style={{ marginTop: 12 }}
          onClick={async () => {
            await post("/api/auth/logout", {});
            window.location.assign("/login");
          }}
        >
          Sign out
        </button>
      </div>
    </main>
  );
}
