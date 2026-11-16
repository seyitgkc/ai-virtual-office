/**
 * What each sample service says about itself. A service serves its entry at
 * /v1/manifest. The office also reads these directly for the offices it sets
 * up itself, so they are connected before any service has been asked.
 */
import type { Manifest } from "./shared.ts";

const body = (name: string, label: string, hint: string) => ({ name, label, hint, place: "body" as const });
const inPath = (name: string, label: string, hint: string) => ({ name, label, hint, place: "path" as const });

export const STOREFRONT: Manifest = {
  name: "Storefront",
  description:
    "The catalogue, the stock each branch holds, and dealer orders. Use it to see what is in stock where and what has been ordered, and to place or cancel a dealer order. An order ships from one branch and is refused if that branch does not hold every line, so check the stock first. Prices here are list prices. Dealer discounts are applied later, on the invoice.",
  recordsPath: "/v1/summary",
  operations: [
    {
      id: "place_order",
      label: "Place an order",
      method: "POST",
      path: "/v1/orders",
      fields: [
        body("account", "Account", "NOR-0188"),
        body("branch", "Ship-from branch", "Laval"),
        body("items", "Items", "GREE-MZ-12 x 6; ECOBEE-T x 2"),
      ],
    },
    {
      id: "cancel_order",
      label: "Cancel an order",
      method: "POST",
      path: "/v1/orders/{order}/cancel",
      fields: [inPath("order", "Order number", "SO-1001")],
    },
  ],
};

export const CARRIER: Manifest = {
  name: "Freight carrier",
  description:
    "Freight service levels with their rates, and shipment bookings. Use it to work out what a shipment will cost and how long it takes, and to book or cancel one. Book only once the order it carries exists, and give that order number as the reference. Cost is a base charge plus a rate per kilogram, so the total weight is needed. Pallet freight is for shipments above 500 kg. Express must be asked for by whoever requested the work.",
  recordsPath: "/v1/summary",
  operations: [
    {
      id: "book_shipment",
      label: "Book a shipment",
      method: "POST",
      path: "/v1/shipments",
      fields: [
        body("reference", "Reference", "SO-1001"),
        body("from", "From", "Laval"),
        body("to", "To", "Richmond Hill"),
        body("weightKg", "Weight (kg)", "66"),
        body("service", "Service", "ground"),
      ],
    },
    {
      id: "cancel_shipment",
      label: "Cancel a shipment",
      method: "POST",
      path: "/v1/shipments/{shipment}/cancel",
      fields: [inPath("shipment", "Shipment number", "SH-5001")],
    },
  ],
};

export const LEDGER: Manifest = {
  name: "Accounts ledger",
  description:
    "Dealer accounts as accounting sees them: pricing tier, credit limit, what is owed, payment record and credit holds, with invoices and payments. Use it to check whether a dealer is good for an order before it is placed, to raise the invoice once an order exists, and to record a payment. An invoice takes the list amount and applies the dealer's tier discount itself. It is refused when the account is on hold or the invoice would take the dealer past the credit limit, and an order can be invoiced only once. Putting an account on hold stops all further invoices, so do it only on a clear instruction.",
  recordsPath: "/v1/summary",
  operations: [
    {
      id: "raise_invoice",
      label: "Raise an invoice",
      method: "POST",
      path: "/v1/invoices",
      fields: [
        body("account", "Account", "BRT-0931"),
        body("reference", "Order number", "SO-1001"),
        body("listAmount", "Amount at list price (CAD)", "5674"),
        body("freight", "Freight (CAD)", "141.30"),
      ],
    },
    {
      id: "record_payment",
      label: "Record a payment",
      method: "POST",
      path: "/v1/payments",
      fields: [body("account", "Account", "BRT-0931"), body("amount", "Amount (CAD)", "2500")],
    },
    {
      id: "set_credit_hold",
      label: "Put an account on hold, or release it",
      method: "PUT",
      path: "/v1/accounts/{account}/hold",
      fields: [
        inPath("account", "Account", "HAL-2210"),
        body("hold", "On hold", "yes or no"),
        body("reason", "Reason", "Balance over the limit"),
      ],
    },
  ],
};

export const SUPPLIER: Manifest = {
  name: "Supplier portal",
  description:
    "The factory's order desk: what each product costs, the smallest order it accepts, the case size, how long it takes to ship, how much it can ship now, and the purchase orders already raised with their inbound dates. Use it when a branch is short of stock and the storefront cannot fill an order, or when stock will run short. An order has to meet the minimum and be in whole cases. When the factory cannot ship the full quantity now, it ships what it has and confirms the rest for a later date, so read the answer. Expediting moves an order to air freight for a surcharge of 18 percent and cannot be undone.",
  recordsPath: "/v1/summary",
  operations: [
    {
      id: "raise_purchase_order",
      label: "Raise a purchase order",
      method: "POST",
      path: "/v1/purchase-orders",
      fields: [
        body("sku", "Product", "GREE-CU-24"),
        body("quantity", "Quantity", "8"),
        body("branch", "Deliver to branch", "Laval"),
      ],
    },
    {
      id: "expedite_order",
      label: "Expedite a purchase order by air",
      method: "POST",
      path: "/v1/purchase-orders/{order}/expedite",
      fields: [inPath("order", "Purchase order number", "PO-7001")],
    },
    {
      id: "cancel_purchase_order",
      label: "Cancel a purchase order",
      method: "POST",
      path: "/v1/purchase-orders/{order}/cancel",
      fields: [inPath("order", "Purchase order number", "PO-7001")],
    },
  ],
};

export const SERVICE_DESK: Manifest = {
  name: "Service desk",
  description:
    "Units in the field by serial number, with who bought them, when they were delivered and whether they are still under the 24 month warranty, plus support tickets, return authorizations and technician visits. Use it when a dealer reports a fault or asks to send a unit back. Open a ticket first: a return or a visit is made against a ticket. A return is authorized only for a unit that is under warranty and has no return open already. A visit needs a weekday that is not in the past, and each day takes two visits, so another date may be needed.",
  recordsPath: "/v1/summary",
  operations: [
    {
      id: "open_ticket",
      label: "Open a ticket",
      method: "POST",
      path: "/v1/tickets",
      fields: [
        body("account", "Account", "CAL-3310"),
        body("serial", "Unit serial number", "GCU24-118204"),
        body("problem", "What is wrong", "Compressor trips after ten minutes"),
      ],
    },
    {
      id: "authorize_return",
      label: "Authorize a return",
      method: "POST",
      path: "/v1/tickets/{ticket}/return",
      fields: [inPath("ticket", "Ticket number", "TK-4001"), body("reason", "Reason", "Failed compressor")],
    },
    {
      id: "schedule_visit",
      label: "Schedule a technician visit",
      method: "POST",
      path: "/v1/tickets/{ticket}/visit",
      fields: [inPath("ticket", "Ticket number", "TK-4001"), body("date", "Date", "2026-11-24")],
    },
    {
      id: "close_ticket",
      label: "Close a ticket",
      method: "POST",
      path: "/v1/tickets/{ticket}/close",
      fields: [inPath("ticket", "Ticket number", "TK-4001"), body("resolution", "How it was resolved", "Unit replaced")],
    },
  ],
};

/** Every sample service, by the folder it lives in. */
export const MANIFESTS = {
  storefront: STOREFRONT,
  carrier: CARRIER,
  ledger: LEDGER,
  supplier: SUPPLIER,
  "service-desk": SERVICE_DESK,
} as const;
