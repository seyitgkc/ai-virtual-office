import type { RoomId } from "./model";

/**
 * Business records kept in each room. All of it is invented for the demo.
 *
 * A record is only ever shown to someone who holds `read` on its room: an
 * agent's prompt, and the room thread endpoint, both go through the access
 * model before including any of this.
 */
export const ROOM_RECORDS: Record<RoomId, string[]> = {
  reception: [
    "Account NOR-0188: Northline Mechanical, service address Richmond Hill, primary contact site supervisor.",
    "Account BRC-0412: Brossard Climatisation, service address Laval.",
    "Account HAL-0077: Halifax Harbour Hotels, service address Dartmouth.",
    "Open dealer requests are answered within one working day.",
  ],
  planning: [
    "Standard lead time is five working days from order confirmation unless a contract says otherwise.",
    "Orders that need stock from two branches ship as split-origin unless the dealer objects.",
    "Inter-branch transfers leave on Tuesdays and Fridays.",
  ],
  fulfilment: [
    "Gree multi-zone head, 12k BTU: Richmond Hill 4, Laval 9, Dartmouth 0, Mississauga 6.",
    "PTAC unit, 12k BTU: Laval 4, Dartmouth 0, Richmond Hill 2.",
    "ecobee thermostat: Richmond Hill 120, Laval 60.",
    "Next inbound container at Laval is due in nine days.",
  ],
  finance: [
    "NOR-0188 is on dealer tier 2: 18 percent off list, net 30.",
    "BRC-0412 is on dealer tier 1: 12 percent off list, net 30.",
    "HAL-0077 is on dealer tier 3: 22 percent off list, net 45.",
    "NOR-0188 credit standing is good, limit 80,000 CAD, 21,400 CAD used.",
    "Gree multi-zone head, 12k BTU: list price 1,240 CAD, landed cost 790 CAD.",
  ],
  operations: [
    "Quotes above 25,000 CAD need the operations manager's approval.",
    "A fulfilment agent may read Finance only under a grant scoped to one task.",
  ],
};
