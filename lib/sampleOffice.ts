/**
 * A ready-made office for someone who has signed in: the distributor from
 * the demo, with the same rooms, roles and records, but with AI agents in
 * place of the playbook agents and the person themselves as its manager.
 * It starts with no work, so the first request is theirs.
 *
 * Every id is given a suffix of its own, because ids are unique across the
 * offices in one database.
 */
import type { Office, Participant } from "./model";
import { office as seeded } from "./seed";

export function sampleOffice(input: {
  suffix: string;
  name: string;
  manager: { displayName: string };
  /** The AI provider every agent starts on. */
  providerId: string;
}): Office {
  const id = (original: string): string => `${original}-${input.suffix}`;
  const room = (original: string): string => (original === "*" ? original : id(original));

  // The demo's two people become one: whoever is setting this office up.
  const manager = seeded.participants.find((p) => p.id === "p-dana")!;
  const kept = seeded.participants.filter((p) => p.kind === "agent" || p.id === manager.id);
  const keptIds = new Set(kept.map((p) => p.id));
  const desks = seeded.floorplan.desks.filter((d) => d.occupantId !== null && keptIds.has(d.occupantId));
  const deskIds = new Set(desks.map((d) => d.id));

  const participants: Participant[] = kept.map((p) => ({
    ...p,
    id: id(p.id),
    roleId: id(p.roleId),
    deskId: p.deskId ? id(p.deskId) : null,
    ...(p.id === manager.id
      ? { displayName: input.manager.displayName }
      : { agentType: "ai" as const, providerId: input.providerId, model: null, playbook: [], backing: null }),
  }));

  return {
    id: `office-${input.suffix}`,
    name: input.name,
    floorplan: {
      id: `fp-${input.suffix}`,
      name: seeded.floorplan.name,
      description: seeded.floorplan.description,
      rooms: seeded.floorplan.rooms.map((r) => ({
        ...r,
        id: id(r.id),
        doors: r.doors.map((d) => ({ ...d, id: id(d.id), toRoomId: d.toRoomId ? id(d.toRoomId) : null })),
        deskIds: r.deskIds.filter((d) => deskIds.has(d)).map(id),
      })),
      desks: desks.map((d) => ({ ...d, id: id(d.id), roomId: id(d.roomId), occupantId: d.occupantId ? id(d.occupantId) : null })),
    },
    stageRooms: {
      intake: id(seeded.stageRooms.intake),
      planning: id(seeded.stageRooms.planning),
      execution: id(seeded.stageRooms.execution),
      review: id(seeded.stageRooms.review),
    },
    participants,
    roles: Object.fromEntries(
      Object.values(seeded.roles).map((r) => [
        id(r.id),
        { ...r, id: id(r.id), grants: r.grants.map((g) => ({ ...g, room: room(g.room) })) },
      ]),
    ),
    rules: [],
    tasks: [],
    messages: [],
    systems: [],
    autoHandoff: true,
  };
}
