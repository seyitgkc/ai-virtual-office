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
import { deskState, statusReply } from "../lib/agentState";
import { canRead, resolveAccess } from "../lib/model";
import { contextOf } from "../lib/policy";
import { buildChatSystem } from "../lib/server/chat";
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
  expect("prompt includes Fulfilment records", prompt.includes("Next inbound container at Laval"), true);
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
      actions: [{ system: "sys-nowhere", operation: "place_order", fields: [] }],
      notes: [
        { to: "p-ledger", body: "Check the credit limit before approving." },
        { to: "p-nobody", body: "Made-up recipient." },
        { to: "p-dana", body: "   " },
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
  expect("an action in a system that is not connected is dropped", cleaned.actions, undefined);
  expect("a note to someone in the office is kept, and the rest dropped", cleaned.notes?.map((n) => n.toParticipantId).join(), "p-ledger");

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
      actions: [],
      notes: [],
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
  const bare = buildStepPrompt({ ...vera, surroundings: { ...vera.surroundings, rooms: vera.surroundings.rooms.map((r) => ({ ...r, records: [] })) } });
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

  console.log("\n-- an AI agent follows up on what a connected system answered --");
  const chained = async (agentType: "ai" | "playbook") => {
    const office = {
      ...initialState.office,
      systems: [
        { id: "sys-shop", name: "Shop", kind: "storefront" as const, roomId: "reception" },
        { id: "sys-freight", name: "Freight", kind: "carrier" as const, roomId: "reception" },
      ],
      participants: initialState.office.participants.map((p) => (p.id === "p-iris" ? { ...p, agentType } : p)),
    };
    const steps: AgentStepInput[] = [];
    const performed: string[] = [];
    const result = await reduce(
      { ...initialState, office },
      { type: "SUBMIT_REQUEST", title: "Three units", detail: "Order and ship three units.", requestedById: "p-sam" },
      {
        step: async (input) => {
          steps.push(input);
          const last = input.priorMessages[input.priorMessages.length - 1]?.body ?? "";
          const order = last.match(/SO-\d+/)?.[0];
          return {
            statusNote: "Working the order.",
            questions: [],
            assumptions: [],
            actions: !input.afterAction
              ? [{ systemId: "sys-shop", operation: "place_order", fields: { account: "A-1", branch: "Laval", items: "PTAC-12 x 3" } }]
              : order
                ? [{ systemId: "sys-freight", operation: "book_shipment", fields: { reference: order, from: "Laval", to: "Ottawa", weightKg: "144", service: "ground" } }]
                : [],
          };
        },
        perform: async (call) => {
          performed.push(`${call.operation}:${call.fields.reference ?? call.fields.items}`);
          return { ok: true, summary: call.operation === "place_order" ? "placed order SO-7001." : "booked shipment SH-1." };
        },
      },
    );
    return { steps, performed, bodies: result.emitted.map((m) => m.body) };
  };
  const ai = await chained("ai");
  expect("after acting, an AI agent takes the step once more", ai.steps.length, 2);
  expect("and is told so", ai.steps[1].afterAction, true);
  expect("with the system's answer as the latest thing in its thread", ai.steps[1].priorMessages.at(-1)?.body, "Shop: placed order SO-7001.");
  expect("so the booking can carry the new order number", ai.performed.join(" | "), "place_order:PTAC-12 x 3 | book_shipment:SO-7001");
  expect("it does not go round a third time", ai.bodies.filter((b) => b === "Working the order.").length, 1);
  expect("the prompt for that step explains why it is taken again", buildStepPrompt(ai.steps[1]).includes("You are taking this step a second time."), true);
  expect("and the first prompt does not", buildStepPrompt(ai.steps[0]).includes("a second time"), false);
  const scripted = await chained("playbook");
  expect("a playbook agent acts once and does not follow up", `${scripted.steps.length} ${scripted.performed.length}`, "1 1");

  console.log("\n-- what a desk shows, and what an agent is shown for a conversation --");
  const seeded = initialState.office;
  const who = (id: string) => seeded.participants.find((p) => p.id === id)!;
  const seededCtx = contextOf(seeded, initialState.now);
  const quillDesk = deskState(seeded, who("p-quill"));
  expect("a halted agent's desk says it is waiting for access", `${quillDesk.tone} ${quillDesk.task?.id}`, "permission T-1001");
  expect("and shows what it asked for", quillDesk.detail.includes("Finance"), true);
  expect("an agent waiting on an answer says so", deskState(seeded, who("p-vera")).tone, "question");
  expect("an agent with no open work has nothing on the desk", deskState(seeded, who("p-iris")).tone, "idle");
  const report = statusReply(seeded, who("p-quill"), who("p-dana"), seededCtx);
  expect("a playbook agent answers with where its work stands", report.includes("T-1001") && report.includes("halted"), true);
  expect("and says it follows a playbook", report.startsWith("I follow a playbook"), true);
  const withDana = buildChatSystem(seeded, who("p-ledger"), who("p-dana"), seededCtx, []);
  const withSam = buildChatSystem(seeded, who("p-ledger"), who("p-sam"), seededCtx, []);
  expect("talking to someone who reads Finance, the Finance agent is shown its records", withDana.includes("dealer tier 2"), true);
  expect("talking to someone who does not, it is not", withSam.includes("dealer tier 2"), false);
  expect("and is told why", withSam.includes("this person cannot"), true);
  expect("an agent that cannot read Finance is never shown it", buildChatSystem(seeded, who("p-vera"), who("p-dana"), seededCtx, []).includes("dealer tier 2"), false);
  expect("live records it is handed are included", buildChatSystem(seeded, who("p-vera"), who("p-dana"), seededCtx, ["[Storefront, live] Product X"]).includes("[Storefront, live] Product X"), true);
  expect("the conversation instructions rule out changing anything", withDana.includes("You cannot change anything from this conversation"), true);

  console.log("\n-- notes from an agent --");
  let seenByNext: AgentStepInput | null = null;
  const noted = await reduce(
    initialState,
    { type: "SUBMIT_REQUEST", title: "Two heads", detail: "Northline need two heads.", requestedById: "p-sam" },
    {
      step: async (input) => {
        seenByNext = input;
        return {
          questions: [],
          assumptions: [],
          notes: [
            { toParticipantId: "p-atlas", body: "The dealer wants delivery before the 24th." },
            { toParticipantId: "p-atlas", body: "The dealer wants delivery before the 24th." },
            { toParticipantId: input.participant.id, body: "A note to myself." },
            { toParticipantId: "p-nobody", body: "A note to nobody." },
            { toParticipantId: "p-sam", body: "Logged, nothing needed from you." },
          ],
        };
      },
    },
  );
  const left = noted.emitted.filter((m) => m.kind === "note");
  expect("a note is addressed to one participant, a person or another agent", left.map((m) => (m.audience.to === "participant" ? m.audience.id : "")).join(), "p-atlas");
  expect("repeats, notes to itself, to nobody and beyond two are dropped", left.length, 1);
  expect("the agent is told who its colleagues are", (seenByNext as AgentStepInput | null)?.surroundings.colleagues.some((c) => c.id === "p-atlas"), true);
  expect("and its prompt lists them", buildStepPrompt(seenByNext!).includes("Other agents in the office:"), true);
  const atlasPerson = initialState.office.participants.find((p) => p.id === "p-atlas")!;
  const samPerson = initialState.office.participants.find((p) => p.id === "p-sam")!;
  const noteCtx = contextOf(noted.state.office, noted.state.now);
  expect("the agent it is for can read it", canRead(left[0], atlasPerson, noteCtx), true);
  expect("someone else in the same room cannot", canRead(left[0], samPerson, noteCtx), false);

  console.log(`\n${failures === 0 ? "all agent checks passed" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
