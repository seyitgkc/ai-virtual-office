/**
 * Outside systems a room can be connected to, and what an agent may do in
 * each. A connected system belongs to one room, and the room's access rules
 * cover it: `read` on the room shows the system's live records, and `act` on
 * the room allows its operations.
 *
 * The office knows nothing about any particular system. A system says what
 * it is for and what can be done in it, in a manifest it serves itself, and a
 * person can reword the description that agents are given.
 */
import type { RoomId } from "./model";

/** One value an operation takes. It travels in the path or in the body of the call. */
export interface SystemField {
  name: string;
  label: string;
  /** An example value, shown to people and to agents. */
  hint: string;
  place: "path" | "body";
}

/** One thing that can be done in a system. */
export interface SystemOperation {
  id: string;
  label: string;
  method: "POST" | "PUT" | "DELETE";
  /** The path of the call. A field placed in the path appears as {name}. */
  path: string;
  /** Every field must be filled in for the operation to be carried out. */
  fields: SystemField[];
}

/** What a system says about itself. Served by the system at /v1/manifest. */
export interface ServiceManifest {
  name: string;
  /** When to use the system and how, written for whoever will use it. */
  description: string;
  /** Where the system's current records are read from, as plain lines. */
  recordsPath: string;
  operations: SystemOperation[];
}

/** Every room whose readers are shown a system's records. */
export const roomsShowing = (system: { roomId: RoomId; shownIn: RoomId[] }): RoomId[] => [system.roomId, ...system.shownIn];

/** A connected system as the office knows it. Its address and key stay on the server. */
export interface ConnectedSystem {
  id: string;
  name: string;
  /** The room it is operated from: acting in it takes `act` on this room. */
  roomId: RoomId;
  /**
   * Further rooms whose readers are shown its records. Nobody may act in it
   * from these, so a denial on the room it is operated from still holds.
   */
  shownIn: RoomId[];
  /** When to use it and how. Agents are given this, and a person can reword it. */
  description: string;
  operations: SystemOperation[];
  /**
   * When set, an agent that is allowed to act here still has each action
   * held until a person approves it.
   */
  needsApproval: boolean;
}

/** The two answers offered when an agent asks to act in a system. */
export const APPROVE = "Approve";
export const DECLINE = "Decline";

export const operationOf = (system: Pick<ConnectedSystem, "operations">, id: string): SystemOperation | undefined =>
  system.operations.find((o) => o.id === id);

/** Something an agent wants done in a connected system. */
export interface SystemAction {
  systemId: string;
  operation: string;
  fields: Record<string, string>;
}

/**
 * Keep only the fields an operation takes, trimmed. Returns null when the
 * system has no such operation or a field is empty.
 */
export function checkedFields(
  system: Pick<ConnectedSystem, "operations">,
  operation: string,
  fields: Record<string, string>,
): Record<string, string> | null {
  const known = operationOf(system, operation);
  if (!known) return null;
  const kept: Record<string, string> = {};
  for (const field of known.fields) {
    const value = (fields[field.name] ?? "").trim().slice(0, 200);
    if (!value) return null;
    kept[field.name] = value;
  }
  return kept;
}

const text = (value: unknown, max: number): string => (typeof value === "string" ? value.trim().slice(0, max) : "");
const SAFE_PATH = /^\/[\w\-./{}]{0,120}$/;
const SAFE_NAME = /^[A-Za-z][\w]{0,39}$/;

/**
 * Read a manifest a system served, keeping only what is well formed. Returns
 * null when it is not a manifest at all. Sizes are capped, because the text
 * ends up in front of a model.
 */
export function parseManifest(input: unknown): ServiceManifest | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const name = text(raw.name, 40);
  const recordsPath = text(raw.recordsPath, 120);
  if (!name || !SAFE_PATH.test(recordsPath) || !Array.isArray(raw.operations)) return null;

  const operations: SystemOperation[] = [];
  for (const entry of raw.operations.slice(0, 12)) {
    const o = (entry ?? {}) as Record<string, unknown>;
    const id = text(o.id, 40);
    const path = text(o.path, 120);
    const method = text(o.method, 10).toUpperCase();
    if (!SAFE_NAME.test(id) || !SAFE_PATH.test(path)) continue;
    if (method !== "POST" && method !== "PUT" && method !== "DELETE") continue;
    const fields: SystemField[] = [];
    for (const f of Array.isArray(o.fields) ? o.fields.slice(0, 8) : []) {
      const field = (f ?? {}) as Record<string, unknown>;
      const fieldName = text(field.name, 40);
      if (!SAFE_NAME.test(fieldName) || fields.some((x) => x.name === fieldName)) continue;
      const place = field.place === "path" ? "path" : "body";
      // A field said to be in the path has to appear there.
      if (place === "path" && !path.includes(`{${fieldName}}`)) continue;
      fields.push({ name: fieldName, label: text(field.label, 40) || fieldName, hint: text(field.hint, 80), place });
    }
    if (operations.some((x) => x.id === id)) continue;
    operations.push({ id, label: text(o.label, 60) || id, method, path, fields });
  }
  return { name, description: text(raw.description, 1200), recordsPath, operations };
}
