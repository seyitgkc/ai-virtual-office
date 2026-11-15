/**
 * A stand-in for a freight carrier: service levels with rates, and shipment
 * bookings. It runs as its own service and keeps its data in memory, so a
 * restart clears the bookings.
 *
 *   GET  /health                      open, for container health checks
 *   GET  /v1/services                 service levels and how each is priced
 *   GET  /v1/rates?weightKg=120       a quote per service level
 *   GET  /v1/shipments                bookings, newest first
 *   POST /v1/shipments                { reference, from, to, weightKg, service }
 *   POST /v1/shipments/:id/cancel
 *
 * Every /v1 call needs "Authorization: Bearer <API_KEY>". A POST may carry an
 * Idempotency-Key header: the same key always returns the same booking.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

interface ServiceLevel {
  code: string;
  name: string;
  transitDays: number;
  baseCharge: number;
  perKg: number;
  currency: "CAD";
}

interface Shipment {
  id: string;
  tracking: string;
  reference: string;
  from: string;
  to: string;
  weightKg: number;
  service: string;
  cost: number;
  currency: "CAD";
  transitDays: number;
  status: "booked" | "cancelled";
  bookedAt: string;
}

const SERVICES: ServiceLevel[] = [
  { code: "ground", name: "Ground", transitDays: 3, baseCharge: 45, perKg: 0.9, currency: "CAD" },
  { code: "express", name: "Express", transitDays: 1, baseCharge: 80, perKg: 1.6, currency: "CAD" },
  { code: "freight", name: "Pallet freight", transitDays: 5, baseCharge: 160, perKg: 0.45, currency: "CAD" },
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

const costOf = (level: ServiceLevel, weightKg: number): number =>
  Math.round((level.baseCharge + level.perKg * weightKg) * 100) / 100;

const weightOf = (value: unknown): number => {
  const weight = Number(value);
  if (!Number.isFinite(weight) || weight <= 0 || weight > 20_000) {
    throw new Refusal(422, "bad_weight", "The weight must be a number of kilograms from 0 to 20000.");
  }
  return weight;
};

/** Build the service. `apiKey` is the bearer key every /v1 call must carry. */
export function carrier(apiKey: string): Server {
  let shipments: Shipment[] = [];
  let sequence = 5000;
  let byKey = new Map<string, string>();

  // Bookings are cleared once a day, so shared use does not pile them up.
  setInterval(() => {
    shipments = [];
    sequence = 5000;
    byKey = new Map();
  }, 24 * 60 * 60 * 1000).unref();

  function book(body: Record<string, unknown>): Shipment {
    const field = (name: string): string => {
      const value = typeof body[name] === "string" ? (body[name] as string).trim() : "";
      if (!value) throw new Refusal(422, `missing_${name}`, `A booking needs "${name}".`);
      return value.slice(0, 80);
    };
    const reference = field("reference");
    const from = field("from");
    const to = field("to");
    const weightKg = weightOf(body.weightKg);
    const wanted = field("service").toLowerCase();
    const level = SERVICES.find((s) => s.code === wanted || s.name.toLowerCase() === wanted);
    if (!level) {
      throw new Refusal(422, "unknown_service", `No service "${wanted}". Services: ${SERVICES.map((s) => s.code).join(", ")}.`);
    }
    const shipment: Shipment = {
      id: `SH-${++sequence}`,
      tracking: `TRK${String(sequence).padStart(9, "0")}CA`,
      reference,
      from,
      to,
      weightKg,
      service: level.code,
      cost: costOf(level, weightKg),
      currency: "CAD",
      transitDays: level.transitDays,
      status: "booked",
      bookedAt: new Date().toISOString(),
    };
    shipments.unshift(shipment);
    return shipment;
  }

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://service");
      const route = `${request.method} ${url.pathname.replace(/\/+$/, "") || "/"}`;
      if (route === "GET /health") return send(response, 200, { ok: true, service: "carrier" });

      if (request.headers.authorization !== `Bearer ${apiKey}`) {
        throw new Refusal(401, "unauthorized", "Send the API key as a Bearer token.");
      }
      if (route === "GET /v1/services") return send(response, 200, { services: SERVICES });
      if (route === "GET /v1/shipments") return send(response, 200, { shipments: shipments.slice(0, 50) });
      if (route === "GET /v1/rates") {
        const weightKg = weightOf(url.searchParams.get("weightKg"));
        return send(response, 200, {
          weightKg,
          rates: SERVICES.map((s) => ({ service: s.code, cost: costOf(s, weightKg), currency: s.currency, transitDays: s.transitDays })),
        });
      }

      if (route === "POST /v1/shipments") {
        const key = String(request.headers["idempotency-key"] ?? "");
        const earlier = key ? shipments.find((s) => s.id === byKey.get(key)) : undefined;
        if (earlier) return send(response, 200, { shipment: earlier, repeated: true });
        const shipment = book(await readBody(request));
        if (key) byKey.set(key, shipment.id);
        return send(response, 201, { shipment });
      }

      const cancel = route.match(/^POST \/v1\/shipments\/([\w-]+)\/cancel$/);
      if (cancel) {
        const shipment = shipments.find((s) => s.id === cancel[1].toUpperCase());
        if (!shipment) throw new Refusal(404, "unknown_shipment", `No shipment ${cancel[1]}.`);
        shipment.status = "cancelled";
        return send(response, 200, { shipment });
      }

      throw new Refusal(404, "not_found", "No such endpoint.");
    } catch (error) {
      if (error instanceof Refusal) {
        return send(response, error.status, { error: { code: error.code, message: error.message } });
      }
      return send(response, 500, { error: { code: "internal", message: "The carrier failed." } });
    }
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  const apiKey = process.env.API_KEY ?? "";
  if (apiKey.length < 8) {
    console.error("Set API_KEY (at least 8 characters) before starting the carrier.");
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 8082);
  carrier(apiKey).listen(port, "0.0.0.0", () => console.log(`carrier listening on ${port}`));
}
