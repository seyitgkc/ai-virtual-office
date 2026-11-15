/**
 * Outside systems a room can be connected to, and what an agent may do in
 * each. A connected system belongs to one room, and the room's access rules
 * cover it: `read` on the room shows the system's live records, and `act` on
 * the room allows its operations.
 */
import type { RoomId } from "./model";

export const SYSTEM_KINDS = ["storefront", "carrier"] as const;
export type SystemKind = (typeof SYSTEM_KINDS)[number];

/** A connected system as the office knows it. Its address and key stay on the server. */
export interface ConnectedSystem {
  id: string;
  name: string;
  kind: SystemKind;
  roomId: RoomId;
}

export interface SystemOperation {
  id: string;
  label: string;
  /** Every field must be filled in for the operation to be carried out. */
  fields: { name: string; label: string; hint: string }[];
}

export const SYSTEM_INFO: Record<SystemKind, { label: string; description: string; operations: SystemOperation[] }> = {
  storefront: {
    label: "Storefront",
    description: "Catalogue, stock per branch and orders.",
    operations: [
      {
        id: "place_order",
        label: "Place an order",
        fields: [
          { name: "account", label: "Account", hint: "NOR-0188" },
          { name: "branch", label: "Ship-from branch", hint: "Laval" },
          { name: "items", label: "Items", hint: "GREE-MZ-12 x 6; ECOBEE-T x 2" },
        ],
      },
      {
        id: "cancel_order",
        label: "Cancel an order",
        fields: [{ name: "order", label: "Order number", hint: "SO-1001" }],
      },
    ],
  },
  carrier: {
    label: "Freight carrier",
    description: "Service levels, rates and shipment bookings.",
    operations: [
      {
        id: "book_shipment",
        label: "Book a shipment",
        fields: [
          { name: "reference", label: "Reference", hint: "SO-1001" },
          { name: "from", label: "From", hint: "Laval" },
          { name: "to", label: "To", hint: "Richmond Hill" },
          { name: "weightKg", label: "Weight (kg)", hint: "66" },
          { name: "service", label: "Service", hint: "ground" },
        ],
      },
      {
        id: "cancel_shipment",
        label: "Cancel a shipment",
        fields: [{ name: "shipment", label: "Shipment number", hint: "SH-5001" }],
      },
    ],
  },
};

export const operationOf = (kind: SystemKind, id: string): SystemOperation | undefined =>
  SYSTEM_INFO[kind].operations.find((o) => o.id === id);

/** Something an agent wants done in a connected system. */
export interface SystemAction {
  systemId: string;
  operation: string;
  fields: Record<string, string>;
}

/**
 * Keep only the fields an operation takes, trimmed. Returns null when the
 * operation does not exist for this kind of system or a field is empty.
 */
export function checkedFields(
  kind: SystemKind,
  operation: string,
  fields: Record<string, string>,
): Record<string, string> | null {
  const known = operationOf(kind, operation);
  if (!known) return null;
  const kept: Record<string, string> = {};
  for (const field of known.fields) {
    const value = (fields[field.name] ?? "").trim().slice(0, 200);
    if (!value) return null;
    kept[field.name] = value;
  }
  return kept;
}
