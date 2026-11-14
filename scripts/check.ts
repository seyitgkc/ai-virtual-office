/** Exercises the access model against the seed office. Run: npx tsx check.ts */
import { resolveAccess, hasConflict, canRead, type IndividualRule } from "../lib/model";
import { office, contextFor, byId } from "../lib/seed";
import { entryPose, freeDeskSpot, obstacles, planExtent, roomAt, stepWalker } from "../lib/geometry";

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
  const inside = walk(start, 0, 0.05, 70);
  expect("front door leads into Reception", roomAt(rooms, inside.x, inside.z)?.id, "reception");

  // Straight at the solid wall between Reception and Planning, away from its door.
  const atWall = walk({ x: 8, z: 1.5 }, 0.05, 0, 100);
  expect("a wall stops the walker", roomAt(rooms, atWall.x, atWall.z)?.id, "reception");

  // Every interior door pair lines up well enough to walk through.
  const crossings: Array<[string, { x: number; z: number }, number, number, string]> = [
    ["Reception to Planning", { x: 8.5, z: 4 }, 0.05, 0, "planning"],
    ["Planning to Finance", { x: 18.5, z: 4 }, 0.05, 0, "finance"],
    ["Reception to Fulfilment", { x: 5, z: 6.5 }, 0, 0.05, "fulfilment"],
    ["Planning to Fulfilment", { x: 12.5, z: 6.5 }, 0, 0.05, "fulfilment"],
    ["Planning to Operations", { x: 17.5, z: 6.5 }, 0, 0.05, "operations"],
    ["Finance to Operations", { x: 25, z: 6.5 }, 0, 0.05, "operations"],
    ["Fulfilment to Operations", { x: 13.5, z: 12 }, 0.05, 0, "operations"],
  ];
  for (const [label, from, dx, dz, wanted] of crossings) {
    const end = walk(from, dx, dz, 60);
    expect(label, roomAt(rooms, end.x, end.z)?.id, wanted);
  }
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
