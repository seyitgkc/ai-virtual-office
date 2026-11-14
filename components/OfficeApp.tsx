"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { useOffice } from "../lib/useOffice";
import { authorize, contextOf } from "../lib/policy";
import { entryPose } from "../lib/geometry";
import type { OfficeView } from "../lib/view";
import { Feed, Inspector, TaskList, TitleCard } from "./Panels";
import { Minimap } from "./Minimap";
import { InviteDialog } from "./InviteDialog";
import { Settings } from "./Settings";

const Scene = dynamic(() => import("./Scene").then((m) => m.Scene), {
  ssr: false,
  loading: () => <div className="scene-loading">Loading office...</div>,
});

/** The whole interface for a signed-in person: the 3D office and its panels. */
export function OfficeApp({ initial }: { initial: OfficeView }) {
  const {
    view,
    office,
    now,
    feed,
    pending,
    notice,
    noticeTone,
    dismissNotice,
    roomHighlight,
    participantAlert,
    dispatch,
    adminOp,
    officeOp,
    saveAi,
    testAi,
    tokenOperation,
    signOut,
  } = useOffice(initial);

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
    () => initial.office.tasks.find((t) => t.closedAt === null)?.id ?? null,
  );
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);

  const [inviting, setInviting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  const ctx = useMemo(() => contextOf(office, now), [office, now]);

  // A newly filed request opens in the inspector straight away.
  const taskCount = useRef(office.tasks.length);
  useEffect(() => {
    if (office.tasks.length > taskCount.current) {
      setSelectedTaskId(office.tasks[office.tasks.length - 1].id);
      setSelectedPersonId(null);
    }
    taskCount.current = office.tasks.length;
  }, [office.tasks]);

  const viewer =
    office.participants.find((p) => p.id === view.viewer.participantId) ?? office.participants[0];
  const mayFile = authorize(office, ctx, viewer, {
    type: "SUBMIT_REQUEST",
    title: "-",
    detail: "-",
    requestedById: viewer.id,
  });

  const task = office.tasks.find((t) => t.id === selectedTaskId) ?? null;
  const participant = office.participants.find((p) => p.id === selectedPersonId) ?? null;

  return (
    <main className="office" data-pending={pending}>
      <Scene
        office={office}
        mode={mode}
        walkPose={walkPose}
        walkRoomId={walkRoomId}
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
          viewer={view.viewer}
          officeName={office.name}
          offices={view.offices}
          onSwitchOffice={(officeId) => officeOp({ operation: "switch", officeId })}
          runtime={view.runtime}
          onSignOut={signOut}
          onSettings={() => setSettingsOpen(true)}
          onInvite={() => setInviting(true)}
        />
        <TaskList
          tasks={office.tasks}
          selectedId={selectedTaskId}
          onSelect={(id) => {
            setSelectedTaskId(id);
            setSelectedPersonId(null);
          }}
          submitBlocked={mayFile.allowed ? null : mayFile.reason}
          onSubmit={(title, detail) =>
            dispatch({ type: "SUBMIT_REQUEST", title, detail, requestedById: viewer.id })
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
        viewer={viewer}
        hiddenMessages={view.hiddenMessages}
        tokens={view.accessTokens}
        accounts={view.accounts}
        dispatch={dispatch}
        onTokenOperation={tokenOperation}
        onClear={() => {
          setSelectedTaskId(null);
          setSelectedPersonId(null);
        }}
      />

      {notice && (
        <div className="notice" role="status" data-tone={noticeTone}>
          <span>{notice}</span>
          <button className="btn" onClick={dismissNotice}>
            Dismiss
          </button>
        </div>
      )}
      {pending && <div className="working">Working...</div>}
      {inviting && <InviteDialog office={office} onClose={() => setInviting(false)} />}
      {settingsOpen && (
        <Settings
          view={view}
          viewer={viewer}
          adminOp={adminOp}
          dispatch={dispatch}
          officeOp={officeOp}
          saveAi={saveAi}
          testAi={testAi}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </main>
  );
}
