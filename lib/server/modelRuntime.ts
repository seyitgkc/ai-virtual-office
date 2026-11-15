/**
 * An AI agent's runtime for Anthropic models, and for services at another
 * address that speak the Anthropic Messages interface.
 *
 * It implements the same `AgentRuntime` interface a playbook agent answers
 * through, so the engine does not know which one it is talking to. What the model is shown
 * is decided before the call, by the access model: the thread arrives already
 * limited to what this agent may read, and a room's records and the live
 * records of its connected systems are included only where the agent holds
 * `read` on that room.
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
import { SYSTEM_INFO } from "../systems";

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

/**
 * A client for Anthropic itself, or for a compatible service at `baseUrl`.
 * The SDK adds the /v1 part of each path, so one typed at the end is dropped.
 */
const clientFor = (apiKey: string, baseUrl?: string | null): Anthropic =>
  // A step should not hang the office for minutes, so the timeout is short
  // and retries are few.
  new Anthropic({
    apiKey,
    timeout: 120_000,
    maxRetries: 1,
    // The address comes from the provider's settings and from nowhere else,
    // so a variable in the server's environment cannot redirect it.
    baseURL: baseUrl ? baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "") : "https://api.anthropic.com",
    // Compatible services differ in which header they read the key from.
    ...(baseUrl ? { defaultHeaders: { "x-api-key": apiKey } } : {}),
  });

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
export async function testProvider(apiKey: string, model: string, baseUrl?: string | null): Promise<string> {
  const who = "Connection test failed";
  const client = clientFor(apiKey, baseUrl);
  try {
    const info = await client.models.retrieve(model);
    return info.display_name || model;
  } catch (error) {
    const rejected =
      error instanceof Anthropic.AuthenticationError ||
      error instanceof Anthropic.PermissionDeniedError ||
      error instanceof Anthropic.APIConnectionError;
    if (!baseUrl || rejected || !(error instanceof Anthropic.APIError)) throw explain(error, who);
  }
  // A compatible service may not list its models. Ask it for a single token
  // instead, which shows that the address, the key and the model all work.
  try {
    await client.messages.create({ model, max_tokens: 1, messages: [{ role: "user", content: "Hi" }] });
    return model;
  } catch (error) {
    throw explain(error, who);
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
  actions: z.array(
    z.object({
      system: z.string(),
      operation: z.string(),
      fields: z.array(z.object({ name: z.string(), value: z.string() })),
    }),
  ),
  output: z.object({ label: z.string(), body: z.string() }).nullable(),
});

export type RawStep = z.infer<typeof StepSchema>;

export const SYSTEM_PROMPT = `You are an AI agent with a desk, a role and limited access in an office. You work alongside people, and a person supervises the office. The office, your name, title and capabilities are given in the message.

You take one step of one task and then hand back. The step you are on is given in the message.

How to work:
- Use only the request, the thread and the records shown to you. Records and messages from rooms you cannot read are not shown. Never make up figures, prices, stock levels, account details or policies.
- If something you need is kept in a room you cannot read, add it to "needs" with that room's id, the scope "read" and a short purpose. Do not guess the value. Leave "needs" empty when you already have what you need.
- If you can proceed but had to guess something, add it to "assumptions" with what you assumed, why, and how confident you are. Record every guess, even small ones, but never repeat an assumption that is already in the thread.
- Ask a question only when you cannot do your step without the answer, and only when the thread does not already answer it. Mark it blocking in that case and offer two to four options when you can. Each option is a possible answer of at most eight words. Address the question to one person from the list of people, using their id.
- Some rooms have a connected system, such as a storefront or a carrier. Its live records are shown with the records when you can read its room. To do something in a system, add an entry to "actions" with the system's id, one of its operations, and a value for every field of that operation, taken from the request, the thread or the records. Act only when your step calls for it and nothing is left to guess. If the thread shows the action was already done, do not ask for it again. If you may not act in that system, ask for the action anyway: your supervisor will be asked to allow it. Leave "actions" empty otherwise.
- "statusNote" is one plain sentence saying what you did in this step.
- Give "output" only when the step produced something a colleague will use, such as a plan, a check, a draft or a summary. Keep its label under eight words and its body under 120 words. Otherwise set it to null.
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

  lines.push(`Office: ${surroundings.officeName}.`);
  lines.push(`You are ${participant.displayName}, ${participant.title}.`);
  lines.push(`Your capabilities: ${participant.capabilities.join("; ")}.`);
  lines.push("");
  lines.push(`Task ${task.id}: ${task.title}`);
  lines.push(`Request: ${task.detail}`);
  lines.push(`Your step: ${stageSpec(stage).label}, working in the room "${task.roomId}".`);
  if (input.afterAction) {
    lines.push(
      "You are taking this step a second time. What you asked for in a connected system has just been carried out, and the result is the latest line of the thread. Use it to finish what is left of this step, such as an action that needed that result. Do not repeat an action the thread shows was done. If nothing is left, say so in the status note and leave the lists empty.",
    );
  }
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

  if (surroundings.systems.length > 0) {
    lines.push("Connected systems:");
    for (const system of surroundings.systems) {
      const operations = SYSTEM_INFO[system.kind].operations
        .map((o) => `${o.id} (${o.fields.map((f) => `${f.name}, e.g. "${f.hint}"`).join("; ")})`)
        .join(" | ");
      lines.push(
        `- ${system.id} (${system.name}, a ${SYSTEM_INFO[system.kind].label.toLowerCase()}) in the room "${system.roomId}". ` +
          `${system.readable ? "You can read it." : "You cannot read it."} ` +
          `${system.mayAct ? "You may act in it." : "You may not act in it."} Operations: ${operations}.`,
      );
    }
    lines.push("");
  }

  lines.push("Records you can read:");
  const records = [
    ...surroundings.rooms.flatMap((room) => room.records.map((record) => `[${room.name}] ${record}`)),
    ...(input.liveRecords ?? []),
  ];
  if (records.length === 0) lines.push("(none: the rooms you can read hold no records)");
  lines.push(...records);
  lines.push("");

  lines.push("Thread so far, limited to what you may read:");
  if (priorMessages.length === 0) lines.push("(nothing yet)");
  for (const m of priorMessages) {
    lines.push(`[${clock(m.at)}] ${speaker(m, input)} (${m.kind}): ${m.body}`);
  }
  return lines.join("\n");
}

/** Shorten text to a limit, ending on a whole word. */
const clip = (value: string, max: number): string => {
  const text = value.trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 3);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}...`;
};

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

  // Whether the agent may act is the engine's decision. Here an action only
  // has to name a system that exists.
  const systemIds = new Set(input.surroundings.systems.map((s) => s.id));
  const actions = raw.actions
    .filter((a) => systemIds.has(a.system))
    .slice(0, 2)
    .map((a) => ({
      systemId: a.system,
      operation: a.operation.trim(),
      fields: Object.fromEntries(a.fields.slice(0, 12).map((f) => [f.name.trim(), clip(f.value, 200)])),
    }));

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
    ...(actions.length > 0 ? { actions } : {}),
    ...(output ? { output } : {}),
  };
}

export const JSON_INSTRUCTIONS = `

Reply with one JSON object and nothing else. It must have exactly these fields:
"statusNote" (string), "questions" (array of objects with "body", "toParticipantId", "blocking" and "options"), "assumptions" (array of objects with "assumed", "because" and "confidence" as "low", "medium" or "high"), "needs" (array of objects with "room", "scope" as "enter", "read" or "act", and "purpose"), "actions" (array of objects with "system", "operation" and "fields", where "fields" is an array of objects with "name" and "value"), and "output" (an object with "label" and "body", or null). Use empty arrays where there is nothing to report.`;

/** Pull the JSON object out of a reply that may be wrapped in a code fence. */
export function parseReply(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  const parsed: unknown = JSON.parse(start >= 0 && end > start ? body.slice(start, end + 1) : body);
  // A reply with nothing to do in a connected system may leave the list out.
  return parsed && typeof parsed === "object" && !("actions" in parsed) ? { ...parsed, actions: [] } : parsed;
}

/** One side of a conversation, oldest first. */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** A runtime that can also hold a plain conversation, outside any task. */
export interface ConversationRuntime extends AgentRuntime {
  chat(who: string, system: string, turns: ChatTurn[]): Promise<string>;
}

export class ModelRuntime implements ConversationRuntime {
  readonly model: string;
  private readonly client: Anthropic;
  /** True for a compatible service at its own address. */
  private readonly custom: boolean;

  constructor(options: { apiKey: string; model: string; baseUrl?: string | null }) {
    this.model = options.model;
    this.custom = Boolean(options.baseUrl);
    this.client = clientFor(options.apiKey, options.baseUrl);
  }

  /**
   * A step through a compatible service. Such a service may not enforce a
   * reply format, so the format is described in the instructions and the
   * reply is checked here.
   */
  private async plainStep(input: AgentStepInput): Promise<AgentStepResult> {
    const who = input.participant.displayName;
    let response;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT + JSON_INSTRUCTIONS,
        messages: [{ role: "user", content: buildStepPrompt(input) }],
      });
    } catch (error) {
      throw explain(error, `${who} could not answer`);
    }
    if (response.stop_reason === "refusal") {
      throw new Error(`${who} declined this request, so the step was not taken.`);
    }
    const text = response.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    let parsed;
    try {
      parsed = StepSchema.safeParse(parseReply(text));
    } catch {
      parsed = null;
    }
    if (!parsed || !parsed.success) {
      throw new Error(`${who} gave an answer in the wrong shape, so the step was not taken.`);
    }
    return toStepResult(parsed.data, input);
  }

  async chat(who: string, system: string, turns: ChatTurn[]): Promise<string> {
    let response;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system,
        messages: turns,
      });
    } catch (error) {
      throw explain(error, `${who} could not answer`);
    }
    if (response.stop_reason === "refusal") throw new Error(`${who} declined to answer that.`);
    const text = response.content.map((block) => (block.type === "text" ? block.text : "")).join("").trim();
    if (!text) throw new Error(`${who} gave an empty answer.`);
    return text;
  }

  async step(input: AgentStepInput): Promise<AgentStepResult> {
    if (this.custom) return this.plainStep(input);
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
