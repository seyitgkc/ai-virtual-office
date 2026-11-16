/**
 * Checks what happens to a task that is rejected after it has already done
 * things in connected systems: a person is asked, the agents that did each
 * thing carry the answer out, and the task closes only when nothing is left
 * standing or a person says to leave it. No network: the systems and the
 * models are stand-ins. Run: npx tsx scripts/windup.ts
 */
import { CARRIER, LEDGER, STOREFRONT } from "../services/manifests.ts";
import { reduce, type Action, type AgentRuntime, type AgentStepInput, type AgentStepResult, type EngineState, type SystemCall, type SystemOutcome, type Wake } from "../lib/engine";
import { initialState } from "../lib/initialState";
import { PlaybookRuntime } from "../lib/playbook";
import { authorize, contextOf } from "../lib/policy";
import { buildStepPrompt } from "../lib/server/modelRuntime";
import { APPROVE } from "../lib/systems";
import { CLOSE_AS_IS, deedsOf, LEAVE_ALL, TRY_AGAIN, UNDO_ALL } from "../lib/windup";

let failures = 0;
function expect(label: string, actual: unknown, wanted: unknown): void {
  const ok = actual === wanted;
  if (!ok) failures++;
  console.log(`${ok ? "pass" : "FAIL"}  ${label}${ok ? "" : `  (got ${String(actual)})`}`);
}

/** Three stand-in systems that keep what was made in them and can refuse. */
class World {
  made = new Map<string, "standing" | "gone">();
  calls: string[] = [];
  private n = 1000;
  /** Operations that are refused, with the reason given. */
  refuse = new Map<string, string>();

  perform = async (call: SystemCall): Promise<SystemOutcome> => {
    this.calls.push(`${call.operation}:${Object.values(call.fields).join(",")}`);
    const no = this.refuse.get(call.operation);
    if (no) return { ok: false, summary: `refused to ${call.operation.replace(/_/g, " ")}: ${no}.` };
    const make = (prefix: string, what: string): SystemOutcome => {
      const id = `${prefix}-${++this.n}`;
      this.made.set(id, "standing");
      return { ok: true, summary: `${what} ${id}.`, record: id };
    };
    const take = (field: string, what: string): SystemOutcome => {
      const id = (call.fields[field] ?? "").toUpperCase();
      if (!this.made.has(id)) return { ok: false, summary: `refused to ${call.operation.replace(/_/g, " ")}: there is no ${id}.` };
      this.made.set(id, "gone");
      return { ok: true, summary: `${what} ${id}.`, record: id };
    };
    switch (call.operation) {
      case "place_order":
        return make("SO", "placed order");
      case "cancel_order":
        return take("order", "cancelled order");
      case "book_shipment":
        return make("SH", "booked shipment");
      case "cancel_shipment":
        return take("shipment", "cancelled shipment");
      case "raise_invoice":
        return make("INV", "raised invoice");
      case "void_invoice":
        return take("invoice", "voided invoice");
      case "record_payment":
        return make("PAY", "recorded payment");
      default:
        return { ok: false, summary: "has no such operation." };
    }
  };

  standing = (): string => [...this.made].filter(([, s]) => s === "standing").map(([id]) => id.split("-")[0]).sort().join();
}

const system = (id: string, manifest: typeof STOREFRONT, needsApproval = false) => ({
  id,
  name: manifest.name,
  description: manifest.description,
  operations: manifest.operations,
  roomId: "fulfilment",
  shownIn: [] as string[],
  needsApproval,
});

/** What the worker does at execution, as a list of operations. */
type Work = ("place_order" | "book_shipment" | "raise_invoice" | "record_payment")[];

const FIELDS: Record<Work[number], [string, Record<string, string>]> = {
  place_order: ["sys-shop", { account: "CAL-3310", branch: "Laval", items: "GREE-CU-24 x 2" }],
  book_shipment: ["sys-freight", { reference: "SO-1001", from: "Laval", to: "Richmond Hill", weightKg: "104", service: "ground" }],
  raise_invoice: ["sys-ledger", { account: "CAL-3310", reference: "SO-1001", listAmount: "4300", freight: "138.60" }],
  record_payment: ["sys-ledger", { account: "CAL-3310", amount: "500" }],
};

/**
 * A stand-in model. At execution it does the work it is given. Asked to deal
 * with one thing on a rejected task, it uses the operation and the record the
 * note names, unless told to name another record or to do nothing.
 */
class Brain implements AgentRuntime {
  inputs: AgentStepInput[] = [];
  /** A record to name in place of the one the note gives. */
  wrongRecord: string | null = null;
  /** Operations the agent leaves alone, saying why in its note. */
  leaves = new Set<string>();
  perform: World["perform"];
  constructor(private readonly work: Work, world: World) {
    this.perform = world.perform;
  }

  async step(input: AgentStepInput): Promise<AgentStepResult> {
    this.inputs.push(input);
    const nothing: AgentStepResult = { questions: [], assumptions: [] };
    if (input.attending && input.windingUp) {
      const to = input.attending.fromId;
      const operation = /\((\w+)\)/.exec(input.attending.body)?.[1];
      const record = /the record is ([A-Z]+-\d+)/.exec(input.attending.body)?.[1];
      if (input.afterAction) return { ...nothing, notes: [{ toParticipantId: to, body: `I have dealt with ${record}. The system's answer is in the thread.` }] };
      const where = input.surroundings.systems.find((s) => s.operations.some((o) => o.id === operation));
      const how = where?.operations.find((o) => o.id === operation);
      if (!operation || !record || !where || !how || this.leaves.has(operation)) {
        return { ...nothing, notes: [{ toParticipantId: to, body: "I left that as it is, as you asked." }] };
      }
      const fields = Object.fromEntries(how.fields.map((f, i) => [f.name, i === 0 ? (this.wrongRecord ?? record) : "The task was rejected"]));
      return { ...nothing, actions: [{ systemId: where.id, operation, fields }] };
    }
    if (input.attending || input.afterAction || input.stage !== "execution") return nothing;
    return {
      ...nothing,
      statusNote: "Carried out the order.",
      actions: this.work.map((operation) => ({ systemId: FIELDS[operation][0], operation, fields: FIELDS[operation][1] })),
      output: { label: "Order", body: "The order is placed." },
    };
  }
}

async function main(): Promise<void> {
  const office = (agentType: "ai" | "playbook", approval = false) => ({
    ...initialState,
    office: {
      ...initialState.office,
      participants: initialState.office.participants.map((p) => (p.kind === "agent" ? { ...p, agentType, playbook: [] } : p)),
      systems: [system("sys-shop", STOREFRONT, approval), system("sys-freight", CARRIER), system("sys-ledger", LEDGER)],
    },
  });

  /** File a task, let the agents take it to review, and reject it. */
  const rejected = async (start: EngineState, brain: AgentRuntime) => {
    let at = (await reduce(start, { type: "SUBMIT_REQUEST", title: "Calder order", detail: "Two condensers.", requestedById: "p-dana" }, brain)).state;
    const id = at.office.tasks.at(-1)!.id;
    for (let i = 0; i < 3; i++) at = (await reduce(at, { type: "ADVANCE", taskId: id }, brain)).state;
    const before = at;
    const ruled = await reduce(at, { type: "DECIDE", taskId: id, byId: "p-dana", verdict: "rejected" }, brain);
    return { at: ruled.state, id, before, emitted: ruled.emitted };
  };
  const taskOf = (at: EngineState, id: string) => at.office.tasks.find((t) => t.id === id)!;
  const openQuestion = (at: EngineState, id: string) =>
    at.office.messages.find((m) => m.kind === "question" && taskOf(at, id).openQuestionIds.includes(m.id))!;
  const answer = (at: EngineState, id: string, said: string, brain: AgentRuntime, option = true) =>
    reduce(at, { type: "ANSWER_QUESTION", questionId: openQuestion(at, id).id, answeredById: "p-dana", body: said, ...(option ? { chosenOption: said } : {}) }, brain);

  /** Do what the office would: let each woken agent look at its note, then take the winding up further. */
  const settle = async (from: EngineState, id: string, wakes: Wake[], brain: Brain): Promise<EngineState> => {
    let at = from;
    const queue = [...wakes];
    for (let i = 0; i < 40; i++) {
      const next = queue.shift();
      const action: Action = !next
        ? { type: "WIND_UP", taskId: id }
        : next.kind === "attend"
          ? { type: "AGENT_ATTEND", taskId: next.taskId, participantId: next.participantId, noteId: next.noteId }
          : { type: "AGENT_RESUME", taskId: next.taskId };
      const step = await reduce(at, action, brain);
      at = step.state;
      queue.push(...step.wake);
      if (!next && step.emitted.length === 0) break;
    }
    return at;
  };
  const lastBody = (at: EngineState, id: string) => at.office.messages.findLast((m) => m.taskId === id)!.body;

  console.log("\n-- a task that did nothing in any system --");
  {
    const world = new World();
    const brain = new Brain([], world);
    const { at, id } = await rejected(office("ai"), brain);
    expect("rejecting it closes it at once", `${taskOf(at, id).status} ${taskOf(at, id).closedAt !== null}`, "rejected true");
    expect("and nobody is asked anything", taskOf(at, id).openQuestionIds.length, 0);
  }

  console.log("\n-- a task that placed an order, booked freight and raised an invoice --");
  const world = new World();
  const brain = new Brain(["place_order", "book_shipment", "raise_invoice"], world);
  const start = await rejected(office("ai"), brain);
  const id = start.id;
  {
    const at = start.at;
    expect("the three things are on record before it is rejected", deedsOf(start.before.office, id).standing.map((d) => d.message.did.record).join(), "SO-1001,SH-1002,INV-1003");
    expect("rejecting it does not close it", `${taskOf(at, id).status} ${taskOf(at, id).closedAt} ${taskOf(at, id).windUp}`, "blocked_question null true");
    const q = openQuestion(at, id);
    expect("the person who rejected it is asked", q.audience.to === "participant" && q.audience.id, "p-dana");
    expect("what it did is listed from the record", ["placed order SO-1001", "booked shipment SH-1002", "raised invoice INV-1003"].every((s) => q.body.includes(s)), true);
    expect("with who did each thing and where", q.body.includes(", in Storefront: placed order SO-1001"), true);
    expect("and two ready answers", q.kind === "question" && q.options?.join(" | "), `${UNDO_ALL} | ${LEAVE_ALL}`);
    expect("the task does not move on meanwhile", (await reduce(at, { type: "ADVANCE", taskId: id }, brain)).state.office.tasks.find((t) => t.id === id)!.stage, taskOf(at, id).stage);
    expect("and cannot be decided a second time", (await reduce(at, { type: "DECIDE", taskId: id, byId: "p-dana", verdict: "approved" }, brain)).state.office.tasks.find((t) => t.id === id)!.status, "blocked_question");
    const dana = at.office.participants.find((p) => p.id === "p-dana")!;
    expect("only the office takes the winding up further", authorize(at.office, contextOf(at.office, at.now), dana, { type: "WIND_UP", taskId: id }).allowed, false);
  }

  {
    // A system may add how things stood right after. That is left out of the list.
    const at = start.before;
    const invoice = at.office.messages.find((m) => m.taskId === id && m.body.includes("raised invoice"))!;
    const wordy = { ...at.office, messages: at.office.messages.map((m) => (m.id === invoice.id ? { ...m, body: `${m.body.replace(/\.$/, "")}, 1,927.30 CAD due on 2026-12-16. The account now has 8,027.30 CAD owed.` } : m)) };
    expect("only what was done is listed, not the balance quoted at the time", deedsOf(wordy, id).standing.at(-1)!.summary, "raised invoice INV-1003, 1,927.30 CAD due on 2026-12-16");
  }

  console.log("\n-- undo all of them --");
  {
    const said = await answer(start.at, id, UNDO_ALL, brain);
    const note = said.emitted.find((m) => m.kind === "note")!;
    expect("the newest thing is dealt with first", note.body.includes("raised invoice INV-1003"), true);
    expect("by the agent that did it", note.audience.to === "participant" && note.audience.id, start.before.office.messages.find((m) => m.body.includes("raised invoice"))!.fromId);
    expect("in the name of the person who answered", note.fromId, "p-dana");
    expect("the note names the operation and the record", note.body.includes('"Void an invoice" (void_invoice), and the record is INV-1003'), true);
    expect("and that agent is woken for it", said.wake.map((w) => w.kind).join(), "attend");
    expect("the task is with the agents now", `${taskOf(said.state, id).status} ${taskOf(said.state, id).closedAt}`, "in_progress null");
    const told = brain.inputs.length;
    const end = await settle(said.state, id, said.wake, brain);
    const shown = brain.inputs[told];
    expect("the agent is told the task was rejected and what to do", buildStepPrompt(shown).includes("This task was rejected and is being wound up."), true);
    expect("and to report once, when the system has answered", buildStepPrompt(shown).includes('In the step where you add the action, leave "notes" empty'), true);
    expect("each thing is taken back, newest first", world.calls.slice(3).join(" | "), "void_invoice:INV-1003,The task was rejected | cancel_shipment:SH-1002 | cancel_order:SO-1001");
    expect("nothing is left standing in the systems", world.standing(), "");
    expect("and only then does the task close", `${taskOf(end, id).status} ${taskOf(end, id).closedAt !== null} ${taskOf(end, id).windUp}`, "rejected true undefined");
    expect("the thread ends with what was taken back", lastBody(end, id).startsWith("Closed as rejected. Nothing this task did in a connected system is left standing. Taken back: "), true);
    expect("the agent told the person what came of each", end.office.messages.filter((m) => m.taskId === id && m.kind === "note" && m.audience.to === "participant" && m.audience.id === "p-dana").length, 3);
    expect("a closed task takes no further answer", (await reduce(end, { type: "WIND_UP", taskId: id }, brain)).emitted.length, 0);
  }

  console.log("\n-- leave them as they are --");
  {
    const w = new World();
    const b = new Brain(["place_order", "book_shipment"], w);
    const r = await rejected(office("ai"), b);
    const said = await answer(r.at, r.id, LEAVE_ALL, b);
    expect("the task closes at once", `${taskOf(said.state, r.id).status} ${taskOf(said.state, r.id).closedAt !== null}`, "rejected true");
    expect("nothing is touched in the systems", w.standing(), "SH,SO");
    expect("and the thread says what was left in place", lastBody(said.state, r.id).includes("Left in place: (1)") && lastBody(said.state, r.id).includes("placed order SO-1001"), true);
    expect("no agent is woken", said.wake.length, 0);
  }

  console.log("\n-- something cannot be taken back --");
  {
    const w = new World();
    const b = new Brain(["place_order", "book_shipment"], w);
    const r = await rejected(office("ai"), b);
    w.refuse.set("cancel_shipment", "it has left the dock");
    const said = await answer(r.at, r.id, UNDO_ALL, b);
    const stuck = await settle(said.state, r.id, said.wake, b);
    expect("the order is cancelled and the shipment is not", w.standing(), "SH");
    expect("so the task stays open", `${taskOf(stuck, r.id).status} ${taskOf(stuck, r.id).closedAt}`, "blocked_question null");
    const q = openQuestion(stuck, r.id);
    expect("the person is told what is still in place, and why", q.body.includes("Still in place: (1)") && q.body.includes("booked shipment SH-1002") && q.body.includes("it has left the dock"), true);
    expect("and what was taken back", q.body.includes("Taken back: (1)") && q.body.includes("placed order SO-1001"), true);
    expect("and is asked what next", q.kind === "question" && q.options?.join(" | "), `${TRY_AGAIN} | ${CLOSE_AS_IS}`);
    expect("in words that say it could not be taken back", q.body.startsWith("Not everything this rejected task did could be taken back."), true);

    w.refuse.clear();
    const again = await answer(stuck, r.id, TRY_AGAIN, b);
    const done = await settle(again.state, r.id, again.wake, b);
    expect("trying again repeats what was asked before", w.calls.at(-1), "cancel_shipment:SH-1002");
    expect("and the task closes once it works", `${taskOf(done, r.id).status} ${w.standing()}`, "rejected ");

    const closed = await answer(stuck, r.id, CLOSE_AS_IS, b);
    expect("or it is closed as it stands, on the person's word", taskOf(closed.state, r.id).status, "rejected");
    expect("with what is left in place on record", lastBody(closed.state, r.id).includes("Left in place: (1)") && lastBody(closed.state, r.id).includes("SH-1002"), true);
  }

  console.log("\n-- an agent may only take back what this task made --");
  {
    const w = new World();
    const b = new Brain(["place_order"], w);
    const r = await rejected(office("ai"), b);
    w.made.set("SO-0007", "standing");
    b.wrongRecord = "SO-0007";
    const said = await answer(r.at, r.id, UNDO_ALL, b);
    const stuck = await settle(said.state, r.id, said.wake, b);
    expect("an order of another task is not cancelled", w.made.get("SO-0007"), "standing");
    expect("the system is never asked", w.calls.includes("cancel_order:SO-0007"), false);
    expect("the thread says why it was not done", stuck.office.messages.some((m) => m.taskId === r.id && m.body.includes("not done, because it named SO-0007, and what this task made in Storefront is SO-1001")), true);
    expect("and the person is asked what next", openQuestion(stuck, r.id).body.includes("placed order SO-1001"), true);
  }

  console.log("\n-- something the system cannot take back --");
  {
    const w = new World();
    const b = new Brain(["record_payment"], w);
    const r = await rejected(office("ai"), b);
    const said = await answer(r.at, r.id, UNDO_ALL, b);
    expect("no agent is asked to do what cannot be done", said.wake.length, 0);
    expect("the person is told the system has no way to take it back", openQuestion(said.state, r.id).body.includes("Accounts ledger has no way to take this back"), true);
    expect("and the task stays open for their answer", taskOf(said.state, r.id).closedAt, null);
  }

  console.log("\n-- an answer in the person's own words --");
  {
    const w = new World();
    const b = new Brain(["place_order", "book_shipment"], w);
    const r = await rejected(office("ai"), b);
    b.leaves.add("cancel_order");
    const said = await answer(r.at, r.id, "Cancel the freight. Keep the order, the dealer still wants it.", b, false);
    const note = said.emitted.find((m) => m.kind === "note")!;
    expect("the agent is given the answer word for word", note.body.includes('"Cancel the freight. Keep the order, the dealer still wants it."'), true);
    const end = await settle(said.state, r.id, said.wake, b);
    expect("the freight is cancelled and the order kept", w.standing(), "SO");
    expect("the person is shown what still stands before it closes", `${taskOf(end, r.id).closedAt} ${openQuestion(end, r.id).body.includes("placed order SO-1001")}`, "null true");
    expect("with what the agent said about it", openQuestion(end, r.id).body.includes("said: I left that as it is, as you asked"), true);
    expect("in words that fit an answer that was followed", openQuestion(end, r.id).body.startsWith("The agents have acted on your answer, and part of what this rejected task did is still in place."), true);
  }

  console.log("\n-- a playbook agent --");
  {
    const w = new World();
    // A playbook agent's step is written by a person. Here it places an order.
    const asked: AgentStepInput[] = [];
    const playbooks = new PlaybookRuntime();
    const b: AgentRuntime = {
      step: (input) => {
        asked.push(input);
        return playbooks.step(input);
      },
      perform: w.perform,
    };
    const withPlaybook = office("playbook");
    const scripted = {
      ...withPlaybook,
      office: {
        ...withPlaybook.office,
        participants: withPlaybook.office.participants.map((p) =>
          p.id === "p-vera"
            ? {
                ...p,
                playbook: [
                  {
                    id: "pb-order",
                    when: { stage: "execution" as const, requestContains: "", requestedBy: "anyone" as const },
                    then: {
                      statusNote: "Placed the order.",
                      output: null,
                      question: null,
                      assumption: null,
                      need: null,
                      action: { systemId: "sys-shop", operation: "place_order", fields: FIELDS.place_order[1] },
                      note: null,
                    },
                  },
                ],
              }
            : p,
        ),
      },
    };
    const r = await rejected(scripted, b);
    expect("its order is on record", deedsOf(r.before.office, r.id).standing.map((d) => d.message.did.record).join(), "SO-1001");
    const said = await answer(r.at, r.id, UNDO_ALL, b);
    expect("the office cancels it in the agent's name, with no model asked", `${w.calls.at(-1)} ${asked.some((i) => i.windingUp)}`, "cancel_order:SO-1001 false");
    expect("the agent reports back to the person", said.emitted.some((m) => m.kind === "note" && m.fromId === "p-vera" && m.body.startsWith("Done. Storefront cancelled order SO-1001")), true);
    expect("and the task closes in the same breath", taskOf(said.state, r.id).status, "rejected");
  }

  console.log("\n-- a system that holds every action for approval --");
  {
    const w = new World();
    const b = new Brain(["place_order"], w);
    // The order is placed with approval, and taking it back needs approval too.
    let at = (await reduce(office("ai", true), { type: "SUBMIT_REQUEST", title: "Calder order", detail: "Two condensers.", requestedById: "p-dana" }, b)).state;
    const tid = at.office.tasks.at(-1)!.id;
    for (let i = 0; i < 2; i++) at = (await reduce(at, { type: "ADVANCE", taskId: tid }, b)).state;
    at = (await reduce(at, { type: "ANSWER_QUESTION", questionId: openQuestion(at, tid).id, answeredById: "p-dana", body: APPROVE, chosenOption: APPROVE }, b)).state;
    at = (await reduce(at, { type: "ADVANCE", taskId: tid }, b)).state;
    const stale = at.office.messages.find((m) => m.taskId === tid && m.kind === "question")!;
    at = (await reduce(at, { type: "DECIDE", taskId: tid, byId: "p-dana", verdict: "rejected" }, b)).state;
    const said = await answer(at, tid, UNDO_ALL, b);
    const waiting = await settle(said.state, tid, said.wake, b);
    const hold = openQuestion(waiting, tid);
    expect("taking it back waits for approval like any action there", `${taskOf(waiting, tid).status} ${hold.kind === "question" && hold.heldAction?.operation}`, "blocked_question cancel_order");
    expect("nothing is cancelled before that", w.standing(), "SO");
    const approved = await reduce(waiting, { type: "ANSWER_QUESTION", questionId: hold.id, answeredById: "p-dana", body: APPROVE, chosenOption: APPROVE }, b);
    const end = await settle(approved.state, tid, approved.wake, b);
    expect("once approved it is cancelled and the task closes", `${w.standing()}|${taskOf(end, tid).status}`, "|rejected");
    expect("a question from before the rejection can no longer be answered", (await reduce(end, { type: "ANSWER_QUESTION", questionId: stale.id, answeredById: "p-dana", body: APPROVE, chosenOption: APPROVE }, b)).emitted.length, 0);
  }

  console.log(`\n${failures === 0 ? "all winding up checks passed" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
