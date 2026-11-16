/**
 * A stand-in for an accounts receivable ledger: dealer accounts with their
 * pricing tier, credit limit and balance, and the invoices and payments that
 * move that balance. It keeps its data in memory, so a restart brings the
 * sample data back.
 *
 * An invoice raised by mistake can be voided, which takes it off the balance.
 * A payment cannot be taken back here: that is a refund, made by a person.
 *
 * Beyond what every sample service offers (see ../shared.ts):
 *   GET /v1/accounts   the accounts
 *   GET /v1/invoices   invoices, newest first
 */
import type { Server } from "node:http";
import { LEDGER } from "../manifests.ts";
import { cad, dayFromNow, need, orNone, needNumber, Refusal, serve, startWhenRun, type Done, type Json } from "../shared.ts";

interface Account {
  id: string;
  name: string;
  tier: 1 | 2 | 3;
  creditLimit: number;
  balance: number;
  termsDays: number;
  latePayments: number;
  onHold: string | null;
}

interface Invoice {
  id: string;
  account: string;
  reference: string;
  listAmount: number;
  discount: number;
  freight: number;
  total: number;
  dueOn: string;
}

/** Share of list price taken off for each dealer tier. */
const DISCOUNT: Record<Account["tier"], number> = { 1: 0.12, 2: 0.18, 3: 0.22 };
/** An invoice this large needs a person's sign-off for a dealer with late payments. */
const SIGN_OFF_ABOVE = 5000;

const accounts = (): Account[] => [
  { id: "NOR-0188", name: "Northline Mechanical", tier: 2, creditLimit: 80_000, balance: 21_400, termsDays: 30, latePayments: 0, onHold: null },
  { id: "BRT-0931", name: "Brightline Mechanical", tier: 2, creditLimit: 40_000, balance: 6_100, termsDays: 30, latePayments: 0, onHold: null },
  { id: "CAL-3310", name: "Calder Heating", tier: 1, creditLimit: 15_000, balance: 9_200, termsDays: 30, latePayments: 2, onHold: null },
  { id: "HAL-2210", name: "Halden HVAC", tier: 1, creditLimit: 25_000, balance: 24_300, termsDays: 30, latePayments: 1, onHold: "Balance within 3 percent of the limit" },
  { id: "HAL-0077", name: "Halifax Harbour Hotels", tier: 3, creditLimit: 120_000, balance: 38_750, termsDays: 45, latePayments: 0, onHold: null },
];

const round = (amount: number): number => Math.round(amount * 100) / 100;

/** Build the service. `apiKey` is the bearer key every /v1 call must carry. */
export function ledger(apiKey: string): Server {
  let book = accounts();
  let invoices: Invoice[] = [];
  let voided: string[] = [];
  let payments: { id: string; account: string; amount: number; on: string; released: boolean }[] = [];
  let paid = 8000;
  let sequence = 3000;

  const find = (id: string): Account => {
    const account = book.find((a) => a.id === id.trim().toUpperCase());
    if (!account) throw new Refusal(404, "unknown_account", `No account ${id}. Accounts: ${book.map((a) => a.id).join(", ")}.`);
    return account;
  };
  const standing = (a: Account): string =>
    `${cad(a.balance)} owed of a ${cad(a.creditLimit)} limit, ${cad(round(a.creditLimit - a.balance))} free`;

  function raiseInvoice(input: Json): Done {
    const account = find(need(input, "account", "an account"));
    const reference = need(input, "reference", "the order number it is for").toUpperCase();
    const listAmount = needNumber(input, "listAmount", "The amount at list price", 0.01, 2_000_000);
    const freight = needNumber({ freight: input.freight ?? "0" }, "freight", "The freight amount", 0, 100_000);

    if (account.onHold) {
      throw new Refusal(409, "on_hold", `${account.id} is on credit hold (${account.onHold}). Nothing can be invoiced until the hold is released.`);
    }
    const earlier = invoices.find((i) => i.reference === reference);
    if (earlier) throw new Refusal(409, "already_invoiced", `${reference} was already invoiced as ${earlier.id} for ${cad(earlier.total)}.`);

    const discount = round(listAmount * DISCOUNT[account.tier]);
    const total = round(listAmount - discount + freight);
    if (account.balance + total > account.creditLimit) {
      const over = round(account.balance + total - account.creditLimit);
      throw new Refusal(409, "over_limit", `This invoice of ${cad(total)} would take ${account.id} ${cad(over)} past its credit limit. It has ${standing(account)}. A payment or a higher limit is needed first.`);
    }
    if (account.latePayments >= 2 && total > SIGN_OFF_ABOVE) {
      throw new Refusal(409, "needs_sign_off", `${account.id} has paid late ${account.latePayments} times this year, so an invoice above ${cad(SIGN_OFF_ABOVE)} needs a person's sign-off. This one is ${cad(total)}.`);
    }

    const invoice: Invoice = {
      id: `INV-${++sequence}`,
      account: account.id,
      reference,
      listAmount,
      discount,
      freight,
      total,
      dueOn: dayFromNow(account.termsDays),
    };
    invoices.unshift(invoice);
    account.balance = round(account.balance + total);
    return {
      summary: `raised invoice ${invoice.id} on ${account.id} for ${reference}: ${cad(listAmount)} at list less ${cad(discount)} for tier ${account.tier}${freight > 0 ? `, plus ${cad(freight)} freight` : ""}, ${cad(total)} due on ${invoice.dueOn}. The account now has ${standing(account)}.`,
      record: invoice.id,
      invoice,
    };
  }

  function voidInvoice(input: Json): Done {
    const id = need(input, "invoice", "an invoice number").toUpperCase();
    const reason = need(input, "reason", "a reason");
    const invoice = invoices.find((i) => i.id === id);
    if (!invoice) {
      const gone = voided.find((v) => v === id);
      if (gone) return { summary: `invoice ${id} was already voided.`, record: id };
      throw new Refusal(404, "unknown_invoice", `No invoice ${id}.`);
    }
    const account = find(invoice.account);
    invoices = invoices.filter((i) => i.id !== id);
    voided.push(id);
    account.balance = round(Math.max(0, account.balance - invoice.total));
    return {
      summary: `voided invoice ${invoice.id} for ${invoice.reference} (${reason}), taking ${cad(invoice.total)} off ${account.id}. The account now has ${standing(account)}.`,
      record: invoice.id,
      invoice,
    };
  }

  function recordPayment(input: Json): Done {
    const account = find(need(input, "account", "an account"));
    const amount = needNumber(input, "amount", "The payment amount", 0.01, 2_000_000);
    if (amount > account.balance) {
      throw new Refusal(409, "overpayment", `${account.id} owes ${cad(account.balance)}, so a payment of ${cad(amount)} is more than is due.`);
    }
    account.balance = round(account.balance - amount);
    // A hold placed for the balance lifts itself once there is room again.
    const released = account.onHold !== null && account.balance <= account.creditLimit * 0.8;
    if (released) account.onHold = null;
    payments.unshift({ id: `PAY-${++paid}`, account: account.id, amount, on: dayFromNow(0), released });
    return {
      record: `PAY-${paid}`,
      summary: `recorded a payment of ${cad(amount)} from ${account.id}. The account now has ${standing(account)}${released ? ", and its credit hold is released" : account.onHold ? ", and it is still on hold" : ""}.`,
      account,
    };
  }

  function setHold(input: Json): Done {
    const account = find(need(input, "account", "an account"));
    const wanted = need(input, "hold", "yes or no").toLowerCase();
    if (!["yes", "no", "true", "false", "on", "off"].includes(wanted)) {
      throw new Refusal(422, "bad_hold", 'Say "yes" to put the account on hold or "no" to release it.');
    }
    const hold = ["yes", "true", "on"].includes(wanted);
    const reason = need(input, "reason", "a reason");
    if (!hold && account.balance > account.creditLimit) {
      throw new Refusal(409, "still_over", `${account.id} is over its limit (${standing(account)}), so the hold cannot be released yet.`);
    }
    account.onHold = hold ? reason : null;
    return { summary: `${account.id} is ${hold ? `now on credit hold: ${reason}` : `released from credit hold: ${reason}`}.`, account };
  }

  return serve({
    apiKey,
    manifest: LEDGER,
    records: () => [
      "Dealer tier 1 takes 12 percent off list, tier 2 takes 18 percent, tier 3 takes 22 percent.",
      `A dealer with two or more late payments this year needs a person's sign-off for an invoice above ${cad(SIGN_OFF_ABOVE)}.`,
      ...book.map(
        (a) =>
          `Account ${a.id}, ${a.name}: tier ${a.tier}, net ${a.termsDays} days, ${standing(a)}, ${a.latePayments === 0 ? "pays on time" : `${a.latePayments} late payment${a.latePayments === 1 ? "" : "s"} this year`}${a.onHold ? `. ON CREDIT HOLD: ${a.onHold}` : ""}.`,
      ),
      ...orNone(
        invoices.slice(0, 8).map((i) => `Invoice ${i.id}: ${i.account}, for ${i.reference}, ${cad(i.total)} due on ${i.dueOn}.`),
        "No invoices are on record.",
      ),
      ...orNone(
        payments.slice(0, 8).map(
        (p) => `Payment ${p.id}: ${cad(p.amount)} from ${p.account} on ${p.on}${p.released ? ", which released its credit hold" : ""}.`,
      ),
        "No payments are on record.",
      ),
    ],
    operations: { raise_invoice: raiseInvoice, void_invoice: voidInvoice, record_payment: recordPayment, set_credit_hold: setHold },
    reads: { "/v1/accounts": () => ({ accounts: book }), "/v1/invoices": () => ({ invoices: invoices.slice(0, 50) }) },
    reset: () => {
      book = accounts();
      invoices = [];
      voided = [];
      payments = [];
      sequence = 3000;
      paid = 8000;
    },
  });
}

startWhenRun(import.meta.url, 8083, ledger, "ledger");
