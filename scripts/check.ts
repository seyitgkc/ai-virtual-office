/** Exercises the access model against the seed office. Run: npx tsx check.ts */
import { resolveAccess, hasConflict, canRead, type IndividualRule } from "../lib/model";
import { office, contextFor, byId } from "../lib/seed";
import { entryPose, freeDeskSpot, landingSpot, obstacles, PICKS_PERSON_BY_TOUCH, planExtent, roomAt, stepWalker } from "../lib/geometry";

const ctx = contextFor(office);
let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown): void {
  const ok = actual === wanted;
  if (!ok) failures++;
  console.log(`${ok ? "pass" : "FAIL"}  ${label}  (got ${String(actual)})`);
}

console.log("\n-- role deny closes the Finance door --");
const quillFinance = resolveAccess(byId("p-quill"), "finance", "read", ctx);
expect("Quill read Finance", quillFinance.effect, "deny");
console.log(`      ${quillFinance.explanation}`);

console.log("\n-- individual allow outranks role deny --");
const grant: IndividualRule = {
  id: "r-99",
  participantId: "p-quill",
  room: "finance",
  scopes: ["read"],
  effect: "allow",
  reason: "Dealer tier lookup for task T-1001",
  grantedBy: "p-dana",
  grantedAt: ctx.now,
  expiresOnTaskId: "T-1001",
};
const granted = { ...ctx, rules: [...ctx.rules, grant] };
const afterGrant = resolveAccess(byId("p-quill"), "finance", "read", granted);
expect("Quill read Finance after grant", afterGrant.effect, "allow");
expect("  overrode something", hasConflict(afterGrant), true);
console.log(`      ${afterGrant.explanation}`);

console.log("\n-- the grant dies with its task --");
const closed = { ...granted, closedTaskIds: new Set(["T-1001"]) };
expect("Quill read Finance once T-1001 closes", resolveAccess(byId("p-quill"), "finance", "read", closed).effect, "deny");

console.log("\n-- deny wins inside the individual tier --");
const veraFinance = resolveAccess(byId("p-vera"), "finance", "read", ctx);
expect("Vera read Finance", veraFinance.effect, "deny");
expect("  flagged as conflicting", hasConflict(veraFinance), true);
console.log(`      ${veraFinance.explanation}`);

console.log("\n-- wildcard supervisor --");
for (const room of ["reception", "planning", "finance", "fulfilment", "operations"]) {
  expect(`Dana act in ${room}`, resolveAccess(byId("p-dana"), room, "act", ctx).effect, "allow");
}

console.log("\n-- closed by default --");
expect("Iris act in Finance", resolveAccess(byId("p-iris"), "finance", "act", ctx).effect, "deny");
expect("Ledger enter Fulfilment", resolveAccess(byId("p-ledger"), "fulfilment", "enter", ctx).effect, "deny");

console.log("\n-- time-limited rule --");
expect("Sam enter Fulfilment now", resolveAccess(byId("p-sam"), "fulfilment", "enter", ctx).effect, "allow");
const later = { ...ctx, now: ctx.now + 1000 * 60 * 60 * 48 };
expect("Sam enter Fulfilment in 48h", resolveAccess(byId("p-sam"), "fulfilment", "enter", later).effect, "deny");

console.log("\n-- permissions gate what you can read --");
const financeOutput = office.messages.find((m) => m.id === "m-3003")!;
expect("Dana reads the Finance thread", canRead(financeOutput, byId("p-dana"), ctx), true);
expect("Vera reads the Finance thread", canRead(financeOutput, byId("p-vera"), ctx), false);
const escalation = office.messages.find((m) => m.id === "m-1012")!;
expect("Dana reads the escalation sent to her", canRead(escalation, byId("p-dana"), ctx), true);
expect("Quill reads their own escalation", canRead(escalation, byId("p-quill"), ctx), true);
expect("Atlas reads someone else's DM", canRead(escalation, byId("p-atlas"), ctx), false);

console.log("\n-- walking the plan --");
{
  const { rooms } = office.floorplan;
  const all = obstacles(office.floorplan);
  const ext = planExtent(rooms);
  const bounds = { minX: ext.minX - 3, maxX: ext.maxX + 3, minZ: ext.minZ - 3, maxZ: ext.maxZ + 3 };
  const walk = (from: { x: number; z: number }, dx: number, dz: number, steps: number) => {
    let at = from;
    for (let i = 0; i < steps; i++) at = stepWalker(at, dx, dz, all, 0.3, bounds);
    return at;
  };

  const start = entryPose(rooms);
  expect("visitor starts outside", roomAt(rooms, start.x, start.z), null);
  const inside = walk(start, 0.05, 0, 70);
  expect("the way in leads into the hall", roomAt(rooms, inside.x, inside.z)?.id, "hall");

  // Straight at the solid wall between Reception and Planning: rooms open onto the hall only.
  const atWall = walk({ x: 8, z: 1.5 }, 0.05, 0, 100);
  expect("a wall stops the walker", roomAt(rooms, atWall.x, atWall.z)?.id, "reception");
  const alongHall = walk({ x: 1, z: 9.6 }, 0.05, 0, 560);
  expect("the hall runs the length of the office", alongHall.x > 29, true);

  // Every room's door lines up with the hall's well enough to walk through.
  const crossings: Array<[string, { x: number; z: number }, number, string]> = [
    ["Hall to Reception", { x: 5, z: 9.5 }, -0.05, "reception"],
    ["Hall to Planning", { x: 15, z: 9.5 }, -0.05, "planning"],
    ["Hall to Finance", { x: 25, z: 9.5 }, -0.05, "finance"],
    ["Hall to Fulfilment", { x: 7.5, z: 9.7 }, 0.05, "fulfilment"],
    ["Hall to Operations", { x: 22.5, z: 9.7 }, 0.05, "operations"],
    ["Reception back to the hall", { x: 5, z: 6.5 }, 0.05, "hall"],
  ];
  for (const [label, from, dz, wanted] of crossings) {
    const end = walk(from, 0, dz, 60);
    expect(label, roomAt(rooms, end.x, end.z)?.id, wanted);
  }

  // A room the walker may not enter has its doorway shut, and only that one.
  const shut = obstacles(office.floorplan, new Set(["finance"]));
  const tryDoor = (from: { x: number; z: number }) => {
    let at = from;
    for (let i = 0; i < 60; i++) at = stepWalker(at, 0, -0.05, shut, 0.3, bounds);
    return roomAt(rooms, at.x, at.z)?.id;
  };
  expect("a doorway into a room one may not enter stops the walker", tryDoor({ x: 25, z: 9.5 }), "hall");
  expect("the other doorways stay open", tryDoor({ x: 15, z: 9.5 }), "planning");

  // Picking a place on the map.
  const none = new Set<string>();
  const here = { x: 5, z: 9.6, yaw: 0.4 };
  const clear = (p: { x: number; z: number }, plan = office.floorplan): boolean =>
    !obstacles(plan).some((o) => Math.abs(p.x - o.cx) < o.lx / 2 + 0.3 && Math.abs(p.z - o.cz) < o.lz / 2 + 0.3);
  const open = landingSpot(office.floorplan, none, here, { x: 13, z: 6 });
  expect("a free place is where the walker lands, facing as before", open.ok && `${open.pose.x} ${open.pose.z} ${open.pose.yaw}`, "13 6 0.4");
  expect("a room one may not enter refuses", JSON.stringify(landingSpot(office.floorplan, new Set(["finance"]), here, { x: 25, z: 6 })), '{"ok":false,"why":"shut"}');
  expect("the same room accepts someone who may enter it", landingSpot(office.floorplan, none, here, { x: 25, z: 6 }).ok, true);
  const inWall = landingSpot(office.floorplan, none, here, { x: 10.02, z: 5 });
  expect("a place inside a wall gives the nearest free spot in the same room", inWall.ok && clear(inWall.pose) && roomAt(rooms, inWall.pose.x, inWall.pose.z)?.id, "planning");
  expect("and not far from what was picked", inWall.ok && Math.hypot(inWall.pose.x - 10.02, inWall.pose.z - 5) < 1, true);
  const outside = landingSpot(office.floorplan, none, here, { x: -1.5, z: 9.6 });
  expect("the strip outside the walls can be picked", outside.ok && roomAt(rooms, outside.pose.x, outside.pose.z), null);
  expect("beyond it there is nowhere to stand", JSON.stringify(landingSpot(office.floorplan, none, here, { x: -12, z: 9.6 })), '{"ok":false,"why":"nowhere"}');
  const samSeat = { x: 7, z: 3.32 };
  const toSam = landingSpot(office.floorplan, none, here, { x: 7.2, z: 3.1 });
  const gap = toSam.ok ? Math.hypot(toSam.pose.x - samSeat.x, toSam.pose.z - samSeat.z) : 0;
  expect("picking a person puts the walker a step back from them", toSam.ok && clear(toSam.pose) && Math.abs(gap - 1.7) < 0.01, true);
  expect("in their room", toSam.ok && roomAt(rooms, toSam.pose.x, toSam.pose.z)?.id, "reception");
  // Forward is (-sin yaw, -cos yaw).
  const facing = toSam.ok ? (-Math.sin(toSam.pose.yaw) * (samSeat.x - toSam.pose.x) + -Math.cos(toSam.pose.yaw) * (samSeat.z - toSam.pose.z)) / gap : 0;
  expect("turned to face them", facing > 0.999, true);
  expect("on the side the walker came from", toSam.ok && toSam.pose.z > samSeat.z, true);
  const nearSam = { x: 8.5, z: 3.32 };
  const byPointer = landingSpot(office.floorplan, none, here, nearSam);
  expect("a pick a metre and a half from someone is a place", byPointer.ok && `${byPointer.pose.x} ${byPointer.pose.z}`, "8.5 3.32");
  const byFinger = landingSpot(office.floorplan, none, here, nearSam, PICKS_PERSON_BY_TOUCH);
  expect("the same pick by a finger goes to that person", byFinger.ok && Math.abs(Math.hypot(byFinger.pose.x - samSeat.x, byFinger.pose.z - samSeat.z) - 1.7) < 0.01, true);
  expect("a person in a room one may not enter cannot be picked", JSON.stringify(landingSpot(office.floorplan, new Set(["reception"]), here, samSeat)), '{"ok":false,"why":"shut"}');
  const emptyDesk = { ...office.floorplan, desks: office.floorplan.desks.map((d) => (d.id === "desk-pla-1" ? { ...d, occupantId: null } : d)) };
  const byDesk = landingSpot(emptyDesk, none, here, { x: 15, z: 3.54 });
  expect("a desk nobody sits at gives a spot beside it", byDesk.ok && clear(byDesk.pose, emptyDesk) && Math.hypot(byDesk.pose.x - 15, byDesk.pose.z - 3.54) < 1.9, true);
}

console.log("\n-- room for one more desk --");
{
  const plan = office.floorplan;
  const spot = freeDeskSpot(plan, "finance");
  expect("Finance has room for another desk", spot !== null, true);
  expect("the new desk is inside Finance", spot ? roomAt(plan.rooms, spot.x, spot.z)?.id : null, "finance");
  const nearest = Math.min(
    ...plan.desks.filter((d) => d.roomId === "finance").map((d) => Math.hypot(d.position.x - spot!.x, d.position.z - spot!.z)),
  );
  expect("and clear of the desk already there", nearest >= 3, true);
  expect("an unknown room has no spot", freeDeskSpot(plan, "vault"), null);
}

console.log(`\n${failures === 0 ? "all checks passed" : failures + " FAILED"}\n`);
process.exit(failures === 0 ? 0 : 1);
