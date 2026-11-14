"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { reduce, ScriptedRuntime, type Action, type EngineState } from "./engine";
import { office as seedOffice } from "./seed";
import type { Task } from "./model";

export interface FeedEntry {
  id: number;
  at: number;
  text: string;
}

interface UiState {
  engine: EngineState;
  feed: FeedEntry[];
  feedSeq: number;
}

const initial: UiState = {
  engine: {
    office: seedOffice,
    now: Date.parse("2026-11-20T09:35:00-05:00"),
    // Above every id in the seed, so generated ids can never collide with it.
    seq: 4000,
    clockStepMinutes: 3,
  },
  feed: [
    {
      id: 0,
      at: Date.parse("2026-11-20T09:35:00-05:00"),
      text: "Office loaded. Three tasks in flight.",
    },
  ],
  feedSeq: 1,
};

const runtime = new ScriptedRuntime();

async function uiReduce(state: UiState, action: Action): Promise<UiState> {
  const result = await reduce(state.engine, action, runtime);
  let seq = state.feedSeq;
  const entries = result.notes.map((text) => ({
    id: seq++,
    at: result.state.now,
    text,
  }));
  return {
    engine: result.state,
    feed: [...entries.reverse(), ...state.feed].slice(0, 60),
    feedSeq: seq,
  };
}

export function useOffice() {
  const [state, setState] = useState(initial);
  const [pending, setPending] = useState(false);

  // Actions run one at a time, each against the result of the one before it,
  // because a transition may wait on an agent.
  const latest = useRef(initial);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const dispatch = useCallback((action: Action) => {
    queue.current = queue.current.then(async () => {
      setPending(true);
      try {
        latest.current = await uiReduce(latest.current, action);
        setState(latest.current);
      } finally {
        setPending(false);
      }
    });
  }, []);
  const office = state.engine.office;

  const roomOfTask = useMemo(() => {
    const map: Record<string, "none" | "question" | "permission"> = {};
    for (const t of office.tasks) {
      if (t.status === "blocked_permission") map[t.roomId] = "permission";
      else if (t.status === "blocked_question" && map[t.roomId] !== "permission") {
        map[t.roomId] = "question";
      }
    }
    return map;
  }, [office.tasks]);

  const alertOfParticipant = useMemo(() => {
    const map: Record<string, "none" | "question" | "permission"> = {};
    for (const t of office.tasks) {
      if (!t.ownerId) continue;
      if (t.status === "blocked_permission") map[t.ownerId] = "permission";
      else if (t.status === "blocked_question" && map[t.ownerId] !== "permission") {
        map[t.ownerId] = "question";
      }
    }
    return map;
  }, [office.tasks]);

  const openTasks = useMemo(
    () => office.tasks.filter((t: Task) => t.closedAt === null),
    [office.tasks],
  );

  return {
    office,
    now: state.engine.now,
    feed: state.feed,
    openTasks,
    roomHighlight: (roomId: string) => roomOfTask[roomId] ?? "none",
    participantAlert: (id: string) => alertOfParticipant[id] ?? "none",
    pending,
    dispatch,
  };
}
