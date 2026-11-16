/**
 * A stand-in for an after-sales service desk: units in the field by serial
 * number, with their warranty, and the tickets, return authorizations and
 * technician visits raised against them. It keeps its data in memory, so a
 * restart brings the sample data back.
 *
 * Beyond what every sample service offers (see ../shared.ts):
 *   GET /v1/units     registered units
 *   GET /v1/tickets   tickets, newest first
 */
import type { Server } from "node:http";
import { SERVICE_DESK } from "../manifests.ts";
import { dayFromNow, need, Refusal, serve, startWhenRun, type Done, type Json } from "../shared.ts";

interface Unit {
  serial: string;
  sku: string;
  account: string;
  /** Days ago the unit was delivered. Kept relative so the sample data never ages. */
  deliveredDaysAgo: number;
}

interface Ticket {
  id: string;
  account: string;
  serial: string;
  problem: string;
  priority: "urgent" | "normal";
  status: "open" | "closed";
  returnNumber: string | null;
  visitOn: string | null;
  resolution: string | null;
}

const WARRANTY_MONTHS = 24;
const VISITS_PER_DAY = 2;

const fleet = (): Unit[] => [
  { serial: "GCU24-118204", sku: "GREE-CU-24", account: "CAL-3310", deliveredDaysAgo: 210 },
  { serial: "GCU24-090377", sku: "GREE-CU-24", account: "BRT-0931", deliveredDaysAgo: 940 },
  { serial: "GMZ12-204551", sku: "GREE-MZ-12", account: "NOR-0188", deliveredDaysAgo: 75 },
  { serial: "GMZ12-204552", sku: "GREE-MZ-12", account: "NOR-0188", deliveredDaysAgo: 75 },
  { serial: "PTAC12-33018", sku: "PTAC-12", account: "HAL-0077", deliveredDaysAgo: 700 },
  { serial: "PTAC12-33019", sku: "PTAC-12", account: "HAL-0077", deliveredDaysAgo: 760 },
  { serial: "ECO-T-771203", sku: "ECOBEE-T", account: "BRT-0931", deliveredDaysAgo: 30 },
];

const monthsSince = (days: number): number => Math.floor(days / 30.4);
const underWarranty = (unit: Unit): boolean => monthsSince(unit.deliveredDaysAgo) < WARRANTY_MONTHS;
/** Words that mean someone is without heating or cooling, or something is unsafe. */
const URGENT = /no heat|no cool|leak|smoke|burn|spark|trip|shut ?down|won'?t start|not start|dead/i;

/** Build the service. `apiKey` is the bearer key every /v1 call must carry. */
export function serviceDesk(apiKey: string): Server {
  let units = fleet();
  let tickets: Ticket[] = [];
  let ticketSequence = 4000;
  let returnSequence = 6000;

  const findTicket = (id: string): Ticket => {
    const ticket = tickets.find((t) => t.id === id.trim().toUpperCase());
    if (!ticket) throw new Refusal(404, "unknown_ticket", `No ticket ${id}.`);
    if (ticket.status === "closed") throw new Refusal(409, "closed", `${ticket.id} is closed. Open a new ticket for a new fault.`);
    return ticket;
  };
  const warranty = (unit: Unit): string =>
    underWarranty(unit)
      ? `under warranty, ${WARRANTY_MONTHS - monthsSince(unit.deliveredDaysAgo)} months left`
      : `out of warranty by ${monthsSince(unit.deliveredDaysAgo) - WARRANTY_MONTHS} months`;

  function open(input: Json): Done {
    const account = need(input, "account", "an account").toUpperCase();
    const serial = need(input, "serial", "the unit's serial number").toUpperCase();
    const problem = need(input, "problem", "what is wrong");
    const unit = units.find((u) => u.serial === serial);
    if (!unit) throw new Refusal(404, "unknown_serial", `No unit with serial ${serial} is registered. Check the number on the unit's plate.`);
    if (unit.account !== account) {
      throw new Refusal(409, "wrong_account", `Unit ${serial} was sold to ${unit.account}, so ${account} cannot raise a ticket for it.`);
    }
    const already = tickets.find((t) => t.serial === serial && t.status === "open");
    if (already) throw new Refusal(409, "ticket_open", `Unit ${serial} already has ${already.id} open: "${already.problem}". Use that ticket.`);

    const ticket: Ticket = {
      id: `TK-${++ticketSequence}`,
      account,
      serial,
      problem,
      priority: URGENT.test(problem) ? "urgent" : "normal",
      status: "open",
      returnNumber: null,
      visitOn: null,
      resolution: null,
    };
    tickets.unshift(ticket);
    return {
      summary: `opened ${ticket.id} (${ticket.priority}) for ${account} on unit ${serial}, a ${unit.sku} delivered ${monthsSince(unit.deliveredDaysAgo)} months ago and ${warranty(unit)}.`,
      ticket,
    };
  }

  function authorizeReturn(input: Json): Done {
    const ticket = findTicket(need(input, "ticket", "a ticket number"));
    const reason = need(input, "reason", "a reason");
    const unit = units.find((u) => u.serial === ticket.serial)!;
    if (ticket.returnNumber) throw new Refusal(409, "return_open", `${ticket.id} already has return ${ticket.returnNumber}.`);
    if (!underWarranty(unit)) {
      throw new Refusal(409, "out_of_warranty", `Unit ${unit.serial} is ${warranty(unit)}, so a return cannot be authorized. A paid repair visit can be scheduled on the ticket.`);
    }
    ticket.returnNumber = `RMA-${++returnSequence}`;
    return {
      summary: `authorized return ${ticket.returnNumber} on ${ticket.id} for unit ${unit.serial} (${reason}). The unit has to be back by ${dayFromNow(14)}, with the return number on the carton.`,
      ticket,
    };
  }

  function scheduleVisit(input: Json): Done {
    const ticket = findTicket(need(input, "ticket", "a ticket number"));
    const date = need(input, "date", "a date as YYYY-MM-DD");
    const day = new Date(`${date}T12:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(day.getTime())) {
      throw new Refusal(422, "bad_date", "Give the date as YYYY-MM-DD.");
    }
    if (date <= dayFromNow(0)) throw new Refusal(409, "too_soon", `A visit needs at least a day's notice. The earliest date is ${dayFromNow(1)}.`);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) throw new Refusal(409, "weekend", `${date} is a weekend. Technicians work Monday to Friday.`);
    const booked = tickets.filter((t) => t.visitOn === date && t.id !== ticket.id).length;
    if (booked >= VISITS_PER_DAY) throw new Refusal(409, "day_full", `${date} is fully booked (${VISITS_PER_DAY} visits). Try the next working day.`);

    const moved = ticket.visitOn;
    ticket.visitOn = date;
    const unit = units.find((u) => u.serial === ticket.serial)!;
    return {
      summary: `${moved ? `moved the visit on ${ticket.id} from ${moved} to ${date}` : `booked a technician for ${date} on ${ticket.id}`}, ${booked === 0 ? "morning" : "afternoon"} slot. ${underWarranty(unit) ? "The visit is covered by warranty." : "The unit is out of warranty, so the visit is chargeable."}`,
      ticket,
    };
  }

  function close(input: Json): Done {
    const ticket = findTicket(need(input, "ticket", "a ticket number"));
    ticket.resolution = need(input, "resolution", "how it was resolved");
    ticket.status = "closed";
    return { summary: `closed ${ticket.id}: ${ticket.resolution}.`, ticket };
  }

  return serve({
    apiKey,
    manifest: SERVICE_DESK,
    records: () => [
      `Warranty is ${WARRANTY_MONTHS} months from delivery. Technicians work Monday to Friday, ${VISITS_PER_DAY} visits a day, with a day's notice.`,
      ...units.map((u) => `Unit ${u.serial}: ${u.sku}, sold to ${u.account}, delivered ${monthsSince(u.deliveredDaysAgo)} months ago, ${warranty(u)}.`),
      ...tickets.slice(0, 8).map(
        (t) =>
          `Ticket ${t.id} (${t.status}, ${t.priority}): ${t.account}, unit ${t.serial}, "${t.problem}"${t.returnNumber ? `, return ${t.returnNumber}` : ""}${t.visitOn ? `, visit on ${t.visitOn}` : ""}${t.resolution ? `, resolved: ${t.resolution}` : ""}.`,
      ),
    ],
    operations: { open_ticket: open, authorize_return: authorizeReturn, schedule_visit: scheduleVisit, close_ticket: close },
    reads: { "/v1/units": () => ({ units }), "/v1/tickets": () => ({ tickets: tickets.slice(0, 50) }) },
    reset: () => {
      units = fleet();
      tickets = [];
      ticketSequence = 4000;
      returnSequence = 6000;
    },
  });
}

startWhenRun(import.meta.url, 8085, serviceDesk, "service desk");
