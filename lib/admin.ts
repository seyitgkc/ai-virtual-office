/**
 * Changes to how the office is set up: its rooms, roles, people and agents.
 *
 * These are separate from the workflow actions in the engine. An action moves
 * work along. An admin operation changes the place the work happens in. Each
 * one is a pure function from an office to a new office, and refuses with a
 * plain-language reason when the change would leave the office broken.
 */
import { freeDeskSpot } from "./geometry";
import {
  ALL_SCOPES,
  ANY_ROOM,
  PERMISSIONS,
  PLAYBOOK_STAGES,
  type AccessGrant,
  type AccessScope,
  type AgentType,
  type Desk,
  type Effect,
  type Floorplan,
  type Office,
  type Participant,
  type Permission,
  type PlaybookStep,
  type Role,
  type Room,
  type RoomSelector,
  type StageRooms,
  type Wall,
} from "./model";
import { checkedFields } from "./systems";

export type ConfigurableStage = keyof StageRooms;
export const CONFIGURABLE_STAGES: ConfigurableStage[] = ["intake", "planning", "execution", "review"];

export type AdminOp =
  | { type: "RENAME_OFFICE"; name: string }
  | { type: "CLEAR_WORK" }
  | { type: "SET_AUTO_HANDOFF"; on: boolean }
  | {
      type: "ADD_AGENT";
      displayName: string;
      title: string;
      roleId: string;
      roomId: string;
      capabilities: string[];
      /** An AI agent asks a model. A playbook agent follows written steps. */
      agentType: AgentType;
      providerId?: string | null;
      model?: string | null;
    }
  | {
      type: "UPDATE_PARTICIPANT";
      participantId: string;
      displayName?: string;
      title?: string;
      roleId?: string;
      roomId?: string;
      capabilities?: string[];
      agentType?: AgentType;
      providerId?: string | null;
      model?: string | null;
    }
  | { type: "SET_PLAYBOOK"; participantId: string; steps: PlaybookStep[] }
  | { type: "REMOVE_PARTICIPANT"; participantId: string }
  | { type: "ADD_ROLE"; name: string; description: string }
  | { type: "UPDATE_ROLE"; roleId: string; name?: string; description?: string }
  | { type: "SET_ROLE_PERMISSION"; roleId: string; permission: Permission; allowed: boolean }
  | { type: "REMOVE_ROLE"; roleId: string }
  | {
      type: "SET_ROLE_GRANT";
      roleId: string;
      room: RoomSelector;
      scope: AccessScope;
      effect: Effect | "none";
    }
  | {
      type: "ADD_ROOM";
      name: string;
      purpose: string;
      width: number;
      depth: number;
      /** The room it is built against. Left empty when it goes along the corridor. */
      attachTo: string;
      /** A wall of that room, or "along" for the next free place along the corridor. */
      side: Wall | "along";
      /** True for a corridor: a room to walk through, which other rooms open onto. */
      corridor?: boolean;
    }
  | { type: "UPDATE_ROOM"; roomId: string; name?: string; purpose?: string }
  | { type: "SET_ROOM_RECORDS"; roomId: string; records: string[] }
  | { type: "REMOVE_ROOM"; roomId: string }
  | { type: "SET_STAGE_ROOM"; stage: ConfigurableStage; roomId: string };

/** Thrown when an operation is refused. The message is shown to the person. */
export class AdminError extends Error {}

const refuse = (message: string): never => {
  throw new AdminError(message);
};

const COLOURS = ["#c98a3c", "#7a5ea8", "#4a8c8c", "#b05a7a", "#8c6a3c", "#5b8a72", "#4f7fa8", "#a85f7a"];
const WALLS: Wall[] = ["north", "south", "east", "west"];
const DOOR_WIDTH = 1.4;
const MIN_ROOM = 4;
const MAX_ROOM = 24;

/** Names for an agent whose name was left empty. */
export const AGENT_NAMES = [
  "Ada", "Arlo", "Basil", "Cleo", "Dara", "Elio", "Esme", "Felix", "Greta", "Hugo",
  "Ines", "Juno", "Kai", "Lena", "Milo", "Nadia", "Nico", "Orla", "Pia", "Quinn",
  "Rafa", "Remy", "Sana", "Tess", "Theo", "Uma", "Vito", "Wren", "Yara", "Zeno",
];

/**
 * A name nobody in the office has yet. Which one is drawn from the new
 * agent's id, so the choice varies without this file reaching for chance.
 */
function spareName(office: Office, seed: string): string {
  const taken = new Set(office.participants.map((p) => p.displayName.toLowerCase()));
  const free = AGENT_NAMES.filter((n) => !taken.has(n.toLowerCase()));
  const draw = [...seed].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) >>> 0, 7);
  return free.length > 0 ? free[draw % free.length] : `Agent ${office.participants.length + 1}`;
}

const named = (value: string, what: string, max = 60): string => {
  const text = value.trim();
  if (text.length < 2 || text.length > max) refuse(`Enter ${what} (2 to ${max} characters).`);
  return text;
};

const roomName = (office: Office, id: string): string =>
  office.floorplan.rooms.find((r) => r.id === id)?.name ?? id;

/** Rebuild each room's desk list, which is derived from the desks. */
function withDesks(floorplan: Floorplan, desks: Desk[]): Floorplan {
  return {
    ...floorplan,
    desks,
    rooms: floorplan.rooms.map((room) => ({
      ...room,
      deskIds: desks.filter((d) => d.roomId === room.id).map((d) => d.id),
    })),
  };
}

/** The permission a person needs for each kind of set-up change. */
export function permissionFor(op: AdminOp): Permission {
  switch (op.type) {
    case "RENAME_OFFICE":
    case "CLEAR_WORK":
    case "SET_AUTO_HANDOFF":
      return "manage_office";
    case "ADD_AGENT":
    case "UPDATE_PARTICIPANT":
    case "REMOVE_PARTICIPANT":
    case "SET_PLAYBOOK":
      return "manage_people";
    case "ADD_ROLE":
    case "UPDATE_ROLE":
    case "REMOVE_ROLE":
    case "SET_ROLE_GRANT":
    case "SET_ROLE_PERMISSION":
      return "manage_roles";
    case "ADD_ROOM":
    case "UPDATE_ROOM":
    case "SET_ROOM_RECORDS":
    case "REMOVE_ROOM":
    case "SET_STAGE_ROOM":
      return "manage_rooms";
  }
}

const hasPermissions = (role: Role | undefined): boolean => (role?.permissions.length ?? 0) > 0;

/** Someone must always be able to repair the roles, or the office locks itself out. */
function requireRoleManager(office: Office): void {
  const keepers = office.participants.filter(
    (p) => p.kind === "human" && office.roles[p.roleId]?.permissions.includes("manage_roles"),
  );
  if (keepers.length === 0) refuse("That would leave the office with no person who can manage its roles.");
}

const short = (value: string, max: number): string => value.trim().slice(0, max);

/**
 * Check and tidy a playbook before it is stored. People and rooms it names
 * must exist. Empty parts become null, so a step only does what was filled in.
 */
function cleanPlaybook(office: Office, steps: PlaybookStep[], newId: () => string): PlaybookStep[] {
  if (steps.length > 30) refuse("A playbook can hold up to 30 steps.");
  const people = new Set(office.participants.map((p) => p.id));
  const rooms = new Set(office.floorplan.rooms.map((r) => r.id));
  return steps.map((step, index) => {
    const label = `Step ${index + 1}`;
    const stage = step.when.stage;
    if (stage !== "any" && !PLAYBOOK_STAGES.includes(stage)) refuse(`${label}: choose a stage.`);
    const requestedBy = step.when.requestedBy;
    if (requestedBy !== "anyone" && !people.has(requestedBy)) refuse(`${label}: that person is not in the office.`);

    const { output, question, assumption, need, action, note } = step.then;
    if (note && note.to !== "requester" && !people.has(note.to)) {
      refuse(`${label}: the note is addressed to someone who is not in the office.`);
    }
    const system = action ? office.systems.find((s) => s.id === action.systemId) : undefined;
    const fields = action && system ? checkedFields(system, action.operation, action.fields) : null;
    if (action && !system) refuse(`${label}: the connected system it uses does not exist.`);
    if (action && !fields) refuse(`${label}: fill in every field of the action.`);
    if (question && question.to !== "requester" && !people.has(question.to)) {
      refuse(`${label}: the question is addressed to someone who is not in the office.`);
    }
    if (need && !rooms.has(need.room)) refuse(`${label}: the room it needs does not exist.`);
    if (need && !ALL_SCOPES.includes(need.scope)) refuse(`${label}: choose a scope.`);

    const cleaned: PlaybookStep = {
      id: step.id || `pb-${newId()}`,
      when: { stage, requestContains: short(step.when.requestContains, 80), requestedBy },
      then: {
        statusNote: short(step.then.statusNote, 300),
        output:
          output && output.body.trim()
            ? { label: short(output.label, 60) || "Output", body: short(output.body, 1200) }
            : null,
        question:
          question && question.body.trim()
            ? {
                body: short(question.body, 400),
                to: question.to,
                blocking: question.blocking === true,
                options: question.options.map((o) => short(o, 80)).filter((o) => o.length > 0).slice(0, 4),
              }
            : null,
        assumption:
          assumption && assumption.assumed.trim()
            ? {
                assumed: short(assumption.assumed, 200),
                because: short(assumption.because, 300),
                confidence: ["low", "medium", "high"].includes(assumption.confidence) ? assumption.confidence : "medium",
              }
            : null,
        need: need ? { room: need.room, scope: need.scope, purpose: short(need.purpose, 200) } : null,
        action: action && fields ? { systemId: action.systemId, operation: action.operation, fields } : null,
        note: note && note.body.trim() ? { to: note.to, body: short(note.body, 400) } : null,
      },
    };
    const t = cleaned.then;
    if (!t.statusNote && !t.output && !t.question && !t.assumption && !t.need && !t.action && !t.note) {
      refuse(`${label} does nothing yet. Fill in at least one part under Then.`);
    }
    return cleaned;
  });
}

/** Where a participant shows up in the office's history, if anywhere. */
function historyOf(office: Office, id: string): string | null {
  if (office.tasks.some((t) => t.ownerId === id || t.requestedById === id)) return "tasks";
  const inMessages = office.messages.some(
    (m) =>
      m.fromId === id ||
      (m.audience.to === "participant" && m.audience.id === id) ||
      (m.kind === "assignment" && m.toParticipantId === id) ||
      (m.kind === "handoff" && (m.fromParticipantId === id || m.toParticipantId === id)),
  );
  if (inMessages) return "messages";
  if (office.rules.some((r) => r.grantedBy === id && r.participantId !== id)) return "access rules they granted";
  return null;
}

const overlaps = (a: Room["bounds"], b: Room["bounds"]): boolean =>
  a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.z < b.z + b.d - 0.01 && b.z < a.z + a.d - 0.01;

const opposite: Record<Wall, Wall> = { north: "south", south: "north", east: "west", west: "east" };

/**
 * Bounds for a new room placed against one wall of an existing room, with the
 * matching doors. South is low z, north is high z, west is low x, east is
 * high x. The two doors meet at the middle of the wall the rooms share.
 */
function attachRoom(
  target: Room,
  side: Wall,
  width: number,
  depth: number,
): { bounds: Room["bounds"]; doorAlong: number; targetAlong: number } {
  const t = target.bounds;
  if (side === "east" || side === "west") {
    const bounds = { x: side === "east" ? t.x + t.w : t.x - width, z: t.z, w: width, d: depth };
    const centre = t.z + Math.min(t.d, depth) / 2;
    return { bounds, doorAlong: (centre - bounds.z) / depth, targetAlong: (centre - t.z) / t.d };
  }
  const bounds = { x: t.x, z: side === "north" ? t.z + t.d : t.z - depth, w: width, d: depth };
  const centre = t.x + Math.min(t.w, width) / 2;
  return { bounds, doorAlong: (centre - bounds.x) / width, targetAlong: (centre - t.x) / t.w };
}

/**
 * The next free place along a corridor, on whichever of its long sides has
 * room nearest its start. When the place runs past the corridor's end, the
 * corridor is lengthened to reach it. Returns null when nothing fits.
 */
function placeAlong(
  corridor: Room,
  width: number,
  depth: number,
  rooms: Room[],
): { bounds: Room["bounds"]; side: Wall; grown: Room["bounds"] } | null {
  const c = corridor.bounds;
  const lengthwise = c.w >= c.d;
  const others = rooms.filter((r) => r.id !== corridor.id);
  const start = lengthwise ? c.x : c.z;
  const ends = others.map((r) => (lengthwise ? r.bounds.x + r.bounds.w : r.bounds.z + r.bounds.d));
  const starts = [start, ...ends.filter((e) => e > start)].sort((a, b) => a - b);

  let best: { bounds: Room["bounds"]; side: Wall; at: number } | null = null;
  for (const side of (lengthwise ? ["north", "south"] : ["east", "west"]) as Wall[]) {
    for (const at of starts) {
      const bounds = lengthwise
        ? { x: at, z: side === "north" ? c.z + c.d : c.z - depth, w: width, d: depth }
        : { x: side === "east" ? c.x + c.w : c.x - width, z: at, w: width, d: depth };
      if (others.some((r) => overlaps(r.bounds, bounds))) continue;
      if (!best || at < best.at) best = { bounds, side, at };
      break;
    }
  }
  if (!best) return null;
  const reach = lengthwise ? best.bounds.x + width - c.x : best.bounds.z + depth - c.z;
  const grown = lengthwise ? { ...c, w: Math.max(c.w, reach) } : { ...c, d: Math.max(c.d, reach) };
  if (others.some((r) => overlaps(r.bounds, grown))) return null;
  return { bounds: best.bounds, side: best.side, grown };
}

/** A room for walking through holds no desk and hosts no stage. */
const notCorridor = (room: Room, what: string): Room =>
  room.corridor ? refuse(`${what} in ${room.name}, which is only for walking through.`) : room;

function setRoleGrant(
  grants: AccessGrant[],
  room: RoomSelector,
  scope: AccessScope,
  effect: Effect | "none",
): AccessGrant[] {
  const without = grants
    .map((g) => (g.room === room ? { ...g, scopes: g.scopes.filter((s) => s !== scope) } : g))
    .filter((g) => g.scopes.length > 0);
  if (effect === "none") return without;

  const index = without.findIndex((g) => g.room === room && g.effect === effect);
  if (index === -1) return [...without, { room, scopes: [scope], effect }];
  return without.map((g, i) =>
    i === index ? { ...g, scopes: ALL_SCOPES.filter((s) => s === scope || g.scopes.includes(s)) } : g,
  );
}

/**
 * Apply one admin operation.
 *
 * @param actorId the supervising person making the change
 * @param newId   supplies a fresh unique suffix for anything created
 */
export function applyAdminOp(
  office: Office,
  op: AdminOp,
  actorId: string,
  newId: () => string,
  /** Ids of the office's AI providers, when the caller knows them. */
  providerIds?: ReadonlySet<string>,
): Office {
  const knownProvider = (id: string | null | undefined): string | null => {
    if (!id) return null;
    if (providerIds && !providerIds.has(id)) refuse("That AI provider does not exist in this office.");
    return id;
  };
  const { floorplan } = office;
  const findRoom = (id: string): Room =>
    floorplan.rooms.find((r) => r.id === id) ?? refuse("That room does not exist.");
  const findRole = (id: string): Role => office.roles[id] ?? refuse("That role does not exist.");
  const findPerson = (id: string): Participant =>
    office.participants.find((p) => p.id === id) ?? refuse("That person or agent does not exist.");
  // Nobody can hand out more than they hold themselves.
  const actorRole = office.roles[office.participants.find((p) => p.id === actorId)?.roleId ?? ""];
  const actorHolds = (permissions: Permission[]): boolean =>
    permissions.every((p) => actorRole?.permissions.includes(p));

  switch (op.type) {
    case "RENAME_OFFICE":
      return { ...office, name: named(op.name, "a name for the office") };

    case "SET_AUTO_HANDOFF":
      return { ...office, autoHandoff: op.on };

    case "CLEAR_WORK":
      // Grants made for one task go with the tasks. Standing rules stay.
      return {
        ...office,
        tasks: [],
        messages: [],
        rules: office.rules.filter((r) => r.expiresOnTaskId === undefined),
      };

    case "ADD_AGENT": {
      const suffix = newId();
      const displayName = op.displayName.trim() ? named(op.displayName, "the agent's name") : spareName(office, suffix);
      const title = named(op.title, "the agent's title");
      const role = findRole(op.roleId);
      const room = notCorridor(findRoom(op.roomId), "Nobody has a desk");
      if (hasPermissions(role)) refuse("An agent cannot hold a role that carries permissions.");
      if (op.agentType !== "ai" && op.agentType !== "playbook") refuse("Choose what kind of agent this is.");
      const spot = freeDeskSpot(floorplan, room.id) ?? refuse(`${room.name} has no space for another desk.`);

      const desk: Desk = {
        id: `desk-${suffix}`,
        roomId: room.id,
        position: spot,
        facing: 0,
        occupantId: `p-${suffix}`,
      };
      const agent: Participant = {
        id: `p-${suffix}`,
        kind: "agent",
        displayName,
        title,
        roleId: role.id,
        deskId: desk.id,
        capabilities: op.capabilities.map((c) => c.trim()).filter((c) => c.length > 0).slice(0, 8),
        backing: null,
        agentType: op.agentType,
        providerId: op.agentType === "ai" ? knownProvider(op.providerId) : null,
        model: op.agentType === "ai" && op.model?.trim() ? op.model.trim().slice(0, 80) : null,
        playbook: [],
        appearance: { color: COLOURS[office.participants.length % COLOURS.length] },
      };
      return {
        ...office,
        floorplan: withDesks(floorplan, [...floorplan.desks, desk]),
        participants: [...office.participants, agent],
      };
    }

    case "UPDATE_PARTICIPANT": {
      const person = findPerson(op.participantId);
      let next: Participant = person;
      let desks = floorplan.desks;

      if (op.displayName !== undefined) next = { ...next, displayName: named(op.displayName, "a name") };
      if (op.title !== undefined) next = { ...next, title: named(op.title, "a title") };
      if (op.capabilities !== undefined) {
        next = {
          ...next,
          capabilities: op.capabilities.map((c) => c.trim()).filter((c) => c.length > 0).slice(0, 8),
        };
      }
      if (op.roleId !== undefined && op.roleId !== person.roleId) {
        const role = findRole(op.roleId);
        if (hasPermissions(role) && person.kind === "agent") {
          refuse("An agent cannot hold a role that carries permissions.");
        }
        if (!actorHolds(role.permissions)) {
          refuse(`You can only give someone a role whose permissions you hold yourself. ${role.name} has more.`);
        }
        next = { ...next, roleId: role.id };
      }
      if (op.agentType !== undefined || op.providerId !== undefined || op.model !== undefined) {
        if (person.kind !== "agent") refuse("Only an agent has these settings.");
        const agentType = op.agentType ?? next.agentType ?? "playbook";
        next = {
          ...next,
          agentType,
          providerId:
            agentType === "ai" ? (op.providerId !== undefined ? knownProvider(op.providerId) : next.providerId) : null,
          model:
            agentType === "ai"
              ? op.model !== undefined
                ? op.model?.trim()
                  ? op.model.trim().slice(0, 80)
                  : null
                : next.model
              : null,
        };
      }
      if (op.roomId !== undefined) {
        const room = notCorridor(findRoom(op.roomId), "Nobody has a desk");
        const current = desks.find((d) => d.id === person.deskId);
        if (current?.roomId !== room.id) {
          const spot = freeDeskSpot(floorplan, room.id) ?? refuse(`${room.name} has no space for another desk.`);
          if (current) {
            desks = desks.map((d) => (d.id === current.id ? { ...d, roomId: room.id, position: spot } : d));
          } else {
            const desk: Desk = {
              id: `desk-${newId()}`,
              roomId: room.id,
              position: spot,
              facing: 0,
              occupantId: person.id,
            };
            desks = [...desks, desk];
            next = { ...next, deskId: desk.id };
          }
        }
      }

      const updated: Office = {
        ...office,
        floorplan: desks === floorplan.desks ? floorplan : withDesks(floorplan, desks),
        participants: office.participants.map((p) => (p.id === person.id ? next : p)),
      };
      requireRoleManager(updated);
      return updated;
    }

    case "SET_PLAYBOOK": {
      const person = findPerson(op.participantId);
      if (person.kind !== "agent") refuse("Only an agent has a playbook.");
      const playbook = cleanPlaybook(office, op.steps, newId);
      return {
        ...office,
        participants: office.participants.map((p) => (p.id === person.id ? { ...p, playbook } : p)),
      };
    }

    case "REMOVE_PARTICIPANT": {
      const person = findPerson(op.participantId);
      if (person.id === actorId) refuse("You cannot remove yourself.");
      const history = historyOf(office, person.id);
      if (history) {
        refuse(
          `${person.displayName} appears in the office's ${history}. Clear the work first, or change their role instead.`,
        );
      }
      const updated: Office = {
        ...office,
        floorplan: withDesks(
          floorplan,
          floorplan.desks.filter((d) => d.id !== person.deskId),
        ),
        participants: office.participants.filter((p) => p.id !== person.id),
        rules: office.rules.filter((r) => r.participantId !== person.id),
      };
      requireRoleManager(updated);
      return updated;
    }

    case "ADD_ROLE": {
      const name = named(op.name, "a name for the role");
      if (Object.values(office.roles).some((r) => r.name.toLowerCase() === name.toLowerCase())) {
        refuse("A role with that name already exists.");
      }
      const id = `role-${newId()}`;
      const role: Role = {
        id,
        name,
        description: op.description.trim().slice(0, 200),
        permissions: [],
        // A new role may walk the corridors and nothing more.
        grants: floorplan.rooms.filter((r) => r.corridor).map((r) => ({ room: r.id, scopes: ["enter"], effect: "allow" })),
      };
      return { ...office, roles: { ...office.roles, [id]: role } };
    }

    case "UPDATE_ROLE": {
      const role = findRole(op.roleId);
      const next: Role = {
        ...role,
        ...(op.name !== undefined ? { name: named(op.name, "a name for the role") } : {}),
        ...(op.description !== undefined ? { description: op.description.trim().slice(0, 200) } : {}),
      };
      return { ...office, roles: { ...office.roles, [role.id]: next } };
    }

    case "SET_ROLE_PERMISSION": {
      const role = findRole(op.roleId);
      if (!PERMISSIONS.includes(op.permission)) refuse("Unknown permission.");
      if (op.allowed && !actorHolds([op.permission])) refuse("You can only grant a permission you hold yourself.");
      if (op.allowed && office.participants.some((p) => p.kind === "agent" && p.roleId === role.id)) {
        refuse("Agents hold this role, and permissions are for people. Give the agents another role first.");
      }
      const permissions = PERMISSIONS.filter((p) =>
        p === op.permission ? op.allowed : role.permissions.includes(p),
      );
      const updated: Office = { ...office, roles: { ...office.roles, [role.id]: { ...role, permissions } } };
      requireRoleManager(updated);
      return updated;
    }

    case "REMOVE_ROLE": {
      const role = findRole(op.roleId);
      const holders = office.participants.filter((p) => p.roleId === role.id);
      if (holders.length > 0) {
        refuse(`${holders.map((p) => p.displayName).join(", ")} still hold the ${role.name} role.`);
      }
      const { [role.id]: _removed, ...rest } = office.roles;
      return { ...office, roles: rest };
    }

    case "SET_ROLE_GRANT": {
      const role = findRole(op.roleId);
      if (op.room !== ANY_ROOM) findRoom(op.room);
      if (!ALL_SCOPES.includes(op.scope)) refuse("Unknown scope.");
      const next: Role = { ...role, grants: setRoleGrant(role.grants, op.room, op.scope, op.effect) };
      return { ...office, roles: { ...office.roles, [role.id]: next } };
    }

    case "ADD_ROOM": {
      const name = named(op.name, "a name for the room");
      const purpose = op.purpose.trim().slice(0, 120);
      const width = Math.round(op.width);
      const depth = Math.round(op.depth);
      const least = op.corridor ? 2 : MIN_ROOM;
      if (![width, depth].every((n) => Number.isFinite(n) && n >= least && n <= MAX_ROOM)) {
        refuse(`Width and depth must be between ${least} and ${MAX_ROOM} metres.`);
      }
      if (floorplan.rooms.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
        refuse("A room with that name already exists.");
      }

      // Where the room goes, which wall of its neighbour the door is in, and
      // how far along each wall the two doors sit.
      let target: Room;
      let wall: Wall;
      let bounds: Room["bounds"];
      let doorAlong: number;
      let targetAlong: number;
      let grown: Room["bounds"] | null = null;
      if (op.side === "along") {
        target =
          floorplan.rooms.find((r) => r.corridor && (!op.attachTo || r.id === op.attachTo)) ??
          refuse("This office has no corridor. Choose a room and a wall to build against.");
        const place =
          placeAlong(target, width, depth, floorplan.rooms) ??
          refuse(`There is no space left along ${target.name}. Choose a room and a wall to build against.`);
        ({ bounds, side: wall, grown } = place);
        const lengthwise = grown.w >= grown.d;
        doorAlong = 0.5;
        targetAlong = lengthwise
          ? (bounds.x + width / 2 - grown.x) / grown.w
          : (bounds.z + depth / 2 - grown.z) / grown.d;
      } else {
        if (!WALLS.includes(op.side)) refuse("Choose which wall to attach the room to.");
        target = findRoom(op.attachTo);
        wall = op.side;
        ({ bounds, doorAlong, targetAlong } = attachRoom(target, wall, width, depth));
        const blocker = floorplan.rooms.find((r) => overlaps(r.bounds, bounds));
        if (blocker) {
          refuse(`There is no space there. ${blocker.name} is in the way. Try another wall or a smaller room.`);
        }
      }

      const suffix = newId();
      const id = `room-${suffix}`;
      const room: Room = {
        id,
        name,
        purpose,
        bounds,
        doors: [{ id: `door-${suffix}-a`, toRoomId: target.id, wall: opposite[wall], along: doorAlong, width: DOOR_WIDTH }],
        deskIds: [],
        records: [],
        ...(op.corridor ? { corridor: true } : {}),
      };
      // A corridor that grew keeps its doors where they stand, so their
      // places along the longer wall are worked out again.
      const before = target.bounds;
      const after = grown ?? before;
      const stretch = (door: Room["doors"][number]): Room["doors"][number] => {
        const alongLength = door.wall === "north" || door.wall === "south";
        const was = alongLength ? before.w : before.d;
        const now = alongLength ? after.w : after.d;
        return was === now ? door : { ...door, along: (door.along * was) / now };
      };
      const rooms = floorplan.rooms.map((r) =>
        r.id === target.id
          ? {
              ...r,
              bounds: after,
              doors: [
                ...r.doors.map(stretch),
                { id: `door-${suffix}-b`, toRoomId: id, wall, along: targetAlong, width: DOOR_WIDTH },
              ],
            }
          : r,
      );
      // Everyone may walk a corridor, so each role is let into a new one.
      const roles = op.corridor
        ? Object.fromEntries(
            Object.entries(office.roles).map(([key, role]) => [key, { ...role, grants: setRoleGrant(role.grants, id, "enter", "allow") }]),
          )
        : office.roles;
      return { ...office, roles, floorplan: { ...floorplan, rooms: [...rooms, room] } };
    }

    case "UPDATE_ROOM": {
      const room = findRoom(op.roomId);
      const next: Room = {
        ...room,
        ...(op.name !== undefined ? { name: named(op.name, "a name for the room") } : {}),
        ...(op.purpose !== undefined ? { purpose: op.purpose.trim().slice(0, 120) } : {}),
      };
      return {
        ...office,
        floorplan: { ...floorplan, rooms: floorplan.rooms.map((r) => (r.id === room.id ? next : r)) },
      };
    }

    case "SET_ROOM_RECORDS": {
      const room = findRoom(op.roomId);
      const records = op.records.map((r) => r.trim().replace(/\s+/g, " ")).filter((r) => r.length > 0);
      if (records.length > 40) refuse("A room can hold up to 40 records.");
      if (records.some((r) => r.length > 300)) refuse("Keep each record under 300 characters.");
      return {
        ...office,
        floorplan: { ...floorplan, rooms: floorplan.rooms.map((r) => (r.id === room.id ? { ...room, records } : r)) },
      };
    }

    case "REMOVE_ROOM": {
      const room = findRoom(op.roomId);
      if (floorplan.rooms.length === 1) refuse("An office needs at least one room.");
      const stage = CONFIGURABLE_STAGES.find((s) => office.stageRooms[s] === room.id);
      if (stage) refuse(`${room.name} hosts the ${stage} stage. Move that stage to another room first.`);
      const seated = office.participants.filter((p) =>
        floorplan.desks.some((d) => d.id === p.deskId && d.roomId === room.id),
      );
      if (seated.length > 0) {
        refuse(`${seated.map((p) => p.displayName).join(", ")} still sit in ${room.name}. Move them first.`);
      }
      if (office.tasks.some((t) => t.roomId === room.id)) refuse(`There is work in ${room.name}.`);
      const inThread = office.messages.some(
        (m) =>
          m.roomId === room.id ||
          (m.audience.to === "room" && m.audience.id === room.id) ||
          (m.kind === "handoff" && m.toRoomId === room.id),
      );
      if (inThread) refuse(`${room.name} is part of the office's message history. Clear the work first.`);

      // A room that no longer exists has no policy: its grants and rules go too.
      const roles = Object.fromEntries(
        Object.entries(office.roles).map(([id, role]) => [
          id,
          { ...role, grants: role.grants.filter((g) => g.room !== room.id) },
        ]),
      );
      return {
        ...office,
        roles,
        rules: office.rules.filter((r) => r.room !== room.id),
        floorplan: withDesks(
          {
            ...floorplan,
            rooms: floorplan.rooms
              .filter((r) => r.id !== room.id)
              .map((r) => ({ ...r, doors: r.doors.filter((d) => d.toRoomId !== room.id) })),
          },
          floorplan.desks.filter((d) => d.roomId !== room.id),
        ),
      };
    }

    case "SET_STAGE_ROOM": {
      if (!CONFIGURABLE_STAGES.includes(op.stage)) refuse("Unknown stage.");
      const room = notCorridor(findRoom(op.roomId), "No stage of the work is done");
      return { ...office, stageRooms: { ...office.stageRooms, [op.stage]: room.id } };
    }
  }
}

/**
 * An office with nothing in it yet: one room, one supervising person, two
 * roles to start from, and no agents, work or rules. Every id carries the
 * given suffix, so many such offices can live in one database.
 */
export function blankOffice(input: {
  suffix: string;
  name: string;
  admin: { displayName: string; title: string };
}): Office {
  const { suffix } = input;
  const roomId = `room-${suffix}`;
  const deskId = `desk-${suffix}`;
  const adminId = `p-${suffix}`;
  const adminRole = `role-${suffix}-admin`;
  const memberRole = `role-${suffix}-member`;
  const hallId = `hall-${suffix}`;
  // A corridor with the first room opening onto it. Rooms added later line
  // up along the corridor, which lengthens to take them.
  const hall: Room = {
    id: hallId,
    name: "Corridor",
    purpose: "Every room opens onto it",
    bounds: { x: 0, z: 0, w: 24, d: 3 },
    doors: [
      { id: `door-${suffix}-out`, toRoomId: null, wall: "west", along: 0.5, width: 1.6 },
      { id: `door-${suffix}-b`, toRoomId: roomId, wall: "north", along: 0.25, width: DOOR_WIDTH },
    ],
    deskIds: [],
    records: [],
    corridor: true,
  };
  const main: Room = {
    id: roomId,
    name: "Main room",
    purpose: "Everything happens here until more rooms are added",
    bounds: { x: 0, z: 3, w: 12, d: 10 },
    doors: [{ id: `door-${suffix}-a`, toRoomId: hallId, wall: "south", along: 0.5, width: DOOR_WIDTH }],
    deskIds: [deskId],
    records: [],
  };
  return {
    id: `o-${suffix}`,
    name: named(input.name, "a name for the office"),
    floorplan: {
      id: `fp-${suffix}`,
      name: "Floor plan",
      description: "",
      rooms: [main, hall],
      desks: [{ id: deskId, roomId, position: { x: 6, z: 8 }, facing: Math.PI, occupantId: adminId }],
    },
    stageRooms: { intake: roomId, planning: roomId, execution: roomId, review: roomId },
    participants: [
      {
        id: adminId,
        kind: "human",
        displayName: input.admin.displayName,
        title: input.admin.title,
        roleId: adminRole,
        deskId,
        capabilities: [],
        backing: null,
        agentType: null,
        providerId: null,
        model: null,
        playbook: [],
        appearance: { color: "#2f6f4f" },
      },
    ],
    roles: {
      [adminRole]: {
        id: adminRole,
        name: "Administrator",
        description: "Sets up the office and oversees the work.",
        permissions: [...PERMISSIONS],
        grants: [{ room: ANY_ROOM, scopes: ALL_SCOPES, effect: "allow" }],
      },
      [memberRole]: {
        id: memberRole,
        name: "Member",
        description: "Works in the main room.",
        permissions: [],
        grants: [
          { room: roomId, scopes: ALL_SCOPES, effect: "allow" },
          { room: hallId, scopes: ["enter"], effect: "allow" },
        ],
      },
    },
    rules: [],
    tasks: [],
    messages: [],
    systems: [],
    autoHandoff: true,
  };
}

const text = (value: unknown, max = 200): value is string => typeof value === "string" && value.length <= max;
const optionalText = (value: unknown, max = 200): string | undefined => (text(value, max) ? value : undefined);

/** Read playbook steps out of untrusted JSON, keeping only known fields. */
function parseSteps(input: unknown[]): PlaybookStep[] {
  const str = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");
  const obj = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  return input.slice(0, 40).flatMap((raw) => {
    const step = obj(raw);
    const when = obj(step?.when);
    const then = obj(step?.then);
    if (!step || !when || !then) return [];
    const output = obj(then.output);
    const question = obj(then.question);
    const assumption = obj(then.assumption);
    const need = obj(then.need);
    const action = obj(then.action);
    const note = obj(then.note);
    const fields = obj(action?.fields) ?? {};
    return [
      {
        id: str(step.id, 60),
        when: {
          stage: str(when.stage, 20) as PlaybookStep["when"]["stage"],
          requestContains: str(when.requestContains, 200),
          requestedBy: str(when.requestedBy, 60) || "anyone",
        },
        then: {
          statusNote: str(then.statusNote, 600),
          output: output ? { label: str(output.label, 200), body: str(output.body, 4000) } : null,
          question: question
            ? {
                body: str(question.body, 1000),
                to: str(question.to, 60) || "requester",
                blocking: question.blocking === true,
                options: Array.isArray(question.options)
                  ? question.options.filter((o): o is string => typeof o === "string").slice(0, 8)
                  : [],
              }
            : null,
          assumption: assumption
            ? {
                assumed: str(assumption.assumed, 600),
                because: str(assumption.because, 600),
                confidence: str(assumption.confidence, 10) as "low" | "medium" | "high",
              }
            : null,
          need: need
            ? { room: str(need.room, 60), scope: str(need.scope, 10) as AccessScope, purpose: str(need.purpose, 600) }
            : null,
          action: action
            ? {
                systemId: str(action.systemId, 60),
                operation: str(action.operation, 40),
                fields: Object.fromEntries(
                  Object.entries(fields)
                    .slice(0, 12)
                    .map(([name, value]) => [name.slice(0, 40), str(value, 400)]),
                ),
              }
            : null,
          note: note ? { to: str(note.to, 60) || "requester", body: str(note.body, 1000) } : null,
        },
      },
    ];
  });
}

/** Turn untrusted JSON into an admin operation, or null when it is not one. */
export function parseAdminOp(input: unknown): AdminOp | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => text(v, 120)).slice(0, 8) : [];

  switch (o.type) {
    case "RENAME_OFFICE":
      return text(o.name) ? { type: "RENAME_OFFICE", name: o.name } : null;
    case "CLEAR_WORK":
      return { type: "CLEAR_WORK" };
    case "SET_AUTO_HANDOFF":
      return typeof o.on === "boolean" ? { type: "SET_AUTO_HANDOFF", on: o.on } : null;
    case "ADD_AGENT":
      return (text(o.displayName) || o.displayName === "" || o.displayName === undefined) &&
        text(o.title) &&
        text(o.roleId, 60) &&
        text(o.roomId, 60)
        ? {
            type: "ADD_AGENT",
            displayName: text(o.displayName) ? o.displayName : "",
            title: o.title,
            roleId: o.roleId,
            roomId: o.roomId,
            capabilities: list(o.capabilities),
            agentType: o.agentType === "ai" ? "ai" : "playbook",
            providerId: text(o.providerId, 80) ? o.providerId : null,
            model: text(o.model, 80) ? o.model : null,
          }
        : null;
    case "SET_PLAYBOOK":
      return text(o.participantId, 60) && Array.isArray(o.steps)
        ? { type: "SET_PLAYBOOK", participantId: o.participantId, steps: parseSteps(o.steps) }
        : null;
    case "UPDATE_PARTICIPANT":
      return text(o.participantId, 60)
        ? {
            type: "UPDATE_PARTICIPANT",
            participantId: o.participantId,
            ...(optionalText(o.displayName) !== undefined ? { displayName: o.displayName as string } : {}),
            ...(optionalText(o.title) !== undefined ? { title: o.title as string } : {}),
            ...(optionalText(o.roleId, 60) !== undefined ? { roleId: o.roleId as string } : {}),
            ...(optionalText(o.roomId, 60) !== undefined ? { roomId: o.roomId as string } : {}),
            ...(Array.isArray(o.capabilities) ? { capabilities: list(o.capabilities) } : {}),
            ...(o.agentType === "ai" || o.agentType === "playbook" ? { agentType: o.agentType } : {}),
            ...(o.providerId === null || text(o.providerId, 80) ? { providerId: o.providerId as string | null } : {}),
            ...(o.model === null || text(o.model, 80) ? { model: o.model as string | null } : {}),
          }
        : null;
    case "REMOVE_PARTICIPANT":
      return text(o.participantId, 60) ? { type: "REMOVE_PARTICIPANT", participantId: o.participantId } : null;
    case "ADD_ROLE":
      return text(o.name)
        ? {
            type: "ADD_ROLE",
            name: o.name,
            description: optionalText(o.description) ?? "",
          }
        : null;
    case "SET_ROLE_PERMISSION":
      return text(o.roleId, 60) && PERMISSIONS.includes(o.permission as Permission) && typeof o.allowed === "boolean"
        ? { type: "SET_ROLE_PERMISSION", roleId: o.roleId, permission: o.permission as Permission, allowed: o.allowed }
        : null;
    case "UPDATE_ROLE":
      return text(o.roleId, 60)
        ? {
            type: "UPDATE_ROLE",
            roleId: o.roleId,
            ...(optionalText(o.name) !== undefined ? { name: o.name as string } : {}),
            ...(optionalText(o.description) !== undefined ? { description: o.description as string } : {}),
          }
        : null;
    case "REMOVE_ROLE":
      return text(o.roleId, 60) ? { type: "REMOVE_ROLE", roleId: o.roleId } : null;
    case "SET_ROLE_GRANT":
      return text(o.roleId, 60) &&
        text(o.room, 60) &&
        ALL_SCOPES.includes(o.scope as AccessScope) &&
        (o.effect === "allow" || o.effect === "deny" || o.effect === "none")
        ? {
            type: "SET_ROLE_GRANT",
            roleId: o.roleId,
            room: o.room,
            scope: o.scope as AccessScope,
            effect: o.effect,
          }
        : null;
    case "ADD_ROOM":
      return text(o.name) &&
        typeof o.width === "number" &&
        typeof o.depth === "number" &&
        (o.side === "along" ? o.attachTo === undefined || text(o.attachTo, 60) : text(o.attachTo, 60) && WALLS.includes(o.side as Wall))
        ? {
            type: "ADD_ROOM",
            name: o.name,
            purpose: optionalText(o.purpose) ?? "",
            width: o.width,
            depth: o.depth,
            attachTo: text(o.attachTo, 60) ? o.attachTo : "",
            side: o.side as Wall | "along",
            ...(o.corridor === true ? { corridor: true } : {}),
          }
        : null;
    case "UPDATE_ROOM":
      return text(o.roomId, 60)
        ? {
            type: "UPDATE_ROOM",
            roomId: o.roomId,
            ...(optionalText(o.name) !== undefined ? { name: o.name as string } : {}),
            ...(optionalText(o.purpose) !== undefined ? { purpose: o.purpose as string } : {}),
          }
        : null;
    case "SET_ROOM_RECORDS":
      return text(o.roomId, 60) && Array.isArray(o.records)
        ? {
            type: "SET_ROOM_RECORDS",
            roomId: o.roomId,
            records: o.records.filter((r): r is string => typeof r === "string").slice(0, 60),
          }
        : null;
    case "REMOVE_ROOM":
      return text(o.roomId, 60) ? { type: "REMOVE_ROOM", roomId: o.roomId } : null;
    case "SET_STAGE_ROOM":
      return CONFIGURABLE_STAGES.includes(o.stage as ConfigurableStage) && text(o.roomId, 60)
        ? { type: "SET_STAGE_ROOM", stage: o.stage as ConfigurableStage, roomId: o.roomId }
        : null;
    default:
      return null;
  }
}
