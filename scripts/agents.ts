/**
 * Checks what an agent is shown and how a model's reply is cleaned up. No
 * network: the model is never called. Run: npx tsx scripts/agents.ts
 */
import {
  reduce,
  type AgentRuntime,
  type AgentStepInput,
  type AgentStepResult,
} from "../lib/engine";
import { initialState } from "../lib/initialState";
import { resolveAccess } from "../lib/model";
import { contextOf } from "../lib/policy";
import { buildStepPrompt, SYSTEM_PROMPT, toStepResult } from "../lib/server/modelRuntime";

let failures = 0;
function expect(label: string, actual: unknown, wanted: unknown): void {
  const ok = actual === wanted;
  if (!ok) failures++;
  console.log(`${ok ? "pass" : "FAIL"}  ${label}${ok ? "" : `  (got ${String(actual)})`}`);
}

/** Records every input it is given and answers with a fixed result. */
class Recorder implements AgentRuntime {
  readonly inputs: AgentStepInput[] = [];
  constructor(private readonly answer: (input: AgentStepInput) => AgentStepResult) {}
  async step(input: AgentStepInput): Promise<AgentStepResult> {
    this.inputs.push(input);
    return this.answer(input);
  }
}

async function main(): Promise<void> {
  const quiet = new Recorder(() => ({ questions: [], assumptions: [] }));
  let state = initialState;
  const apply = async (action: Parameters<typeof reduce>[1]) => {
    state = (await reduce(state, action, quiet)).state;
  };

  console.log("\n-- what an agent is shown --");
  await apply({ type: "SUBMIT_REQUEST", title: "Order 4502", detail: "Four heads.", requestedById: "p-dana" });
  const task = () => state.office.tasks[state.office.tasks.length - 1];
  await apply({ type: "ADVANCE", taskId: task().id });
  await apply({ type: "ADVANCE", taskId: task().id });
  const vera = quiet.inputs.find((i) => i.participant.id === "p-vera")!;
  const room = (id: string) => vera.surroundings.rooms.find((r) => r.id === id)!;
  expect("the step went to Vera in Fulfilment", vera.stage, "execution");
  expect("Vera may read Fulfilment", room("fulfilment").readable, true);
  expect("Vera may not read Finance", room("finance").readable, false);
  expect("only people can be asked", vera.surroundings.people.every((p) => p.id === "p-dana" || p.id === "p-sam"), true);

  const prompt = buildStepPrompt(vera);
  expect("prompt includes Fulfilment stock records", prompt.includes("Gree multi-zone head, 12k BTU: Richmond Hill 4"), true);
  expect("prompt leaves out Finance records", prompt.includes("dealer tier 2"), false);
  expect("prompt leaves out landed cost", prompt.includes("landed cost 790"), false);
  expect("prompt says Finance cannot be read", prompt.includes("finance (Finance)") && prompt.includes("You cannot read it."), true);

  console.log("\n-- an agent with access is shown more --");
  await apply({ type: "REVOKE_RULE", ruleId: "r-02", revokedBy: "p-dana" });
  await apply({ type: "SUBMIT_REQUEST", title: "Order 4503", detail: "Two heads.", requestedById: "p-dana" });
  await apply({ type: "ADVANCE", taskId: task().id });
  await apply({ type: "ADVANCE", taskId: task().id });
  const veraLater = quiet.inputs.filter((i) => i.participant.id === "p-vera").at(-1)!;
  expect("with the deny revoked, Vera may read Finance", veraLater.surroundings.rooms.find((r) => r.id === "finance")!.readable, true);
  expect("and her prompt now carries Finance records", buildStepPrompt(veraLater).includes("dealer tier 2"), true);

  console.log("\n-- messages are filtered per agent --");
  const withDm = new Recorder(() => ({ questions: [], assumptions: [] }));
  // T-1001 holds a direct message from Quill to Dana. Handing it to Vera must not show it to her.
  const moved = await reduce(initialState, { type: "REASSIGN", taskId: "T-1001", toParticipantId: "p-vera", byId: "p-dana" }, withDm);
  const advanced = await reduce(moved.state, { type: "REVOKE_RULE", ruleId: "r-02", revokedBy: "p-dana" }, withDm);
  await reduce(
    { ...advanced.state, office: { ...advanced.state.office, tasks: advanced.state.office.tasks.map((t) => (t.id === "T-1001" ? { ...t, status: "in_progress" as const } : t)) } },
    { type: "ADVANCE", taskId: "T-1001" },
    withDm,
  );
  const ledger = withDm.inputs.find((i) => i.participant.id === "p-ledger");
  const all = initialState.office.messages.filter((m) => m.taskId === "T-1001").length;
  expect("the Finance agent took the review step", ledger?.stage, "review");
  expect("it was shown fewer messages than exist on the task", (ledger?.priorMessages.length ?? all) < all, true);
  expect(
    "none of them a private message between other people",
    ledger?.priorMessages.some((m) => m.audience.to === "participant" && m.audience.id !== "p-ledger" && m.fromId !== "p-ledger"),
    false,
  );

  console.log("\n-- a model's reply is cleaned before the engine sees it --");
  const cleaned = toStepResult(
    {
      statusNote: "  Checked stock.  ",
      questions: [
        { body: "Split the shipment?", toParticipantId: "p-nobody", blocking: true, options: ["Yes", "", "No"] },
        { body: "", toParticipantId: "p-sam", blocking: false, options: [] },
        { body: "Second", toParticipantId: "p-sam", blocking: false, options: [] },
        { body: "Third", toParticipantId: "p-sam", blocking: false, options: [] },
      ],
      assumptions: [{ assumed: "x".repeat(900), because: "why", confidence: "low" }],
      needs: [
        { room: "vault", scope: "read", purpose: "made-up room" },
        { room: "fulfilment", scope: "read", purpose: "already readable" },
        { room: "finance", scope: "read", purpose: "dealer tier" },
      ],
      output: { label: "", body: "   " },
    },
    vera,
  );
  expect("status note is trimmed", cleaned.statusNote, "Checked stock.");
  expect("empty questions are dropped and the rest capped at two", cleaned.questions.length, 2);
  expect("a question to an unknown person goes to the requester", cleaned.questions[0].toParticipantId, "p-dana");
  expect("empty options are dropped", cleaned.questions[0].options?.join(","), "Yes,No");
  expect("long text is clipped", cleaned.assumptions[0].assumed.length, 200);
  expect("needs for unknown or already readable rooms are dropped", cleaned.needs?.map((n) => n.room).join(","), "finance");
  expect("an empty output is no output", cleaned.output, undefined);

  const wordy = toStepResult(
    {
      statusNote: "Done.",
      questions: [
        {
          body: "Which one?",
          toParticipantId: "p-dana",
          blocking: true,
          options: ["Send the delivery address plus zone and capacity requirements in one reply and I will draft the quote", "Short"],
        },
      ],
      assumptions: [],
      needs: [],
      output: null,
    },
    vera,
  );
  const longOption = wordy.questions[0].options?.[0] ?? "";
  expect("a long option is cut at a whole word", longOption.length <= 80 && longOption.endsWith("...") && !/\s\.\.\.$/.test(longOption), true);
  expect("and never in the middle of one", "Send the delivery address plus zone and capacity requirements in one reply and I will draft the quote".startsWith(longOption.slice(0, -3) + " "), true);

  console.log("\n-- the prompt is about the agent's own office --");
  expect("the prompt names the office", buildStepPrompt(vera).startsWith(`Office: ${initialState.office.name}.`), true);
  expect("the standing instructions name no line of business", /HVAC|distributor/i.test(SYSTEM_PROMPT), false);
  const bare = buildStepPrompt({ ...vera, surroundings: { ...vera.surroundings, rooms: vera.surroundings.rooms.map((r) => ({ ...r, id: `other-${r.id}` })) } });
  expect("rooms with no records say so", bare.includes("(none: the rooms you can read hold no records)"), true);

  console.log("\n-- a halt at review ends in a decision --");
  const ledgerPerson = initialState.office.participants.find((p) => p.id === "p-ledger")!;
  const closedRoom = initialState.office.floorplan.rooms.find(
    (r) => resolveAccess(ledgerPerson, r.id, "read", contextOf(initialState.office, initialState.now)).effect === "deny",
  )!;
  const reviewer = (answer: AgentStepResult) =>
    new Recorder((input) => (input.stage === "review" ? answer : { questions: [], assumptions: [] }));
  const toReview = async (runtime: Recorder) => {
    let at = (await reduce(initialState, { type: "SUBMIT_REQUEST", title: "Order 4700", detail: "One head.", requestedById: "p-dana" }, runtime)).state;
    const id = at.office.tasks.at(-1)!.id;
    for (let i = 0; i < 3; i++) at = (await reduce(at, { type: "ADVANCE", taskId: id }, runtime)).state;
    return { at, id };
  };

  const asking = reviewer({ questions: [{ body: "Approve at list price?", toParticipantId: "p-dana", blocking: true }], assumptions: [] });
  let review = await toReview(asking);
  const reviewTask = () => review.at.office.tasks.find((t) => t.id === review.id)!;
  expect("a question at review halts the task", `${reviewTask().stage}/${reviewTask().status}`, "review/blocked_question");
  const asked = review.at.office.messages.findLast((m) => m.kind === "question" && m.taskId === review.id)!;
  review.at = (await reduce(review.at, { type: "ANSWER_QUESTION", questionId: asked.id, answeredById: "p-dana", body: "Yes" }, asking)).state;
  expect("answering it leaves the task waiting for a decision", reviewTask().status, "in_review");
  review.at = (await reduce(review.at, { type: "DECIDE", taskId: review.id, byId: "p-dana", verdict: "approved" }, asking)).state;
  expect("which a person can then give", reviewTask().status, "completed");

  const needing = reviewer({ questions: [], assumptions: [], needs: [{ room: closedRoom.id, scope: "read", purpose: "The stock count for this order." }] });
  review = await toReview(needing);
  expect("a missing permission at review halts the task", `${reviewTask().stage}/${reviewTask().status}`, "review/blocked_permission");
  const wall = review.at.office.messages.findLast((m) => m.kind === "escalation" && m.taskId === review.id)!;
  expect("the escalation names the room", wall.body.includes(`access to ${closedRoom.name}.`), true);
  expect("and reads cleanly", wall.body.includes(".. ") || wall.body.includes(closedRoom.id + "."), false);
  const granted = await reduce(
    review.at,
    { type: "GRANT_ACCESS", participantId: "p-ledger", room: closedRoom.id, scopes: ["read"], effect: "allow", reason: "For this review", grantedBy: "p-dana", expiresOnTaskId: review.id },
    needing,
  );
  review.at = granted.state;
  expect("the grant leaves the task waiting for a decision", reviewTask().status, "in_review");
  expect("and the note says so", granted.notes.some((n) => n.includes("It is ready for a decision.")), true);

  console.log("\n-- repeated assumptions and halted drafts --");
  const guess = { assumed: "Standard delivery terms apply", because: "None were named", confidence: "medium" as const };
  const repeating = new Recorder((input) => ({
    questions: [],
    assumptions: input.stage === "intake" ? [guess] : [{ ...guess, assumed: "standard delivery terms apply." }, { ...guess, assumed: "The customer pays on account" }],
  }));
  let repeat = (await reduce(initialState, { type: "SUBMIT_REQUEST", title: "Order 4800", detail: "One head.", requestedById: "p-dana" }, repeating)).state;
  const repeatId = repeat.office.tasks.at(-1)!.id;
  repeat = (await reduce(repeat, { type: "ADVANCE", taskId: repeatId }, repeating)).state;
  const kept = repeat.office.messages.filter((m) => m.kind === "assumption" && m.taskId === repeatId);
  expect("an assumption repeated at a later step is recorded once", kept.length, 2);
  expect("and a new one is still recorded", kept.at(-1)?.kind === "assumption" && kept.at(-1)?.body.includes("pays on account"), true);

  const drafting = (agentType: "ai" | "playbook") => {
    const office = { ...initialState.office, participants: initialState.office.participants.map((p) => (p.id === "p-ledger" ? { ...p, agentType } : p)) };
    return { ...initialState, office };
  };
  const halting = reviewer({ questions: [], assumptions: [], needs: [{ room: closedRoom.id, scope: "read", purpose: "The stock count" }], output: { label: "Review notes", body: "Checked what I could." } });
  const outputsAfterHalt = async (agentType: "ai" | "playbook") => {
    let at = (await reduce(drafting(agentType), { type: "SUBMIT_REQUEST", title: "Order 4900", detail: "One head.", requestedById: "p-dana" }, halting)).state;
    const id = at.office.tasks.at(-1)!.id;
    for (let i = 0; i < 3; i++) at = (await reduce(at, { type: "ADVANCE", taskId: id }, halting)).state;
    return at.office.messages.filter((m) => m.kind === "output" && m.taskId === id && m.fromId === "p-ledger");
  };
  const aiDraft = await outputsAfterHalt("ai");
  expect("an AI agent's output survives a halt, marked as a draft", aiDraft[0]?.kind === "output" && aiDraft[0].label, "Draft: Review notes");
  expect("a playbook agent's output is still held back", (await outputsAfterHalt("playbook")).length, 0);

  console.log(`\n${failures === 0 ? "all agent checks passed" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
