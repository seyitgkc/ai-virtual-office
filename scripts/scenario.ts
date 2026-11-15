/**
 * End-to-end walkthrough. Doubles as the README's example workflow.
 * Run: npx tsx scenario.ts
 */
import { resolveAccess, type Office } from "../lib/model";
import { floorplan, participants, roles, rules, stageRooms, contextFor, byId } from "../lib/seed";
import {
  reduce,
  eligibleOwners,
  type Action,
  type EngineState,
} from "../lib/engine";
import { PlaybookRuntime } from "../lib/playbook";

const runtime = new PlaybookRuntime();
let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown): void {
  const ok = actual === wanted;
  if (!ok) failures++;
  console.log(`   ${ok ? "pass" : "FAIL"}  ${label} -> ${String(actual)}`);
}

/** A fresh office: the same people and rules, no work in flight yet. */
const blank: Office = {
  id: "office-walkthrough",
  name: "Distributor Operations",
  floorplan,
  stageRooms,
  participants,
  roles,
  rules,
  tasks: [],
  messages: [],
  systems: [],
  autoHandoff: false,
};

let state: EngineState = {
  office: blank,
  now: Date.parse("2026-11-20T09:00:00-05:00"),
  seq: 0,
  clockStepMinutes: 4,
};

async function act(label: string, action: Action): Promise<void> {
  console.log(`\n> ${label}`);
  const result = await reduce(state, action, runtime);
  state = result.state;
  for (const note of result.notes) console.log(`   - ${note}`);
}

const task = () => state.office.tasks[0];

async function main(): Promise<void> {
  // -- 1. a human files work --------------------------------------------------
  await act("Sam files a dealer request", {
    type: "SUBMIT_REQUEST",
    title: "Dealer order: 6x multi-zone heads, Richmond Hill",
    detail:
      "Northline Mechanical need 6x Gree multi-zone heads for a 24 Nov start. Dealer pricing and a firm availability date.",
    requestedById: "p-sam",
  });
  expect("stage", task().stage, "intake");
  expect("status (Iris asked something)", task().status, "blocked_question");
  expect("assumptions recorded", task().assumptionIds.length, 1);

  // -- 2. you cannot advance past an open question ----------------------------
  await act("Try to advance while a question is open", { type: "ADVANCE", taskId: task().id });
  expect("still at intake", task().stage, "intake");

  // -- 3. the human answers ----------------------------------------------------
  await act("Sam answers", {
    type: "ANSWER_QUESTION",
    questionId: task().openQuestionIds[0],
    answeredById: "p-sam",
    body: "Standalone. The condensers are already on site.",
    chosenOption: "Standalone heads",
  });
  expect("unblocked", task().status, "in_progress");

  // -- 4. intake to planning ---------------------------------------------------
  await act("Advance to Planning", { type: "ADVANCE", taskId: task().id });
  expect("stage", task().stage, "planning");
  expect("owner", task().ownerId, "p-atlas");
  expect("assumptions now", task().assumptionIds.length, 2);

  // -- 5. planning to execution, where Vera hits a wall ------------------------
  await act("Advance to Execution", { type: "ADVANCE", taskId: task().id });
  expect("stage", task().stage, "execution");
  expect("owner", task().ownerId, "p-vera");
  expect("blocked on permission", task().status, "blocked_permission");

  // -- 6. a grant alone does not fix a deny ------------------------------------
  await act("Dana grants Vera read on Finance", {
    type: "GRANT_ACCESS",
    participantId: "p-vera",
    room: "finance",
    scopes: ["read"],
    effect: "allow",
    reason: "Dealer tier lookup for this order",
    grantedBy: "p-dana",
    expiresOnTaskId: task().id,
  });
  expect("still blocked, because deny outranks allow", task().status, "blocked_permission");

  // -- 7. clear the stale grant, then the deny ---------------------------------
  await act("Dana revokes r-01, the stale margin-review grant", {
    type: "REVOKE_RULE",
    ruleId: "r-01",
    revokedBy: "p-dana",
  });
  expect("still blocked (the deny remains)", task().status, "blocked_permission");

  await act("Dana revokes r-02, the blanket security deny", {
    type: "REVOKE_RULE",
    ruleId: "r-02",
    revokedBy: "p-dana",
  });
  expect("unblocked, on the scoped grant alone", task().status, "in_progress");

  // -- 8. execution to review --------------------------------------------------
  await act("Advance to Review", { type: "ADVANCE", taskId: task().id });
  expect("stage", task().stage, "review");
  expect("owner handed to Finance", task().ownerId, "p-ledger");
  expect("awaiting a decision", task().status, "in_review");

  // -- 9. the human gate -------------------------------------------------------
  await act("Dana approves", {
    type: "DECIDE",
    taskId: task().id,
    byId: "p-dana",
    verdict: "approved",
  });
  expect("completed", task().status, "completed");
  expect("closed", task().closedAt !== null, true);

  // -- 10. the scoped grant dies with the task ---------------------------------
  console.log("\n> Check Vera's access now the task has closed");
  const after = {
    roles: state.office.roles,
    rules: state.office.rules,
    now: state.now,
    closedTaskIds: new Set(
      state.office.tasks.filter((t) => t.closedAt !== null).map((t) => t.id),
    ),
  };
  const veraNow = resolveAccess(byId("p-vera"), "finance", "read", after);
  expect("Vera read Finance", veraNow.effect, "deny");
  console.log(`   - ${veraNow.explanation}`);

  // -- 11. contradicting an assumption halts the work that rested on it --------
  console.log("\n-- second thread: an assumption turns out to be wrong --");
  let s2: EngineState = { office: blank, now: state.now, seq: 500, clockStepMinutes: 4 };
  const r1 = await reduce(
    s2,
    {
      type: "SUBMIT_REQUEST",
      title: "Dealer order: PTAC units, Dartmouth",
      detail: "Four PTAC units for a hotel retrofit.",
      requestedById: "p-sam",
    },
    runtime,
  );
  s2 = r1.state;
  const t2 = s2.office.tasks[0];
  const assumptionId = t2.assumptionIds[0];
  console.log(`   - open assumption ${assumptionId} on ${t2.id}`);

  const r2 = await reduce(
    s2,
    {
      type: "RESOLVE_ASSUMPTION",
      assumptionId,
      status: "contradicted",
      byId: "p-dana",
    },
    runtime,
  );
  s2 = r2.state;
  for (const note of r2.notes) console.log(`   - ${note}`);
  const t2b = s2.office.tasks[0];
  expect("halted on a contradicted premise", t2b.status, "blocked_question");
  expect("a new question was raised", t2b.openQuestionIds.length >= 1, true);

  // -- 12. who could own work in each room -------------------------------------
  console.log("\n-- eligible owners by room --");
  const ctx = contextFor({ ...blank, tasks: [], messages: [] });
  for (const room of ["reception", "planning", "fulfilment", "finance", "operations"]) {
    const names = eligibleOwners(blank, room, ctx).map((p) => p.displayName);
    console.log(`   ${room.padEnd(12)} ${names.join(", ")}`);
  }

  console.log(`\n${failures === 0 ? "all scenario checks passed" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
