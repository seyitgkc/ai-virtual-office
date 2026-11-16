/**
 * A stand-in for a manufacturer's order desk: what each product costs, the
 * smallest order it takes, how long it ships in and how much it can ship now,
 * with the purchase orders raised against it. It keeps its data in memory, so
 * a restart brings the sample data back.
 *
 * Beyond what every sample service offers (see ../shared.ts):
 *   GET /v1/catalogue         products as the factory sells them
 *   GET /v1/purchase-orders   purchase orders, newest first
 */
import type { Server } from "node:http";
import { SUPPLIER } from "../manifests.ts";
import { cad, dayFromNow, need, needNumber, orNone, Refusal, serve, startWhenRun, type Done, type Json } from "../shared.ts";

interface Item {
  sku: string;
  name: string;
  unitCost: number;
  minimumOrder: number;
  caseSize: number;
  leadDays: number;
  /** Units the factory can ship in the next run. The rest waits for the one after. */
  ready: number;
  nextRunDays: number;
}

interface PurchaseOrder {
  id: string;
  sku: string;
  quantity: number;
  branch: string;
  shipsNow: number;
  arrivesOn: string;
  backordered: number;
  backorderArrivesOn: string | null;
  cost: number;
  expedited: boolean;
  status: "confirmed" | "cancelled";
}

const BRANCHES = ["Richmond Hill", "Laval", "Dartmouth", "Mississauga"];
const AIR_SURCHARGE = 0.18;
const AIR_DAYS = 6;

const catalogue = (): Item[] => [
  { sku: "GREE-MZ-12", name: "Gree multi-zone head, 12k BTU", unitCost: 790, minimumOrder: 6, caseSize: 2, leadDays: 28, ready: 40, nextRunDays: 56 },
  { sku: "GREE-CU-24", name: "Gree condenser, 24k BTU", unitCost: 1380, minimumOrder: 4, caseSize: 1, leadDays: 35, ready: 6, nextRunDays: 63 },
  { sku: "PTAC-12", name: "PTAC unit, 12k BTU", unitCost: 610, minimumOrder: 4, caseSize: 2, leadDays: 21, ready: 10, nextRunDays: 49 },
  { sku: "ECOBEE-T", name: "ecobee thermostat", unitCost: 142, minimumOrder: 20, caseSize: 10, leadDays: 14, ready: 400, nextRunDays: 28 },
];

/** Build the service. `apiKey` is the bearer key every /v1 call must carry. */
export function supplier(apiKey: string): Server {
  let items = catalogue();
  let orders: PurchaseOrder[] = [];
  let sequence = 7000;

  const findOrder = (id: string): PurchaseOrder => {
    const order = orders.find((o) => o.id === id.trim().toUpperCase());
    if (!order) throw new Refusal(404, "unknown_order", `No purchase order ${id}.`);
    return order;
  };

  function raise(input: Json): Done {
    const sku = need(input, "sku", "a product").toUpperCase();
    const item = items.find((i) => i.sku === sku);
    if (!item) throw new Refusal(422, "unknown_sku", `The factory does not make "${sku}". It makes: ${items.map((i) => i.sku).join(", ")}.`);
    const quantity = needNumber(input, "quantity", "The quantity", 1, 5000);
    if (!Number.isInteger(quantity)) throw new Refusal(422, "bad_quantity", "The quantity must be a whole number.");
    const wanted = need(input, "branch", "a branch to deliver to");
    const branch = BRANCHES.find((b) => b.toLowerCase() === wanted.toLowerCase());
    if (!branch) throw new Refusal(422, "unknown_branch", `No branch called "${wanted}". Branches: ${BRANCHES.join(", ")}.`);

    if (quantity < item.minimumOrder) {
      throw new Refusal(409, "below_minimum", `The smallest order for ${sku} is ${item.minimumOrder}; ${quantity} were asked for.`);
    }
    if (quantity % item.caseSize !== 0) {
      const down = quantity - (quantity % item.caseSize);
      throw new Refusal(409, "not_whole_cases", `${sku} ships in cases of ${item.caseSize}. Order ${down} or ${down + item.caseSize}.`);
    }

    // What the factory has ready goes now. The rest is confirmed for its next run.
    const shipsNow = Math.min(quantity, item.ready);
    const backordered = quantity - shipsNow;
    item.ready -= shipsNow;
    const order: PurchaseOrder = {
      id: `PO-${++sequence}`,
      sku,
      quantity,
      branch,
      shipsNow,
      arrivesOn: dayFromNow(item.leadDays),
      backordered,
      backorderArrivesOn: backordered > 0 ? dayFromNow(item.nextRunDays) : null,
      cost: quantity * item.unitCost,
      expedited: false,
      status: "confirmed",
    };
    orders.unshift(order);
    const split =
      backordered === 0
        ? `all ${quantity} arrive on ${order.arrivesOn}`
        : shipsNow === 0
          ? `none can ship from the current run, so all ${quantity} are backordered and arrive on ${order.backorderArrivesOn}`
          : `${shipsNow} arrive on ${order.arrivesOn} and ${backordered} are backordered until ${order.backorderArrivesOn}`;
    return { summary: `raised ${order.id} for ${quantity} x ${sku} to ${branch} at ${cad(order.cost)}: ${split}.`, record: order.id, order };
  }

  function expedite(input: Json): Done {
    const order = findOrder(need(input, "order", "a purchase order number"));
    if (order.status === "cancelled") throw new Refusal(409, "cancelled", `${order.id} is cancelled.`);
    if (order.expedited) throw new Refusal(409, "already_expedited", `${order.id} already travels by air and arrives on ${order.arrivesOn}.`);
    if (order.shipsNow === 0) {
      throw new Refusal(409, "nothing_to_expedite", `Nothing on ${order.id} is ready to ship: all ${order.quantity} wait for the factory's next run, which air freight cannot bring forward.`);
    }
    const surcharge = Math.round(order.shipsNow * (order.cost / order.quantity) * AIR_SURCHARGE * 100) / 100;
    order.expedited = true;
    order.arrivesOn = dayFromNow(AIR_DAYS);
    order.cost = Math.round((order.cost + surcharge) * 100) / 100;
    return {
      summary: `moved ${order.id} to air freight for a surcharge of ${cad(surcharge)}: ${order.shipsNow} x ${order.sku} now arrive on ${order.arrivesOn}${order.backordered > 0 ? `, and the ${order.backordered} backordered still arrive on ${order.backorderArrivesOn}` : ""}. The order now costs ${cad(order.cost)}.`,
      order,
    };
  }

  function cancel(input: Json): Done {
    const order = findOrder(need(input, "order", "a purchase order number"));
    if (order.status === "cancelled") return { summary: `${order.id} was already cancelled.`, record: order.id, order };
    if (order.expedited) {
      throw new Refusal(409, "in_the_air", `${order.id} was moved to air freight and has left the factory, so it can no longer be cancelled.`);
    }
    const item = items.find((i) => i.sku === order.sku);
    if (item) item.ready += order.shipsNow;
    order.status = "cancelled";
    return { summary: `cancelled ${order.id} for ${order.quantity} x ${order.sku}.`, record: order.id, order };
  }

  return serve({
    apiKey,
    manifest: SUPPLIER,
    records: () => [
      ...items.map(
        (i) =>
          `Product ${i.sku}, ${i.name}: ${cad(i.unitCost)} each at cost, smallest order ${i.minimumOrder}, cases of ${i.caseSize}, ${i.leadDays} days to arrive. ${i.ready} can ship from the current run; more follows in ${i.nextRunDays} days.`,
      ),
      ...orNone(
        orders.slice(0, 8).map(
        (o) =>
          `Purchase order ${o.id} (${o.status}${o.expedited ? ", by air" : ""}): ${o.quantity} x ${o.sku} to ${o.branch}, ${cad(o.cost)}. ${o.shipsNow} arrive on ${o.arrivesOn}${o.backordered > 0 ? `, ${o.backordered} backordered until ${o.backorderArrivesOn}` : ""}.`,
      ),
        "No purchase orders are on record.",
      ),
    ],
    operations: { raise_purchase_order: raise, expedite_order: expedite, cancel_purchase_order: cancel },
    reads: { "/v1/catalogue": () => ({ items }), "/v1/purchase-orders": () => ({ orders: orders.slice(0, 50) }) },
    reset: () => {
      items = catalogue();
      orders = [];
      sequence = 7000;
    },
  });
}

startWhenRun(import.meta.url, 8084, supplier, "supplier");
