/**
 * Exercises the database layer: seeds an in-memory database, drives a full
 * workflow through it, and checks after every action that what is read back
 * equals what the engine produced. Run: npx tsx scripts/store.ts
 */
import { ALL_SCOPES, type AccessScope } from "../lib/model";
import { reduce, ScriptedRuntime, type Action, type EngineState } from "../lib/engine";
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
  const runtime = new ScriptedRuntime();

  console.log("\n-- seed round trip --");
  seedDatabase(db, initialState);
  let state: EngineState = initialState;
  const loaded = loadEngineState(db);
  const same = canonical(loaded) === canonical(state);
  expect("seeded office reads back identical", same, true);
  if (!same) console.log(firstDifference(canonical(loaded), canonical(state)));

  const apply = async (label: string, action: Action): Promise<void> => {
    const next = (await reduce(state, action, runtime)).state;
    transaction(db, () => saveEngineState(db, state, next));
    state = next;
    const back = canonical(loadEngineState(db));
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
