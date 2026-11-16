/**
 * Checks what agents do between a person's clicks: taking a step again when
 * an answer arrives, attending to a note from a colleague, and handing a
 * finished step on. Also covers AI providers that belong to an account and
 * the sample office built on one. Models are scripted stand-ins, so nothing
 * leaves the machine. Run: npx tsx scripts/loop.ts
 */
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
  const scripted = {
    step: async (input: AgentStepInput): Promise<AgentStepResult> => {
      const who = input.participant.displayName;
      const answered = input.priorMessages.some((m) => m.kind === "answer");
      steps.push(`${who}:${input.attending ? "note" : input.stage}`);
      if (failAt === input.stage) throw new Error(`${who} could not answer: the provider could not be reached.`);
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
      if (input.attending) return { questions: [], assumptions: [], notes: [{ toParticipantId: input.attending.fromId, body: `${input.participant.displayName} answers.` }] };
      if (input.stage === "intake") {
        return { statusNote: "Asked two colleagues.", questions: [], assumptions: [], notes: [{ toParticipantId: ledger, body: "Credit?" }, { toParticipantId: `p-vera-${suffix}`, body: "Stock?" }] };
      }
      return { statusNote: `${input.participant.displayName} did ${input.stage}.`, questions: [], assumptions: [] };
    },
  });
  view = await service.applyAction(await owner(), { type: "SUBMIT_REQUEST", title: "Order, two answers", detail: "Two units.", requestedById: "" });
  await service.agentsIdle();
  expect("it takes its step again once, with both answers, and the task moves on", steps.join(" "), "Iris:intake Ledger:note Vera:note Iris:intake Atlas:planning Vera:execution Ledger:review");
  service.useAgentRuntime(scripted);

  console.log("\n-- a step that fails in the background --");
  steps.length = 0;
  failAt = "planning";
  view = await service.applyAction(await owner(), { type: "SUBMIT_REQUEST", title: "Order, plain", detail: "Two units.", requestedById: "" });
  await service.agentsIdle();
  view = service.getView(await owner());
  expect("leaves the task where it was", `${taskOf(view, "Order, plain").stage} ${taskOf(view, "Order, plain").status}`, "intake in_progress");
  expect("says so in the activity log", view.feed.some((f) => f.text.includes("could not carry") && f.text.includes("the provider could not be reached")), true);
  expect("and is not tried over and over", steps.join(" "), "Iris:intake Atlas:planning");
  failAt = null;
  view = await service.applyAction(await owner(), { type: "ADVANCE", taskId: taskOf(view, "Order, plain").id });
  await service.agentsIdle();
  expect("a person can still move it on, and the agents carry on from there", taskOf(service.getView(await owner()), "Order, plain").stage, "review");

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
