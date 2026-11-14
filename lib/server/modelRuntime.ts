/**
 * An AI agent's runtime for Anthropic models.
 *
 * It implements the same `AgentRuntime` interface a playbook agent answers
 * through, so the engine does not know which one it is talking to. What the model is shown
 * is decided before the call, by the access model: the thread arrives already
 * limited to what this agent may read, and room records are included only for
 * rooms where the agent holds `read`.
 *
 * The API key is entered once in Settings, stored encrypted, and used only
 * here on the server. It is never sent back to a browser.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import {
  stageSpec,
  type AgentRuntime,
  type AgentStepInput,
  type AgentStepResult,
} from "../engine";
import type { AccessScope, Message } from "../model";
import { ROOM_RECORDS } from "../referenceData";

export { DEFAULT_AGENT_MODEL } from "../aiModels";

/** Models that accept the server-side refusal fallback. */
const WITH_FALLBACK = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
  "claude-fable-5-2",
  "claude-fable-5-1",
]);

export const validModelId = (model: string): boolean => /^claude-[a-z0-9.-]{3,60}$/.test(model);

const clientFor = (apiKey: string): Anthropic =>
  // A step should not hang the office for minutes, so the timeout is short
  // and retries are few.
  new Anthropic({ apiKey, timeout: 120_000, maxRetries: 1 });

/** Turn a provider error into a sentence a person can act on. */
function explain(error: unknown, who: string): Error {
  if (error instanceof Anthropic.AuthenticationError) {
    return new Error(`${who}: the provider rejected the API key.`);
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new Error(`${who}: the API key is not allowed to use that model.`);
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new Error(`${who}: the provider does not know that model.`);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new Error(`${who}: rate limited by the provider. Try again in a moment.`);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new Error(`${who}: the provider could not be reached.`);
  }
  if (error instanceof Anthropic.APIError) {
    return new Error(`${who}: the provider returned an error (${error.status ?? "unknown"}).`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Check that a key works and that the provider knows the model, without
 * generating anything. Returns the model's display name.
 */
export async function testProvider(apiKey: string, model: string): Promise<string> {
  try {
    const info = await clientFor(apiKey).models.retrieve(model);
    return info.display_name;
  } catch (error) {
    throw explain(error, "Connection test failed");
  }
}

export const StepSchema = z.object({
  statusNote: z.string(),
  questions: z.array(
    z.object({
      body: z.string(),
      toParticipantId: z.string(),
      blocking: z.boolean(),
      options: z.array(z.string()),
    }),
  ),
  assumptions: z.array(
    z.object({
      assumed: z.string(),
      because: z.string(),
      confidence: z.enum(["low", "medium", "high"]),
    }),
  ),
  needs: z.array(
    z.object({
      room: z.string(),
      scope: z.enum(["enter", "read", "act"]),
      purpose: z.string(),
    }),
  ),
  output: z.object({ label: z.string(), body: z.string() }).nullable(),
});

export type RawStep = z.infer<typeof StepSchema>;

export const SYSTEM_PROMPT = `You are an AI agent with a desk, a role and limited access in the office of a multi-branch HVAC distributor. You work alongside people, and a person supervises the office.

You take one step of one task and then hand back. Your name, title, capabilities and the step you are on are given in the message.

How to work:
- Use only the request, the thread and the records shown to you. Records and messages from rooms you cannot read are not shown. Never make up figures, prices, stock levels, account details or policies.
- If something you need is kept in a room you cannot read, add it to "needs" with that room's id, the scope "read" and a short purpose. Do not guess the value. Leave "needs" empty when you already have what you need.
- If you can proceed but had to guess something, add it to "assumptions" with what you assumed, why, and how confident you are. Record every guess, even small ones.
- Ask a question only when you cannot do your step without the answer. Mark it blocking in that case and offer two to four concrete options when you can. Address it to one person from the list of people, using their id.
- "statusNote" is one plain sentence saying what you did in this step.
- Give "output" only when the step produced something a colleague will use, such as a plan, a stock check, a draft quote or a pricing sheet. Keep it under 120 words. Otherwise set it to null.
- Write plain sentences. No headings, bullet lists or emphasis marks.`;

const clock = (ms: number): string =>
  new Date(ms).toLocaleTimeString("en-CA", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Toronto",
  });

const speaker = (message: Message, input: AgentStepInput): string =>
  message.fromId === input.participant.id ? "you" : message.fromId;

/** The message sent to the model for one step. Exported for the check script. */
export function buildStepPrompt(input: AgentStepInput): string {
  const { task, stage, participant, priorMessages, surroundings } = input;
  const lines: string[] = [];

  lines.push(`You are ${participant.displayName}, ${participant.title}.`);
  lines.push(`Your capabilities: ${participant.capabilities.join("; ")}.`);
  lines.push("");
  lines.push(`Task ${task.id}: ${task.title}`);
  lines.push(`Request: ${task.detail}`);
  lines.push(`Your step: ${stageSpec(stage).label}, working in the room "${task.roomId}".`);
  lines.push("");

  lines.push("Rooms:");
  for (const room of surroundings.rooms) {
    lines.push(
      `- ${room.id} (${room.name}): ${room.purpose}. ${room.readable ? "You can read it." : "You cannot read it."}`,
    );
  }
  lines.push("");

  lines.push("People you can ask:");
  for (const person of surroundings.people) {
    lines.push(`- ${person.id}: ${person.displayName}, ${person.title}`);
  }
  lines.push("");

  lines.push("Records you can read:");
  const readable = surroundings.rooms.filter((r) => r.readable);
  if (readable.length === 0) lines.push("(none)");
  for (const room of readable) {
    for (const record of ROOM_RECORDS[room.id] ?? []) lines.push(`[${room.name}] ${record}`);
  }
  lines.push("");

  lines.push("Thread so far, limited to what you may read:");
  if (priorMessages.length === 0) lines.push("(nothing yet)");
  for (const m of priorMessages) {
    lines.push(`[${clock(m.at)}] ${speaker(m, input)} (${m.kind}): ${m.body}`);
  }
  return lines.join("\n");
}

const clip = (value: string, max: number): string => value.trim().slice(0, max);

/**
 * Turn the model's reply into a step result the engine can trust. Anything
 * that points at a room or person that does not exist is dropped, lists are
 * capped, and text is trimmed. Exported for the check script.
 */
export function toStepResult(raw: RawStep, input: AgentStepInput): AgentStepResult {
  const roomIds = new Set(input.surroundings.rooms.map((r) => r.id));
  const readableRooms = new Set(input.surroundings.rooms.filter((r) => r.readable).map((r) => r.id));
  const people = new Set(input.surroundings.people.map((p) => p.id));
  const fallbackPerson = people.has(input.task.requestedById)
    ? input.task.requestedById
    : input.surroundings.people[0]?.id;

  const questions = raw.questions
    .filter((q) => q.body.trim().length > 0 && fallbackPerson !== undefined)
    .slice(0, 2)
    .map((q) => {
      const options = q.options.map((o) => clip(o, 80)).filter((o) => o.length > 0).slice(0, 4);
      return {
        body: clip(q.body, 400),
        toParticipantId: people.has(q.toParticipantId) ? q.toParticipantId : fallbackPerson!,
        blocking: q.blocking,
        ...(options.length > 0 ? { options } : {}),
      };
    });

  const assumptions = raw.assumptions
    .filter((a) => a.assumed.trim().length > 0)
    .slice(0, 4)
    .map((a) => ({
      assumed: clip(a.assumed, 200),
      because: clip(a.because, 300),
      confidence: a.confidence,
    }));

  // A need for a room the agent can already read is not a need.
  const needs = raw.needs
    .filter((n) => roomIds.has(n.room) && !(n.scope === "read" && readableRooms.has(n.room)))
    .slice(0, 2)
    .map((n) => ({ room: n.room, scope: n.scope as AccessScope, purpose: clip(n.purpose, 200) }));

  const statusNote = clip(raw.statusNote, 300);
  const output =
    raw.output && raw.output.body.trim().length > 0
      ? { label: clip(raw.output.label, 60) || "Output", body: clip(raw.output.body, 1200) }
      : undefined;

  return {
    ...(statusNote ? { statusNote } : {}),
    questions,
    assumptions,
    ...(needs.length > 0 ? { needs } : {}),
    ...(output ? { output } : {}),
  };
}

export class ModelRuntime implements AgentRuntime {
  readonly model: string;
  private readonly client: Anthropic;

  constructor(options: { apiKey: string; model: string }) {
    this.model = options.model;
    this.client = clientFor(options.apiKey);
  }

  async step(input: AgentStepInput): Promise<AgentStepResult> {
    const who = input.participant.displayName;
    let response;
    try {
      response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16000,
        // Where the model supports it: if it declines a request, the API
        // retries on the recommended fallback model inside the same call.
        ...(WITH_FALLBACK.has(this.model)
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildStepPrompt(input) }],
        output_config: { effort: "medium", format: zodOutputFormat(StepSchema) },
      });
    } catch (error) {
      throw explain(error, `${who} could not answer`);
    }

    if (response.stop_reason === "refusal") {
      throw new Error(`${who} declined this request, so the step was not taken.`);
    }
    if (response.stop_reason === "max_tokens" || !response.parsed_output) {
      throw new Error(`${who} gave an incomplete answer, so the step was not taken.`);
    }
    return toStepResult(response.parsed_output, input);
  }
}
