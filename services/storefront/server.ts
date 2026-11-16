/**
 * A stand-in for a distributor's storefront: a catalogue with stock per
 * branch, and orders that draw that stock down. It keeps its data in memory,
 * so a restart brings the sample data back.
 *
 * Beyond what every sample service offers (see ../shared.ts):
 *   GET /v1/products   the catalogue with stock per branch
 *   GET /v1/orders     orders, newest first
 */
import type { Server } from "node:http";
import { STOREFRONT } from "../manifests.ts";
import { cad, need, orNone, Refusal, serve, startWhenRun, type Done, type Json } from "../shared.ts";

interface Product {
  sku: string;
  name: string;
  listPrice: number;
  currency: "CAD";
  weightKg: number;
  stock: Record<string, number>;
}

interface Order {
  id: string;
  account: string;
  branch: string;
  items: { sku: string; quantity: number }[];
  total: number;
  currency: "CAD";
  status: "placed" | "cancelled";
  placedAt: string;
}

const catalogue = (): Product[] => [
  {
    sku: "GREE-MZ-12",
    name: "Gree multi-zone head, 12k BTU",
    listPrice: 1240,
    currency: "CAD",
    weightKg: 11,
    stock: { "Richmond Hill": 4, Laval: 120, Dartmouth: 0, Mississauga: 6 },
  },
  {
    sku: "GREE-CU-24",
    name: "Gree condenser, 24k BTU",
    listPrice: 2150,
    currency: "CAD",
    weightKg: 52,
    stock: { "Richmond Hill": 3, Laval: 5, Dartmouth: 1, Mississauga: 2 },
  },
  {
    sku: "PTAC-12",
    name: "PTAC unit, 12k BTU",
    listPrice: 980,
    currency: "CAD",
    weightKg: 48,
    stock: { "Richmond Hill": 2, Laval: 4, Dartmouth: 0, Mississauga: 0 },
  },
  {
    sku: "ECOBEE-T",
    name: "ecobee thermostat",
    listPrice: 229,
    currency: "CAD",
    weightKg: 0.5,
    stock: { "Richmond Hill": 120, Laval: 60, Dartmouth: 15, Mississauga: 40 },
  },
];

/** Read order lines given as a list, or as text such as "GREE-MZ-12 x 6; ECOBEE-T x 2". */
function readItems(value: unknown): { sku: string; quantity: number }[] {
  const parts: unknown[] = Array.isArray(value) ? value : String(value ?? "").split(/[;,\n]+/);
  const items = parts
    .map((part) => {
      if (part && typeof part === "object") {
        const item = part as Json;
        return { sku: String(item.sku ?? "").trim().toUpperCase(), quantity: Number(item.quantity) };
      }
      const text = String(part).trim();
      const skuFirst = text.match(/^([A-Za-z][\w-]*)\s*(?:x|\*|:|×)?\s*(\d+)$/i);
      const countFirst = text.match(/^(\d+)\s*(?:x|\*|×)?\s*([A-Za-z][\w-]*)$/i);
      if (skuFirst) return { sku: skuFirst[1].toUpperCase(), quantity: Number(skuFirst[2]) };
      if (countFirst) return { sku: countFirst[2].toUpperCase(), quantity: Number(countFirst[1]) };
      return text ? { sku: text, quantity: NaN } : null;
    })
    .filter((item): item is { sku: string; quantity: number } => item !== null);
  if (items.length === 0 || items.length > 20) throw new Refusal(422, "bad_items", "An order needs 1 to 20 items.");
  return items;
}

/** Build the service. `apiKey` is the bearer key every /v1 call must carry. */
export function storefront(apiKey: string): Server {
  let products = catalogue();
  let orders: Order[] = [];
  let sequence = 1000;

  const branchOf = (name: string): string => {
    const known = Object.keys(products[0].stock);
    const found = known.find((b) => b.toLowerCase() === name.trim().toLowerCase());
    if (!found) throw new Refusal(422, "unknown_branch", `No branch called "${name}". Branches: ${known.join(", ")}.`);
    return found;
  };
  const describe = (order: Order): string =>
    `for account ${order.account} from ${order.branch}: ${order.items.map((i) => `${i.quantity} x ${i.sku}`).join(", ")}, ${cad(order.total)} at list price`;

  function placeOrder(input: Json): Done {
    const account = need(input, "account", "an account");
    const branch = branchOf(need(input, "branch", "a ship-from branch"));
    const lines = readItems(input.items).map(({ sku, quantity }) => {
      const product = products.find((p) => p.sku === sku);
      if (!product) throw new Refusal(422, "unknown_sku", `No product with SKU "${sku}".`);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) {
        throw new Refusal(422, "bad_quantity", `The quantity for ${sku} must be a whole number from 1 to 500.`);
      }
      if (product.stock[branch] < quantity) {
        throw new Refusal(409, "insufficient_stock", `${branch} holds ${product.stock[branch]} of ${sku}; ${quantity} were ordered.`);
      }
      return { product, quantity };
    });

    // Every line was checked before any stock moves, so an order is all or nothing.
    for (const { product, quantity } of lines) product.stock[branch] -= quantity;
    const order: Order = {
      id: `SO-${++sequence}`,
      account,
      branch,
      items: lines.map(({ product, quantity }) => ({ sku: product.sku, quantity })),
      total: lines.reduce((sum, { product, quantity }) => sum + product.listPrice * quantity, 0),
      currency: "CAD",
      status: "placed",
      placedAt: new Date().toISOString(),
    };
    orders.unshift(order);
    return { summary: `placed order ${order.id} ${describe(order)}.`, order };
  }

  function cancelOrder(input: Json): Done {
    const id = need(input, "order", "an order number").toUpperCase();
    const order = orders.find((o) => o.id === id);
    if (!order) throw new Refusal(404, "unknown_order", `No order ${id}.`);
    if (order.status === "placed") {
      for (const item of order.items) {
        const product = products.find((p) => p.sku === item.sku);
        if (product) product.stock[order.branch] += item.quantity;
      }
      order.status = "cancelled";
    }
    return { summary: `cancelled order ${order.id} and returned its stock to ${order.branch}.`, order };
  }

  return serve({
    apiKey,
    manifest: STOREFRONT,
    records: () => [
      ...products.map((p) => {
        const stock = Object.entries(p.stock).map(([branch, quantity]) => `${branch} ${quantity}`).join(", ");
        return `Product ${p.sku}, ${p.name}: list price ${cad(p.listPrice)}, ${p.weightKg} kg each. In stock: ${stock}.`;
      }),
      ...orNone(
        orders.slice(0, 8).map((o) => `Order ${o.id} (${o.status}) ${describe(o)}.`),
        "No orders are on record.",
      ),
    ],
    operations: { place_order: placeOrder, cancel_order: cancelOrder },
    reads: { "/v1/products": () => ({ products }), "/v1/orders": () => ({ orders: orders.slice(0, 50) }) },
    reset: () => {
      products = catalogue();
      orders = [];
      sequence = 1000;
    },
  });
}

startWhenRun(import.meta.url, 8081, storefront, "storefront");
