/**
 * Exercises the database layer: seeds an in-memory database, drives a full
 * workflow through it, and checks after every action that what is read back
 * equals what the engine produced. Run: npx tsx scripts/store.ts
 */
import { ALL_SCOPES, type AccessScope } from "../lib/model";
import { applyAdminOp, type AdminOp } from "../lib/admin";
import { reduce, type Action, type EngineState } from "../lib/engine";
import { PlaybookRuntime } from "../lib/playbook";
import { initialState } from "../lib/initialState";
import { all, openDatabase, transaction } from "../lib/server/db";
import { loadEngineState, saveEngineState, seedDatabase } from "../lib/server/officeStore";

let failures = 0;
function expect(label: string, actual: unknown, wanted: unknown): void {
  const ok = actual === wanted;
  if (!ok) failures++;
  console.log(`${ok ? "pass" : "FAIL"}  ${label}${ok ? "" : `  (got ${String(actual)})`}`);
}

/** Canonical text form: sorted keys, scopes in a fixed order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (key, v) => {
    if (key === "scopes" && Array.isArray(v)) {
      return ALL_SCOPES.filter((s) => (v as AccessScope[]).includes(s));
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}

function firstDifference(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `at ${i}: ...${a.slice(Math.max(0, i - 60), i + 60)}... vs ...${b.slice(Math.max(0, i - 60), i + 60)}...`;
}

async function main(): Promise<void> {
  const db = openDatabase(":memory:");
  const runtime = new PlaybookRuntime();

  console.log("\n-- seed round trip --");
  seedDatabase(db, initialState);
  let state: EngineState = initialState;
  const loaded = loadEngineState(db, initialState.office.id);
  const same = canonical(loaded) === canonical(state);
  expect("seeded office reads back identical", same, true);
  if (!same) console.log(firstDifference(canonical(loaded), canonical(state)));

  const apply = async (label: string, action: Action): Promise<void> => {
    const next = (await reduce(state, action, runtime)).state;
    transaction(db, () => saveEngineState(db, state, next));
    state = next;
    const back = canonical(loadEngineState(db, initialState.office.id));
    const ok = back === canonical(state);
    expect(label, ok, true);
    if (!ok) console.log(firstDifference(back, canonical(state)));
  };

  console.log("\n-- every action persists and reads back identical --");
  await apply("submit a request", {
    type: "SUBMIT_REQUEST",
    title: "Dealer order 4502: 4x multi-zone heads",
    detail: "Four multi-zone heads with dealer pricing.",
    requestedById: "p-dana",
  });
  const task = () => state.office.tasks[state.office.tasks.length - 1];
  await apply("answer the intake question", {
    type: "ANSWER_QUESTION",
    questionId: task().openQuestionIds[0],
    answeredById: "p-dana",
    body: "Standalone heads",
    chosenOption: "Standalone heads",
  });
  await apply("advance to planning", { type: "ADVANCE", taskId: task().id });
  await apply("advance to execution, blocked on Finance", { type: "ADVANCE", taskId: task().id });
  expect("task is blocked on permission", task().status, "blocked_permission");
  await apply("grant scoped access", {
    type: "GRANT_ACCESS",
    participantId: "p-vera",
    room: "finance",
    scopes: ["read"],
    effect: "allow",
    reason: `Granted for ${task().id}`,
    grantedBy: "p-dana",
    expiresOnTaskId: task().id,
  });
  await apply("revoke the blocking rule", { type: "REVOKE_RULE", ruleId: "r-02", revokedBy: "p-dana" });
  expect("task is unblocked", task().status, "in_progress");
  await apply("contradict an assumption", {
    type: "RESOLVE_ASSUMPTION",
    assumptionId: task().assumptionIds[0],
    status: "contradicted",
    byId: "p-dana",
  });
  await apply("answer the follow-up question", {
    type: "ANSWER_QUESTION",
    questionId: task().openQuestionIds[0],
    answeredById: "p-dana",
    body: "Laval",
  });
  await apply("reassign to Quill", {
    type: "REASSIGN",
    taskId: task().id,
    toParticipantId: "p-quill",
    byId: "p-dana",
  });
  await apply("advance to review", { type: "ADVANCE", taskId: task().id });
  await apply("approve", { type: "DECIDE", taskId: task().id, byId: "p-dana", verdict: "approved" });
  expect("task completed", task().status, "completed");

  console.log("\n-- set-up changes persist and read back identical --");
  let counter = 0;
  const admin = (label: string, op: AdminOp): void => {
    const next: EngineState = { ...state, office: applyAdminOp(state.office, op, "p-dana", () => `s${++counter}`) };
    transaction(db, () => saveEngineState(db, state, next));
    state = next;
    const back = canonical(loadEngineState(db, initialState.office.id));
    const ok = back === canonical(state);
    expect(label, ok, true);
    if (!ok) console.log(firstDifference(back, canonical(state)));
  };
  admin("rename the office", { type: "RENAME_OFFICE", name: "Northline Distribution" });
  admin("add a room", { type: "ADD_ROOM", name: "Warehouse", purpose: "Goods in and out", width: 8, depth: 8, attachTo: "finance", side: "east" });
  const warehouse = () => state.office.floorplan.rooms.find((r) => r.name === "Warehouse")!.id;
  admin("rename a room", { type: "UPDATE_ROOM", roomId: warehouse(), name: "Warehouse", purpose: "Stock held on site" });
  admin("move a stage to it", { type: "SET_STAGE_ROOM", stage: "execution", roomId: warehouse() });
  admin("add a role", { type: "ADD_ROLE", name: "Warehouse staff", description: "Works the stock" });
  const staffRole = () => Object.values(state.office.roles).find((r) => r.name === "Warehouse staff")!.id;
  admin("give the role access", { type: "SET_ROLE_GRANT", roleId: staffRole(), room: warehouse(), scope: "act", effect: "allow" });
  admin("and a deny elsewhere", { type: "SET_ROLE_GRANT", roleId: staffRole(), room: "finance", scope: "read", effect: "deny" });
  admin("clear one cell", { type: "SET_ROLE_GRANT", roleId: "intake", room: "planning", scope: "read", effect: "none" });
  admin("add an agent", { type: "ADD_AGENT", displayName: "Scout", title: "Stock Agent", roleId: staffRole(), roomId: warehouse(), capabilities: ["Count stock", "Flag shortages"], agentType: "playbook" });
  const scout = () => state.office.participants.find((p) => p.displayName === "Scout")!.id;
  admin("move the agent to another room", { type: "UPDATE_PARTICIPANT", participantId: scout(), roomId: "planning", title: "Planning Aide" });
  admin("give the agent a playbook", {
    type: "SET_PLAYBOOK",
    participantId: scout(),
    steps: [
      {
        id: "",
        when: { stage: "execution", requestContains: "stock", requestedBy: "p-dana" },
        then: {
          statusNote: "Stock counted",
          output: { label: "Count", body: "Twelve on the shelf." },
          question: { body: "Which shelf?", to: "requester", blocking: true, options: ["A", "B"] },
          assumption: { assumed: "Counts are current", because: "Counted this morning", confidence: "high" },
          need: { room: "finance", scope: "read", purpose: "Unit cost" },
          action: null,
        },
      },
      {
        id: "",
        when: { stage: "any", requestContains: "", requestedBy: "anyone" },
        then: { statusNote: "Nothing to count", output: null, question: null, assumption: null, need: null, action: null },
      },
    ],
  });
  admin("reorder and trim the playbook", {
    type: "SET_PLAYBOOK",
    participantId: scout(),
    steps: [...state.office.participants.find((p) => p.id === scout())!.playbook].reverse().slice(0, 1),
  });
  admin("switch the agent to an AI agent", { type: "UPDATE_PARTICIPANT", participantId: scout(), agentType: "ai", model: "some-model" });
  admin("and back to a playbook agent", { type: "UPDATE_PARTICIPANT", participantId: scout(), agentType: "playbook" });
  admin("add a role for people", { type: "ADD_ROLE", name: "Reviewer", description: "Signs off work" });
  const reviewer = () => Object.values(state.office.roles).find((r) => r.name === "Reviewer")!.id;
  admin("give it a permission", { type: "SET_ROLE_PERMISSION", roleId: reviewer(), permission: "decide_reviews", allowed: true });
  admin("and a second", { type: "SET_ROLE_PERMISSION", roleId: reviewer(), permission: "see_everything", allowed: true });
  admin("take the first away", { type: "SET_ROLE_PERMISSION", roleId: reviewer(), permission: "decide_reviews", allowed: false });
  admin("remove that role", { type: "REMOVE_ROLE", roleId: reviewer() });
  admin("move the stage back", { type: "SET_STAGE_ROOM", stage: "execution", roomId: "fulfilment" });
  admin("remove the agent", { type: "REMOVE_PARTICIPANT", participantId: scout() });
  admin("remove the role", { type: "REMOVE_ROLE", roleId: staffRole() });
  admin("clear all work", { type: "CLEAR_WORK" });
  admin("remove the room", { type: "REMOVE_ROOM", roomId: warehouse() });
  expect("tokens of cleared grants are gone", all(db, "SELECT 1 FROM access_tokens t JOIN access_rules r ON r.id = t.rule_id WHERE r.expires_on_task_id IS NOT NULL").length, 0);

  console.log("\n-- integrity --");
  expect("no foreign key violations", all(db, "PRAGMA foreign_key_check").length, 0);
  expect("integrity check", (all(db, "PRAGMA integrity_check")[0] as { integrity_check: string }).integrity_check, "ok");
  const orphans = all<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM access_decisions d
      WHERE NOT EXISTS (SELECT 1 FROM task_events e WHERE e.decision_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM message_escalations m WHERE m.denied_decision_id = d.id)`,
  )[0].n;
  expect("no orphaned access decisions", orphans, 0);

  console.log(`\n${failures === 0 ? "all store checks passed" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
