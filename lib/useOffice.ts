"use client";

import { useCallback, useMemo, useReducer } from "react";
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

function uiReduce(state: UiState, action: Action): UiState {
  const result = reduce(state.engine, action, runtime);
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
  const [state, dispatch] = useReducer(uiReduce, initial);
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
    dispatch: useCallback((a: Action) => dispatch(a), []),
  };
}
