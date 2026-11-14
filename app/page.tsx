"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { useOffice } from "../lib/useOffice";
import { Feed, Inspector, TaskList, TitleCard } from "../components/Panels";
import { Minimap } from "../components/Minimap";
import { entryPose } from "../lib/geometry";
import type { AccessContext } from "../lib/model";

const Scene = dynamic(() => import("../components/Scene").then((m) => m.Scene), {
  ssr: false,
  loading: () => (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "grid",
        placeItems: "center",
        opacity: 0.45,
        fontSize: 12,
      }}
    >
      Loading office...
    </div>
  ),
});

export default function Page() {
  const { office, now, feed, roomHighlight, participantAlert, dispatch } = useOffice();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>("T-1001");
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);

  const [mode, setMode] = useState<"overview" | "walk">("overview");
  const [walkRoomId, setWalkRoomId] = useState<string | null>(null);
  const walkPose = useRef(entryPose(office.floorplan.rooms));

  useEffect(() => {
    if (mode !== "walk") return;
    const leave = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMode("overview");
    };
    window.addEventListener("keydown", leave);
    return () => window.removeEventListener("keydown", leave);
  }, [mode]);

  const ctx: AccessContext = useMemo(
    () => ({
      roles: office.roles,
      rules: office.rules,
      now,
      closedTaskIds: new Set(
        office.tasks.filter((t) => t.closedAt !== null).map((t) => t.id),
      ),
    }),
    [office.roles, office.rules, office.tasks, now],
  );

  // A newly filed request opens in the inspector straight away.
  const taskCount = useRef(office.tasks.length);
  useEffect(() => {
    if (office.tasks.length > taskCount.current) {
      setSelectedTaskId(office.tasks[office.tasks.length - 1].id);
      setSelectedPersonId(null);
    }
    taskCount.current = office.tasks.length;
  }, [office.tasks]);

  const supervisor =
    office.participants.find((p) => p.roleId === "supervisor") ?? office.participants[0];

  const task = office.tasks.find((t) => t.id === selectedTaskId) ?? null;
  const participant =
    office.participants.find((p) => p.id === selectedPersonId) ?? null;

  return (
    <main style={{ position: "fixed", inset: 0 }}>
      <Scene
        office={office}
        mode={mode}
        walkPose={walkPose}
        onWalkRoomChange={setWalkRoomId}
        selectedId={selectedPersonId}
        onSelectParticipant={(id) => {
          setSelectedPersonId(id);
          setSelectedTaskId(null);
        }}
        onSelectRoom={() => setSelectedPersonId(null)}
        roomHighlight={roomHighlight}
        participantAlert={participantAlert}
      />

      <div id="left">
        <TitleCard
          mode={mode}
          onToggleMode={() => setMode((m) => (m === "walk" ? "overview" : "walk"))}
        />
        <TaskList
          tasks={office.tasks}
          selectedId={selectedTaskId}
          onSelect={(id) => {
            setSelectedTaskId(id);
            setSelectedPersonId(null);
          }}
          onSubmit={(title, detail) =>
            dispatch({
              type: "SUBMIT_REQUEST",
              title,
              detail,
              requestedById: supervisor.id,
            })
          }
        />
        {mode === "walk" ? (
          <Minimap
            office={office}
            pose={walkPose}
            currentRoomId={walkRoomId}
            roomHighlight={roomHighlight}
            participantAlert={participantAlert}
          />
        ) : (
          <Feed feed={feed} />
        )}
      </div>
      <Inspector
        office={office}
        ctx={ctx}
        task={task}
        participant={task ? null : participant}
        dispatch={dispatch}
        onClear={() => {
          setSelectedTaskId(null);
          setSelectedPersonId(null);
        }}
      />
    </main>
  );
}
