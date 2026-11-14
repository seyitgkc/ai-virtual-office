/**
 * An AI agent's runtime for any service that speaks the OpenAI chat
 * completions API: OpenAI itself, a gateway, or a model served locally.
 *
 * It is given the same prompt as the Anthropic runtime and must return the
 * same five fields, so what an agent is shown and how its reply is checked do
 * not depend on the provider.
 */
import type { AgentRuntime, AgentStepInput, AgentStepResult } from "../engine";
import { buildStepPrompt, StepSchema, SYSTEM_PROMPT, toStepResult } from "./modelRuntime";

const TIMEOUT_MS = 120_000;

/** The reply shape, as a JSON Schema for services that can enforce one. */
const STEP_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["statusNote", "questions", "assumptions", "needs", "output"],
  properties: {
    statusNote: { type: "string" },
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["body", "toParticipantId", "blocking", "options"],
        properties: {
          body: { type: "string" },
          toParticipantId: { type: "string" },
          blocking: { type: "boolean" },
          options: { type: "array", items: { type: "string" } },
        },
      },
    },
    assumptions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["assumed", "because", "confidence"],
        properties: {
          assumed: { type: "string" },
          because: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
    needs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["room", "scope", "purpose"],
        properties: {
          room: { type: "string" },
          scope: { type: "string", enum: ["enter", "read", "act"] },
          purpose: { type: "string" },
        },
      },
    },
    output: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["label", "body"],
          properties: { label: { type: "string" }, body: { type: "string" } },
        },
        { type: "null" },
      ],
    },
  },
} as const;

const JSON_INSTRUCTIONS = `

Reply with one JSON object and nothing else. It must have exactly these fields:
"statusNote" (string), "questions" (array of objects with "body", "toParticipantId", "blocking" and "options"), "assumptions" (array of objects with "assumed", "because" and "confidence" as "low", "medium" or "high"), "needs" (array of objects with "room", "scope" as "enter", "read" or "act", and "purpose"), and "output" (an object with "label" and "body", or null). Use empty arrays where there is nothing to report.`;

const RESPONSE_FORMATS = [
  { type: "json_schema", json_schema: { name: "agent_step", strict: true, schema: STEP_JSON_SCHEMA } },
  { type: "json_object" },
  undefined,
] as const;

const headers = (apiKey: string | null): Record<string, string> => ({
  "content-type": "application/json",
  ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
});

function describeStatus(status: number, who: string): Error {
  if (status === 401 || status === 403) return new Error(`${who}: the provider rejected the API key.`);
  if (status === 404) return new Error(`${who}: the provider does not know that model or address.`);
  if (status === 429) return new Error(`${who}: rate limited by the provider. Try again in a moment.`);
  return new Error(`${who}: the provider returned an error (${status}).`);
}

/** Pull the JSON object out of a reply that may be wrapped in a code fence. */
function parseReply(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return JSON.parse(start >= 0 && end > start ? body.slice(start, end + 1) : body);
}

export class OpenAiCompatibleRuntime implements AgentRuntime {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | null;

  constructor(options: { baseUrl: string; apiKey: string | null; model: string }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
  }

  async step(input: AgentStepInput): Promise<AgentStepResult> {
    const who = `${input.participant.displayName} could not answer`;
    const messages = [
      { role: "system", content: SYSTEM_PROMPT + JSON_INSTRUCTIONS },
      { role: "user", content: buildStepPrompt(input) },
    ];

    // Services differ in how much of the reply format they can enforce. Ask
    // for the strictest form first and fall back when a service refuses it.
    let response: Response | null = null;
    for (const format of RESPONSE_FORMATS) {
      try {
        response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: headers(this.apiKey),
          body: JSON.stringify({
            model: this.model,
            messages,
            ...(format ? { response_format: format } : {}),
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw new Error(`${who}: the provider could not be reached.`);
      }
      if (response.status !== 400 && response.status !== 422) break;
    }
    if (!response || !response.ok) throw describeStatus(response?.status ?? 0, who);

    let content: unknown;
    try {
      const data = (await response.json()) as { choices?: { message?: { content?: unknown; refusal?: unknown } }[] };
      const message = data.choices?.[0]?.message;
      if (message?.refusal) throw new Error("refused");
      content = message?.content;
    } catch (error) {
      if (error instanceof Error && error.message === "refused") {
        throw new Error(`${input.participant.displayName} declined this request, so the step was not taken.`);
      }
      throw new Error(`${who}: the provider's reply could not be read.`);
    }

    let parsed;
    try {
      parsed = StepSchema.safeParse(parseReply(typeof content === "string" ? content : ""));
    } catch {
      parsed = null;
    }
    if (!parsed || !parsed.success) {
      throw new Error(`${input.participant.displayName} gave an answer in the wrong shape, so the step was not taken.`);
    }
    return toStepResult(parsed.data, input);
  }
}

/**
 * Check that the address answers and accepts the key, without generating
 * anything. Where the service lists its models, the model is looked up too.
 */
export async function testOpenAiCompatible(baseUrl: string, apiKey: string | null, model: string): Promise<string> {
  const who = "Connection test failed";
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: headers(apiKey),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error(`${who}: the provider could not be reached.`);
  }
  if (!response.ok) throw describeStatus(response.status, who);
  const data = (await response.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
  const ids = (data?.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  if (ids.length > 0 && !ids.includes(model)) {
    throw new Error(`${who}: the provider answered but does not list a model called ${model}.`);
  }
  return model;
}
