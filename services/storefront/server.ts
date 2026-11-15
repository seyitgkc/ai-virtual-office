/**
 * A stand-in for a distributor's storefront: a catalogue with stock per
 * branch, and orders that draw that stock down. It runs as its own service
 * and keeps its data in memory, so a restart brings the sample data back.
 *
 *   GET  /health                   open, for container health checks
 *   GET  /v1/products              catalogue with stock per branch
 *   GET  /v1/orders                orders, newest first
 *   POST /v1/orders                { account, branch, items: [{ sku, quantity }] }
 *   POST /v1/orders/:id/cancel     returns the stock
 *
 * Every /v1 call needs "Authorization: Bearer <API_KEY>". A POST may carry an
 * Idempotency-Key header: the same key always returns the same order.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

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

class Refusal extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const send = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const readBody = (request: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    let text = "";
    request.on("data", (chunk) => {
      text += chunk;
      if (text.length > 20_000) reject(new Refusal(413, "too_large", "The request body is too large."));
    });
    request.on("end", () => {
      try {
        const parsed: unknown = text ? JSON.parse(text) : {};
        if (!parsed || typeof parsed !== "object") throw new Error("not an object");
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Refusal(400, "bad_json", "Send a JSON object."));
      }
    });
  });

/** Build the service. `apiKey` is the bearer key every /v1 call must carry. */
export function storefront(apiKey: string): Server {
  let products = catalogue();
  let orders: Order[] = [];
  let sequence = 1000;
  let byKey = new Map<string, string>();

  const reset = (): void => {
    products = catalogue();
    orders = [];
    sequence = 1000;
    byKey = new Map();
  };
  // Sample data comes back once a day, so shared use does not run it dry.
  setInterval(reset, 24 * 60 * 60 * 1000).unref();

  const branchOf = (name: string): string => {
    const known = Object.keys(products[0].stock);
    const found = known.find((b) => b.toLowerCase() === name.trim().toLowerCase());
    if (!found) throw new Refusal(422, "unknown_branch", `No branch called "${name}". Branches: ${known.join(", ")}.`);
    return found;
  };

  function placeOrder(body: Record<string, unknown>): Order {
    const account = typeof body.account === "string" ? body.account.trim() : "";
    if (!account) throw new Refusal(422, "missing_account", "An order needs an account.");
    const branch = branchOf(typeof body.branch === "string" ? body.branch : "");
    const raw = Array.isArray(body.items) ? body.items : [];
    if (raw.length === 0 || raw.length > 20) throw new Refusal(422, "bad_items", "An order needs 1 to 20 items.");

    const items = raw.map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      const sku = typeof item.sku === "string" ? item.sku.trim().toUpperCase() : "";
      const quantity = Number(item.quantity);
      const product = products.find((p) => p.sku === sku);
      if (!product) throw new Refusal(422, "unknown_sku", `No product with SKU "${sku}".`);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) {
        throw new Refusal(422, "bad_quantity", `The quantity for ${sku} must be a whole number from 1 to 500.`);
      }
      if (product.stock[branch] < quantity) {
        throw new Refusal(
          409,
          "insufficient_stock",
          `${branch} holds ${product.stock[branch]} of ${sku}; ${quantity} were ordered.`,
        );
      }
      return { product, quantity };
    });

    // Every line was checked before any stock moves, so an order is all or nothing.
    for (const { product, quantity } of items) product.stock[branch] -= quantity;
    const order: Order = {
      id: `SO-${++sequence}`,
      account,
      branch,
      items: items.map(({ product, quantity }) => ({ sku: product.sku, quantity })),
      total: items.reduce((sum, { product, quantity }) => sum + product.listPrice * quantity, 0),
      currency: "CAD",
      status: "placed",
      placedAt: new Date().toISOString(),
    };
    orders.unshift(order);
    return order;
  }

  function cancelOrder(id: string): Order {
    const order = orders.find((o) => o.id === id.toUpperCase());
    if (!order) throw new Refusal(404, "unknown_order", `No order ${id}.`);
    if (order.status === "cancelled") return order;
    for (const item of order.items) {
      const product = products.find((p) => p.sku === item.sku);
      if (product) product.stock[order.branch] += item.quantity;
    }
    order.status = "cancelled";
    return order;
  }

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://service");
      const route = `${request.method} ${url.pathname.replace(/\/+$/, "") || "/"}`;
      if (route === "GET /health") return send(response, 200, { ok: true, service: "storefront" });

      if (request.headers.authorization !== `Bearer ${apiKey}`) {
        throw new Refusal(401, "unauthorized", "Send the API key as a Bearer token.");
      }
      if (route === "GET /v1/products") return send(response, 200, { products });
      if (route === "GET /v1/orders") return send(response, 200, { orders: orders.slice(0, 50) });

      if (route === "POST /v1/orders") {
        const key = String(request.headers["idempotency-key"] ?? "");
        const earlier = key ? orders.find((o) => o.id === byKey.get(key)) : undefined;
        if (earlier) return send(response, 200, { order: earlier, repeated: true });
        const order = placeOrder(await readBody(request));
        if (key) byKey.set(key, order.id);
        return send(response, 201, { order });
      }

      const cancel = route.match(/^POST \/v1\/orders\/([\w-]+)\/cancel$/);
      if (cancel) return send(response, 200, { order: cancelOrder(cancel[1]) });

      throw new Refusal(404, "not_found", "No such endpoint.");
    } catch (error) {
      if (error instanceof Refusal) {
        return send(response, error.status, { error: { code: error.code, message: error.message } });
      }
      return send(response, 500, { error: { code: "internal", message: "The storefront failed." } });
    }
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  const apiKey = process.env.API_KEY ?? "";
  if (apiKey.length < 8) {
    console.error("Set API_KEY (at least 8 characters) before starting the storefront.");
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 8081);
  storefront(apiKey).listen(port, "0.0.0.0", () => console.log(`storefront listening on ${port}`));
}
