/**
 * Checks the admin operations: rooms, roles, people and agents, and an office
 * built from nothing. Run: npx tsx scripts/admin.ts
 */
import { setupSteps } from "../lib/setup";
import { AGENT_NAMES, AdminError, applyAdminOp, blankOffice, parseAdminOp, permissionFor, type AdminOp } from "../lib/admin";
import { reduce } from "../lib/engine";
import { PlaybookRuntime } from "../lib/playbook";
import { obstacles, planExtent, roomAt, stepWalker } from "../lib/geometry";
import { initialState } from "../lib/initialState";
import { PERMISSIONS, resolveAccess, type Office, type PlaybookStep } from "../lib/model";
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
  const withRole = apply(seed, { type: "ADD_ROLE", name: "Auditor", description: "Reads everything" });
  const auditor = Object.values(withRole.roles).find((r) => r.name === "Auditor")!;
  expect("a role is added able to walk the corridor and nothing more", JSON.stringify(auditor.grants), JSON.stringify([{ room: "hall", scopes: ["enter"], effect: "allow" }]));
  expect("and no permissions", auditor.permissions.length, 0);
  expect("an unused role can be removed", Object.keys(apply(withRole, { type: "REMOVE_ROLE", roleId: auditor.id }).roles).length, 5);
  expect("a role in use cannot be removed", refusal(seed, { type: "REMOVE_ROLE", roleId: "intake" })?.includes("Iris"), true);

  console.log("\n-- permissions --");
  expect("the seeded supervisor role holds every permission", seed.roles.supervisor.permissions.length, PERMISSIONS.length);
  expect("the seeded agent roles hold none", seed.roles.intake.permissions.length, 0);
  let perms = apply(withRole, { type: "SET_ROLE_PERMISSION", roleId: auditor.id, permission: "see_everything", allowed: true });
  expect("one permission can be given to a role", perms.roles[auditor.id].permissions.join(), "see_everything");
  perms = apply(perms, { type: "SET_ROLE_PERMISSION", roleId: auditor.id, permission: "decide_reviews", allowed: true });
  perms = apply(perms, { type: "SET_ROLE_PERMISSION", roleId: auditor.id, permission: "see_everything", allowed: false });
  expect("and taken away again, one at a time", perms.roles[auditor.id].permissions.join(), "decide_reviews");
  expect(
    "a role held by agents cannot carry a permission",
    refusal(seed, { type: "SET_ROLE_PERMISSION", roleId: "intake", permission: "manage_access", allowed: true })?.includes("Agents hold this role"),
    true,
  );
  expect(
    "the last person who can manage roles cannot lose that",
    refusal(seed, { type: "SET_ROLE_PERMISSION", roleId: "supervisor", permission: "manage_roles", allowed: false }) !== null,
    true,
  );
  // Sam is moved to a role that may manage roles and people, and nothing else.
  let limited = apply(perms, { type: "SET_ROLE_PERMISSION", roleId: auditor.id, permission: "manage_roles", allowed: true });
  limited = apply(limited, { type: "SET_ROLE_PERMISSION", roleId: auditor.id, permission: "manage_people", allowed: true });
  limited = apply(limited, { type: "UPDATE_PARTICIPANT", participantId: "p-sam", roleId: auditor.id });
  expect(
    "nobody can grant a permission they do not hold",
    refusal(limited, { type: "SET_ROLE_PERMISSION", roleId: auditor.id, permission: "manage_office", allowed: true }, "p-sam"),
    "You can only grant a permission you hold yourself.",
  );
  expect(
    "nor move someone into a role that holds more than they do",
    refusal(limited, { type: "UPDATE_PARTICIPANT", participantId: "p-sam", roleId: "supervisor" }, "p-sam")?.includes("has more"),
    true,
  );
  expect(
    "but they can take away a permission they hold",
    apply(limited, { type: "SET_ROLE_PERMISSION", roleId: auditor.id, permission: "decide_reviews", allowed: false }, "p-sam").roles[auditor.id].permissions.includes("decide_reviews"),
    false,
  );
  expect("each kind of change names the permission it needs: rooms", permissionFor({ type: "REMOVE_ROOM", roomId: "x" }), "manage_rooms");
  expect("roles", permissionFor({ type: "ADD_ROLE", name: "x", description: "" }), "manage_roles");
  expect("people and agents", permissionFor({ type: "SET_PLAYBOOK", participantId: "x", steps: [] }), "manage_people");
  expect("the office itself", permissionFor({ type: "CLEAR_WORK" }), "manage_office");

  console.log("\n-- people and agents --");
  let people = apply(seed, {
    type: "ADD_AGENT",
    displayName: "Scout",
    title: "Returns Agent",
    roleId: "fulfilment",
    roomId: "fulfilment",
    capabilities: ["Process returns", "  ", "Issue credit notes"],
    agentType: "playbook",
  });
  const scout = people.participants.at(-1)!;
  const scoutDesk = people.floorplan.desks.find((d) => d.id === scout.deskId)!;
  expect("an agent is added", scout.kind, "agent");
  expect("as a playbook agent with no steps yet", `${scout.agentType}/${scout.playbook.length}`, "playbook/0");
  expect("with a desk in the chosen room", scoutDesk.roomId, "fulfilment");
  expect("the room lists the new desk", people.floorplan.rooms.find((r) => r.id === "fulfilment")!.deskIds.includes(scoutDesk.id), true);
  expect("blank capabilities are dropped", scout.capabilities.length, 2);
  expect("an agent cannot be given a supervising role", refusal(seed, { type: "ADD_AGENT", displayName: "Boss", title: "Chief", roleId: "supervisor", roomId: "operations", capabilities: [], agentType: "ai" }) !== null, true);
  people = apply(people, { type: "UPDATE_PARTICIPANT", participantId: scout.id, roomId: "planning", roleId: "planner" });
  expect("moving an agent moves its desk", people.floorplan.desks.find((d) => d.id === scout.deskId)!.roomId, "planning");
  expect("and changes its role", people.participants.at(-1)!.roleId, "planner");

  console.log("\n-- agent types and playbooks --");
  const step = (over: Partial<PlaybookStep["then"]>, when: Partial<PlaybookStep["when"]> = {}): PlaybookStep => ({
    id: "",
    when: { stage: "any", requestContains: "", requestedBy: "anyone", ...when },
    then: { statusNote: "", output: null, question: null, assumption: null, need: null, action: null, note: null, ...over },
  });
  let booked = apply(people, {
    type: "SET_PLAYBOOK",
    participantId: scout.id,
    steps: [
      step({ statusNote: " Returns logged ", output: { label: "", body: "Credit note raised." } }, { stage: "execution", requestContains: "return" }),
      step({ question: { body: "Which branch?", to: "requester", blocking: true, options: ["Laval", " ", "Ottawa"] } }),
    ],
  });
  const book = booked.participants.find((p) => p.id === scout.id)!.playbook;
  expect("a playbook is stored in order", book.length, 2);
  expect("each step gets an id", book.every((s) => s.id.startsWith("pb-")) && book[0].id !== book[1].id, true);
  expect("text is trimmed", book[0].then.statusNote, "Returns logged");
  expect("an output without a heading gets one", book[0].then.output?.label, "Output");
  expect("blank answer options are dropped", book[1].then.question?.options.join(), "Laval,Ottawa");
  expect("a step that does nothing is refused", refusal(people, { type: "SET_PLAYBOOK", participantId: scout.id, steps: [step({})] })?.includes("does nothing yet"), true);
  expect("a step may not need a room that does not exist", refusal(people, { type: "SET_PLAYBOOK", participantId: scout.id, steps: [step({ need: { room: "vault", scope: "read", purpose: "x" } })] })?.includes("does not exist"), true);
  expect("nor ask someone who is not in the office", refusal(people, { type: "SET_PLAYBOOK", participantId: scout.id, steps: [step({ question: { body: "Hello?", to: "p-nobody", blocking: false, options: [] } })] }) !== null, true);
  expect("a person has no playbook", refusal(people, { type: "SET_PLAYBOOK", participantId: "p-dana", steps: [] }), "Only an agent has a playbook.");
  booked = apply(booked, { type: "UPDATE_PARTICIPANT", participantId: scout.id, agentType: "ai", providerId: null, model: "some-model" });
  const asAi = booked.participants.find((p) => p.id === scout.id)!;
  expect("an agent can be switched to an AI agent", `${asAi.agentType}/${asAi.model}`, "ai/some-model");
  expect("its playbook is kept for later", asAi.playbook.length, 2);
  expect(
    "an AI agent can only name a provider the office has",
    (() => {
      try {
        applyAdminOp(booked, { type: "UPDATE_PARTICIPANT", participantId: scout.id, providerId: "prov-missing" }, "p-dana", newId, new Set(["prov-real"]));
        return null;
      } catch (error) {
        return error instanceof AdminError ? error.message : "other";
      }
    })(),
    "That AI provider does not exist in this office.",
  );
  booked = apply(booked, { type: "UPDATE_PARTICIPANT", participantId: scout.id, agentType: "playbook" });
  expect("switching back clears the model", booked.participants.find((p) => p.id === scout.id)!.model, null);
  expect("a person cannot be given an agent type", refusal(seed, { type: "UPDATE_PARTICIPANT", participantId: "p-sam", agentType: "ai" }), "Only an agent has these settings.");

  expect("an agent with no history can be removed", apply(people, { type: "REMOVE_PARTICIPANT", participantId: scout.id }).participants.length, seed.participants.length);
  expect("an agent with history cannot", refusal(seed, { type: "REMOVE_PARTICIPANT", participantId: "p-quill" })?.includes("Clear the work"), true);
  expect("nobody can remove themselves", refusal(seed, { type: "REMOVE_PARTICIPANT", participantId: "p-dana" }), "You cannot remove yourself.");
  expect("the last person who manages roles cannot be demoted", refusal(seed, { type: "UPDATE_PARTICIPANT", participantId: "p-dana", roleId: "intake" }) !== null, true);

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
  const memberRole = Object.values(blank.roles).find((r) => r.permissions.length === 0)!.id;
  expect("its first person holds every permission", blank.roles[blank.participants[0].roleId].permissions.length, PERMISSIONS.length);
  expect("a blank office has one room on a corridor, and one person", `${blank.floorplan.rooms.length}/${blank.participants.length}`, "2/1");
  const hallOf = (o: Office) => o.floorplan.rooms.find((r) => r.corridor)!;
  expect("the corridor has the way out and a door to the room", hallOf(blank).doors.map((d) => d.toRoomId ?? "out").join(","), `out,${mainRoom}`);
  let lined = blank;
  for (const name of ["Sales", "Stores", "Accounts office", "Workshop"]) {
    lined = apply(lined, { type: "ADD_ROOM", name, purpose: "", width: 10, depth: 8, attachTo: "", side: "along" }, me);
  }
  const hall = hallOf(lined);
  const placedAt = (name: string) => { const b = lined.floorplan.rooms.find((r) => r.name === name)!.bounds; return `${b.x},${b.z}`; };
  expect("rooms added along the corridor take each side in turn", ["Sales", "Stores", "Accounts office", "Workshop"].map(placedAt).join(" "), "0,-8 10,-8 12,3 20,-8");
  expect("the corridor lengthens to reach the furthest room", hall.bounds.w, 30);
  const touching = (r: Office["floorplan"]["rooms"][number]) => r.bounds.z === hall.bounds.z + hall.bounds.d || r.bounds.z + r.bounds.d === hall.bounds.z;
  expect("every room stands against the corridor", lined.floorplan.rooms.filter((r) => !r.corridor).every(touching), true);
  const doorX = (toRoomId: string) => hall.bounds.x + hall.doors.find((d) => d.toRoomId === toRoomId)!.along * hall.bounds.w;
  const centred = lined.floorplan.rooms.filter((r) => !r.corridor).every((r) => Math.abs(doorX(r.id) - (r.bounds.x + r.bounds.w / 2)) < 0.01);
  expect("and each corridor door faces the middle of its room, after the corridor grew", centred, true);
  expect("nobody is given a desk in a corridor", refusal(lined, { type: "ADD_AGENT", displayName: "", title: "Porter", roleId: memberRole, roomId: hall.id, capabilities: [], agentType: "playbook" }, me), "Nobody has a desk in Corridor, which is only for walking through.");
  expect("and no stage is hosted there", refusal(lined, { type: "SET_STAGE_ROOM", stage: "intake", roomId: hall.id }, me), "No stage of the work is done in Corridor, which is only for walking through.");
  const second = apply(lined, { type: "ADD_ROOM", name: "Back passage", purpose: "", width: 3, depth: 8, attachTo: mainRoom, side: "north", corridor: true }, me);
  expect("a corridor can be added, and every role may walk it", Object.values(second.roles).every((r) => r.grants.some((g) => (g.room === second.floorplan.rooms.at(-1)!.id || g.room === "*") && g.scopes.includes("enter"))), true);
  expect("and no work or rules", blank.tasks.length + blank.messages.length + blank.rules.length, 0);
  const idsOf = (o: Office) => [o.id, o.floorplan.id, ...o.floorplan.rooms.map((r) => r.id), ...o.floorplan.desks.map((d) => d.id), ...o.participants.map((p) => p.id), ...Object.keys(o.roles)];
  expect("two blank offices share no ids", idsOf(blank).some((id) => idsOf(other).includes(id)), false);
  blank = apply(blank, { type: "ADD_ROOM", name: "Accounts", purpose: "Pricing and approval", width: 8, depth: 10, attachTo: mainRoom, side: "east" }, me);
  const accounts = blank.floorplan.rooms.at(-1)!;
  blank = apply(blank, { type: "SET_STAGE_ROOM", stage: "review", roomId: accounts.id }, me);
  blank = apply(blank, { type: "ADD_AGENT", displayName: "Nova", title: "Assistant", roleId: memberRole, roomId: mainRoom, capabilities: ["Take requests"], agentType: "playbook" }, me);
  const run = await reduce(
    { office: blank, now: initialState.now, seq: 0, clockStepMinutes: 3, idScope: "ab12-" },
    { type: "SUBMIT_REQUEST", title: "First request", detail: "Something to do.", requestedById: me },
    new PlaybookRuntime(),
  );
  const first = run.state.office.tasks[0];
  expect("a request in the new office goes to its agent", first.ownerId, blank.participants.at(-1)!.id);
  expect("in the room that hosts intake", first.roomId, mainRoom);
  expect("ids it generates carry the office's own tag", first.id, "T-ab12-1");
  expect("an agent with an empty playbook says plainly that it did nothing", run.state.office.messages.some((m) => m.body.includes("has no playbook step for this")), true);

  const todo = (o: Office, providers: { id: string; usable: boolean }[] = []) =>
    setupSteps(o, initialState.now, providers).filter((s) => !s.done && !s.optional).map((s) => s.id).join(",");
  const fresh = blankOffice({ suffix: "ee55", name: "Fresh", admin: { displayName: "Ann", title: "Administrator" } });
  const freshMe = fresh.participants[0].id;
  const freshMain = fresh.floorplan.rooms[0].id;
  const freshMember = Object.values(fresh.roles).find((r) => r.permissions.length === 0)!.id;
  expect("a new office still needs an agent and a first request", todo(fresh), "agents,request");
  let staffed = apply(fresh, { type: "ADD_AGENT", displayName: "", title: "Helper", roleId: freshMember, roomId: freshMain, capabilities: [], agentType: "ai", providerId: "prov-x" }, freshMe);
  expect("an AI agent needs a provider with a working key", todo(staffed), "provider,request");
  expect("and with one, only the request is left", todo(staffed, [{ id: "prov-x", usable: true }]), "request");
  staffed = apply(staffed, { type: "ADD_ROOM", name: "Accounts", purpose: "", width: 8, depth: 8, attachTo: "", side: "along" }, freshMe);
  staffed = apply(staffed, { type: "SET_STAGE_ROOM", stage: "review", roomId: staffed.floorplan.rooms.at(-1)!.id }, freshMe);
  expect("a stage moved to a room nobody may work in is named twice over", todo(staffed, [{ id: "prov-x", usable: true }]), "roles,agents,request");
  expect("and the step says which room", setupSteps(staffed, initialState.now, []).find((s) => s.id === "agents")!.detail, "Nobody can take the work in Accounts.");

  const unnamed = { type: "ADD_AGENT" as const, displayName: "", title: "Helper", roleId: memberRole, roomId: mainRoom, capabilities: [], agentType: "playbook" as const };
  const withOne = apply(blank, unnamed, me);
  const withTwo = apply(withOne, unnamed, me);
  const drawn = [withOne.participants.at(-1)!.displayName, withTwo.participants.at(-1)!.displayName];
  expect("an agent added without a name is given one from the list", drawn.every((n) => AGENT_NAMES.includes(n)), true);
  expect("and no two agents are given the same one", drawn[0] !== drawn[1], true);
  expect("an empty name passes the check on what the browser sends", parseAdminOp({ ...unnamed })?.type, "ADD_AGENT");

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
