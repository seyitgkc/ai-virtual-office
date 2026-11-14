/**
 * Checks the admin operations: rooms, roles, people and agents, and an office
 * built from nothing. Run: npx tsx scripts/admin.ts
 */
import { AdminError, applyAdminOp, blankOffice, parseAdminOp, type AdminOp } from "../lib/admin";
import { reduce, ScriptedRuntime } from "../lib/engine";
import { obstacles, planExtent, roomAt, stepWalker } from "../lib/geometry";
import { initialState } from "../lib/initialState";
import { resolveAccess, type Office } from "../lib/model";
import { contextOf } from "../lib/policy";

let failures = 0;
function expect(label: string, actual: unknown, wanted: unknown): void {
  const ok = actual === wanted;
  if (!ok) failures++;
  console.log(`${ok ? "pass" : "FAIL"}  ${label}${ok ? "" : `  (got ${String(actual)})`}`);
}

let counter = 0;
const newId = (): string => `t${++counter}`;
const apply = (office: Office, op: AdminOp, actor = "p-dana"): Office => applyAdminOp(office, op, actor, newId);
const refusal = (office: Office, op: AdminOp, actor = "p-dana"): string | null => {
  try {
    apply(office, op, actor);
    return null;
  } catch (error) {
    if (error instanceof AdminError) return error.message;
    throw error;
  }
};

async function main(): Promise<void> {
  const seed = initialState.office;

  console.log("\n-- rooms --");
  let office = apply(seed, {
    type: "ADD_ROOM",
    name: "Warehouse",
    purpose: "Goods in and out",
    width: 8,
    depth: 8,
    attachTo: "finance",
    side: "east",
  });
  const warehouse = office.floorplan.rooms.find((r) => r.name === "Warehouse")!;
  expect("a room is added", office.floorplan.rooms.length, seed.floorplan.rooms.length + 1);
  expect("it sits against Finance's east wall", warehouse.bounds.x, 30);
  expect("it has a door back to Finance", warehouse.doors[0].toRoomId, "finance");
  expect(
    "Finance gained a door to it",
    office.floorplan.rooms.find((r) => r.id === "finance")!.doors.some((d) => d.toRoomId === warehouse.id),
    true,
  );
  {
    const all = obstacles(office.floorplan);
    const ext = planExtent(office.floorplan.rooms);
    const bounds = { minX: ext.minX - 3, maxX: ext.maxX + 3, minZ: ext.minZ - 3, maxZ: ext.maxZ + 3 };
    let at = { x: 28.5, z: 4 };
    for (let i = 0; i < 60; i++) at = stepWalker(at, 0.05, 0, all, 0.3, bounds);
    expect("the new doorway can be walked through", roomAt(office.floorplan.rooms, at.x, at.z)?.id, warehouse.id);
  }
  expect(
    "a room that would overlap another is refused",
    refusal(seed, { type: "ADD_ROOM", name: "Annex", purpose: "", width: 8, depth: 8, attachTo: "reception", side: "east" }) !== null,
    true,
  );
  expect(
    "a room of absurd size is refused",
    refusal(seed, { type: "ADD_ROOM", name: "Hangar", purpose: "", width: 400, depth: 8, attachTo: "finance", side: "east" }) !== null,
    true,
  );
  expect(
    "renaming a room",
    apply(office, { type: "UPDATE_ROOM", roomId: warehouse.id, name: "Stockroom" }).floorplan.rooms.at(-1)!.name,
    "Stockroom",
  );
  expect("a room that hosts a stage cannot be removed", refusal(seed, { type: "REMOVE_ROOM", roomId: "finance" })?.includes("review"), true);
  expect("a room with people in it cannot be removed", refusal(seed, { type: "REMOVE_ROOM", roomId: "operations" })?.includes("Dana"), true);
  const withoutWarehouse = apply(office, { type: "REMOVE_ROOM", roomId: warehouse.id });
  expect("an empty room can be removed", withoutWarehouse.floorplan.rooms.length, seed.floorplan.rooms.length);
  expect(
    "and the door that led to it is closed up",
    withoutWarehouse.floorplan.rooms.find((r) => r.id === "finance")!.doors.some((d) => d.toRoomId === warehouse.id),
    false,
  );

  console.log("\n-- stages --");
  office = apply(office, { type: "SET_STAGE_ROOM", stage: "review", roomId: warehouse.id });
  expect("a stage can move to another room", office.stageRooms.review, warehouse.id);
  expect("then its old room is free to remove (if empty)", refusal(office, { type: "REMOVE_ROOM", roomId: "finance" })?.includes("Ledger"), true);

  console.log("\n-- roles and access --");
  const ctx = (o: Office) => contextOf(o, initialState.now);
  const iris = (o: Office) => o.participants.find((p) => p.id === "p-iris")!;
  expect("before: Intake cannot read Finance", resolveAccess(iris(seed), "finance", "read", ctx(seed)).effect, "deny");
  let roles = apply(seed, { type: "SET_ROLE_GRANT", roleId: "intake", room: "finance", scope: "read", effect: "allow" });
  expect("after an allow on the role: it can", resolveAccess(iris(roles), "finance", "read", ctx(roles)).effect, "allow");
  roles = apply(roles, { type: "SET_ROLE_GRANT", roleId: "intake", room: "finance", scope: "read", effect: "deny" });
  expect("switching the cell to deny", resolveAccess(iris(roles), "finance", "read", ctx(roles)).effect, "deny");
  expect(
    "one cell never holds both allow and deny",
    roles.roles.intake.grants.filter((g) => g.room === "finance" && g.scopes.includes("read")).length,
    1,
  );
  roles = apply(roles, { type: "SET_ROLE_GRANT", roleId: "intake", room: "finance", scope: "read", effect: "none" });
  expect("clearing the cell leaves no grant for it", roles.roles.intake.grants.some((g) => g.room === "finance"), false);
  const withRole = apply(seed, { type: "ADD_ROLE", name: "Auditor", description: "Reads everything", supervises: false });
  const auditor = Object.values(withRole.roles).find((r) => r.name === "Auditor")!;
  expect("a role is added with no access", auditor.grants.length, 0);
  expect("an unused role can be removed", Object.keys(apply(withRole, { type: "REMOVE_ROLE", roleId: auditor.id }).roles).length, 5);
  expect("a role in use cannot be removed", refusal(seed, { type: "REMOVE_ROLE", roleId: "intake" })?.includes("Iris"), true);
  expect(
    "the last supervising person cannot lose that power",
    refusal(seed, { type: "UPDATE_ROLE", roleId: "supervisor", supervises: false }) !== null,
    true,
  );

  console.log("\n-- people and agents --");
  let people = apply(seed, {
    type: "ADD_AGENT",
    displayName: "Scout",
    title: "Returns Agent",
    roleId: "fulfilment",
    roomId: "fulfilment",
    capabilities: ["Process returns", "  ", "Issue credit notes"],
  });
  const scout = people.participants.at(-1)!;
  const scoutDesk = people.floorplan.desks.find((d) => d.id === scout.deskId)!;
  expect("an agent is added", scout.kind, "agent");
  expect("with a desk in the chosen room", scoutDesk.roomId, "fulfilment");
  expect("the room lists the new desk", people.floorplan.rooms.find((r) => r.id === "fulfilment")!.deskIds.includes(scoutDesk.id), true);
  expect("blank capabilities are dropped", scout.capabilities.length, 2);
  expect("an agent cannot be given a supervising role", refusal(seed, { type: "ADD_AGENT", displayName: "Boss", title: "Chief", roleId: "supervisor", roomId: "operations", capabilities: [] }) !== null, true);
  people = apply(people, { type: "UPDATE_PARTICIPANT", participantId: scout.id, roomId: "planning", roleId: "planner" });
  expect("moving an agent moves its desk", people.floorplan.desks.find((d) => d.id === scout.deskId)!.roomId, "planning");
  expect("and changes its role", people.participants.at(-1)!.roleId, "planner");
  expect("an agent with no history can be removed", apply(people, { type: "REMOVE_PARTICIPANT", participantId: scout.id }).participants.length, seed.participants.length);
  expect("an agent with history cannot", refusal(seed, { type: "REMOVE_PARTICIPANT", participantId: "p-quill" })?.includes("Clear the work"), true);
  expect("nobody can remove themselves", refusal(seed, { type: "REMOVE_PARTICIPANT", participantId: "p-dana" }), "You cannot remove yourself.");
  expect("the last supervisor cannot be demoted", refusal(seed, { type: "UPDATE_PARTICIPANT", participantId: "p-dana", roleId: "intake" }) !== null, true);

  console.log("\n-- clearing work --");
  const cleared = apply(seed, { type: "CLEAR_WORK" });
  expect("tasks and messages are gone", cleared.tasks.length + cleared.messages.length, 0);
  expect("standing rules stay", cleared.rules.length, seed.rules.length);
  expect("after that, an agent can be removed", apply(cleared, { type: "REMOVE_PARTICIPANT", participantId: "p-quill" }).participants.length, seed.participants.length - 1);

  console.log("\n-- an office built from nothing --");
  let blank = blankOffice({ suffix: "ab12", name: "Kim Mechanical", admin: { displayName: "Alex Kim", title: "Owner" } });
  const other = blankOffice({ suffix: "cd34", name: "Second office", admin: { displayName: "Alex Kim", title: "Owner" } });
  const me = blank.participants[0].id;
  const mainRoom = blank.floorplan.rooms[0].id;
  const memberRole = Object.values(blank.roles).find((r) => !r.supervises)!.id;
  expect("a blank office has one room and one person", `${blank.floorplan.rooms.length}/${blank.participants.length}`, "1/1");
  expect("and no work or rules", blank.tasks.length + blank.messages.length + blank.rules.length, 0);
  const idsOf = (o: Office) => [o.id, o.floorplan.id, ...o.floorplan.rooms.map((r) => r.id), ...o.floorplan.desks.map((d) => d.id), ...o.participants.map((p) => p.id), ...Object.keys(o.roles)];
  expect("two blank offices share no ids", idsOf(blank).some((id) => idsOf(other).includes(id)), false);
  blank = apply(blank, { type: "ADD_ROOM", name: "Accounts", purpose: "Pricing and approval", width: 8, depth: 10, attachTo: mainRoom, side: "east" }, me);
  const accounts = blank.floorplan.rooms.at(-1)!;
  blank = apply(blank, { type: "SET_STAGE_ROOM", stage: "review", roomId: accounts.id }, me);
  blank = apply(blank, { type: "ADD_AGENT", displayName: "Nova", title: "Assistant", roleId: memberRole, roomId: mainRoom, capabilities: ["Take requests"] }, me);
  const run = await reduce(
    { office: blank, now: initialState.now, seq: 0, clockStepMinutes: 3, idScope: "ab12-" },
    { type: "SUBMIT_REQUEST", title: "First request", detail: "Something to do.", requestedById: me },
    new ScriptedRuntime(),
  );
  const first = run.state.office.tasks[0];
  expect("a request in the new office goes to its agent", first.ownerId, blank.participants.at(-1)!.id);
  expect("in the room that hosts intake", first.roomId, mainRoom);
  expect("ids it generates carry the office's own tag", first.id, "T-ab12-1");
  expect("an unscripted agent says plainly that no model is connected", run.state.office.messages.some((m) => m.body.includes("No model is connected")), true);

  console.log("\n-- untrusted input --");
  expect("unknown operations are rejected", parseAdminOp({ type: "DROP_EVERYTHING" }), null);
  expect("a room without numbers is rejected", parseAdminOp({ type: "ADD_ROOM", name: "X room", attachTo: "main", side: "east", width: "8", depth: 8 }), null);
  expect("an unknown wall is rejected", parseAdminOp({ type: "ADD_ROOM", name: "X room", attachTo: "main", side: "up", width: 8, depth: 8 }), null);
  expect("extra fields are not copied", "admin" in (parseAdminOp({ type: "CLEAR_WORK", admin: true }) ?? {}), false);

  console.log(`\n${failures === 0 ? "all admin checks passed" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
