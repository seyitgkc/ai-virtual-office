"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Action } from "./engine";
import type { OfficeView } from "./view";

export type { FeedEntry } from "./view";

type Halt = "none" | "question" | "permission";

/** How often the office is re-read, so that other people's actions show up. */
const REFRESH_MS = 5000;

async function request(url: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data: unknown = await response.json().catch(() => null);
  return { status: response.status, data };
}

const errorOf = (data: unknown): string =>
  data && typeof data === "object" && "error" in data && typeof data.error === "string"
    ? data.error
    : "The server did not accept that.";

/**
 * The browser's view of the office. State lives on the server: every action
 * is sent there, checked against the signed-in person's permissions, applied,
 * stored, and the resulting view comes back.
 */
export function useOffice(initial: OfficeView) {
  const [view, setView] = useState(initial);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Requests run one at a time so that views arrive in the order they were made.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const send = useCallback((url: string, body: unknown, onData?: (data: unknown) => void) => {
    queue.current = queue.current.then(async () => {
      setPending(true);
      try {
        const { status, data } = await request(url, body);
        if (status === 401) {
          window.location.assign("/login");
          return;
        }
        if (status >= 400) {
          setNotice(errorOf(data));
          return;
        }
        setNotice(null);
        if (onData) onData(data);
        else setView(data as OfficeView);
      } catch {
        setNotice("The office server could not be reached.");
      } finally {
        setPending(false);
      }
    });
  }, []);

  const dispatch = useCallback(
    (action: Action) => send("/api/office/actions", { action }),
    [send],
  );
  const restoreDemo = useCallback(() => send("/api/office/restore", {}), [send]);

  const tokenOperation = useCallback(
    (tokenId: string, operation: "reveal" | "revoke") =>
      send(`/api/tokens/${tokenId}`, { operation }, (data) => {
        if (operation === "revoke") {
          setView(data as OfficeView);
          return;
        }
        const token = (data as { token?: string }).token ?? "";
        navigator.clipboard
          .writeText(token)
          .then(() => setNotice("Token copied. Send it as a Bearer token to /api/rooms/<room>/thread."))
          .catch(() => setNotice(`Token: ${token}`));
      }),
    [send],
  );

  const signOut = useCallback(async () => {
    await request("/api/auth/logout", {});
    window.location.assign("/login");
  }, []);

  // Pick up changes made by other people.
  const busy = useRef(false);
  busy.current = pending;
  useEffect(() => {
    const timer = window.setInterval(async () => {
      if (busy.current || document.hidden) return;
      try {
        const { status, data } = await request("/api/office");
        if (status === 401) window.location.assign("/login");
        else if (status === 200 && !busy.current) setView(data as OfficeView);
      } catch {
        // Offline for a moment. The next tick tries again.
      }
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const { office } = view;

  const roomHalts = useMemo(() => {
    const map: Record<string, Halt> = {};
    for (const t of office.tasks) {
      if (t.status === "blocked_permission") map[t.roomId] = "permission";
      else if (t.status === "blocked_question" && map[t.roomId] !== "permission") {
        map[t.roomId] = "question";
      }
    }
    return map;
  }, [office.tasks]);

  const ownerHalts = useMemo(() => {
    const map: Record<string, Halt> = {};
    for (const t of office.tasks) {
      if (!t.ownerId) continue;
      if (t.status === "blocked_permission") map[t.ownerId] = "permission";
      else if (t.status === "blocked_question" && map[t.ownerId] !== "permission") {
        map[t.ownerId] = "question";
      }
    }
    return map;
  }, [office.tasks]);

  return {
    view,
    office,
    now: view.now,
    feed: view.feed,
    pending,
    notice,
    dismissNotice: useCallback(() => setNotice(null), []),
    roomHighlight: useCallback((roomId: string): Halt => roomHalts[roomId] ?? "none", [roomHalts]),
    participantAlert: useCallback((id: string): Halt => ownerHalts[id] ?? "none", [ownerHalts]),
    dispatch,
    restoreDemo,
    tokenOperation,
    signOut,
  };
}
