/**
 * Checks the two stand-in services and how an office uses them: connecting a
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
import { carrier } from "../services/carrier/server";
import { storefront } from "../services/storefront/server";

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

  // -- the office, with the demo pointed at the two services --------------------
  const folder = mkdtempSync(join(tmpdir(), "office-systems-"));
  const adminPassword = randomBytes(18).toString("base64url");
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
  expect("so connecting one is refused", await refusal(async () => service.saveSystemSettings(await dana(), { name: "Mine", kind: "carrier", roomId: "planning", baseUrl: freightUrl, apiKey: key })), 403);
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
  expect("clearing the halt lets the agent take the step again", (await taskNow()).status, "in_progress");
  expect("which places the order in the storefront", (await thread()).some((m) => m.kind === "status" && /^Storefront: placed order SO-\d+ for account NOR-0188 from Laval: 6 x GREE-MZ-12/.test(m.body)), true);
  expect("the storefront holds it", (await api(`${shopUrl}/v1/orders`)).data.orders[0].account, "NOR-0188");
  expect("and Laval is down by six", await stock("GREE-MZ-12", "Laval"), 114);
  expect("the status note is not repeated", (await thread()).filter((m) => m.kind === "status" && m.body.startsWith("Checked stock")).length, 1);

  console.log("\n-- an office of one's own --");
  const admin = auth.authenticate(db, "owner@example.test", adminPassword)!;
  const owner = await sessionFor("owner@example.test", auth.seatsOf(db, admin.id)[0].participantId);
  let view = service.getView(await owner());
  const main = view.office.floorplan.rooms[0].id;
  view = await service.applyAdminOperation(await owner(), { type: "ADD_ROOM", name: "Warehouse", purpose: "Stock and orders", width: 8, depth: 8, attachTo: main, side: "east" });
  const warehouse = view.office.floorplan.rooms.find((r) => r.name === "Warehouse")!.id;
  view = await service.applyAdminOperation(await owner(), { type: "SET_ROOM_RECORDS", roomId: warehouse, records: ["  Orders ship from Laval.  ", "", "Pallets hold 12 heads."] });
  expect("records are stored trimmed, without empty lines", view.office.floorplan.rooms.find((r) => r.id === warehouse)!.records.join("|"), "Orders ship from Laval.|Pallets hold 12 heads.");
  expect("a system needs a key", await refusal(async () => service.saveSystemSettings(await owner(), { name: "Shop", kind: "storefront", roomId: warehouse, baseUrl: shopUrl })), 400);
  expect("and a web address", await refusal(async () => service.saveSystemSettings(await owner(), { name: "Shop", kind: "storefront", roomId: warehouse, baseUrl: "file:///etc/passwd", apiKey: key })), 400);
  expect("in a room that exists", await refusal(async () => service.saveSystemSettings(await owner(), { name: "Shop", kind: "storefront", roomId: "nowhere", baseUrl: shopUrl, apiKey: key })), 400);
  view = await service.saveSystemSettings(await owner(), { name: "Shop", kind: "storefront", roomId: warehouse, baseUrl: `${shopUrl}/`, apiKey: key });
  const shopId = view.systems[0].id;
  expect("the system is listed with its room", `${view.office.systems[0].name} ${view.office.systems[0].roomId === warehouse}`, "Shop true");
  expect("its key is stored encrypted", (all(db, "SELECT api_key_cipher AS c FROM connected_systems WHERE id = ?", shopId)[0] as { c: string }).c.includes(key), false);
  expect("and never sent to the browser", JSON.stringify(view).includes(key), false);

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
        then: { statusNote: "Ordering.", output: null, question: null, assumption: null, need: null, action: { systemId: shopId, operation: "place_order", fields } },
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
  expect("a refusal by the storefront is reported in the thread", view.office.messages.some((m) => m.body.startsWith("Shop: refused the order: Laval holds 3 of PTAC-12")), true);

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
