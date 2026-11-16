/**
 * A stand-in for a freight carrier: service levels with rates, and shipment
 * bookings. It keeps its data in memory, so a restart clears the bookings.
 *
 * Beyond what every sample service offers (see ../shared.ts):
 *   GET /v1/services               service levels and how each is priced
 *   GET /v1/rates?weightKg=120     a quote per service level
 *   GET /v1/shipments              bookings, newest first
 */
import type { Server } from "node:http";
import { CARRIER } from "../manifests.ts";
import { cad, count, need, orNone, needNumber, Refusal, serve, startWhenRun, type Done, type Json } from "../shared.ts";

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

const costOf = (level: ServiceLevel, weightKg: number): number =>
  Math.round((level.baseCharge + level.perKg * weightKg) * 100) / 100;

/** Build the service. `apiKey` is the bearer key every /v1 call must carry. */
export function carrier(apiKey: string): Server {
  let shipments: Shipment[] = [];
  let sequence = 5000;

  function book(input: Json): Done {
    const reference = need(input, "reference", "a reference");
    const from = need(input, "from", "where it ships from");
    const to = need(input, "to", "where it ships to");
    const weightKg = needNumber(input, "weightKg", "The weight in kilograms", 0.1, 20_000);
    const wanted = need(input, "service", "a service level").toLowerCase();
    const level = SERVICES.find((s) => s.code === wanted || s.name.toLowerCase() === wanted);
    if (!level) {
      throw new Refusal(422, "unknown_service", `No service "${wanted}". Services: ${SERVICES.map((s) => s.code).join(", ")}.`);
    }
    // Parcels have a weight ceiling. Anything heavier travels on a pallet.
    if (level.code !== "freight" && weightKg > 500) {
      throw new Refusal(409, "too_heavy", `${level.name} takes up to 500 kg; this is ${weightKg} kg. Book it as pallet freight.`);
    }
    if (shipments.some((s) => s.status === "booked" && s.reference === reference)) {
      const existing = shipments.find((s) => s.status === "booked" && s.reference === reference)!;
      throw new Refusal(409, "already_booked", `${reference} already travels on shipment ${existing.id}. Cancel that one first to rebook it.`);
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
    return {
      summary: `booked shipment ${shipment.id} for ${reference}: ${from} to ${to}, ${weightKg} kg by ${level.code}, ${cad(shipment.cost)}, ${count(level.transitDays, "day")} in transit, tracking ${shipment.tracking}.`,
      shipment,
    };
  }

  function cancel(input: Json): Done {
    const id = need(input, "shipment", "a shipment number").toUpperCase();
    const shipment = shipments.find((s) => s.id === id);
    if (!shipment) throw new Refusal(404, "unknown_shipment", `No shipment ${id}.`);
    shipment.status = "cancelled";
    return { summary: `cancelled shipment ${shipment.id}.`, shipment };
  }

  return serve({
    apiKey,
    manifest: CARRIER,
    records: () => [
      ...SERVICES.map(
        (s) => `Service "${s.code}" (${s.name}): ${cad(s.baseCharge)} plus ${cad(s.perKg)} per kg, ${count(s.transitDays, "day")} in transit.`,
      ),
      ...orNone(
        shipments.slice(0, 8).map(
        (s) => `Shipment ${s.id} (${s.status}): reference ${s.reference}, ${s.from} to ${s.to}, ${s.weightKg} kg by ${s.service}, ${cad(s.cost)}.`,
      ),
        "No shipments are on record.",
      ),
    ],
    operations: { book_shipment: book, cancel_shipment: cancel },
    reads: {
      "/v1/services": () => ({ services: SERVICES }),
      "/v1/shipments": () => ({ shipments: shipments.slice(0, 50) }),
      "/v1/rates": (query) => {
        const weightKg = needNumber({ weightKg: query.get("weightKg") ?? "" }, "weightKg", "The weight in kilograms", 0.1, 20_000);
        return {
          weightKg,
          rates: SERVICES.map((s) => ({ service: s.code, cost: costOf(s, weightKg), currency: s.currency, transitDays: s.transitDays })),
        };
      },
    },
    reset: () => {
      shipments = [];
      sequence = 5000;
    },
  });
}

startWhenRun(import.meta.url, 8082, carrier, "carrier");
