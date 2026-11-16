/**
 * Checks what agents do between a person's clicks: taking a step again when
 * an answer arrives, attending to a note from a colleague, and handing a
 * finished step on. Also covers AI providers that belong to an account and
 * the sample office built on one. Models are scripted stand-ins, so nothing
 * leaves the machine. Run: npx tsx scripts/loop.ts
 */
import { atWorkOn } from "../lib/agentState";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStepInput, AgentStepResult } from "../lib/engine";

let failures = 0;
function expect(label: string, actual: unknown, wanted: unknown): void {
  const ok = actual === wanted;
  if (!ok) failures++;
  console.log(`${ok ? "pass" : "FAIL"}  ${label}${ok ? "" : `  (got ${String(actual)})`}`);
}

const inTwentyDays = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);

async function main(): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), "office-loop-"));
  const adminPassword = randomBytes(18).toString("base64url");
  process.env.OFFICE_DB_PATH = join(folder, "office.db");
  process.env.AUTH_SECRET = randomBytes(40).toString("base64url");
  process.env.ADMIN_EMAIL = "owner@example.test";
  process.env.ADMIN_PASSWORD = adminPassword;
  process.env.ADMIN_NAME = "Alex Kim";
  delete process.env.DEMO_LOGIN;
  delete process.env.OFFICE_AGENTS_PAUSED;
  delete process.env.DEMO_STOREFRONT_URL;
  delete process.env.DEMO_CARRIER_URL;

  const service = await import("../lib/server/officeService");
  const auth = await import("../lib/server/auth");
  const providers = await import("../lib/server/providers");
  const { all } = await import("../lib/server/db");
  const db = service.officeDatabase();
  const refusal = async (work: () => unknown): Promise<number | null> => {
    try {
      await work();
      return null;
    } catch (error) {
      if (error instanceof service.OfficeError) return error.status;
      throw error;
    }
  };
  const sessionFor = async (email: string, participantId: string | null) => {
    const user = auth.userByEmail(db, email)!;
    const { token } = await auth.issueSession(db, user, participantId);
    return async () => (await auth.readSession(db, token))!;
  };
  const admin = auth.authenticate(db, "owner@example.test", adminPassword)!;
  const owner = await sessionFor("owner@example.test", auth.seatsOf(db, admin.id)[0].participantId);
  const demoPeople = auth.usersInOffice(db, service.DEMO_OFFICE_ID);
  const dana = await sessionFor(demoPeople.find((u) => u.participantId === "p-dana")!.email, "p-dana");

  console.log("\n-- AI providers that belong to an account --");
  const local = { name: "House model", kind: "openai_compatible" as const, baseUrl: "http://127.0.0.1:1/v1", defaultModel: "small" };
  let view = await service.saveProviderSettings(await owner(), local, "account");
  const mine = view.ownProviders[0];
  expect("a provider saved to the account is listed as the person's own", `${view.ownProviders.length} ${mine.name}`, "1 House model");
  expect("it is not one of the office's providers", view.providers.filter((p) => p.sharedBy === null).length, 0);
  expect("but agents in the office can be given it", `${view.providers[0].sharedBy} ${view.providers[0].selectable}`, "you true");
  const firstOffice = view.office.id;
  expect("someone else in the office may not hand it out without the permission", providers.providerIds(db, firstOffice, "someone-else", false).has(mine.id), false);
  expect("and may with it", providers.providerIds(db, firstOffice, "someone-else", true).has(mine.id), true);
  expect("another person is shown whose it is, and neither its address nor its key", JSON.stringify(providers.providerViews(db, firstOffice, "someone-else", false).map((p) => [p.sharedBy, p.selectable, p.baseUrl, p.keyHint])), '[["Alex Kim",false,null,null]]');
  expect("demo access cannot keep providers of its own", await refusal(async () => service.saveProviderSettings(await dana(), local, "account")), 403);
  expect("nor does the demo office see anyone's", service.getView(await dana()).providers.length, 0);

  console.log("\n-- a sample office with AI agents --");
  expect("it needs one of the person's own providers", await refusal(async () => service.createSampleOffice(await owner(), "prov-nowhere")), 400);
  expect("demo access cannot add one", await refusal(async () => service.createSampleOffice(await dana(), mine.id)), 403);
  const made = await service.createSampleOffice(await owner(), mine.id);
  view = service.getView(await owner());
  const agents = view.office.participants.filter((p) => p.kind === "agent");
  expect("the person is switched to it", view.office.id, made.officeId);
  expect("it has the distributor's five rooms along a hall", view.office.floorplan.rooms.map((r) => r.name).join(), "Reception,Planning,Finance,Fulfilment,Operations,Hall");
  expect("five AI agents, all on the chosen provider", `${agents.length} ${agents.every((a) => a.agentType === "ai" && a.providerId === mine.id)}`, "5 true");
  expect("and the person as its only human, holding every permission", `${view.office.participants.filter((p) => p.kind === "human").length} ${view.viewer.displayName} ${view.viewer.permissions.length}`, "1 Alex Kim 11");
  expect("its rooms carry the distributor's records", view.office.floorplan.rooms.find((r) => r.name === "Finance")!.records.length > 0, true);
  expect("it starts with no work and no individual rules", view.office.tasks.length + view.office.rules.length, 0);
  expect("its ids are its own, so the demo is untouched", service.getView(await dana()).office.floorplan.rooms[0].id, "reception");
  expect("agents hand work on by themselves there", view.office.autoHandoff, true);
  expect("no dangling references", all(db, "PRAGMA foreign_key_check").length, 0);

  console.log("\n-- agents carry work forward between clicks --");
  const suffix = made.officeId.replace("office-", "");
  const ledger = `p-ledger-${suffix}`;
  const steps: string[] = [];
  let failAt: string | null = null;
  /** How many times a colleague looking at a note fails before it answers. */
  let failNotes = 0;
  let slowFor: (input: AgentStepInput) => number = () => 0;
  const shopCalls: string[] = [];
  let orders = 2000;
  let refuseCancel = false;
  const atOnce = new Map<string, number>();
  let most = 0;
  let doubled = false;
  const scripted = {
    step: async (input: AgentStepInput): Promise<AgentStepResult> => {
      const who = input.participant.displayName;
      const answered = input.priorMessages.some((m) => m.kind === "answer");
      steps.push(`${who}:${input.attending ? "note" : input.stage}`);
      // How many agents are answering at once, and whether one agent ever is twice.
      const slow = slowFor(input);
      if (slow > 0) {
        atOnce.set(who, (atOnce.get(who) ?? 0) + 1);
        doubled ||= (atOnce.get(who) ?? 0) > 1;
        most = Math.max(most, [...atOnce.values()].reduce((a, b) => a + b, 0));
        await new Promise((resolve) => setTimeout(resolve, slow));
        atOnce.set(who, (atOnce.get(who) ?? 0) - 1);
      }
      if (failAt === input.stage) throw new Error(`${who} could not answer: the provider could not be reached.`);
      if (input.attending && failNotes > 0) {
        failNotes--;
        throw new Error(`${who} could not answer: the provider could not be reached.`);
      }
      // On a rejected task: take back the one thing the note names.
      if (input.attending && input.windingUp) {
        const record = /the record is ([A-Z]+-\d+)/.exec(input.attending.body)?.[1] ?? "";
        return input.afterAction
          ? { statusNote: "", questions: [], assumptions: [], notes: [{ toParticipantId: input.attending.fromId, body: `The shop has answered about ${record}.` }] }
          : { statusNote: "", questions: [], assumptions: [], actions: [{ systemId: "sys-loop-shop", operation: "cancel_order", fields: { order: record } }] };
      }
      if (input.stage === "execution" && input.task.title.includes("doomed") && !input.afterAction && !input.attending) {
        return {
          statusNote: "Placing the order.",
          questions: [],
          assumptions: [],
          actions: [{ systemId: "sys-loop-shop", operation: "place_order", fields: { account: "CAL-3310", branch: "Laval", items: "GREE-CU-24 x 2" } }],
        };
      }
      if (input.attending) {
        return { statusNote: "Checked the credit as asked.", questions: [], assumptions: [], notes: [{ toParticipantId: input.attending.fromId, body: "Credit is fine." }] };
      }
      if (input.stage === "intake" && !answered && input.task.title.includes("ask")) {
        return { statusNote: "Need the branch.", questions: [{ body: "Which branch?", toParticipantId: input.task.requestedById, blocking: true, options: ["Laval", "Dartmouth"] }], assumptions: [] };
      }
      if (input.stage === "planning") {
        return { statusNote: "Planned it.", questions: [], assumptions: [], notes: [{ toParticipantId: ledger, body: "Check this dealer's credit." }] };
      }
      if (input.stage === "execution" && input.task.title.includes("wait")) {
        const over = input.priorMessages.some((m) => m.body.includes("is over") || m.body.includes("ended the wait"));
        return over
          ? { statusNote: "The stock is in. Ordered the rest.", questions: [], assumptions: [] }
          : { statusNote: "Shipped what is here.", questions: [], assumptions: [], wait: { until: inTwentyDays, reason: "The factory order arrives, and the rest can be ordered." } };
      }
      return { statusNote: `${who} did ${input.stage}${answered ? " with the answer" : ""}.`, questions: [], assumptions: [] };
    },
    // A stand-in shop: it numbers what is ordered and can be told to refuse a cancellation.
    perform: async (call: { operation: string; fields: Record<string, string> }) => {
      shopCalls.push(`${call.operation}:${call.fields.order ?? call.fields.items}`);
      if (call.operation === "place_order") return { ok: true, summary: `placed order SO-${++orders}.`, record: `SO-${orders}` };
      return refuseCancel
        ? { ok: false, summary: "refused to cancel an order: it has already shipped." }
        : { ok: true, summary: `cancelled order ${call.fields.order}.`, record: call.fields.order };
    },
  };
  service.useAgentRuntime(scripted);
  const taskOf = (v: typeof view, title: string) => v.office.tasks.find((t) => t.title === title)!;

  view = await service.applyAction(await owner(), { type: "SUBMIT_REQUEST", title: "Order, ask first", detail: "Two units.", requestedById: "" });
  await service.agentsIdle();
  view = service.getView(await owner());
  expect("a question still halts the task", `${taskOf(view, "Order, ask first").stage} ${taskOf(view, "Order, ask first").status}`, "intake blocked_question");
  expect("and nobody works in the background meanwhile", view.agentsAtWork, false);

  const question = view.office.messages.find((m) => m.kind === "question")!;
  view = await service.applyAction(await owner(), { type: "ANSWER_QUESTION", questionId: question.id, answeredById: "", body: "Laval", chosenOption: "Laval" });
  expect("the click returns before the agents have finished", taskOf(view, "Order, ask first").stage, "intake");
  expect("and says that agents are at work", view.agentsAtWork, true);
  await service.agentsIdle();
  view = service.getView(await owner());
  const done = taskOf(view, "Order, ask first");
  expect("the agent that asked takes its step again with the answer", view.office.messages.some((m) => m.body === "Iris did intake with the answer."), true);
  expect("the task is then handed from stage to stage without a click", done.stage, "review");
  expect("and stops at the review, which waits for a person", done.status, "in_review");
  expect("the agent a note was left for attended to it, though the task was not its own", steps.includes("Ledger:note"), true);
  expect("and answered with a note of its own", view.office.messages.some((m) => m.kind === "note" && m.body === "Credit is fine."), true);
  expect("the agent that left the note takes its step again with the reply, before the task moves on", steps.join(" "), "Iris:intake Iris:intake Atlas:planning Ledger:note Atlas:planning Vera:execution Ledger:review");
  expect("and does not leave the same note twice", view.office.messages.filter((m) => m.kind === "note" && m.body === "Check this dealer's credit.").length, 1);
  expect("the activity log shows the agents' own steps", view.feed.some((f) => f.text.includes("moved to Review")), true);
  expect("a person cannot raise an agent's wake-up themselves", await refusal(async () => service.applyAction(await owner(), { type: "AGENT_RESUME", taskId: done.id })), 403);

  console.log("\n-- a task that waits for a day --");
  steps.length = 0;
  view = await service.applyAction(await owner(), { type: "SUBMIT_REQUEST", title: "Order, wait for stock", detail: "Eight units, four now.", requestedById: "" });
  await service.agentsIdle();
  view = service.getView(await owner());
  let waiting = taskOf(view, "Order, wait for stock");
  expect("the task stays where the work is, and is not handed on", `${waiting.stage} ${waiting.status}`, "execution in_progress");
  expect("it knows the day and what it waits for", `${new Date(waiting.wait?.until ?? 0).toISOString().slice(0, 10)} ${waiting.wait?.reason}`, `${inTwentyDays} The factory order arrives, and the rest can be ordered.`);
  expect("the thread says so", view.office.messages.some((m) => m.taskId === waiting.id && m.body.startsWith("Waiting until ")), true);
  expect("nothing is woken before the day", service.wakeDueTasks(Date.now() + 19 * 86_400_000), 0);
  expect("on the day, the task is woken", service.wakeDueTasks(Date.now() + 21 * 86_400_000), 1);
  await service.agentsIdle();
  view = service.getView(await owner());
  waiting = taskOf(view, "Order, wait for stock");
  expect("its agent takes the step again and does what was waiting", view.office.messages.some((m) => m.taskId === waiting.id && m.body === "The stock is in. Ordered the rest."), true);
  expect("the wait is over", waiting.wait, undefined);
  expect("and the task then goes on to review by itself", `${waiting.stage} ${waiting.status}`, "review in_review");
  expect("it is not woken a second time", service.wakeDueTasks(Date.now() + 22 * 86_400_000), 0);

  view = await service.applyAction(await owner(), { type: "SUBMIT_REQUEST", title: "Second order, wait for stock", detail: "Four units.", requestedById: "" });
  await service.agentsIdle();
  view = await service.applyAction(await owner(), { type: "WAKE_TASK", taskId: taskOf(service.getView(await owner()), "Second order, wait for stock").id });
  await service.agentsIdle();
  view = service.getView(await owner());
  expect("a person can end a wait early, and the work carries on", `${taskOf(view, "Second order, wait for stock").stage} ${view.office.messages.some((m) => m.body.includes("ended the wait early"))}`, "review true");

  console.log("\n-- work that nothing is carrying is picked up --");
  service.pauseAgents(true);
  view = await service.applyAction(await owner(), { type: "SUBMIT_REQUEST", title: "Order, turn lost", detail: "One unit.", requestedById: "" });
  await service.agentsIdle();
  expect("with the run lost, the task sits where its first step left it", taskOf(service.getView(await owner()), "Order, turn lost").stage, "intake");
  expect("and nothing is picked up while agents are paused", service.carryOnIdleWork(), 0);
  service.pauseAgents(false);
  expect("the office finds it", service.carryOnIdleWork(), 1);
  await service.agentsIdle();
  expect("and carries it through to review", taskOf(service.getView(await owner()), "Order, turn lost").stage, "review");
  expect("leaving nothing else to pick up", service.carryOnIdleWork(), 0);

  console.log("\n-- two colleagues answer the same agent --");
  steps.length = 0;
  service.useAgentRuntime({
    step: async (input: AgentStepInput): Promise<AgentStepResult> => {
      steps.push(`${input.participant.displayName}:${input.attending ? "note" : input.stage}`);
      // A real model answers over the network, one colleague sooner than the
      // other. The owner must wait for both without the server spinning.
      if (input.attending) await new Promise((resolve) => setTimeout(resolve, input.participant.displayName === "Vera" ? 120 : 40));
      if (input.attending) return { questions: [], assumptions: [], notes: [{ toParticipantId: input.attending.fromId, body: `${input.participant.displayName} answers.` }] };
      if (input.stage === "intake") {
        return { statusNote: "Asked two colleagues.", questions: [], assumptions: [], notes: [{ toParticipantId: ledger, body: "Credit?" }, { toParticipantId: `p-vera-${suffix}`, body: "Stock?" }] };
      }
      return { statusNote: `${input.participant.displayName} did ${input.stage}.`, questions: [], assumptions: [] };
    },
  });
  view = await service.applyAction(await owner(), { type: "SUBMIT_REQUEST", title: "Order, two answers", detail: "Two units.", requestedById: "" });
  // A timer that keeps its beat shows the server is still answering while agents wait on each other.
  let beats = 0;
  const beat = setInterval(() => beats++, 10);
  const quiet = await Promise.race([service.agentsIdle().then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000))]);
  clearInterval(beat);
  expect("the agents finish", quiet, true);
  expect("and the server kept answering while one of them waited for its colleagues", beats > 5, true);
  expect("it takes its step again once, with both answers, and the task moves on", steps.join(" "), "Iris:intake Ledger:note Vera:note Iris:intake Atlas:planning Vera:execution Ledger:review");
  service.useAgentRuntime(scripted);

  console.log("\n-- a step that fails in the background --");
  steps.length = 0;
  failAt = "planning";
  view = await service.applyAction(await owner(), { type: "SUBMIT_REQUEST", title: "Order, plain", detail: "Two units.", requestedById: "" });
  await service.agentsIdle();
  view = service.getView(await owner());
  expect("leaves the task with the agent that could not take it", `${taskOf(view, "Order, plain").stage} ${taskOf(view, "Order, plain").status}`, "planning in_progress");
  expect("who still owes its step, so the task is not handed on without it", taskOf(view, "Order, plain").owed, true);
  expect("says so in the activity log", view.feed.some((f) => f.text.includes("could not carry") && f.text.includes("the provider could not be reached")), true);
  expect("and is not tried over and over", steps.join(" "), "Iris:intake Atlas:planning");
  failAt = null;
  expect("once the provider is back, the office asks the agent again", service.carryOnIdleWork(), 1);
  await service.agentsIdle();
  expect("and the task goes on from there with the step taken", `${taskOf(service.getView(await owner()), "Order, plain").stage} ${steps.join(" ")}`, "review Iris:intake Atlas:planning Atlas:planning Ledger:note Atlas:planning Vera:execution Ledger:review");

  console.log("\n-- a colleague's part that fails --");
  const written = (title: string) =>
    (all(db, "SELECT kind, tries FROM pending_work WHERE task_id = ?", taskOf(view, title).id) as { kind: string; tries: number }[])
      .map((r) => `${r.kind} ${r.tries}`)
      .join(", ");
  steps.length = 0;
  failNotes = 1;
  view = await service.applyAction(await owner(), { type: "SUBMIT_REQUEST", title: "Order, colleague fails", detail: "Two units.", requestedById: "" });
  await service.agentsIdle();
  view = service.getView(await owner());
  expect("the task is not handed on without the colleague's part", taskOf(view, "Order, colleague fails").stage, "planning");
  expect("what the colleague still owes is written down, with one try used", written("Order, colleague fails"), "attend 1");
  expect("and the log says it will be asked again", view.feed.some((f) => f.text.includes("could not carry") && f.text.includes("The office will ask again in a minute.")), true);
  // The server stops and starts: nothing is left in memory.
  service.forgetQueues();
  expect("after a restart the office finds the work again", service.carryOnIdleWork() >= 1, true);
  await service.agentsIdle();
  view = service.getView(await owner());
  expect("the colleague does its part, and the task goes on with it", `${taskOf(view, "Order, colleague fails").stage} ${steps.filter((x) => x === "Ledger:note").length}`, "review 2");
  expect("nothing is left written down", written("Order, colleague fails"), "");

  steps.length = 0;
  failNotes = 99;
  view = await service.applyAction(await owner(), { type: "SUBMIT_REQUEST", title: "Order, colleague keeps failing", detail: "Two units.", requestedById: "" });
  await service.agentsIdle();
  for (let i = 0; i < 4; i++) {
    service.carryOnIdleWork();
    await service.agentsIdle();
  }
  view = service.getView(await owner());
  expect("after three tries the colleague is not asked again", `${steps.filter((x) => x === "Ledger:note").length} ${written("Order, colleague keeps failing")}`, "3 attend 3");
  expect("the task stays where it is", taskOf(view, "Order, colleague keeps failing").stage, "planning");
  expect("and the log says a person has to act", view.feed.some((f) => f.text.includes("That was try 3 of 3, so the task stays where it is until a person acts on it.")), true);
  failNotes = 0;
  view = await service.applyAction(await owner(), { type: "SET_URGENT", taskId: taskOf(view, "Order, colleague keeps failing").id, urgent: true, byId: "" });
  await service.agentsIdle();
  view = service.getView(await owner());
  expect("once a person acts on the task it is tried again and goes on", taskOf(view, "Order, colleague keeps failing").stage, "review");

  console.log("\n-- each agent works through a queue of its own --");
  steps.length = 0;
  slowFor = (input) => (input.task.title.includes("slow") ? 400 : input.task.title.includes("quick") ? 30 : 0);
  const began = Date.now();
  for (const title of ["Order, slow one", "Order, slow two", "Order, quick"]) {
    view = await service.applyAction(await owner(), { type: "SUBMIT_REQUEST", title, detail: "One unit.", requestedById: "" });
  }
  expect("a click does not wait for a model", Date.now() - began < 300, true);
  expect("the task is with its agent, who owes the first step", `${taskOf(view, "Order, quick").stage} ${taskOf(view, "Order, quick").owed}`, "intake true");
  const iris = view.office.participants.find((p) => p.displayName === "Iris")!.id;
  expect("the agent is on one task with the other two waiting", JSON.stringify(view.agentLoad[iris] ?? null), JSON.stringify({ taskId: taskOf(view, "Order, slow one").id, forNote: false, waiting: 2, queued: [taskOf(view, "Order, slow two").id, taskOf(view, "Order, quick").id] }));
  const nameOf = (id: string): string => view.office.participants.find((p) => p.id === id)?.displayName ?? id;
  expect("the task in hand says who is on it", atWorkOn(taskOf(view, "Order, slow one").id, view.agentLoad, nameOf).join(" "), "Iris is working on this now.");
  expect("one behind it says how long the line is", atWorkOn(taskOf(view, "Order, quick").id, view.agentLoad, nameOf).join(" "), "Iris takes this up after 2 other tasks.");
  // While agents are in the middle of slow steps, a person's click still goes through at once.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const clicked = Date.now();
  view = await service.applyAdminOperation(await owner(), { type: "RENAME_OFFICE", name: view.office.name });
  expect("a person's change goes through while agents are mid-step", Date.now() - clicked < 200, true);
  await service.agentsIdle();
  view = service.getView(await owner());
  expect("all three reach review", ["Order, slow one", "Order, slow two", "Order, quick"].map((t) => taskOf(view, t).stage).join(" "), "review review review");
  expect("several agents were answering at the same time", most > 1, true);
  expect("and no agent was ever answering two things at once", doubled, false);
  expect("an agent takes its work in the order it arrived", steps.filter((s2) => s2 === "Iris:intake").length, 3);
  expect("nothing is left on anyone's queue", Object.keys(view.agentLoad).length, 0);
  slowFor = () => 0;

  console.log("\n-- urgent work goes first --");
  steps.length = 0;
  const taken: string[] = [];
  slowFor = (input) => {
    if (input.stage === "intake" && input.task.title.startsWith("Queue")) taken.push(input.task.title);
    return input.task.title.startsWith("Queue") ? 60 : 0;
  };
  for (const title of ["Queue one", "Queue two", "Queue three"]) {
    view = await service.applyAction(await owner(), { type: "SUBMIT_REQUEST", title, detail: "One unit.", requestedById: "" });
  }
  view = await service.applyAction(await owner(), { type: "SUBMIT_REQUEST", title: "Queue rush", detail: "One unit, today.", requestedById: "", urgent: true });
  expect("the urgent task is stored as urgent", taskOf(view, "Queue rush").urgent, true);
  const titleOf = (id: string): string => view.office.tasks.find((t) => t.id === id)?.title ?? id;
  expect("what waits for the agent is listed in the order it will be taken", (view.agentLoad[iris]?.queued ?? []).map(titleOf).join(", "), "Queue rush, Queue two, Queue three");
  await service.agentsIdle();
  expect("the agent finishes what it is on, then takes the urgent task ahead of the rest", taken.join(", "), "Queue one, Queue rush, Queue two, Queue three");
  view = service.getView(await owner());
  expect("and all four reach review", ["Queue one", "Queue two", "Queue three", "Queue rush"].every((t) => taskOf(view, t).stage === "review"), true);
  slowFor = () => 0;

  console.log("\n-- standing work the office files by itself --");
  const { nextAfter } = await import("../lib/standing");
  const monday = Date.parse("2026-11-16T14:00:00Z");
  const friday = Date.parse("2026-11-20T14:00:00Z");
  const iso = (at: number) => new Date(at).toISOString().slice(0, 16);
  expect("a daily request is next due a day later, at the same time", iso(nextAfter(monday, "day", monday)), "2026-11-17T14:00");
  expect("a weekday one passes over the weekend", iso(nextAfter(friday, "weekday", friday)), "2026-11-23T14:00");
  expect("a weekly one keeps its day", iso(nextAfter(monday, "week", monday + 9 * 86_400_000)), "2026-11-30T14:00");
  expect("one long overdue is due at its next turn, with nothing made up for", iso(nextAfter(monday, "day", monday + 30.5 * 86_400_000)), "2026-12-17T14:00");

  steps.length = 0;
  const soon = Date.now() + 3_600_000;
  view = await service.saveStandingRequest(await owner(), { title: "Morning stock check", detail: "Look at stock and reorder what is short.", urgent: false, every: "day", firstAt: soon });
  const standing = async () => service.getView(await owner()).standing[0];
  expect("it is listed with when it is next due", `${view.standing.length} ${view.standing[0].nextAt === soon} ${view.standing[0].filedAs}`, "1 true Alex Kim");
  expect("someone who does not manage the office cannot set one up", await refusal(async () => service.saveStandingRequest(await dana(), { title: "No", detail: "No.", urgent: false, every: "day", firstAt: soon })), 403);
  expect("nothing is filed before its time", await service.fileDueStanding(soon - 1000), 0);
  expect("when its time comes the office files it", await service.fileDueStanding(soon + 1000), 1);
  await service.agentsIdle();
  view = service.getView(await owner());
  const filedTask = view.office.tasks.find((t) => t.title === "Morning stock check")!;
  expect("as an ordinary task, in the name of whoever set it up", `${filedTask.requestedById === view.viewer.participantId} ${filedTask.stage}`, "true review");
  expect("which the agents carried through", steps.includes("Iris:intake") && steps.includes("Ledger:review"), true);
  expect("the log says the office filed it", view.feed.some((f) => f.text.includes(`The office filed the standing request "Morning stock check" as ${filedTask.id}, for Alex Kim`)), true);
  expect("its next turn is a day on", (await standing()).nextAt, soon + 86_400_000);
  expect("it is not filed again while the last one is still open", await service.fileDueStanding(soon + 86_400_000 + 1000), 0);
  expect("and the log says why", service.getView(await owner()).feed.some((f) => f.text.includes(`was not filed: the last one, ${filedTask.id}, is still open.`)), true);
  expect("its turn moved on all the same, so it is not tried every minute", (await standing()).nextAt, soon + 2 * 86_400_000);
  await service.applyAction(await owner(), { type: "DECIDE", taskId: filedTask.id, byId: "", verdict: "approved" });
  expect("once that one is closed it is filed again", await service.fileDueStanding(soon + 2 * 86_400_000 + 1000), 1);
  await service.agentsIdle();
  view = await service.changeStandingRequest(await owner(), (await standing()).id, "pause");
  expect("a paused one is not filed", await service.fileDueStanding(soon + 30 * 86_400_000), 0);
  view = await service.fileStandingNow(await owner(), view.standing[0].id).catch(() => view);
  expect("filing by hand is refused while the last one is open, and says so", await refusal(async () => service.fileStandingNow(await owner(), view.standing[0].id)), 409);
  view = await service.changeStandingRequest(await owner(), view.standing[0].id, "remove");
  expect("and it can be removed", view.standing.length, 0);

  console.log("\n-- a rejected task is wound up between clicks --");
  // A shop in the room where the order is carried out, as the office would hold it once connected.
  const workRoom = view.office.stageRooms.execution;
  const { run: sql } = await import("../lib/server/db");
  sql(db, "INSERT INTO connected_systems (id, room_id, position, name, description, records_path, base_url, updated_at) VALUES ('sys-loop-shop', ?, 900, 'Shop', 'Orders.', '/v1/summary', 'http://127.0.0.1:9', 0)", workRoom);
  sql(db, "INSERT INTO system_operations (system_id, operation, position, label, method, path) VALUES ('sys-loop-shop', 'place_order', 0, 'Place an order', 'POST', '/v1/orders')");
  for (const [at, name] of ["account", "branch", "items"].entries()) {
    sql(db, "INSERT INTO system_operation_fields (system_id, operation, name, position, label, hint, place) VALUES ('sys-loop-shop', 'place_order', ?, ?, ?, '', 'body')", name, at, name);
  }
  sql(db, "INSERT INTO system_operations (system_id, operation, position, label, method, path, undoes) VALUES ('sys-loop-shop', 'cancel_order', 1, 'Cancel an order', 'POST', '/v1/orders/{order}/cancel', 'place_order')");
  sql(db, "INSERT INTO system_operation_fields (system_id, operation, name, position, label, hint, place) VALUES ('sys-loop-shop', 'cancel_order', 'order', 0, 'Order number', '', 'path')");
  const reject = async (title: string) => {
    view = await service.applyAction(await owner(), { type: "SUBMIT_REQUEST", title, detail: "Two condensers.", requestedById: "" });
    await service.agentsIdle();
    view = await service.applyAction(await owner(), { type: "DECIDE", taskId: taskOf(service.getView(await owner()), title).id, byId: "", verdict: "rejected" });
    return view.office.messages.find((m) => m.kind === "question" && taskOf(view, title).openQuestionIds.includes(m.id))!;
  };
  const say = async (title: string, said: string) => {
    const question = view.office.messages.find((m) => m.kind === "question" && taskOf(view, title).openQuestionIds.includes(m.id))!;
    view = await service.applyAction(await owner(), { type: "ANSWER_QUESTION", questionId: question.id, answeredById: "", body: said, chosenOption: said });
  };
  steps.length = 0;
  const asked = await reject("Order, doomed");
  expect("the order was placed, and the question names it", `${shopCalls.join()} ${asked.body.includes("placed order SO-2001")}`, "place_order:GREE-CU-24 x 2 true");
  expect("the rejected task waits for the answer", `${taskOf(view, "Order, doomed").status} ${taskOf(view, "Order, doomed").windUp}`, "blocked_question true");
  await service.agentsIdle();
  expect("and nothing is carried forward meanwhile", `${service.carryOnIdleWork()} ${taskOf(service.getView(await owner()), "Order, doomed").closedAt}`, "0 null");
  steps.length = 0;
  await say("Order, doomed", "Undo all of them");
  expect("the click returns before the agents have finished", taskOf(view, "Order, doomed").closedAt, null);
  await service.agentsIdle();
  view = service.getView(await owner());
  expect("the agent that placed the order is the one that cancels it", `${steps.filter((x) => x === "Vera:note").length > 0} ${shopCalls.at(-1)}`, "true cancel_order:SO-2001");
  expect("the task closes by itself once that is done", `${taskOf(view, "Order, doomed").status} ${taskOf(view, "Order, doomed").closedAt !== null}`, "rejected true");
  expect("and nothing is left written down for it", written("Order, doomed"), "");
  expect("the log says how it ended", view.feed.some((f) => f.text.includes("closed as rejected, with everything it did taken back")), true);

  refuseCancel = true;
  await reject("Order, doomed twice");
  await say("Order, doomed twice", "Undo all of them");
  await service.agentsIdle();
  view = service.getView(await owner());
  const stuckTask = taskOf(view, "Order, doomed twice");
  expect("an order the shop will not cancel keeps the task open", `${stuckTask.status} ${stuckTask.closedAt}`, "blocked_question null");
  expect("and the person is told why, and asked what next", view.office.messages.find((m) => m.kind === "question" && stuckTask.openQuestionIds.includes(m.id))!.body.includes("it has already shipped"), true);
  refuseCancel = false;
  await say("Order, doomed twice", "Try again");
  await service.agentsIdle();
  view = service.getView(await owner());
  expect("trying again once the shop allows it closes the task", `${taskOf(view, "Order, doomed twice").status} ${shopCalls.at(-1)}`, "rejected cancel_order:SO-2002");

  await reject("Order, doomed thrice");
  failNotes = 99;
  await say("Order, doomed thrice", "Undo all of them");
  await service.agentsIdle();
  for (let i = 0; i < 4; i++) {
    service.carryOnIdleWork();
    await service.agentsIdle();
  }
  view = service.getView(await owner());
  const unreached = taskOf(view, "Order, doomed thrice");
  expect("an agent that cannot be reached is tried three times, then the person is asked", `${unreached.status} ${view.office.messages.find((m) => m.kind === "question" && unreached.openQuestionIds.includes(m.id))?.body.includes("placed order SO-2003")}`, "blocked_question true");
  expect("what was given up on is not kept for later", written("Order, doomed thrice"), "");
  failNotes = 1;
  await say("Order, doomed thrice", "Try again");
  await service.agentsIdle();
  // The server stops and starts while the agent still owes its part.
  service.forgetQueues();
  expect("after a restart the office finds the agent's part again", service.carryOnIdleWork() >= 1, true);
  await service.agentsIdle();
  view = service.getView(await owner());
  expect("and takes the winding up to its end", `${taskOf(view, "Order, doomed thrice").status} ${shopCalls.at(-1)}`, "rejected cancel_order:SO-2003");
  failNotes = 0;
  sql(db, "DELETE FROM connected_systems WHERE id = 'sys-loop-shop'");

  console.log("\n-- with the setting off, a person moves each task on --");
  await service.applyAdminOperation(await owner(), { type: "SET_AUTO_HANDOFF", on: false });
  steps.length = 0;
  view = await service.applyAction(await owner(), { type: "SUBMIT_REQUEST", title: "Order, by hand", detail: "Two units.", requestedById: "" });
  await service.agentsIdle();
  view = service.getView(await owner());
  expect("the task waits at its first stage", `${taskOf(view, "Order, by hand").stage} ${steps.join(" ")}`, "intake Iris:intake");
  view = await service.applyAction(await owner(), { type: "ADVANCE", taskId: taskOf(view, "Order, by hand").id });
  await service.agentsIdle();
  view = service.getView(await owner());
  expect("and moves one stage per click", taskOf(view, "Order, by hand").stage, "planning");
  expect("a note is still attended to and answered", steps.join(" "), "Iris:intake Atlas:planning Ledger:note Atlas:planning");

  service.useAgentRuntime(undefined);
  db.close();
  rmSync(folder, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? "all loop checks passed" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
