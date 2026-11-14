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
import { buildStepPrompt, toStepResult } from "../lib/server/modelRuntime";

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

  console.log(`\n${failures === 0 ? "all agent checks passed" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
