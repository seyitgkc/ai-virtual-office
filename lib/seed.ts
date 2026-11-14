/**
 * Seed office for a multi-branch HVAC distributor.
 *
 * One floorplan, five rooms, two humans, five agents, three tasks chosen to
 * put every state on screen the moment the demo loads:
 *
 *   T-1001  blocked_permission   halted at the Finance door
 *   T-1002  blocked_question     halted waiting on a human answer
 *   T-1003  completed            the full happy path, start to finish
 *
 * Everything here is simulated. No participant has a real model backing it;
 * `backing: null` is what the UI reads to badge an agent as mocked.
 */

import {
  ALL_SCOPES,
  ANY_ROOM,
  resolveAccess,
  type AccessContext,
  type Desk,
  type Floorplan,
  type IndividualRule,
  type Message,
  type Office,
  type Participant,
  type Role,
  type RoleId,
  type Room,
  type Task,
  type TaskId,
} from "./model";

// ---------------------------------------------------------------------------
// Clock. Fixed so the demo is deterministic.
// ---------------------------------------------------------------------------

const BASE = Date.parse("2026-11-20T09:00:00-05:00");
/** Minutes after the start of the working day. */
const at = (m: number): number => BASE + m * 60_000;

// ---------------------------------------------------------------------------
// Floorplan
//
//   z=0 ┌──────────┬──────────┬──────────┐
//       │ Reception│ Planning │ Finance  │
//   z=8 ├──────────┴───┬──────┴──────────┤
//       │  Fulfilment  │   Operations    │
//  z=16 └──────────────┴─────────────────┘
//      x=0          x=15               x=30
// ---------------------------------------------------------------------------

const rooms: Room[] = [
  {
    id: "reception",
    name: "Reception",
    purpose: "Dealer requests arrive and are triaged",
    bounds: { x: 0, z: 0, w: 10, d: 8 },
    doors: [
      { id: "d-rec-out", toRoomId: null, wall: "south", along: 0.5, width: 1.6 },
      { id: "d-rec-pla", toRoomId: "planning", wall: "east", along: 0.5, width: 1.4 },
      { id: "d-rec-ful", toRoomId: "fulfilment", wall: "north", along: 0.5, width: 1.4 },
    ],
    deskIds: ["desk-rec-1", "desk-rec-2"],
  },
  {
    id: "planning",
    name: "Planning",
    purpose: "Requests are broken into work and routed",
    bounds: { x: 10, z: 0, w: 10, d: 8 },
    doors: [
      { id: "d-pla-rec", toRoomId: "reception", wall: "west", along: 0.5, width: 1.4 },
      { id: "d-pla-fin", toRoomId: "finance", wall: "east", along: 0.5, width: 1.4 },
      { id: "d-pla-ful", toRoomId: "fulfilment", wall: "north", along: 0.25, width: 1.4 },
      { id: "d-pla-ops", toRoomId: "operations", wall: "north", along: 0.75, width: 1.4 },
    ],
    deskIds: ["desk-pla-1"],
  },
  {
    id: "finance",
    name: "Finance",
    purpose: "Dealer pricing, credit terms and approval",
    bounds: { x: 20, z: 0, w: 10, d: 8 },
    doors: [
      { id: "d-fin-pla", toRoomId: "planning", wall: "west", along: 0.5, width: 1.4 },
      { id: "d-fin-ops", toRoomId: "operations", wall: "north", along: 0.5, width: 1.4 },
    ],
    deskIds: ["desk-fin-1"],
  },
  {
    id: "fulfilment",
    name: "Fulfilment",
    purpose: "Stock across branches, transfers and quoting",
    bounds: { x: 0, z: 8, w: 15, d: 8 },
    doors: [
      { id: "d-ful-rec", toRoomId: "reception", wall: "south", along: 1 / 3, width: 1.4 },
      { id: "d-ful-pla", toRoomId: "planning", wall: "south", along: 5 / 6, width: 1.4 },
      { id: "d-ful-ops", toRoomId: "operations", wall: "east", along: 0.5, width: 1.4 },
    ],
    deskIds: ["desk-ful-1", "desk-ful-2"],
  },
  {
    id: "operations",
    name: "Operations",
    purpose: "Human supervision, escalations and overrides",
    bounds: { x: 15, z: 8, w: 15, d: 8 },
    doors: [
      { id: "d-ops-ful", toRoomId: "fulfilment", wall: "west", along: 0.5, width: 1.4 },
      { id: "d-ops-pla", toRoomId: "planning", wall: "south", along: 1 / 6, width: 1.4 },
      { id: "d-ops-fin", toRoomId: "finance", wall: "south", along: 2 / 3, width: 1.4 },
    ],
    deskIds: ["desk-ops-1"],
  },
];

const desks: Desk[] = [
  { id: "desk-rec-1", roomId: "reception", position: { x: 3, z: 3 }, facing: 0, occupantId: "p-iris" },
  { id: "desk-rec-2", roomId: "reception", position: { x: 7, z: 3 }, facing: 0, occupantId: "p-sam" },
  { id: "desk-pla-1", roomId: "planning", position: { x: 15, z: 4 }, facing: 0, occupantId: "p-atlas" },
  { id: "desk-fin-1", roomId: "finance", position: { x: 25, z: 4 }, facing: 0, occupantId: "p-ledger" },
  { id: "desk-ful-1", roomId: "fulfilment", position: { x: 4, z: 12 }, facing: Math.PI, occupantId: "p-vera" },
  { id: "desk-ful-2", roomId: "fulfilment", position: { x: 11, z: 12 }, facing: Math.PI, occupantId: "p-quill" },
  { id: "desk-ops-1", roomId: "operations", position: { x: 22, z: 12 }, facing: Math.PI, occupantId: "p-dana" },
];

export const floorplan: Floorplan = {
  id: "fp-distributor",
  name: "Single-branch distributor",
  description:
    "Five-room layout for an HVAC distributor: intake, planning, fulfilment, finance, and a supervision office.",
  rooms,
  desks,
};

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const roles: Record<RoleId, Role> = {
  supervisor: {
    id: "supervisor",
    supervises: true,
    name: "Operations Manager",
    description: "Full access. Resolves escalations, grants scoped exceptions.",
    grants: [{ room: ANY_ROOM, scopes: ALL_SCOPES, effect: "allow" }],
  },
  intake: {
    id: "intake",
    supervises: false,
    name: "Intake",
    description: "Receives dealer requests, triages, hands off to Planning.",
    grants: [
      { room: "reception", scopes: ALL_SCOPES, effect: "allow" },
      { room: "planning", scopes: ["enter", "read"], effect: "allow" },
    ],
  },
  planner: {
    id: "planner",
    supervises: false,
    name: "Planner",
    description: "Breaks requests into work and routes them.",
    grants: [
      { room: "planning", scopes: ALL_SCOPES, effect: "allow" },
      { room: "reception", scopes: ["enter", "read"], effect: "allow" },
      { room: "fulfilment", scopes: ["enter", "read"], effect: "allow" },
    ],
  },
  fulfilment: {
    id: "fulfilment",
    supervises: false,
    name: "Fulfilment",
    description:
      "Stock, transfers and quoting. Explicitly denied Finance because pricing authority sits elsewhere.",
    grants: [
      { room: "fulfilment", scopes: ALL_SCOPES, effect: "allow" },
      { room: "planning", scopes: ["enter", "read"], effect: "allow" },
      { room: "finance", scopes: ALL_SCOPES, effect: "deny" },
    ],
  },
  finance: {
    id: "finance",
    supervises: false,
    name: "Finance",
    description: "Dealer tier pricing, credit checks, approval.",
    grants: [
      { room: "finance", scopes: ALL_SCOPES, effect: "allow" },
      { room: "planning", scopes: ["enter", "read"], effect: "allow" },
    ],
  },
};

// ---------------------------------------------------------------------------
// Participants: 2 humans, 5 agents
// ---------------------------------------------------------------------------

export const participants: Participant[] = [
  {
    id: "p-dana",
    kind: "human",
    displayName: "Dana Reyes",
    title: "Operations Manager",
    roleId: "supervisor",
    deskId: "desk-ops-1",
    capabilities: ["Approve quotes", "Grant scoped access", "Override assumptions"],
    backing: null,
    appearance: { color: "#2f6f4f" },
  },
  {
    id: "p-sam",
    kind: "human",
    displayName: "Sam Okafor",
    title: "Dealer Services Rep",
    roleId: "intake",
    deskId: "desk-rec-2",
    capabilities: ["Answer dealer queries", "Confirm order detail"],
    backing: null,
    appearance: { color: "#3b6ea5" },
  },
  {
    id: "p-iris",
    kind: "agent",
    displayName: "Iris",
    title: "Intake Agent",
    roleId: "intake",
    deskId: "desk-rec-1",
    capabilities: [
      "Parse inbound dealer requests",
      "Match dealer to account and branch",
      "Ask clarifying questions before handoff",
    ],
    backing: null,
    appearance: { color: "#c98a3c" },
  },
  {
    id: "p-atlas",
    kind: "agent",
    displayName: "Atlas",
    title: "Planning Agent",
    roleId: "planner",
    deskId: "desk-pla-1",
    capabilities: ["Decompose a request into tasks", "Assign owners", "Set lead times"],
    backing: null,
    appearance: { color: "#7a5ea8" },
  },
  {
    id: "p-vera",
    kind: "agent",
    displayName: "Vera",
    title: "Inventory Agent",
    roleId: "fulfilment",
    deskId: "desk-ful-1",
    capabilities: ["Check stock across branches", "Propose inter-branch transfers"],
    backing: null,
    appearance: { color: "#4a8c8c" },
  },
  {
    id: "p-quill",
    kind: "agent",
    displayName: "Quill",
    title: "Quoting Agent",
    roleId: "fulfilment",
    deskId: "desk-ful-2",
    capabilities: ["Assemble quotes", "Apply dealer tier pricing (requires Finance)"],
    backing: null,
    appearance: { color: "#b05a7a" },
  },
  {
    id: "p-ledger",
    kind: "agent",
    displayName: "Ledger",
    title: "Finance Agent",
    roleId: "finance",
    deskId: "desk-fin-1",
    capabilities: ["Look up dealer tier", "Check credit standing", "Release pricing"],
    backing: null,
    appearance: { color: "#8c6a3c" },
  },
];

// ---------------------------------------------------------------------------
// Individual rules
//
// Vera carries a deliberate standing conflict: an old project grant allowing
// her to read Finance, and a later security-review deny. Deny wins within the
// individual tier, and the office loads with that warning already on screen.
// ---------------------------------------------------------------------------

export const rules: IndividualRule[] = [
  {
    id: "r-01",
    participantId: "p-vera",
    room: "finance",
    scopes: ["read"],
    effect: "allow",
    reason: "Needed landed-cost visibility for the margin review project",
    grantedBy: "p-dana",
    grantedAt: at(-60 * 24 * 40),
  },
  {
    id: "r-02",
    participantId: "p-vera",
    room: "finance",
    scopes: ["read"],
    effect: "deny",
    reason: "Security review: fulfilment agents should not read credit data",
    grantedBy: "p-dana",
    grantedAt: at(-60 * 24 * 5),
  },
  {
    id: "r-03",
    participantId: "p-sam",
    room: "fulfilment",
    scopes: ["enter", "read"],
    effect: "allow",
    reason: "Covering the counter while the branch is short-staffed",
    grantedBy: "p-dana",
    grantedAt: at(-60 * 8),
    expiresAt: at(60 * 40),
  },
];

// ---------------------------------------------------------------------------
// The decision that halted T-1001
//
// Computed from the rules above rather than written by hand, so the seeded
// block can never drift out of step with the access model.
// ---------------------------------------------------------------------------

const seedCtx: AccessContext = {
  roles,
  rules,
  now: at(32),
  closedTaskIds: new Set<TaskId>(),
};

export const quillDeniedFinance = resolveAccess(
  participants.find((p) => p.id === "p-quill")!,
  "finance",
  "read",
  seedCtx,
);

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const tasks: Task[] = [
  {
    id: "T-1001",
    title: "Dealer order 4471: 6x Gree multi-zone, Richmond Hill",
    detail:
      "Northline Mechanical requests six multi-zone heads for a job starting 24 Nov, asking for dealer pricing and confirmed availability.",
    requestedById: "p-sam",
    ownerId: "p-quill",
    roomId: "fulfilment",
    stage: "execution",
    status: "blocked_permission",
    openQuestionIds: [],
    assumptionIds: ["m-1003", "m-1007", "m-1010"],
    createdAt: at(0),
    closedAt: null,
    history: [
      { at: at(0), summary: "Request received in Reception", messageId: "m-1001" },
      { at: at(4), summary: "Iris asked which condenser pairing applies", messageId: "m-1004" },
      { at: at(11), summary: "Sam answered: standalone heads", messageId: "m-1005" },
      { at: at(13), summary: "Handed off to Planning", messageId: "m-1006" },
      { at: at(22), summary: "Handed off to Fulfilment", messageId: "m-1008" },
      { at: at(31), summary: "Quoting picked up; dealer tier pricing required", messageId: "m-1011" },
      {
        at: at(32),
        summary: "Blocked at the Finance door. Quill is denied by role Fulfilment.",
        messageId: "m-1012",
      },
    ],
  },
  {
    id: "T-1002",
    title: "Branch transfer: PTAC units, Laval to Dartmouth",
    detail: "Dartmouth is short four PTAC units for a hotel retrofit.",
    requestedById: "p-dana",
    ownerId: "p-vera",
    roomId: "fulfilment",
    stage: "execution",
    status: "blocked_question",
    openQuestionIds: ["m-2003"],
    assumptionIds: [],
    createdAt: at(15),
    closedAt: null,
    history: [
      { at: at(15), summary: "Transfer requested by Dana", messageId: "m-2001" },
      { at: at(18), summary: "Vera checked stock at Laval", messageId: "m-2002" },
      {
        at: at(20),
        summary: "Vera asked whether to split the shipment and is waiting for an answer",
        messageId: "m-2003",
      },
    ],
  },
  {
    id: "T-1003",
    title: "Quote 4455: ecobee thermostats, 40 units",
    detail: "Stocking order for a repeat dealer, standard tier.",
    requestedById: "p-sam",
    ownerId: "p-ledger",
    roomId: "finance",
    stage: "done",
    status: "completed",
    openQuestionIds: [],
    assumptionIds: ["m-3002"],
    createdAt: at(-180),
    closedAt: at(-120),
    history: [
      { at: at(-180), summary: "Request received", messageId: "m-3001" },
      { at: at(-172), summary: "Planning routed to Fulfilment" },
      { at: at(-160), summary: "Stock confirmed at Richmond Hill" },
      { at: at(-140), summary: "Finance released tier pricing", messageId: "m-3003" },
      { at: at(-120), summary: "Dana approved; quote issued", messageId: "m-3004" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export const messages: Message[] = [
  // --- T-1001 ------------------------------------------------------------
  {
    id: "m-1001",
    kind: "request",
    taskId: "T-1001",
    fromId: "p-sam",
    audience: { to: "room", id: "reception" },
    roomId: "reception",
    at: at(0),
    body: "Northline Mechanical need 6x Gree multi-zone heads for a 24 Nov start. They want dealer pricing and a firm availability date.",
  },
  {
    id: "m-1002",
    kind: "status",
    taskId: "T-1001",
    fromId: "p-iris",
    audience: { to: "room", id: "reception" },
    roomId: "reception",
    at: at(2),
    body: "Matched to account NOR-0188. Parsing line items.",
    progress: 0.1,
  },
  {
    id: "m-1003",
    kind: "assumption",
    taskId: "T-1001",
    fromId: "p-iris",
    audience: { to: "room", id: "reception" },
    roomId: "reception",
    at: at(3),
    body: "Assuming the Richmond Hill branch.",
    assumed: "Fulfilment branch is Richmond Hill",
    because: "The request named no branch; the account's service address is Richmond Hill.",
    confidence: "medium",
    status: "open",
    affectsTaskIds: ["T-1001"],
  },
  {
    id: "m-1004",
    kind: "question",
    taskId: "T-1001",
    fromId: "p-iris",
    audience: { to: "participant", id: "p-sam" },
    roomId: "reception",
    at: at(4),
    body: "Are these standalone heads, or paired with GWH condensers? Pricing differs.",
    blocking: true,
    options: ["Standalone heads", "Paired with GWH condensers", "Dealer to confirm"],
    answeredByMessageId: "m-1005",
  },
  {
    id: "m-1005",
    kind: "answer",
    taskId: "T-1001",
    fromId: "p-sam",
    audience: { to: "participant", id: "p-iris" },
    roomId: "reception",
    at: at(11),
    inReplyTo: "m-1004",
    body: "Standalone. They already have the condensers on site.",
    questionId: "m-1004",
    chosenOption: "Standalone heads",
  },
  {
    id: "m-1006",
    kind: "handoff",
    taskId: "T-1001",
    fromId: "p-iris",
    audience: { to: "room", id: "planning" },
    roomId: "planning",
    at: at(13),
    body: "Triaged and confirmed. Over to Planning.",
    fromParticipantId: "p-iris",
    toParticipantId: "p-atlas",
    toRoomId: "planning",
  },
  {
    id: "m-1007",
    kind: "assumption",
    taskId: "T-1001",
    fromId: "p-atlas",
    audience: { to: "room", id: "planning" },
    roomId: "planning",
    at: at(18),
    body: "Assuming standard lead time.",
    assumed: "Five working days from order confirmation",
    because: "No contract terms were attached to the account record.",
    confidence: "low",
    status: "open",
    affectsTaskIds: ["T-1001"],
  },
  {
    id: "m-1008",
    kind: "handoff",
    taskId: "T-1001",
    fromId: "p-atlas",
    audience: { to: "room", id: "fulfilment" },
    roomId: "fulfilment",
    at: at(22),
    body: "Six line items, one shipment. Fulfilment to confirm stock and quote.",
    fromParticipantId: "p-atlas",
    toParticipantId: "p-vera",
    toRoomId: "fulfilment",
  },
  {
    id: "m-1009",
    kind: "status",
    taskId: "T-1001",
    fromId: "p-vera",
    audience: { to: "room", id: "fulfilment" },
    roomId: "fulfilment",
    at: at(27),
    body: "Stock: 4 at Richmond Hill, 2 at Laval. Transfer would land 21 Nov.",
    progress: 0.55,
  },
  {
    id: "m-1010",
    kind: "assumption",
    taskId: "T-1001",
    fromId: "p-vera",
    audience: { to: "room", id: "fulfilment" },
    roomId: "fulfilment",
    at: at(28),
    body: "Assuming an inter-branch transfer is acceptable.",
    assumed: "The dealer will accept a split-origin shipment",
    because: "Richmond Hill alone cannot fill the order and the dealer stated no preference.",
    confidence: "medium",
    status: "open",
    affectsTaskIds: ["T-1001"],
  },
  {
    id: "m-1011",
    kind: "handoff",
    taskId: "T-1001",
    fromId: "p-vera",
    audience: { to: "room", id: "fulfilment" },
    roomId: "fulfilment",
    at: at(31),
    body: "Stock confirmed. Quill to assemble the quote.",
    fromParticipantId: "p-vera",
    toParticipantId: "p-quill",
    toRoomId: "fulfilment",
  },
  {
    id: "m-1012",
    kind: "escalation",
    taskId: "T-1001",
    fromId: "p-quill",
    audience: { to: "participant", id: "p-dana" },
    roomId: "fulfilment",
    at: at(32),
    body: "I need NOR-0188's dealer tier to price this, which means reading Finance. My role denies it. Grant me scoped access for this task, or hand the quote to Ledger.",
    cause: "permission",
    deniedDecision: quillDeniedFinance,
  },

  // --- T-1002 ------------------------------------------------------------
  {
    id: "m-2001",
    kind: "request",
    taskId: "T-1002",
    fromId: "p-dana",
    audience: { to: "room", id: "fulfilment" },
    roomId: "fulfilment",
    at: at(15),
    body: "Dartmouth is four PTAC units short for a hotel retrofit. Move them from Laval.",
  },
  {
    id: "m-2002",
    kind: "status",
    taskId: "T-1002",
    fromId: "p-vera",
    audience: { to: "room", id: "fulfilment" },
    roomId: "fulfilment",
    at: at(18),
    body: "Laval shows seven on hand, but two are allocated to an open order.",
    progress: 0.3,
  },
  {
    id: "m-2003",
    kind: "question",
    taskId: "T-1002",
    fromId: "p-vera",
    audience: { to: "participant", id: "p-dana" },
    roomId: "fulfilment",
    at: at(20),
    body: "Send four now and leave Laval short, or send two now and two after the next inbound?",
    blocking: true,
    options: ["Send four now", "Split: two now, two later", "Hold until inbound arrives"],
  },

  // --- T-1003 ------------------------------------------------------------
  {
    id: "m-3001",
    kind: "request",
    taskId: "T-1003",
    fromId: "p-sam",
    audience: { to: "room", id: "reception" },
    roomId: "reception",
    at: at(-180),
    body: "Repeat dealer wants 40 ecobee thermostats as a stocking order.",
  },
  {
    id: "m-3002",
    kind: "assumption",
    taskId: "T-1003",
    fromId: "p-atlas",
    audience: { to: "room", id: "planning" },
    roomId: "planning",
    at: at(-170),
    body: "Assuming the standing tier applies.",
    assumed: "Standard dealer tier, no promotional pricing",
    because: "No campaign code was supplied with the request.",
    confidence: "high",
    status: "confirmed",
    affectsTaskIds: ["T-1003"],
  },
  {
    id: "m-3003",
    kind: "output",
    taskId: "T-1003",
    fromId: "p-ledger",
    audience: { to: "room", id: "finance" },
    roomId: "finance",
    at: at(-140),
    body: "Tier 2 pricing released, 40 units, net 30.",
    label: "Pricing sheet 4455",
    simulated: true,
  },
  {
    id: "m-3004",
    kind: "decision",
    taskId: "T-1003",
    fromId: "p-dana",
    audience: { to: "room", id: "finance" },
    roomId: "finance",
    at: at(-120),
    body: "Approved. Issue the quote.",
    verdict: "approved",
  },
];

// ---------------------------------------------------------------------------
// Assembled office
// ---------------------------------------------------------------------------

export const office: Office = {
  id: "office-distributor-demo",
  name: "Distributor Operations",
  floorplan,
  participants,
  roles,
  rules,
  tasks,
  messages,
};

/** Build the access context the resolver needs from an office snapshot. */
export function contextFor(o: Office, now: number = at(35)): AccessContext {
  const closed = new Set<TaskId>(
    o.tasks.filter((t) => t.closedAt !== null).map((t) => t.id),
  );
  return { roles: o.roles, rules: o.rules, now, closedTaskIds: closed };
}

export const byId = (id: string): Participant => {
  const found = participants.find((p) => p.id === id);
  if (!found) throw new Error(`No participant ${id}`);
  return found;
};
