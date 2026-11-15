/**
 * Conversations between a person and an agent, held at the agent's desk.
 *
 * A conversation is outside the workflow: it changes no task and grants no
 * access. What an AI agent is shown for it is limited twice over, to what the
 * agent may read and to what the person asking may read, so talking to an
 * agent never reveals a room's contents to someone who could not read them.
 */
import { stageSpec } from "../engine";
import { bothRead, deskState } from "../agentState";
import { resolveAccess, type AccessContext, type Office, type Participant } from "../model";
import type { ChatLine } from "../view";
import { all, run, type Db } from "./db";
import type { ChatTurn } from "./modelRuntime";

const KEPT_PER_PERSON = 200;
const TURNS_SHOWN_TO_MODEL = 12;

/** Everything this person and the office's agents have said to each other. */
export function chatLines(db: Db, personId: string): ChatLine[] {
  return all<{ id: number; agent_id: string; from_agent: number; body: string; at: number }>(
    db,
    "SELECT id, agent_id, from_agent, body, at FROM chat_messages WHERE person_id = ? ORDER BY id DESC LIMIT ?",
    personId,
    KEPT_PER_PERSON,
  )
    .reverse()
    .map((r) => ({ id: r.id, agentId: r.agent_id, fromAgent: r.from_agent === 1, body: r.body, at: r.at }));
}

export function recordExchange(db: Db, agentId: string, personId: string, asked: string, reply: string, at: number): void {
  const insert = "INSERT INTO chat_messages (agent_id, person_id, from_agent, body, at) VALUES (?, ?, ?, ?, ?)";
  run(db, insert, agentId, personId, 0, asked, at);
  run(db, insert, agentId, personId, 1, reply, at);
}

/** The earlier part of one conversation, as turns for a model. */
export function earlierTurns(db: Db, agentId: string, personId: string): ChatTurn[] {
  return chatLines(db, personId)
    .filter((line) => line.agentId === agentId)
    .slice(-TURNS_SHOWN_TO_MODEL)
    .map((line) => ({ role: line.fromAgent ? ("assistant" as const) : ("user" as const), content: line.body }));
}

/**
 * The standing instructions and context for one conversation. `liveRecords`
 * holds lines from connected systems in rooms both of them can read.
 */
export function buildChatSystem(
  office: Office,
  agent: Participant,
  asker: Participant,
  ctx: AccessContext,
  liveRecords: string[],
): string {
  const reads = (who: Participant, roomId: string): boolean => resolveAccess(who, roomId, "read", ctx).effect === "allow";
  const shared = office.floorplan.rooms.filter((room) => reads(agent, room.id) && reads(asker, room.id));
  const visible = bothRead(ctx, agent, asker);
  const lines: string[] = [];

  lines.push(
    `You are ${agent.displayName}, ${agent.title}, an AI agent with a desk in the office "${office.name}". ` +
      `${asker.displayName}, ${asker.title}, has come to your desk to talk to you.`,
    "",
    "How to answer:",
    "- Answer in plain sentences, in at most 120 words. No headings, bullet lists or emphasis marks.",
    "- Use only what is shown below. Records and messages from rooms you cannot read are not shown, and neither is anything the person you are talking to may not read. Never make up figures, stock levels, prices or account details.",
    "- If you are asked for something you were not shown, say that you cannot see it. If you know which room keeps it, name the room.",
    "- You cannot change anything from this conversation. You cannot place orders, move tasks, answer open questions or grant access here. For work to be done, tell them to file a request. For access, tell them to ask whoever manages access.",
    "",
    `Your capabilities: ${agent.capabilities.join("; ") || "none listed"}.`,
    "",
    "Rooms:",
  );
  for (const room of office.floorplan.rooms) {
    const mine = reads(agent, room.id);
    lines.push(
      `- ${room.name}: ${room.purpose || "no purpose given"}. ${
        mine ? (reads(asker, room.id) ? "You can both read it." : "You can read it, but this person cannot, so its contents are not shown.") : "You cannot read it."
      }`,
    );
  }

  lines.push("", "Records you may both read:");
  const records = [...shared.flatMap((room) => room.records.map((record) => `[${room.name}] ${record}`)), ...liveRecords];
  lines.push(...(records.length > 0 ? records : ["(none)"]));

  const state = deskState(office, agent, visible);
  const owned = office.tasks.filter((t) => t.closedAt === null && t.ownerId === agent.id);
  lines.push("", `Your desk right now: ${state.headline}.`, "", "Your open work:");
  if (owned.length === 0) lines.push("(none)");
  for (const task of owned.slice(0, 4)) {
    lines.push(`- ${task.id}, "${task.title}": ${stageSpec(task.stage).label}, status ${task.status.replace(/_/g, " ")}.`);
    const thread = office.messages.filter((m) => m.taskId === task.id && visible(m)).slice(-6);
    for (const m of thread) {
      const from = m.fromId === agent.id ? "you" : (office.participants.find((p) => p.id === m.fromId)?.displayName ?? m.fromId);
      lines.push(`    ${from} (${m.kind}): ${m.body}`);
    }
  }
  return lines.join("\n");
}
