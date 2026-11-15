/**
 * Outside systems connected to rooms: storing them, reading their live
 * records, and carrying out operations in them.
 *
 * Nothing here decides who may see or do what. The engine and the office
 * service check the room's access rules first and call in only afterwards.
 * API keys are stored encrypted and never leave the server.
 */
import { createHash, randomUUID } from "node:crypto";
import type { SystemCall, SystemOutcome } from "../engine";
import type { Office } from "../model";
import { DEMO_CARRIER_ID, DEMO_STOREFRONT_ID, office as seededOffice } from "../seed";
import { SYSTEM_INFO, SYSTEM_KINDS, type SystemKind } from "../systems";
import type { SystemView } from "../view";
import { all, get, run, type Db } from "./db";
import { checkedBaseUrl, ProviderError } from "./providers";
import { seal, unseal } from "./secrets";

interface SystemRow {
  id: string;
  room_id: string;
  name: string;
  kind: SystemKind;
  base_url: string;
  api_key_cipher: string | null;
  key_hint: string | null;
  needs_approval: number;
}

/** Thrown for input a person can correct. The message is shown to them. */
export class SystemError extends Error {}

const IN_OFFICE = `FROM connected_systems s
  JOIN rooms r ON r.id = s.room_id
  JOIN floorplans f ON f.id = r.floorplan_id
 WHERE f.office_id = ?`;

const rows = (db: Db, officeId: string): SystemRow[] =>
  all<SystemRow>(db, `SELECT s.* ${IN_OFFICE} ORDER BY s.position`, officeId);

const row = (db: Db, officeId: string, id: string): SystemRow | undefined =>
  get<SystemRow>(db, `SELECT s.* ${IN_OFFICE} AND s.id = ?`, officeId, id);

const DEMO_IDS = new Set([DEMO_STOREFRONT_ID, DEMO_CARRIER_ID]);

/** The connected systems of an office, without their keys. */
export function systemViews(db: Db, officeId: string): SystemView[] {
  return rows(db, officeId).map((r) => {
    const key = unseal(r.api_key_cipher);
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      roomId: r.room_id,
      baseUrl: r.base_url,
      needsApproval: r.needs_approval === 1,
      hasKey: key !== null,
      keyHint: key !== null ? r.key_hint : null,
      keyUnreadable: r.api_key_cipher !== null && key === null,
    };
  });
}

export interface SystemInput {
  id?: string;
  name: string;
  kind: SystemKind;
  roomId: string;
  baseUrl: string;
  apiKey?: string;
  /** Hold each action an agent takes here until a person approves it. */
  needsApproval?: boolean;
}

/** Connect a system to a room, or change one when `id` is given. */
export function saveSystem(db: Db, office: Office, input: SystemInput): void {
  const existing = input.id ? row(db, office.id, input.id) : undefined;
  if (input.id && !existing) throw new SystemError("That connected system does not exist in this office.");
  if (!existing && rows(db, office.id).length >= 12) throw new SystemError("An office can connect up to 12 systems.");

  const name = input.name.trim();
  if (name.length < 2 || name.length > 40) throw new SystemError("Give the system a name (2 to 40 characters).");
  if (!SYSTEM_KINDS.includes(input.kind)) throw new SystemError("Choose what kind of system this is.");
  if (!office.floorplan.rooms.some((r) => r.id === input.roomId)) throw new SystemError("That room does not exist.");
  let baseUrl: string;
  try {
    baseUrl = checkedBaseUrl(input.baseUrl, "the system's");
  } catch (error) {
    throw error instanceof ProviderError ? new SystemError(error.message) : error;
  }

  const typed = input.apiKey?.trim();
  if (typed && (typed.length < 8 || typed.length > 400 || /\s/.test(typed))) {
    throw new SystemError("That does not look like an API key.");
  }
  const cipher = typed ? seal(typed) : (existing?.api_key_cipher ?? null);
  const hint = typed ? typed.slice(-4) : (existing?.key_hint ?? null);
  if (cipher === null) throw new SystemError("Enter the system's API key.");

  if (existing) {
    run(
      db,
      `UPDATE connected_systems
          SET name = ?, kind = ?, room_id = ?, base_url = ?, api_key_cipher = ?, key_hint = ?, updated_at = ?,
              needs_approval = ?
        WHERE id = ?`,
      name,
      input.kind,
      input.roomId,
      baseUrl,
      cipher,
      hint,
      Date.now(),
      (input.needsApproval ?? existing.needs_approval === 1) ? 1 : 0,
      existing.id,
    );
    return;
  }
  const next = get<{ next: number }>(db, "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM connected_systems");
  run(
    db,
    `INSERT INTO connected_systems
       (id, room_id, position, name, kind, base_url, api_key_cipher, key_hint, updated_at, needs_approval)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    `sys-${randomUUID().slice(0, 8)}`,
    input.roomId,
    next?.next ?? 0,
    name,
    input.kind,
    baseUrl,
    cipher,
    hint,
    Date.now(),
    input.needsApproval ? 1 : 0,
  );
}

/** Disconnect a system. Returns its name and room for the activity log. */
export function removeSystem(db: Db, officeId: string, id: string): { name: string; roomId: string } {
  const existing = row(db, officeId, id);
  if (!existing) throw new SystemError("That connected system does not exist in this office.");
  run(db, "DELETE FROM connected_systems WHERE id = ?", id);
  return { name: existing.name, roomId: existing.room_id };
}

export const systemRoom = (db: Db, officeId: string, id: string): string | null =>
  row(db, officeId, id)?.room_id ?? null;

// ---------------------------------------------------------------------------
// Talking to a system
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json => (value && typeof value === "object" ? (value as Json) : {});
const asList = (value: unknown): Json[] => (Array.isArray(value) ? value.map(asObject) : []);
const str = (value: unknown): string => (typeof value === "string" || typeof value === "number" ? String(value) : "");
const money = (value: unknown, currency: unknown): string =>
  `${Number(value).toLocaleString("en-CA", { maximumFractionDigits: 2 })} ${str(currency) || "CAD"}`;

/** One HTTP call. Throws a plain sentence when the system does not answer. */
async function call(
  system: SystemRow,
  method: "GET" | "POST",
  path: string,
  body?: Json,
  idempotencyKey?: string,
): Promise<{ status: number; data: Json }> {
  const key = unseal(system.api_key_cipher);
  if (!key) throw new Error("its API key cannot be read, so it has to be entered again");
  let response: Response;
  try {
    response = await fetch(`${system.base_url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body ? { "content-type": "application/json" } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
  } catch {
    throw new Error("it could not be reached");
  }
  const data = asObject(await response.json().catch(() => null));
  if (response.status === 401 || response.status === 403) throw new Error("it rejected the API key");
  return { status: response.status, data };
}

/** The system's own reason for refusing, as the end of a sentence. */
const reason = (data: Json, status: number): string =>
  (str(asObject(data.error).message) || `it answered with status ${status}`).replace(/[.\s]+$/, "");

async function readStorefront(system: SystemRow): Promise<string[]> {
  const [products, orders] = await Promise.all([call(system, "GET", "/v1/products"), call(system, "GET", "/v1/orders")]);
  if (products.status !== 200) throw new Error(reason(products.data, products.status));
  return [
    ...asList(products.data.products).slice(0, 40).map((p) => {
      const stock = Object.entries(asObject(p.stock))
        .map(([branch, quantity]) => `${branch} ${str(quantity)}`)
        .join(", ");
      return `Product ${str(p.sku)}, ${str(p.name)}: list price ${money(p.listPrice, p.currency)}, ${str(p.weightKg)} kg each. In stock: ${stock}.`;
    }),
    ...asList(orders.data.orders).slice(0, 8).map((o) => {
      const items = asList(o.items).map((i) => `${str(i.quantity)} x ${str(i.sku)}`).join(", ");
      return `Order ${str(o.id)} (${str(o.status)}): account ${str(o.account)}, from ${str(o.branch)}, ${items}, ${money(o.total, o.currency)}.`;
    }),
  ];
}

async function readCarrier(system: SystemRow): Promise<string[]> {
  const [services, shipments] = await Promise.all([
    call(system, "GET", "/v1/services"),
    call(system, "GET", "/v1/shipments"),
  ]);
  if (services.status !== 200) throw new Error(reason(services.data, services.status));
  return [
    ...asList(services.data.services).slice(0, 12).map(
      (s) =>
        `Service "${str(s.code)}" (${str(s.name)}): ${money(s.baseCharge, s.currency)} plus ${money(s.perKg, s.currency)} per kg, ${str(s.transitDays)} days in transit.`,
    ),
    ...asList(shipments.data.shipments).slice(0, 8).map(
      (s) =>
        `Shipment ${str(s.id)} (${str(s.status)}): reference ${str(s.reference)}, ${str(s.from)} to ${str(s.to)}, ${str(s.weightKg)} kg by ${str(s.service)}, ${money(s.cost, s.currency)}.`,
    ),
  ];
}

const read = (system: SystemRow): Promise<string[]> =>
  system.kind === "storefront" ? readStorefront(system) : readCarrier(system);

/**
 * What these systems hold right now, one line per record, each marked with
 * the system it came from. A system that does not answer says so in its place.
 */
export async function liveRecords(db: Db, officeId: string, systemIds: string[]): Promise<string[]> {
  const wanted = rows(db, officeId).filter((r) => systemIds.includes(r.id));
  const lines = await Promise.all(
    wanted.map(async (system) => {
      try {
        return (await read(system)).map((line) => `[${system.name}, live] ${line}`);
      } catch (error) {
        const why = error instanceof Error ? error.message : "it failed";
        return [`[${system.name}] No records could be read: ${why}.`];
      }
    }),
  );
  return lines.flat();
}

/** Read one system for a person. Throws a sentence when it does not answer. */
export async function readSystem(db: Db, officeId: string, id: string): Promise<{ name: string; records: string[] }> {
  const system = row(db, officeId, id);
  if (!system) throw new SystemError("That connected system does not exist in this office.");
  try {
    return { name: system.name, records: await read(system) };
  } catch (error) {
    const why = error instanceof Error ? error.message : "it failed";
    throw new Error(`${system.name} gave no answer: ${why}.`);
  }
}

/** Read "GREE-MZ-12 x 6; ECOBEE-T x 2" into order lines. */
export function parseItems(text: string): { sku: string; quantity: number }[] | null {
  const items = text
    .split(/[;,\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const skuFirst = part.match(/^([A-Za-z][\w-]*)\s*(?:x|\*|:|×)?\s*(\d+)$/i);
      const countFirst = part.match(/^(\d+)\s*(?:x|\*|×)?\s*([A-Za-z][\w-]*)$/i);
      if (skuFirst) return { sku: skuFirst[1].toUpperCase(), quantity: Number(skuFirst[2]) };
      if (countFirst) return { sku: countFirst[2].toUpperCase(), quantity: Number(countFirst[1]) };
      return null;
    });
  return items.length > 0 && items.every((i) => i !== null) ? (items as { sku: string; quantity: number }[]) : null;
}

/** The same task asking for the same thing twice gets the same result back. */
const idempotencyKey = (action: SystemCall): string =>
  createHash("sha256")
    .update(JSON.stringify([action.taskId, action.system.id, action.operation, Object.entries(action.fields).sort()]))
    .digest("hex")
    .slice(0, 32);

async function performIn(system: SystemRow, action: SystemCall): Promise<SystemOutcome> {
  const f = action.fields;
  const refused = (data: Json, status: number, what: string): SystemOutcome => ({
    ok: false,
    summary: `refused ${what}: ${reason(data, status)}.`,
  });

  switch (`${system.kind}:${action.operation}`) {
    case "storefront:place_order": {
      const items = parseItems(f.items);
      if (!items) return { ok: false, summary: `could not read the items "${f.items}", so no order was placed.` };
      const { status, data } = await call(
        system,
        "POST",
        "/v1/orders",
        { account: f.account, branch: f.branch, items },
        idempotencyKey(action),
      );
      if (status !== 200 && status !== 201) return refused(data, status, "the order");
      const order = asObject(data.order);
      const lines = asList(order.items).map((i) => `${str(i.quantity)} x ${str(i.sku)}`).join(", ");
      const detail = `for account ${str(order.account)} from ${str(order.branch)}: ${lines}, ${money(order.total, order.currency)} at list price`;
      return {
        ok: true,
        summary: data.repeated
          ? `order ${str(order.id)} was already placed for this task, ${detail}.`
          : `placed order ${str(order.id)} ${detail}.`,
      };
    }
    case "storefront:cancel_order": {
      const { status, data } = await call(system, "POST", `/v1/orders/${encodeURIComponent(f.order)}/cancel`);
      if (status !== 200) return refused(data, status, "the cancellation");
      const order = asObject(data.order);
      return { ok: true, summary: `cancelled order ${str(order.id)} and returned its stock to ${str(order.branch)}.` };
    }
    case "carrier:book_shipment": {
      const { status, data } = await call(
        system,
        "POST",
        "/v1/shipments",
        { reference: f.reference, from: f.from, to: f.to, weightKg: Number(f.weightKg.replace(/[^\d.]/g, "")), service: f.service },
        idempotencyKey(action),
      );
      if (status !== 200 && status !== 201) return refused(data, status, "the booking");
      const s = asObject(data.shipment);
      const detail = `${str(s.from)} to ${str(s.to)}, ${str(s.weightKg)} kg by ${str(s.service)}, ${money(s.cost, s.currency)}, ${str(s.transitDays)} days in transit, tracking ${str(s.tracking)}`;
      return {
        ok: true,
        summary: data.repeated
          ? `shipment ${str(s.id)} was already booked for this task, ${detail}.`
          : `booked shipment ${str(s.id)} for ${str(s.reference)}: ${detail}.`,
      };
    }
    case "carrier:cancel_shipment": {
      const { status, data } = await call(system, "POST", `/v1/shipments/${encodeURIComponent(f.shipment)}/cancel`);
      if (status !== 200) return refused(data, status, "the cancellation");
      return { ok: true, summary: `cancelled shipment ${str(asObject(data.shipment).id)}.` };
    }
    default:
      return { ok: false, summary: `has no operation called ${action.operation}, so nothing was done.` };
  }
}

/** Carry out one operation. Always resolves, with what happened in a sentence. */
export async function performInSystem(db: Db, officeId: string, action: SystemCall): Promise<SystemOutcome> {
  const system = row(db, officeId, action.system.id);
  if (!system) return { ok: false, summary: "it is no longer connected, so nothing was done." };
  try {
    return await performIn(system, action);
  } catch (error) {
    const why = error instanceof Error ? error.message : "it failed";
    return { ok: false, summary: `nothing was done, because ${why}.` };
  }
}

// ---------------------------------------------------------------------------
// The demo office
// ---------------------------------------------------------------------------

/**
 * Connect the demo office to the systems named in the server's environment,
 * and disconnect it from any that are no longer named. The demo's playbook
 * steps that use those systems get their actions back if they have none.
 */
export function ensureDemoSystems(db: Db, demo: Office): void {
  const key = process.env.DEMO_SYSTEMS_KEY?.trim() ?? "";
  // An order in the demo's storefront waits for a person's approval, so the
  // demo shows that gate as well as the one on access.
  const wanted: { id: string; name: string; kind: SystemKind; roomId: string; url: string; approval: number }[] = [
    { id: DEMO_STOREFRONT_ID, name: "Storefront", kind: "storefront", roomId: "fulfilment", url: process.env.DEMO_STOREFRONT_URL?.trim() ?? "", approval: 1 },
    { id: DEMO_CARRIER_ID, name: "Freight carrier", kind: "carrier", roomId: "planning", url: process.env.DEMO_CARRIER_URL?.trim() ?? "", approval: 0 },
  ];
  for (const system of wanted) {
    const usable = system.url !== "" && key.length >= 8 && demo.floorplan.rooms.some((r) => r.id === system.roomId);
    if (!usable) {
      run(db, "DELETE FROM connected_systems WHERE id = ?", system.id);
      continue;
    }
    const position = get<{ next: number }>(db, "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM connected_systems");
    run(
      db,
      `INSERT INTO connected_systems
         (id, room_id, position, name, kind, base_url, api_key_cipher, key_hint, updated_at, needs_approval)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         room_id = excluded.room_id, base_url = excluded.base_url,
         api_key_cipher = excluded.api_key_cipher, key_hint = excluded.key_hint, updated_at = excluded.updated_at,
         needs_approval = excluded.needs_approval`,
      system.id,
      system.roomId,
      position?.next ?? 0,
      system.name,
      system.kind,
      system.url.replace(/\/+$/, ""),
      seal(key),
      key.slice(-4),
      Date.now(),
      system.approval,
    );
  }

  for (const seeded of seededOffice.participants) {
    for (const step of seeded.playbook) {
      const action = step.then.action;
      if (!action || !DEMO_IDS.has(action.systemId)) continue;
      const stored = get(db, "SELECT 1 AS found FROM playbook_steps WHERE id = ? AND participant_id = ?", step.id, seeded.id);
      const has = get(db, "SELECT 1 AS found FROM playbook_actions WHERE step_id = ?", step.id);
      if (!stored || has) continue;
      run(db, "INSERT INTO playbook_actions (step_id, system_id, operation) VALUES (?, ?, ?)", step.id, action.systemId, action.operation);
      for (const [name, value] of Object.entries(action.fields)) {
        run(db, "INSERT INTO playbook_action_fields (step_id, name, value) VALUES (?, ?, ?)", step.id, name, value);
      }
    }
  }

  // Stored demo text that disagrees with the storefront's sample stock, or
  // with the order the demo places there, is replaced with the seeded wording.
  const reworded: [table: string, column: string, key: string, id: string, stale: string, current: string][] = [
    ["playbook_steps", "status_note", "id", "pb-vera-execution", "Checked stock across branches; a transfer is required to fill the order.", "Checked stock across branches; Laval can fill the whole order."],
    ["playbook_assumptions", "assumed", "step_id", "pb-vera-execution", "The dealer will accept a split-origin shipment", "The dealer will accept shipment from Laval"],
    ["playbook_assumptions", "because", "step_id", "pb-vera-execution", "No single branch can fill the order and the dealer stated no preference.", "Richmond Hill alone cannot fill the order and the dealer stated no preference."],
    ["playbook_needs", "purpose", "step_id", "pb-vera-execution", "Dealer tier and landed cost, to price the transfer", "Dealer tier and landed cost, to price the order"],
    ["playbook_outputs", "body", "step_id", "pb-quill-execution", "Six line items, split origin, pending tier pricing.", "Six heads shipped from Laval, pending tier pricing."],
    ["messages", "body", "id", "m-1009", "Stock: 4 at Richmond Hill, 2 at Laval. Transfer would land 21 Nov.", "Stock: 4 at Richmond Hill, 120 at Laval. Laval can ship all six by 21 Nov."],
    ["messages", "body", "id", "m-1010", "Assuming an inter-branch transfer is acceptable.", "Assuming shipment from Laval is acceptable."],
    ["message_assumptions", "assumed", "message_id", "m-1010", "The dealer will accept a split-origin shipment", "The dealer will accept shipment from Laval"],
  ];
  for (const [table, column, key, id, stale, current] of reworded) {
    run(db, `UPDATE ${table} SET ${column} = ? WHERE ${key} = ? AND ${column} = ?`, current, id, stale);
  }

  // A demo office stored before rooms kept records gets the seeded ones.
  const anyRecords = get(
    db,
    `SELECT 1 AS found FROM room_records x JOIN rooms r ON r.id = x.room_id
       JOIN floorplans f ON f.id = r.floorplan_id WHERE f.office_id = ?`,
    demo.id,
  );
  if (!anyRecords) {
    for (const room of seededOffice.floorplan.rooms) {
      if (!demo.floorplan.rooms.some((r) => r.id === room.id)) continue;
      room.records.forEach((body, position) => {
        run(db, "INSERT INTO room_records (room_id, position, body) VALUES (?, ?, ?)", room.id, position, body);
      });
    }
  }
}

/**
 * Connect an office to the two sample services named in the server's
 * environment. Does nothing where they are not named. Orders in the
 * storefront wait for approval, as in the demo.
 */
export function connectSampleServices(db: Db, suffix: string, rooms: { storefront: string; carrier: string }): void {
  const key = process.env.DEMO_SYSTEMS_KEY?.trim() ?? "";
  if (key.length < 8) return;
  const wanted: [string, string, SystemKind, string, string, number][] = [
    [`sys-${suffix}-storefront`, "Storefront", "storefront", rooms.storefront, process.env.DEMO_STOREFRONT_URL?.trim() ?? "", 1],
    [`sys-${suffix}-carrier`, "Freight carrier", "carrier", rooms.carrier, process.env.DEMO_CARRIER_URL?.trim() ?? "", 0],
  ];
  for (const [id, name, kind, roomId, url, approval] of wanted) {
    if (!url) continue;
    const position = get<{ next: number }>(db, "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM connected_systems");
    run(
      db,
      `INSERT INTO connected_systems
         (id, room_id, position, name, kind, base_url, api_key_cipher, key_hint, updated_at, needs_approval)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      roomId,
      position?.next ?? 0,
      name,
      kind,
      url.replace(/\/+$/, ""),
      seal(key),
      key.slice(-4),
      Date.now(),
      approval,
    );
  }
}

export const systemKindLabel = (kind: SystemKind): string => SYSTEM_INFO[kind].label;
