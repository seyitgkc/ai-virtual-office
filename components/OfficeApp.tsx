"use client";

import { Report } from "./Report";
import { setupSteps, type SetupTab } from "../lib/setup";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { useOffice } from "../lib/useOffice";
import { resolveAccess } from "../lib/model";
import { authorize, contextOf } from "../lib/policy";
import { entryPose } from "../lib/geometry";
import type { OfficeView } from "../lib/view";
import { Feed, Inspector, TaskList, TitleCard } from "./Panels";
import { Minimap } from "./Minimap";
import { Inbox, inboxCount } from "./Inbox";
import { InviteDialog } from "./InviteDialog";
import { Settings } from "./Settings";
import { taskLabel } from "../lib/taskLabels";
import { TaskContext } from "./TaskCard";

/** On a phone one section shows at a time. A wide screen shows them all. */
type Sheet = "office" | "work" | "detail" | "activity";

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
    providerOp,
    systemOp,
    standingOp,
    readSystem,
    talk,
    markOpened,
    tokenOperation,
    refresh,
    signOut,
  } = useOffice(initial);

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
    () => initial.office.tasks.find((t) => t.closedAt === null)?.id ?? null,
  );
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);

  const [sheet, setSheet] = useState<Sheet>("office");
  const [inviting, setInviting] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<"overview" | "walk">("overview");
  const [walkRoomId, setWalkRoomId] = useState<string | null>(null);
  const walkPose = useRef(entryPose(office.floorplan.rooms));
  // Who the walker is close to and facing, and a counter that moves the
  // keyboard into the message box when they choose to talk.
  const [facedId, setFacedId] = useState<string | null>(null);
  const [talkFocus, setTalkFocus] = useState(0);
  const faced = mode === "walk" ? (office.participants.find((p) => p.id === facedId) ?? null) : null;

  useEffect(() => {
    if (mode !== "walk") return;
    const leave = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape first leaves a text box, and only then the walk.
      const active = document.activeElement;
      if (active instanceof HTMLElement && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")) {
        active.blur();
        return;
      }
      setMode("overview");
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
      setSheet("detail");
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

  // A conversation counts as opened while its panel is on screen.
  const unreadFromSelected = selectedPersonId && !selectedTaskId ? (view.unread.directs[selectedPersonId] ?? 0) : 0;
  useEffect(() => {
    if (unreadFromSelected > 0 && selectedPersonId) void markOpened({ otherId: selectedPersonId });
  }, [unreadFromSelected, selectedPersonId, markOpened]);

  // Rooms the signed-in person may not walk into. Their doorways are barred.
  const closedRooms = useMemo(
    () =>
      new Set(
        office.floorplan.rooms
          .filter((room) => resolveAccess(viewer, room.id, "enter", ctx).effect !== "allow")
          .map((room) => room.id),
      ),
    [office.floorplan.rooms, viewer, ctx],
  );

  const task = office.tasks.find((t) => t.id === selectedTaskId) ?? null;
  const participant = office.participants.find((p) => p.id === selectedPersonId) ?? null;
  // What a new office still needs, shown until its first request is filed.
  const setup =
    !view.isDemoOffice && office.tasks.length === 0 && view.viewer.permissions.includes("manage_office")
      ? {
          steps: setupSteps(office, view.now, view.providers),
          onOpen: (tab: SetupTab) => {
            setSettingsTab(tab);
            setSettingsOpen(true);
          },
        }
      : null;

  return (
    <TaskContext.Provider
      value={{
        office,
        agentLoad: view.agentLoad,
        openTaskId: selectedTaskId,
        openTask: (id) => {
          setSelectedTaskId(id);
          setSelectedPersonId(null);
          setSheet("detail");
        },
      }}
    >
    <main className="office" data-pending={pending} data-sheet={sheet}>
      <Scene
        office={office}
        viewerId={viewer.id}
        mode={mode}
        walkPose={walkPose}
        walkRoomId={walkRoomId}
        onWalkRoomChange={setWalkRoomId}
        selectedId={selectedPersonId}
        onSelectParticipant={(id) => {
          setSelectedPersonId(id);
          setSelectedTaskId(null);
          setSheet("detail");
        }}
        onSelectRoom={() => setSelectedPersonId(null)}
        closedRooms={closedRooms}
        inspectorOpen={task !== null || participant !== null || setup !== null}
        onFaceParticipant={setFacedId}
        onInteract={(id) => {
          setSelectedPersonId(id);
          setSelectedTaskId(null);
          setSheet("detail");
          setTalkFocus((n) => n + 1);
        }}
        roomHighlight={roomHighlight}
        participantAlert={participantAlert}
        agentLoad={view.agentLoad}
        onSelectTask={(id) => {
          setSelectedTaskId(id);
          setSelectedPersonId(null);
          setSheet("detail");
        }}
      />

      <div id="left">
        <TitleCard
          mode={mode}
          onToggleMode={() => setMode((m) => (m === "walk" ? "overview" : "walk"))}
          viewer={view.viewer}
          officeName={office.name}
          offices={view.offices}
          onSwitchOffice={(officeId) => officeOp({ operation: "switch", officeId })}
          isDemoOffice={view.isDemoOffice}
          onSignOut={signOut}
          onSettings={() => {
            setSettingsTab(undefined);
            setSettingsOpen(true);
          }}
          onInvite={() => setInviting(true)}
          waitingInvites={view.invitations.length}
          onReport={() => setReportOpen(true)}
          inboxCount={inboxCount(view, viewer)}
          onInbox={() => setInboxOpen(true)}
        />
        <TaskList
          tasks={office.tasks}
          selectedId={selectedTaskId}
          onSelect={(id) => {
            setSelectedTaskId(id);
            setSelectedPersonId(null);
            setSheet("detail");
          }}
          submitBlocked={mayFile.allowed ? null : mayFile.reason}
          isDemoOffice={view.isDemoOffice}
          intakeRoomName={
            office.floorplan.rooms.find((r) => r.id === office.stageRooms.intake)?.name ?? "the office"
          }
          onSubmit={(title, detail, urgent, documents) =>
            dispatch({
              type: "SUBMIT_REQUEST",
              title,
              detail,
              requestedById: viewer.id,
              ...(urgent ? { urgent: true } : {}),
              ...(documents.length > 0 ? { documents } : {}),
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
          <Feed feed={feed} office={office} />
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
        directs={view.directs}
        onTalk={talk}
        talkFocus={talkFocus}
        pending={pending}
        dispatch={dispatch}
        onTokenOperation={tokenOperation}
        setup={setup}
        agentLoad={view.agentLoad}
        keepRecord={
          view.viewer.permissions.includes("manage_rooms")
            ? (roomId, record) => adminOp({ type: "KEEP_ROOM_RECORD", roomId, record })
            : null
        }
        onClear={() => {
          // Back to where the selection was made.
          setSheet(selectedTaskId ? "work" : "office");
          setSelectedTaskId(null);
          setSelectedPersonId(null);
        }}
      />

      <nav className="phone-nav" aria-label="Sections">
        {(
          [
            { id: "office", label: "Office" },
            { id: "work", label: `Work (${office.tasks.filter((t) => t.closedAt === null).length})` },
            { id: "detail", label: "Details" },
            { id: "activity", label: mode === "walk" ? "Map" : "Activity" },
          ] as { id: Sheet; label: string }[]
        ).map((s) => (
          <button
            key={s.id}
            type="button"
            aria-current={sheet === s.id ? "page" : undefined}
            onClick={() => setSheet(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      {faced && faced.id !== selectedPersonId && (
        <div className="interact-hint" role="status">
          Press <kbd>F</kbd> to talk to {faced.displayName}
        </div>
      )}

      {notice && (
        <div className="notice" role="status" data-tone={noticeTone}>
          <span>{notice}</span>
          <button className="btn" onClick={dismissNotice}>
            Dismiss
          </button>
        </div>
      )}
      {pending && <div className="working">Working...</div>}
      {!pending && view.agentsAtWork && (
        <div className="working">
          {Object.entries(view.agentLoad)
            .filter(([, load]) => load.taskId !== null)
            .map(([id, load]) => {
              const who = office.participants.find((p) => p.id === id)?.displayName ?? "An agent";
              return `${who} is on ${taskLabel(office, load.taskId ?? "")}${load.waiting > 0 ? `, ${load.waiting} more waiting` : ""}`;
            })
            .join(" · ") || "Agents are working..."}
        </div>
      )}
      {inviting && (
        <InviteDialog
          office={office}
          ownPermissions={view.viewer.permissions}
          entersFreely={view.isDemoOffice}
          invitations={view.invitations}
          onChanged={() => void refresh()}
          onClose={() => setInviting(false)}
        />
      )}
      {inboxOpen && (
        <Inbox
          view={view}
          viewer={viewer}
          onOpenTask={(taskId, noteId) => {
            setSelectedTaskId(taskId);
            setSelectedPersonId(null);
            setSheet("detail");
            setInboxOpen(false);
            if (noteId && view.unread.notes.includes(noteId)) void markOpened({ noteId });
          }}
          onOpenPerson={(id) => {
            setSelectedPersonId(id);
            setSelectedTaskId(null);
            setSheet("detail");
            setInboxOpen(false);
            setTalkFocus((n) => n + 1);
          }}
          onClose={() => setInboxOpen(false)}
        />
      )}
      {reportOpen && <Report view={view} onClose={() => setReportOpen(false)} />}
      {settingsOpen && (
        <Settings
          view={view}
          viewer={viewer}
          adminOp={adminOp}
          dispatch={dispatch}
          officeOp={officeOp}
          providerOp={providerOp}
          systemOp={systemOp}
          standingOp={standingOp}
          readSystem={readSystem}
          initialTab={settingsTab}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </main>
    </TaskContext.Provider>
  );
}
