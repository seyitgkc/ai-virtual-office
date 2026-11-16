/**
 * What a new office still needs before work can run through it, worked out
 * from the office as it stands. Shown to whoever sets the office up until the
 * first request is filed.
 */
import { eligibleOwners } from "./engine";
import { canOwnWorkIn, type Office } from "./model";
import { contextOf } from "./policy";

export type SetupTab = "rooms" | "roles" | "people" | "providers" | "systems";

export interface SetupStep {
  id: string;
  label: string;
  /** What to do, or what is still missing, in one sentence. */
  detail: string;
  done: boolean;
  /** A step the office works without. */
  optional: boolean;
  /** The Settings tab where it is done, or null for a step done in the office itself. */
  tab: SetupTab | null;
}

const STAGES = ["intake", "planning", "execution", "review"] as const;

const listed = (names: string[]): string =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

export function setupSteps(office: Office, now: number, providers: { id: string; usable: boolean }[]): SetupStep[] {
  const ctx = contextOf(office, now);
  const rooms = office.floorplan.rooms.filter((r) => !r.corridor);
  const stageRooms = [...new Set(STAGES.map((s) => office.stageRooms[s]))]
    .map((id) => office.floorplan.rooms.find((r) => r.id === id))
    .filter((r) => r !== undefined);
  const agents = office.participants.filter((p) => p.kind === "agent");

  // A role is ready for a room when someone holding it could own work there.
  // A stand-in with the role and no rules of their own answers that.
  const staffRoles = Object.values(office.roles).filter((r) => r.permissions.length === 0);
  const roleCanWorkIn = (roomId: string): boolean =>
    staffRoles.some(
      (role) =>
        canOwnWorkIn({ ...office.participants[0], id: "nobody", kind: "agent", roleId: role.id }, roomId, ctx).effect === "allow",
    );
  const noRole = stageRooms.filter((r) => !roleCanWorkIn(r.id)).map((r) => r.name);
  const noAgent = stageRooms
    .filter((r) => !eligibleOwners(office, r.id, ctx).some((p) => p.kind === "agent"))
    .map((r) => r.name);

  const ai = agents.filter((p) => p.agentType === "ai");
  const usable = new Set(providers.filter((p) => p.usable).map((p) => p.id));
  const noProvider = ai.filter((p) => !p.providerId || !usable.has(p.providerId)).map((p) => p.displayName);

  return [
    {
      id: "rooms",
      label: "Add the rooms the work passes through",
      detail:
        rooms.length > 1
          ? `${rooms.length} rooms stand along the corridor.`
          : "One room does every stage. Add a room for each kind of work that should have its own access, then choose which room hosts each stage.",
      done: rooms.length > 1,
      optional: true,
      tab: "rooms",
    },
    {
      id: "roles",
      label: "Give a role the right to work in each room",
      detail:
        noRole.length === 0
          ? "Every room that hosts a stage has a role that may work in it."
          : `No role without permissions may enter and act in ${listed(noRole)}.`,
      done: noRole.length === 0,
      optional: false,
      tab: "roles",
    },
    {
      id: "agents",
      label: "Seat an agent in each room that hosts a stage",
      detail: noAgent.length === 0 ? "Every stage has an agent who can take it." : `Nobody can take the work in ${listed(noAgent)}.`,
      done: noAgent.length === 0,
      optional: false,
      tab: "people",
    },
    {
      id: "provider",
      label: "Give each AI agent a provider",
      detail:
        ai.length === 0
          ? "There are no AI agents. Playbook agents need no provider."
          : noProvider.length === 0
            ? "Every AI agent has a provider with a working key."
            : `${listed(noProvider)} ${noProvider.length === 1 ? "has" : "have"} no provider with a working key.`,
      done: noProvider.length === 0,
      optional: ai.length === 0,
      tab: "providers",
    },
    {
      id: "systems",
      label: "Connect the systems the work is done in",
      detail:
        office.systems.length > 0
          ? `${listed(office.systems.map((s) => s.name))} ${office.systems.length === 1 ? "is" : "are"} connected.`
          : "Without one, agents can read records and write, and cannot place an order or book anything.",
      done: office.systems.length > 0,
      optional: true,
      tab: "systems",
    },
    {
      id: "request",
      label: "File the first request",
      detail: "Use New request in the work list. It goes to whoever takes intake.",
      done: office.tasks.length > 0,
      optional: false,
      tab: null,
    },
  ];
}
