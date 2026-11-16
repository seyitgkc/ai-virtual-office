/**
 * Outside systems connected to rooms: storing them, reading their live
 * records, and carrying out operations in them.
 *
 * Nothing here decides who may see or do what. The engine and the office
 * service check the room's access rules first and call in only afterwards.
 * API keys are stored encrypted and never leave the server.
 */
import { createHash, randomUUID } from "node:crypto";
import { MANIFESTS } from "../../services/manifests.ts";
import type { SystemCall, SystemOutcome } from "../engine";
import type { Office } from "../model";
import { DEMO_CARRIER_ID, DEMO_STOREFRONT_ID, office as seededOffice } from "../seed";
import { parseManifest, type ServiceManifest, type SystemOperation } from "../systems";
import type { SystemView } from "../view";
import { all, get, run, transaction, type Db } from "./db";
import { checkedBaseUrl, ProviderError } from "./providers";
import { seal, unseal } from "./secrets";

interface SystemRow {
  id: string;
  room_id: string;
  name: string;
  description: string;
  records_path: string;
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

/** The further rooms that show each stored system's records, by system id. */
export function storedShownRooms(db: Db): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const r of all<{ system_id: string; room_id: string }>(db, "SELECT system_id, room_id FROM system_shown_rooms ORDER BY system_id, position")) {
    found.set(r.system_id, [...(found.get(r.system_id) ?? []), r.room_id]);
  }
  return found;
}

/** What can be done in every stored system, by system id. */
export function storedOperations(db: Db): Map<string, SystemOperation[]> {
  const fields = all<{ system_id: string; operation: string; name: string; label: string; hint: string; place: "path" | "body" }>(
    db,
    "SELECT * FROM system_operation_fields ORDER BY position",
  );
  const found = new Map<string, SystemOperation[]>();
  for (const o of all<{ system_id: string; operation: string; label: string; method: SystemOperation["method"]; path: string; undoes: string | null }>(
    db,
    "SELECT * FROM system_operations ORDER BY position",
  )) {
    const list = found.get(o.system_id) ?? [];
    list.push({
      id: o.operation,
      label: o.label,
      method: o.method,
      path: o.path,
      fields: fields
        .filter((f) => f.system_id === o.system_id && f.operation === o.operation)
        .map((f) => ({ name: f.name, label: f.label, hint: f.hint, place: f.place })),
      ...(o.undoes ? { undoes: o.undoes } : {}),
    });
    found.set(o.system_id, list);
  }
  return found;
}

function writeOperations(db: Db, systemId: string, operations: SystemOperation[]): void {
  run(db, "DELETE FROM system_operation_fields WHERE system_id = ?", systemId);
  run(db, "DELETE FROM system_operations WHERE system_id = ?", systemId);
  operations.forEach((operation, position) => {
    run(
      db,
      "INSERT INTO system_operations (system_id, operation, position, label, method, path, undoes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      systemId,
      operation.id,
      position,
      operation.label,
      operation.method,
      operation.path,
      operation.undoes ?? null,
    );
    operation.fields.forEach((field, at) => {
      run(
        db,
        "INSERT INTO system_operation_fields (system_id, operation, name, position, label, hint, place) VALUES (?, ?, ?, ?, ?, ?, ?)",
        systemId,
        operation.id,
        field.name,
        at,
        field.label,
        field.hint,
        field.place,
      );
    });
  });
}

/** The connected systems of an office, without their keys. */
export function systemViews(db: Db, officeId: string): SystemView[] {
  const operations = storedOperations(db);
  const shown = storedShownRooms(db);
  return rows(db, officeId).map((r) => {
    const key = unseal(r.api_key_cipher);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      operations: (operations.get(r.id) ?? []).map((o) => o.label),
      roomId: r.room_id,
      shownIn: shown.get(r.id) ?? [],
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
  /** Left empty, the system's own name is used. */
  name: string;
  /** When to use the system and how. Left empty, the system's own description is used. */
  description: string;
  /** The room it is operated from. */
  roomId: string;
  /** Further rooms whose readers are shown its records. Left out, they stay as they are. */
  shownIn?: string[];
  baseUrl: string;
  apiKey?: string;
  /** Hold each action an agent takes here until a person approves it. */
  needsApproval?: boolean;
  /** Ask the system again what can be done in it. */
  refresh?: boolean;
}

/** A checked change to a system, ready to be stored. */
export interface SystemChange {
  existingId: string | null;
  name: string;
  description: string;
  roomId: string;
  /** Null when the further rooms are left as they are. */
  shownIn: string[] | null;
  baseUrl: string;
  cipher: string;
  hint: string | null;
  needsApproval: boolean;
  /** Set when the system was asked about itself for this change. */
  manifest: ServiceManifest | null;
}

/**
 * Check a change to a system. A system being connected, moved to another
 * address or given a new key is asked to describe itself, which also proves
 * the address and the key work.
 */
export async function checkSystem(db: Db, office: Office, input: SystemInput): Promise<SystemChange> {
  const existing = input.id ? row(db, office.id, input.id) : undefined;
  if (input.id && !existing) throw new SystemError("That connected system does not exist in this office.");
  if (!existing && rows(db, office.id).length >= 12) throw new SystemError("An office can connect up to 12 systems.");
  const home = office.floorplan.rooms.find((r) => r.id === input.roomId);
  if (!home) throw new SystemError("That room does not exist.");
  if (home.corridor) throw new SystemError(`${home.name} is only for walking through, so no system is operated from it.`);
  const shownIn = input.shownIn ? [...new Set(input.shownIn)].filter((id) => id !== home.id) : null;
  for (const id of shownIn ?? []) {
    const room = office.floorplan.rooms.find((r) => r.id === id);
    if (!room) throw new SystemError("One of the rooms to show the records in does not exist.");
    if (room.corridor) throw new SystemError(`${room.name} is only for walking through, so nothing is shown there.`);
  }

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

  let name = input.name.trim();
  let description = input.description.trim();
  if (description.length > 1200) throw new SystemError("Keep the description under 1,200 characters.");

  const ask = !existing || existing.base_url !== baseUrl || Boolean(typed) || input.refresh === true || !name || !description;
  let manifest: ServiceManifest | null = null;
  if (ask) {
    const key = typed ?? unseal(cipher);
    if (!key) throw new SystemError("The stored API key cannot be read. Enter it again.");
    try {
      manifest = await fetchManifest(baseUrl, key);
    } catch (error) {
      throw new SystemError(`The system did not describe itself: ${error instanceof Error ? error.message : "it failed"}.`);
    }
    name ||= manifest.name;
    description ||= manifest.description;
  }
  if (name.length < 2 || name.length > 40) throw new SystemError("Give the system a name (2 to 40 characters).");
  if (description.length < 10) throw new SystemError("Describe when the system is used and how (at least 10 characters).");

  return {
    existingId: existing?.id ?? null,
    name,
    description,
    roomId: input.roomId,
    shownIn,
    baseUrl,
    cipher,
    hint,
    needsApproval: input.needsApproval ?? existing?.needs_approval === 1,
    manifest,
  };
}

/** Store a checked change. Returns the system's name for the activity log. */
export function storeSystem(db: Db, change: SystemChange): string {
  const id = change.existingId ?? `sys-${randomUUID().slice(0, 8)}`;
  if (change.existingId) {
    run(
      db,
      `UPDATE connected_systems
          SET name = ?, description = ?, room_id = ?, base_url = ?, api_key_cipher = ?, key_hint = ?, updated_at = ?,
              needs_approval = ?, records_path = COALESCE(?, records_path)
        WHERE id = ?`,
      change.name,
      change.description,
      change.roomId,
      change.baseUrl,
      change.cipher,
      change.hint,
      Date.now(),
      change.needsApproval ? 1 : 0,
      change.manifest?.recordsPath ?? null,
      id,
    );
  } else {
    const next = get<{ next: number }>(db, "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM connected_systems");
    run(
      db,
      `INSERT INTO connected_systems
         (id, room_id, position, name, description, records_path, base_url, api_key_cipher, key_hint, updated_at, needs_approval)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      change.roomId,
      next?.next ?? 0,
      change.name,
      change.description,
      change.manifest?.recordsPath ?? "/v1/summary",
      change.baseUrl,
      change.cipher,
      change.hint,
      Date.now(),
      change.needsApproval ? 1 : 0,
    );
  }
  if (change.manifest) writeOperations(db, id, change.manifest.operations);
  // The room it is operated from shows its records already.
  run(db, "DELETE FROM system_shown_rooms WHERE system_id = ? AND room_id = ?", id, change.roomId);
  if (change.shownIn) {
    run(db, "DELETE FROM system_shown_rooms WHERE system_id = ?", id);
    change.shownIn.forEach((room, position) =>
      run(db, "INSERT INTO system_shown_rooms (system_id, room_id, position) VALUES (?, ?, ?)", id, room, position),
    );
  }
  return change.name;
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
const str = (value: unknown): string => (typeof value === "string" || typeof value === "number" ? String(value) : "");

/** One HTTP call. Throws a plain sentence when the system does not answer. */
async function send(
  baseUrl: string,
  key: string,
  method: "GET" | SystemOperation["method"],
  path: string,
  body?: Json,
  idempotencyKey?: string,
): Promise<{ status: number; data: Json }> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
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

function call(system: SystemRow, method: "GET" | SystemOperation["method"], path: string, body?: Json, idempotencyKey?: string) {
  const key = unseal(system.api_key_cipher);
  if (!key) throw new Error("its API key cannot be read, so it has to be entered again");
  return send(system.base_url, key, method, path, body, idempotencyKey);
}

/** The system's own reason for refusing, as the end of a sentence. */
const reason = (data: Json, status: number): string =>
  (str(asObject(data.error).message).slice(0, 400) || `it answered with status ${status}`).replace(/[.\s]+$/, "");

/** Ask a system what it is for and what can be done in it. */
async function fetchManifest(baseUrl: string, key: string): Promise<ServiceManifest> {
  const { status, data } = await send(baseUrl, key, "GET", "/v1/manifest");
  if (status !== 200) throw new Error(reason(data, status));
  const manifest = parseManifest(data);
  if (!manifest) throw new Error("what it sent back at /v1/manifest is not a description of a system");
  return manifest;
}

/** How often each system has been asked again since this server started. A count of -1 means it answered. */
const asked = globalThis as unknown as { __systemsAsked?: Map<string, number> };
const ASK_AGAIN = 5;

/**
 * Ask each connected system once more what can be done in it, after the
 * server starts. A system gains operations over time, such as a way to take
 * something back, and the office otherwise knows only what the system said
 * on the day it was connected. One that does not answer is asked again on
 * later turns of the clock, a few times. Returns how many answered.
 */
export async function rereadOperations(db: Db): Promise<number> {
  const counts = (asked.__systemsAsked ??= new Map());
  let answered = 0;
  for (const system of all<SystemRow>(db, "SELECT * FROM connected_systems ORDER BY position")) {
    const tries = counts.get(system.id) ?? 0;
    if (tries < 0 || tries >= ASK_AGAIN) continue;
    counts.set(system.id, tries + 1);
    const key = unseal(system.api_key_cipher);
    if (!key) continue;
    try {
      const manifest = await fetchManifest(system.base_url, key);
      transaction(db, () => {
        // It may have been disconnected while it was being asked.
        if (get(db, "SELECT 1 AS found FROM connected_systems WHERE id = ?", system.id)) writeOperations(db, system.id, manifest.operations);
      });
      counts.set(system.id, -1);
      answered++;
    } catch {
      // Not reachable at the moment. It keeps the operations it has.
    }
  }
  return answered;
}

/** A system's records as it tells them: plain lines, capped in number and length. */
async function read(system: SystemRow): Promise<string[]> {
  const { status, data } = await call(system, "GET", system.records_path);
  if (status !== 200) throw new Error(reason(data, status));
  return (Array.isArray(data.lines) ? data.lines : [])
    .filter((line): line is string => typeof line === "string" && line.trim() !== "")
    .slice(0, 60)
    .map((line) => line.trim().slice(0, 400));
}

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

/** The same task asking for the same thing twice gets the same result back. */
const idempotencyKey = (action: SystemCall): string =>
  createHash("sha256")
    .update(JSON.stringify([action.taskId, action.system.id, action.operation, Object.entries(action.fields).sort()]))
    .digest("hex")
    .slice(0, 32);

/**
 * Carry out one operation the way the system says it is called: fields the
 * operation places in the path are filled in there, and the rest go in the
 * body. The system answers with a sentence saying what it did.
 */
async function performIn(system: SystemRow, action: SystemCall): Promise<SystemOutcome> {
  const operation = action.system.operations.find((o) => o.id === action.operation);
  if (!operation) return { ok: false, summary: `has no operation called ${action.operation}, so nothing was done.` };

  const path = operation.path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(action.fields[name] ?? ""));
  const body = Object.fromEntries(
    operation.fields.filter((f) => f.place === "body").map((f) => [f.name, action.fields[f.name] ?? ""]),
  );
  const { status, data } = await call(system, operation.method, path, body, idempotencyKey(action));
  if (status !== 200 && status !== 201) {
    return { ok: false, summary: `refused to ${operation.label.toLowerCase()}: ${reason(data, status)}.` };
  }
  const said = str(data.summary).trim().slice(0, 600);
  const record = str(data.record).trim().slice(0, 60);
  return { ok: true, summary: said || `answered that "${operation.label}" was done, with no detail.`, ...(record ? { record } : {}) };
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
 * The sample services, the room each belongs in, and the environment variable
 * that says where it runs. An order in the storefront waits for a person's
 * approval, so the demo shows that gate as well as the one on access.
 */
const SAMPLE_SERVICES = [
  { service: "storefront", demoId: DEMO_STOREFRONT_ID, room: "fulfilment", env: "DEMO_STOREFRONT_URL", approval: 1 },
  { service: "carrier", demoId: DEMO_CARRIER_ID, room: "planning", env: "DEMO_CARRIER_URL", approval: 0 },
  { service: "ledger", demoId: "sys-demo-ledger", room: "finance", env: "DEMO_LEDGER_URL", approval: 0 },
  { service: "supplier", demoId: "sys-demo-supplier", room: "operations", env: "DEMO_SUPPLIER_URL", approval: 0 },
  { service: "service-desk", demoId: "sys-demo-service-desk", room: "reception", env: "DEMO_SERVICE_DESK_URL", approval: 0 },
] as const;

type SampleService = (typeof SAMPLE_SERVICES)[number];

const sampleKey = (): string => process.env.DEMO_SYSTEMS_KEY?.trim() ?? "";
const sampleUrl = (sample: SampleService): string => (process.env[sample.env]?.trim() ?? "").replace(/\/+$/, "");

/**
 * Connect one sample service, or bring an existing connection up to date. Its
 * description and operations are read from the service's own source, so the
 * office does not have to reach it first.
 */
function connectSample(db: Db, sample: SampleService, id: string, roomId: string): void {
  const manifest = MANIFESTS[sample.service];
  const key = sampleKey();
  const position = get<{ next: number }>(db, "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM connected_systems");
  run(
    db,
    `INSERT INTO connected_systems
       (id, room_id, position, name, description, records_path, base_url, api_key_cipher, key_hint, updated_at, needs_approval)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       room_id = excluded.room_id, base_url = excluded.base_url, description = excluded.description,
       records_path = excluded.records_path, api_key_cipher = excluded.api_key_cipher, key_hint = excluded.key_hint,
       updated_at = excluded.updated_at, needs_approval = excluded.needs_approval`,
    id,
    roomId,
    position?.next ?? 0,
    manifest.name,
    manifest.description,
    manifest.recordsPath,
    sampleUrl(sample),
    seal(key),
    key.slice(-4),
    Date.now(),
    sample.approval,
  );
  writeOperations(db, id, manifest.operations);
}

/**
 * Connect the demo office to the systems named in the server's environment,
 * and disconnect it from any that are no longer named. The demo's playbook
 * steps that use those systems get their actions back if they have none.
 */
export function ensureDemoSystems(db: Db, demo: Office): void {
  for (const sample of SAMPLE_SERVICES) {
    const id = sample.demoId;
    if (!sampleUrl(sample) || sampleKey().length < 8 || !demo.floorplan.rooms.some((r) => r.id === sample.room)) {
      run(db, "DELETE FROM connected_systems WHERE id = ?", id);
      continue;
    }
    connectSample(db, sample, id, sample.room);
  }

  for (const seeded of seededOffice.participants) {
    for (const step of seeded.playbook) {
      const action = step.then.action;
      if (!action || !SAMPLE_SERVICES.some((sample) => sample.demoId === action.systemId)) continue;
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
 * Connect an office to the sample services named in the server's environment,
 * each in the room that suits it. Does nothing for a service that is not named.
 */
export function connectSampleServices(db: Db, suffix: string): void {
  if (sampleKey().length < 8) return;
  for (const sample of SAMPLE_SERVICES) {
    if (sampleUrl(sample)) connectSample(db, sample, `sys-${suffix}-${sample.service}`, `${sample.room}-${suffix}`);
  }
}
