/**
 * Checks the stand-in services and how an office uses them: connecting a
 * system to a room, reading its live records, and an agent placing an order
 * only once it holds `act` on that room. The services are started on this
 * machine, so nothing leaves it. Run: npx tsx scripts/systems.ts
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carrier } from "../services/carrier/server.ts";
import { ledger } from "../services/ledger/server.ts";
import { serviceDesk } from "../services/service-desk/server.ts";
import { storefront } from "../services/storefront/server.ts";
import { supplier } from "../services/supplier/server.ts";

let failures = 0;
function expect(label: string, actual: unknown, wanted: unknown): void {
  const ok = actual === wanted;
  if (!ok) failures++;
  console.log(`${ok ? "pass" : "FAIL"}  ${label}${ok ? "" : `  (got ${String(actual)})`}`);
}

const listen = (server: Server): Promise<string> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });

async function main(): Promise<void> {
  const key = `check-${randomBytes(12).toString("hex")}`;
  const shop = storefront(key);
  const freight = carrier(key);
  const shopUrl = await listen(shop);
  const freightUrl = await listen(freight);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Reply = { status: number; data: Record<string, any> };
  const api = async (url: string, method = "GET", body?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
    const response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  const stock = async (sku: string, branch: string): Promise<number> =>
    (await api(`${shopUrl}/v1/products`)).data.products.find((p: { sku: string }) => p.sku === sku).stock[branch];

  console.log("\n-- the storefront service --");
  expect("health needs no key", (await fetch(`${shopUrl}/health`)).status, 200);
  expect("everything else does", (await fetch(`${shopUrl}/v1/products`)).status, 401);
  expect("a wrong key is refused", (await fetch(`${shopUrl}/v1/products`, { headers: { authorization: "Bearer nope" } })).status, 401);
  expect("Laval starts with 120 heads", await stock("GREE-MZ-12", "Laval"), 120);
  const order = { account: "NOR-0188", branch: "laval", items: [{ sku: "gree-mz-12", quantity: 2 }] };
  const placed = await api(`${shopUrl}/v1/orders`, "POST", order, { "idempotency-key": "once" });
  expect("an order is created", placed.status, 201);
  expect("priced at list", placed.data.order.total, 2480);
  expect("and draws the stock down", await stock("GREE-MZ-12", "Laval"), 118);
  const again = await api(`${shopUrl}/v1/orders`, "POST", order, { "idempotency-key": "once" });
  expect("the same key returns the same order", again.data.order.id, placed.data.order.id);
  expect("without touching stock again", await stock("GREE-MZ-12", "Laval"), 118);
  const tooMany = await api(`${shopUrl}/v1/orders`, "POST", { ...order, items: [{ sku: "ECOBEE-T", quantity: 1 }, { sku: "PTAC-12", quantity: 9 }] });
  expect("an order the branch cannot fill is refused", tooMany.status, 409);
  expect("and moves none of its lines", await stock("ECOBEE-T", "Laval"), 60);
  expect("an unknown product is refused", (await api(`${shopUrl}/v1/orders`, "POST", { ...order, items: [{ sku: "NOPE", quantity: 1 }] })).status, 422);
  expect("an unknown branch is refused", (await api(`${shopUrl}/v1/orders`, "POST", { ...order, branch: "Moon" })).status, 422);
  await api(`${shopUrl}/v1/orders/${placed.data.order.id}/cancel`, "POST");
  expect("cancelling returns the stock", await stock("GREE-MZ-12", "Laval"), 120);

  console.log("\n-- the carrier service --");
  expect("it needs the key too", (await fetch(`${freightUrl}/v1/services`)).status, 401);
  const rates = await api(`${freightUrl}/v1/rates?weightKg=100`);
  expect("a quote per service level", rates.data.rates.length, 3);
  expect("ground for 100 kg", rates.data.rates.find((r: { service: string }) => r.service === "ground").cost, 135);
  const booking = { reference: "SO-1", from: "Laval", to: "Richmond Hill", weightKg: 66, service: "ground" };
  const booked = await api(`${freightUrl}/v1/shipments`, "POST", booking);
  expect("a shipment is booked", booked.status, 201);
  expect("at the quoted rate", booked.data.shipment.cost, 104.4);
  expect("an unknown service is refused", (await api(`${freightUrl}/v1/shipments`, "POST", { ...booking, service: "teleport" })).status, 422);
  await api(`${freightUrl}/v1/shipments/${booked.data.shipment.id}/cancel`, "POST");
  expect("and can be cancelled", (await api(`${freightUrl}/v1/shipments`)).data.shipments[0].status, "cancelled");

  console.log("\n-- every service describes itself --");
  const shopManifest = await api(`${shopUrl}/v1/manifest`);
  expect("a service says what it is for", shopManifest.data.description.includes("stock each branch holds"), true);
  expect("and what can be done in it", shopManifest.data.operations.map((o: { id: string }) => o.id).join(), "place_order,cancel_order");
  expect("its records are plain lines", (await api(`${shopUrl}/v1/summary`)).data.lines[0].startsWith("Product GREE-MZ-12"), true);
  expect("the manifest needs the key too", (await fetch(`${shopUrl}/v1/manifest`)).status, 401);

  console.log("\n-- the accounts ledger --");
  const books = ledger(key);
  const booksUrl = await listen(books);
  const invoice = (account: string, reference: string, listAmount: number, freight = 0) =>
    api(`${booksUrl}/v1/invoices`, "POST", { account, reference, listAmount, freight });
  const raised = await invoice("BRT-0931", "SO-1001", 5000, 100);
  expect("an invoice takes the tier discount off list and adds freight", raised.data.invoice.total, 4200);
  expect("and says so in a sentence", raised.data.summary.includes("less 900 CAD for tier 2"), true);
  expect("an order is invoiced once", (await invoice("BRT-0931", "SO-1001", 5000)).data.error.code, "already_invoiced");
  expect("an account on hold is refused", (await invoice("HAL-2210", "SO-1002", 100)).data.error.code, "on_hold");
  expect("an invoice past the credit limit is refused", (await invoice("CAL-3310", "SO-1003", 8000)).data.error.code, "over_limit");
  expect("a dealer that pays late needs sign-off for a large one", (await invoice("CAL-3310", "SO-1004", 5800)).data.error.code, "needs_sign_off");
  expect("but not for a small one", (await invoice("CAL-3310", "SO-1005", 1000)).status, 201);
  expect("a payment larger than the balance is refused", (await api(`${booksUrl}/v1/payments`, "POST", { account: "HAL-2210", amount: 90000 })).data.error.code, "overpayment");
  const paid = await api(`${booksUrl}/v1/payments`, "POST", { account: "HAL-2210", amount: "8,000 CAD" });
  expect("a payment that makes room lifts the hold", paid.data.account.onHold, null);
  const heldAccount = await api(`${booksUrl}/v1/accounts/NOR-0188/hold`, "PUT", { hold: "yes", reason: "Dispute" });
  expect("an account can be put on hold", heldAccount.data.account.onHold, "Dispute");
  expect("the records show the hold", (await api(`${booksUrl}/v1/summary`)).data.lines.some((l: string) => l.includes("NOR-0188") && l.includes("ON CREDIT HOLD: Dispute")), true);
  books.close();
  books.closeAllConnections();

  console.log("\n-- the supplier portal --");
  const factory = supplier(key);
  const factoryUrl = await listen(factory);
  const purchase = (sku: string, quantity: number, branch = "Laval") => api(`${factoryUrl}/v1/purchase-orders`, "POST", { sku, quantity, branch });
  expect("an order below the minimum is refused", (await purchase("GREE-CU-24", 2)).data.error.code, "below_minimum");
  expect("an order that is not whole cases is refused", (await purchase("GREE-MZ-12", 7)).data.error.code, "not_whole_cases");
  const split = await purchase("GREE-CU-24", 8);
  expect("what the factory has ships now and the rest is backordered", `${split.data.order.shipsNow} ${split.data.order.backordered}`, "6 2");
  expect("and the answer gives both dates", /6 arrive on \d{4}-\d\d-\d\d and 2 are backordered until \d{4}/.test(split.data.summary), true);
  const late = await purchase("GREE-CU-24", 4);
  expect("an order with nothing ready is all backordered", late.data.order.shipsNow, 0);
  expect("which air freight cannot bring forward", (await api(`${factoryUrl}/v1/purchase-orders/${late.data.order.id}/expedite`, "POST")).data.error.code, "nothing_to_expedite");
  const flown = await api(`${factoryUrl}/v1/purchase-orders/${split.data.order.id}/expedite`, "POST");
  expect("expediting adds 18 percent on what ships now", flown.data.order.cost, 8 * 1380 + 6 * 1380 * 0.18);
  expect("and cannot be cancelled afterwards", (await api(`${factoryUrl}/v1/purchase-orders/${split.data.order.id}/cancel`, "POST")).data.error.code, "in_the_air");
  expect("an order still at the factory can", (await api(`${factoryUrl}/v1/purchase-orders/${late.data.order.id}/cancel`, "POST")).data.order.status, "cancelled");
  factory.close();
  factory.closeAllConnections();

  console.log("\n-- the service desk --");
  const desk = serviceDesk(key);
  const deskUrl = await listen(desk);
  const ticket = (account: string, serial: string, problem: string) => api(`${deskUrl}/v1/tickets`, "POST", { account, serial, problem });
  expect("an unknown serial is refused", (await ticket("CAL-3310", "NOPE-1", "Dead")).data.error.code, "unknown_serial");
  expect("a unit sold to someone else is refused", (await ticket("NOR-0188", "GCU24-118204", "Dead")).data.error.code, "wrong_account");
  const fault = await ticket("CAL-3310", "GCU24-118204", "Compressor trips after ten minutes");
  expect("a fault that stops the unit is urgent", fault.data.ticket.priority, "urgent");
  expect("and the answer says whether it is under warranty", fault.data.summary.includes("under warranty"), true);
  expect("a unit has one open ticket at a time", (await ticket("CAL-3310", "GCU24-118204", "Again")).data.error.code, "ticket_open");
  const rma = await api(`${deskUrl}/v1/tickets/${fault.data.ticket.id}/return`, "POST", { reason: "Failed compressor" });
  expect("a unit under warranty gets a return number", /^RMA-\d+$/.test(rma.data.ticket.returnNumber), true);
  const old = await ticket("BRT-0931", "GCU24-090377", "Noisy fan");
  expect("a quiet fault is normal priority", old.data.ticket.priority, "normal");
  expect("a unit out of warranty gets no return", (await api(`${deskUrl}/v1/tickets/${old.data.ticket.id}/return`, "POST", { reason: "Noisy" })).data.error.code, "out_of_warranty");
  const weekday = (offset: number): string => {
    const day = new Date(Date.now() + offset * 86_400_000);
    return day.toISOString().slice(0, 10);
  };
  let first = 2;
  while ([0, 6].includes(new Date(`${weekday(first)}T12:00:00Z`).getUTCDay())) first++;
  let weekend = 1;
  while (![0, 6].includes(new Date(`${weekday(weekend)}T12:00:00Z`).getUTCDay())) weekend++;
  const visit = (id: string, date: string) => api(`${deskUrl}/v1/tickets/${id}/visit`, "POST", { date });
  expect("a visit on a weekend is refused", (await visit(old.data.ticket.id, weekday(weekend))).data.error.code, "weekend");
  expect("a visit today is too soon", (await visit(old.data.ticket.id, weekday(0))).data.error.code, "too_soon");
  expect("a weekday visit is booked, chargeable out of warranty", (await visit(old.data.ticket.id, weekday(first))).data.summary.includes("chargeable"), true);
  await visit(fault.data.ticket.id, weekday(first));
  const third = await ticket("HAL-0077", "PTAC12-33018", "No heat in room 214");
  expect("a third visit on a full day is refused", (await visit(third.data.ticket.id, weekday(first))).data.error.code, "day_full");
  await api(`${deskUrl}/v1/tickets/${third.data.ticket.id}/close`, "POST", { resolution: "Breaker reset on site" });
  expect("a closed ticket takes nothing more", (await visit(third.data.ticket.id, weekday(first))).data.error.code, "closed");
  desk.close();
  desk.closeAllConnections();

  // -- the office, with the demo pointed at the two services --------------------
  const folder = mkdtempSync(join(tmpdir(), "office-systems-"));
  const adminPassword = randomBytes(18).toString("base64url");
  // Agents carrying work forward by themselves is checked on its own below.
  process.env.OFFICE_AGENTS_PAUSED = "1";
  process.env.OFFICE_DB_PATH = join(folder, "office.db");
  process.env.AUTH_SECRET = randomBytes(40).toString("base64url");
  process.env.ADMIN_EMAIL = "owner@example.test";
  process.env.ADMIN_PASSWORD = adminPassword;
  process.env.DEMO_STOREFRONT_URL = shopUrl;
  process.env.DEMO_CARRIER_URL = freightUrl;
  process.env.DEMO_SYSTEMS_KEY = key;
  delete process.env.DEMO_LOGIN;

  const service = await import("../lib/server/officeService");
  const auth = await import("../lib/server/auth");
  const systems = await import("../lib/server/systems");
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

  console.log("\n-- the demo office is connected at start-up --");
  const demoPeople = auth.usersInOffice(db, service.DEMO_OFFICE_ID);
  const dana = await sessionFor(demoPeople.find((u) => u.participantId === "p-dana")!.email, "p-dana");
  const sam = await sessionFor(demoPeople.find((u) => u.participantId === "p-sam")!.email, "p-sam");
  let demo = service.getView(await dana());
  expect("the demo has its two systems", demo.office.systems.map((s) => `${s.name} in ${s.roomId}`).join("; "), "Storefront in fulfilment; Freight carrier in planning");
  expect("nobody may change them there", demo.systemsEditable, false);
  expect("so connecting one is refused", await refusal(async () => service.saveSystemSettings(await dana(), { name: "Mine", description: "", roomId: "planning", baseUrl: freightUrl, apiKey: key })), 403);
  expect("the key is not in the view", JSON.stringify(demo).includes(key), false);
  const live = await service.readSystemRecords(await dana(), demo.systems[0].id);
  expect("the manager can read the storefront live", live.records.some((r) => r.includes("GREE-MZ-12") && r.includes("Laval 120")), true);
  expect("someone who does not manage rooms cannot", await refusal(async () => service.readSystemRecords(await sam(), demo.systems[0].id)), 403);
  expect("the demo rooms carry their records", demo.office.floorplan.rooms.find((r) => r.id === "finance")!.records.length > 0, true);
  expect("a room the viewer cannot read arrives without them", service.getView(await sam()).office.floorplan.rooms.find((r) => r.id === "finance")!.records.length, 0);
  expect("the live lines reach an agent that can read the room", (await systems.liveRecords(db, service.DEMO_OFFICE_ID, [demo.systems[0].id]))[0].startsWith("[Storefront, live] Product"), true);

  console.log("\n-- the demo's order is placed once access allows the step --");
  demo = await service.applyAction(await sam(), { type: "SUBMIT_REQUEST", title: "Six heads for Northline", detail: "Northline Mechanical need 6x Gree multi-zone heads.", requestedById: "" });
  const taskId = demo.office.tasks[demo.office.tasks.length - 1].id;
  const taskNow = async () => service.getView(await dana()).office.tasks.find((t) => t.id === taskId)!;
  const thread = async () => service.getView(await dana()).office.messages.filter((m) => m.taskId === taskId);
  await service.applyAction(await sam(), { type: "ANSWER_QUESTION", questionId: (await taskNow()).openQuestionIds[0], answeredById: "", body: "Standalone.", chosenOption: "Standalone heads" });
  await service.applyAction(await dana(), { type: "ADVANCE", taskId });
  await service.applyAction(await dana(), { type: "ADVANCE", taskId });
  expect("the task halts at execution for Finance", `${(await taskNow()).stage} ${(await taskNow()).status}`, "execution blocked_permission");
  expect("nothing was ordered while it was halted", (await api(`${shopUrl}/v1/orders`)).data.orders.filter((o: { status: string }) => o.status === "placed").length, 0);
  await service.applyAction(await dana(), { type: "REVOKE_RULE", ruleId: "r-02", revokedBy: "" });
  demo = await service.applyAction(await dana(), { type: "GRANT_ACCESS", participantId: (await taskNow()).ownerId!, room: "finance", scopes: ["read"], effect: "allow", reason: "Dealer tier for this order", grantedBy: "", expiresOnTaskId: taskId });
  expect("clearing the halt lets the agent take the step again, which now waits for approval", (await taskNow()).status, "blocked_question");
  const ask = (await thread()).find((m) => m.kind === "question" && m.heldAction);
  expect("the agent asks the manager whether it may place the order", ask?.body, "May I place an order in Storefront? Account: NOR-0188. Ship-from branch: Laval. Items: GREE-MZ-12 x 6.");
  expect("with the action held on the question", `${ask?.kind === "question" && ask.heldAction?.operation} ${ask?.audience.to === "participant" ? ask.audience.id : ""}`, "place_order p-dana");
  expect("nothing is ordered while approval is pending", (await api(`${shopUrl}/v1/orders`)).data.orders.filter((o: { status: string }) => o.status === "placed").length, 0);
  expect("someone who was not asked and does not manage access cannot approve", await refusal(async () => service.applyAction(await sam(), { type: "ANSWER_QUESTION", questionId: ask!.id, answeredById: "", body: "Approve", chosenOption: "Approve" })), 403);
  await service.applyAction(await dana(), { type: "ANSWER_QUESTION", questionId: ask!.id, answeredById: "", body: "Approve", chosenOption: "Approve" });
  expect("approval unblocks the task", (await taskNow()).status, "in_progress");
  expect("and places the order in the storefront", (await thread()).some((m) => m.kind === "status" && /^Storefront: placed order SO-\d+ for account NOR-0188 from Laval: 6 x GREE-MZ-12/.test(m.body)), true);
  expect("the storefront holds it", (await api(`${shopUrl}/v1/orders`)).data.orders[0].account, "NOR-0188");
  expect("and Laval is down by six", await stock("GREE-MZ-12", "Laval"), 114);
  expect("the status note is not repeated", (await thread()).filter((m) => m.kind === "status" && m.body.startsWith("Checked stock")).length, 1);

  console.log("\n-- talking to an agent at its desk --");
  const tasksBefore = JSON.stringify(service.getView(await dana()).office.tasks);
  demo = await service.sendDirectMessage(await dana(), "p-ledger", "  What are you working on?  ");
  expect("the exchange is kept for the person who had it", demo.directs.map((c) => (c.fromMe ? "me" : "agent")).join(), "me,agent");
  expect("what was said is stored trimmed", demo.directs[0].body, "What are you working on?");
  expect("a playbook agent reports where its work stands", demo.directs[1].body.startsWith("I follow a playbook"), true);
  expect("the reply counts as read, since the sender is looking at it", Object.keys(demo.unread.directs).length, 0);
  expect("talking changes no task", JSON.stringify(demo.office.tasks), tasksBefore);
  expect("nobody else sees the conversation", service.getView(await sam()).directs.length, 0);
  expect("an empty message is refused", await refusal(async () => service.sendDirectMessage(await dana(), "p-ledger", "   ")), 400);
  expect("so is one to yourself", await refusal(async () => service.sendDirectMessage(await dana(), "p-dana", "Hello")), 400);
  expect("and one to someone who is not in the office", await refusal(async () => service.sendDirectMessage(await dana(), "p-nobody", "Hello")), 404);
  expect("someone who may not enter the agent's room cannot talk to it there", await refusal(async () => service.sendDirectMessage(await sam(), "p-ledger", "Hello")), 403);

  console.log("\n-- messages between people --");
  await service.sendDirectMessage(await sam(), "p-dana", "Can you look at the Northline order?");
  await service.sendDirectMessage(await sam(), "p-dana", "No rush.");
  demo = service.getView(await dana());
  expect("a person can write to any other person, whatever rooms they may enter", demo.directs.filter((d) => d.withId === "p-sam").length, 2);
  expect("the recipient sees them as unread", demo.unread.directs["p-sam"], 2);
  expect("the sender has nothing unread", Object.keys(service.getView(await sam()).unread.directs).length, 0);
  demo = service.markOpened(await dana(), { otherId: "p-sam" });
  expect("opening the conversation clears the count", demo.unread.directs["p-sam"], undefined);
  demo = await service.sendDirectMessage(await dana(), "p-sam", "On it.");
  expect("a reply reaches the first person as unread", service.getView(await sam()).unread.directs["p-dana"], 1);
  expect("the conversation with the agent is kept apart from it", demo.directs.filter((d) => d.withId === "p-ledger").length, 2);
  expect("the activity log says a message was sent, without its content", JSON.stringify(demo.feed).includes("sent a message to Sam Okafor") && !JSON.stringify(demo.feed).includes("On it."), true);

  console.log("\n-- the demo can be put back as it first loaded --");
  expect("someone who does not manage the office cannot reset it", await refusal(async () => service.resetDemoOffice(await sam())), 403);
  await service.resetDemoOffice(await dana());
  demo = service.getView(await dana());
  expect("the person who reset it is still signed in to their seat", demo.viewer.participantId, "p-dana");
  expect("the three seeded tasks are back and the new one is gone", demo.office.tasks.map((t) => t.id).join(), "T-1001,T-1002,T-1003");
  expect("the dealer order is halted at the Finance door again", demo.office.tasks[0].status, "blocked_permission");
  expect("the revoked rule is back", demo.office.rules.some((r) => r.id === "r-02"), true);
  expect("the systems are still connected", demo.office.systems.length, 2);
  expect("the other demo sign-in still has its seat", service.getView(await sam()).viewer.participantId, "p-sam");
  expect("no demo account was duplicated", auth.usersInOffice(db, service.DEMO_OFFICE_ID).length, 2);
  expect("no dangling references after the reset", all(db, "PRAGMA foreign_key_check").length, 0);

  console.log("\n-- an agent leaves a note for another agent --");
  demo = await service.applyAction(await dana(), { type: "GRANT_ACCESS", participantId: "p-quill", room: "finance", scopes: ["read"], effect: "allow", reason: "Dealer tier for this order", grantedBy: "", expiresOnTaskId: "T-1001" });
  const quillNote = demo.office.messages.find((m) => m.kind === "note" && m.taskId === "T-1001");
  expect("the quoting agent's note is in the thread, addressed to the finance agent", `${quillNote?.fromId} ${quillNote?.audience.to === "participant" ? quillNote.audience.id : ""}`, "p-quill p-ledger");
  expect("someone who cannot read everything does not see a note between two others", service.getView(await sam()).office.messages.some((m) => m.kind === "note"), false);
  expect("a note for someone else is not in the manager's own inbox", demo.unread.notes.length, 0);
  await service.resetDemoOffice(await dana());

  console.log("\n-- an office of one's own --");
  const admin = auth.authenticate(db, "owner@example.test", adminPassword)!;
  const owner = await sessionFor("owner@example.test", auth.seatsOf(db, admin.id)[0].participantId);
  let view = service.getView(await owner());
  expect("an office other than the demo cannot be reset", await refusal(async () => service.resetDemoOffice(await owner())), 403);
  const main = view.office.floorplan.rooms[0].id;
  view = await service.applyAdminOperation(await owner(), { type: "ADD_ROOM", name: "Warehouse", purpose: "Stock and orders", width: 8, depth: 8, attachTo: main, side: "east" });
  const warehouse = view.office.floorplan.rooms.find((r) => r.name === "Warehouse")!.id;
  view = await service.applyAdminOperation(await owner(), { type: "SET_ROOM_RECORDS", roomId: warehouse, records: ["  Orders ship from Laval.  ", "", "Pallets hold 12 heads."] });
  expect("records are stored trimmed, without empty lines", view.office.floorplan.rooms.find((r) => r.id === warehouse)!.records.join("|"), "Orders ship from Laval.|Pallets hold 12 heads.");
  expect("a system needs a key", await refusal(async () => service.saveSystemSettings(await owner(), { name: "Shop", description: "", roomId: warehouse, baseUrl: shopUrl })), 400);
  expect("and a web address", await refusal(async () => service.saveSystemSettings(await owner(), { name: "Shop", description: "", roomId: warehouse, baseUrl: "file:///etc/passwd", apiKey: key })), 400);
  expect("in a room that exists", await refusal(async () => service.saveSystemSettings(await owner(), { name: "Shop", description: "", roomId: "nowhere", baseUrl: shopUrl, apiKey: key })), 400);
  view = await service.saveSystemSettings(await owner(), { name: "Shop", description: "", roomId: warehouse, baseUrl: `${shopUrl}/`, apiKey: key });
  const shopId = view.systems[0].id;
  expect("it arrives with the system's own description", view.systems[0].description.includes("stock each branch holds"), true);
  expect("and what the system says can be done in it", view.systems[0].operations.join(), "Place an order,Cancel an order");
  expect("an address that is not such a system is refused", await refusal(async () => service.saveSystemSettings(await owner(), { name: "Nothing", description: "", roomId: warehouse, baseUrl: "http://127.0.0.1:9", apiKey: key })), 400);
  expect("and so is a key the system rejects", await refusal(async () => service.saveSystemSettings(await owner(), { name: "Shop two", description: "", roomId: warehouse, baseUrl: shopUrl, apiKey: "not-the-right-key" })), 400);
  view = await service.saveSystemSettings(await owner(), { id: shopId, name: "Shop", description: "Use this only for restocking jobs. Check the branch stock before ordering.", roomId: warehouse, baseUrl: shopUrl });
  expect("the description can be reworded", view.office.systems[0].description, "Use this only for restocking jobs. Check the branch stock before ordering.");
  expect("and its operations stay", view.office.systems[0].operations.length, 2);
  view = await service.saveSystemSettings(await owner(), { id: shopId, name: "", description: "", roomId: warehouse, baseUrl: shopUrl });
  expect("left empty, the name and description go back to the system's own", `${view.systems[0].name}: ${view.systems[0].description.slice(0, 13)}`, "Storefront: The catalogue");
  view = await service.saveSystemSettings(await owner(), { id: shopId, name: "Shop", description: view.systems[0].description, roomId: warehouse, baseUrl: shopUrl });
  expect("the system is listed with its room", `${view.office.systems[0].name} ${view.office.systems[0].roomId === warehouse}`, "Shop true");
  expect("its key is stored encrypted", (all(db, "SELECT api_key_cipher AS c FROM connected_systems WHERE id = ?", shopId)[0] as { c: string }).c.includes(key), false);
  expect("and never sent to the browser", JSON.stringify(view).includes(key), false);

  const shopAs = { id: shopId, name: "Shop", description: view.systems[0].description, roomId: warehouse, baseUrl: shopUrl };
  const corridorId = view.office.floorplan.rooms.find((r) => r.corridor)!.id;
  view = await service.saveSystemSettings(await owner(), { ...shopAs, shownIn: [main, warehouse, main] });
  expect("its records can be shown in a further room, listed once and never the room it is operated from", view.systems[0].shownIn.join(), main);
  expect("and the office knows it", view.office.systems[0].shownIn.join(), main);
  view = await service.saveSystemSettings(await owner(), shopAs);
  expect("a change that does not mention those rooms leaves them alone", view.systems[0].shownIn.join(), main);
  expect("a room that does not exist cannot show them", await refusal(async () => service.saveSystemSettings(await owner(), { ...shopAs, shownIn: ["nowhere"] })), 400);
  expect("nor can a corridor", await refusal(async () => service.saveSystemSettings(await owner(), { ...shopAs, shownIn: [corridorId] })), 400);
  expect("and no system is operated from a corridor", await refusal(async () => service.saveSystemSettings(await owner(), { ...shopAs, roomId: corridorId })), 400);
  view = await service.saveSystemSettings(await owner(), { ...shopAs, roomId: main, shownIn: [main] });
  expect("moved to a room that showed its records, it is no longer shown there as an extra", `${view.systems[0].roomId === main} ${view.systems[0].shownIn.length}`, "true 0");
  view = await service.saveSystemSettings(await owner(), { ...shopAs, shownIn: [] });
  expect("and the further rooms can be cleared", `${view.systems[0].roomId === warehouse} ${view.systems[0].shownIn.length}`, "true 0");

  const memberRole = Object.values(view.office.roles).find((r) => r.permissions.length === 0)!.id;
  view = await service.applyAdminOperation(await owner(), { type: "ADD_AGENT", displayName: "Nova", title: "Order desk", roleId: memberRole, roomId: main, capabilities: [], agentType: "playbook" });
  const nova = view.office.participants.find((p) => p.displayName === "Nova")!.id;
  const playbook = (fields: Record<string, string>) => ({
    type: "SET_PLAYBOOK" as const,
    participantId: nova,
    steps: [
      {
        id: "",
        when: { stage: "intake" as const, requestContains: "", requestedBy: "anyone" },
        then: { statusNote: "Ordering.", output: null, question: null, assumption: null, need: null, action: { systemId: shopId, operation: "place_order", fields }, note: null },
      },
    ],
  });
  expect("an action with a field left empty is refused", await refusal(async () => service.applyAdminOperation(await owner(), playbook({ account: "ACME-1", branch: "Laval" }))), 409);
  view = await service.applyAdminOperation(await owner(), playbook({ account: "ACME-1", branch: "Laval", items: "PTAC-12 x 1; 2 x ECOBEE-T" }));
  view = await service.applyAction(await owner(), { type: "SUBMIT_REQUEST", title: "Restock", detail: "One PTAC and two thermostats.", requestedById: "" });
  const job = view.office.tasks[0];
  expect("without act on the Warehouse the task halts", job.status, "blocked_permission");
  expect("the supervisor is told what for", view.office.messages.some((m) => m.kind === "escalation" && m.body.includes("act access to Warehouse") && m.body.includes("Place an order in Shop")), true);
  expect("and nothing reached the storefront", await stock("PTAC-12", "Laval"), 4);
  view = await service.applyAction(await owner(), { type: "GRANT_ACCESS", participantId: nova, room: warehouse, scopes: ["act"], effect: "allow", reason: "Places orders for this job", grantedBy: "", expiresOnTaskId: job.id });
  expect("granting act for this task places the order", view.office.messages.some((m) => /^Shop: placed order SO-\d+ for account ACME-1 from Laval: 1 x PTAC-12, 2 x ECOBEE-T, 1,438 CAD/.test(m.body)), true);
  expect("the stock moved", `${await stock("PTAC-12", "Laval")} ${await stock("ECOBEE-T", "Laval")}`, "3 58");

  view = await service.applyAdminOperation(await owner(), playbook({ account: "ACME-1", branch: "Laval", items: "PTAC-12 x 40" }));
  await service.applyAction(await owner(), { type: "GRANT_ACCESS", participantId: nova, room: warehouse, scopes: ["act"], effect: "allow", reason: "Standing order desk", grantedBy: "" });
  view = await service.applyAction(await owner(), { type: "SUBMIT_REQUEST", title: "Bulk", detail: "Forty PTAC units.", requestedById: "" });
  expect("a refusal by the storefront is reported in the thread", view.office.messages.some((m) => m.body.startsWith("Shop: refused to place an order: Laval holds 3 of PTAC-12")), true);
  const refusalNote = view.office.messages.find((m) => m.kind === "note");
  expect("and whoever asked for the work gets a note about it", refusalNote?.audience.to === "participant" && refusalNote.audience.id === view.viewer.participantId && refusalNote.body.includes("did not do what"), true);
  expect("which is unread in their inbox", view.unread.notes.join(), refusalNote?.id);
  expect("until they open it", service.markOpened(await owner(), { noteId: refusalNote!.id }).unread.notes.length, 0);

  console.log("\n-- a system whose actions need approval --");
  view = await service.saveSystemSettings(await owner(), { id: shopId, name: "Shop", description: "", roomId: warehouse, baseUrl: shopUrl, needsApproval: true });
  expect("the setting is stored, and the key is kept without being sent again", `${view.systems[0].needsApproval} ${view.systems[0].hasKey}`, "true true");
  view = await service.applyAdminOperation(await owner(), playbook({ account: "ACME-1", branch: "Laval", items: "ECOBEE-T x 5" }));
  const thermostats = await stock("ECOBEE-T", "Laval");
  view = await service.applyAction(await owner(), { type: "SUBMIT_REQUEST", title: "Thermostats", detail: "Five thermostats.", requestedById: "" });
  const held = view.office.messages.filter((m) => m.kind === "question" && m.heldAction).at(-1)!;
  expect("an agent that may act still has to ask first", view.office.tasks.at(-1)!.status, "blocked_question");
  expect("and nothing reaches the storefront", await stock("ECOBEE-T", "Laval"), thermostats);
  view = await service.applyAction(await owner(), { type: "ANSWER_QUESTION", questionId: held.id, answeredById: "", body: "Not this week.", chosenOption: "Decline" });
  expect("declining unblocks the task without ordering", `${view.office.tasks.at(-1)!.status} ${await stock("ECOBEE-T", "Laval")}`, `in_progress ${thermostats}`);
  expect("and the thread says who declined", view.office.messages.at(-1)!.body, "Shop: not done, because Owner did not approve it.");
  view = await service.applyAction(await owner(), { type: "SUBMIT_REQUEST", title: "Thermostats again", detail: "Five thermostats.", requestedById: "" });
  const heldAgain = view.office.messages.filter((m) => m.kind === "question" && m.heldAction).at(-1)!;
  view = await service.applyAction(await owner(), { type: "ANSWER_QUESTION", questionId: heldAgain.id, answeredById: "", body: "Go ahead, as long as it is five.", });
  expect("an answer typed in place of the Approve choice does not count as approval", await stock("ECOBEE-T", "Laval"), thermostats);
  view = await service.saveSystemSettings(await owner(), { id: shopId, name: "Shop", description: "", roomId: warehouse, baseUrl: shopUrl, needsApproval: false });

  shop.close();
  shop.closeAllConnections();
  view = await service.applyAction(await owner(), { type: "SUBMIT_REQUEST", title: "Later", detail: "Same again.", requestedById: "" });
  expect("a system that is down is reported, and the office carries on", view.office.messages.some((m) => m.body === "Shop: nothing was done, because it could not be reached."), true);
  expect("reading it says so too", await refusal(async () => service.readSystemRecords(await owner(), shopId)), 424);

  await service.applyAdminOperation(await owner(), { type: "CLEAR_WORK" });
  view = await service.applyAdminOperation(await owner(), { type: "REMOVE_ROOM", roomId: warehouse });
  expect("removing the room disconnects its system", view.office.systems.length, 0);
  expect("no dangling references anywhere", all(db, "PRAGMA foreign_key_check").length, 0);

  freight.close();
  freight.closeAllConnections();
  db.close();
  rmSync(folder, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? "all system checks passed" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
