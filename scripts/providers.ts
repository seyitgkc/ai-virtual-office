/**
 * Checks how a playbook agent picks its step, and how an AI agent talks to an
 * OpenAI compatible service and to an Anthropic compatible one. The services
 * are stand-ins started on this machine, so nothing leaves it. Run: npx tsx scripts/providers.ts
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { reduce, type AgentRuntime, type AgentStepInput, type AgentStepResult } from "../lib/engine";
import { initialState } from "../lib/initialState";
import type { PlaybookStep } from "../lib/model";
import { runPlaybook, stepApplies } from "../lib/playbook";
import { ModelRuntime, testProvider } from "../lib/server/modelRuntime";
import { OpenAiCompatibleRuntime, testOpenAiCompatible } from "../lib/server/openaiRuntime";

let failures = 0;
function expect(label: string, actual: unknown, wanted: unknown): void {
  const ok = actual === wanted;
  if (!ok) failures++;
  console.log(`${ok ? "pass" : "FAIL"}  ${label}${ok ? "" : `  (got ${String(actual)})`}`);
}

const body = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => resolve(text));
  });

const errorOf = async (work: () => Promise<unknown>): Promise<string | null> => {
  try {
    await work();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

async function main(): Promise<void> {
  // Capture a real step input by letting the engine run one step.
  let input!: AgentStepInput;
  const capture: AgentRuntime = {
    step: async (i): Promise<AgentStepResult> => {
      input = i;
      return { questions: [], assumptions: [] };
    },
  };
  await reduce(
    initialState,
    { type: "SUBMIT_REQUEST", title: "Return of two heads", detail: "Northline sends two units back.", requestedById: "p-sam" },
    capture,
  );

  console.log("\n-- which playbook step applies --");
  const step = (when: Partial<PlaybookStep["when"]>, note: string, then: Partial<PlaybookStep["then"]> = {}): PlaybookStep => ({
    id: `pb-${note}`,
    when: { stage: "any", requestContains: "", requestedBy: "anyone", ...when },
    then: { statusNote: note, output: null, question: null, assumption: null, need: null, action: null, note: null, ...then },
  });
  expect("the captured step is at intake", input.stage, "intake");
  expect("a step with no conditions always applies", stepApplies(step({}, "any"), input), true);
  expect("a stage condition must match", stepApplies(step({ stage: "review" }, "x"), input), false);
  expect("request text is matched without regard to case", stepApplies(step({ requestContains: "RETURN" }, "x"), input), true);
  expect("in the title or the detail", stepApplies(step({ requestContains: "two units" }, "x"), input), true);
  expect("and fails when absent", stepApplies(step({ requestContains: "warranty" }, "x"), input), false);
  expect("the requester can be a condition", stepApplies(step({ requestedBy: "p-sam" }, "x"), input), true);
  expect("another requester does not match", stepApplies(step({ requestedBy: "p-dana" }, "x"), input), false);
  expect("all conditions must hold together", stepApplies(step({ stage: "intake", requestContains: "return", requestedBy: "p-dana" }, "x"), input), false);

  const withBook = (playbook: PlaybookStep[]): AgentStepInput => ({ ...input, participant: { ...input.participant, playbook } });
  const taken = runPlaybook(
    withBook([
      step({ requestContains: "warranty" }, "warranty"),
      step({ requestContains: "return" }, "returns", {
        output: { label: "Return", body: "Logged." },
        question: { body: "Which branch?", to: "requester", blocking: true, options: [] },
        need: { room: "finance", scope: "read", purpose: "Credit" },
      }),
      step({}, "fallback"),
    ]),
  );
  expect("the first step that applies is taken", taken.statusNote, "returns");
  expect("its output is posted", taken.output?.body, "Logged.");
  expect("a question for the requester goes to whoever asked", taken.questions[0].toParticipantId, "p-sam");
  expect("its access need is raised", taken.needs?.[0].room, "finance");
  expect("later steps are not reached", runPlaybook(withBook([step({}, "first"), step({}, "second")])).statusNote, "first");
  expect("with no step that applies, the agent says so", runPlaybook(withBook([step({ stage: "review" }, "x")])).statusNote?.includes("has no playbook step"), true);

  console.log("\n-- an OpenAI compatible service --");
  const seen: { path: string; auth: string | undefined; format: string | undefined; model: string }[] = [];
  let mode: "strict" | "loose" | "fenced" | "garbage" | "refuse" | "locked" = "strict";
  const answer = {
    statusNote: "Checked the request",
    questions: [{ body: "Which branch?", toParticipantId: "p-sam", blocking: true, options: [] }],
    assumptions: [],
    needs: [],
    output: { label: "Intake", body: "Two heads returned." },
    wait: { until: "2027-01-15", reason: "The stock arrives." },
  };
  const server = createServer(async (request, response) => {
    const send = (status: number, data: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(data));
    };
    if (mode === "locked") return send(401, { error: "bad key" });
    if (request.url === "/v1/models") return send(200, { data: [{ id: "small-model" }, { id: "big-model" }] });
    const sent = JSON.parse(await body(request)) as { model: string; response_format?: { type: string } };
    seen.push({ path: request.url ?? "", auth: request.headers.authorization, format: sent.response_format?.type, model: sent.model });
    // A looser service refuses a schema and then plain JSON mode.
    if (mode !== "strict" && sent.response_format) return send(400, { error: "response_format is not supported" });
    const content =
      mode === "garbage"
        ? "I would rather chat."
        : mode === "fenced"
          ? "Here you go:\n```json\n" + JSON.stringify(answer) + "\n```"
          : JSON.stringify(answer);
    send(200, { choices: [{ message: mode === "refuse" ? { content: null, refusal: "No." } : { content } }] });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const runtime = new OpenAiCompatibleRuntime({ baseUrl: `${baseUrl}/`, apiKey: "test-key-for-the-stand-in", model: "small-model" });

  let result = await runtime.step(input);
  expect("the reply becomes the agent's step", result.statusNote, "Checked the request");
  expect("with its output", result.output?.body, "Two heads returned.");
  expect("and the day it waits for, through the same reading a real reply gets", `${result.wait?.until} ${result.wait?.reason}`, "2027-01-15 The stock arrives.");
  expect("and its question", result.questions[0]?.body, "Which branch?");
  expect("the chat completions address is used", seen[0].path, "/v1/chat/completions");
  expect("the key is sent as a bearer token", seen[0].auth, "Bearer test-key-for-the-stand-in");
  expect("the agent's model is asked for", seen[0].model, "small-model");
  expect("a strict reply format is asked for first", seen[0].format, "json_schema");

  seen.length = 0;
  mode = "loose";
  result = await runtime.step(input);
  expect("a service without reply formats still works", result.output?.label, "Intake");
  expect("after falling back twice", seen.map((s) => s.format ?? "none").join(), "json_schema,json_object,none");

  mode = "fenced";
  expect("a reply wrapped in a code fence is read", (await runtime.step(input)).statusNote, "Checked the request");
  mode = "garbage";
  expect("a reply that cannot be read stops the step, after a second try", (await errorOf(() => runtime.step(input)))?.includes("could not be understood twice in a row (its answer was not valid JSON)"), true);
  mode = "refuse";
  expect("a refusal stops the step", (await errorOf(() => runtime.step(input)))?.includes("declined"), true);

  mode = "strict";
  const modeBefore = mode;
  mode = "garbage";
  seen.length = 0;
  expect(
    "in a conversation the service's plain reply is the answer",
    await runtime.chat("Nova", "You are Nova.", [{ role: "user", content: "What are you working on?" }]),
    "I would rather chat.",
  );
  expect("and no reply format is asked for", seen[0].format, undefined);
  mode = "refuse";
  expect("a refusal in a conversation is reported", (await errorOf(() => runtime.chat("Nova", "You are Nova.", [{ role: "user", content: "Hi" }])))?.includes("declined"), true);
  mode = modeBefore;

  const keyless = new OpenAiCompatibleRuntime({ baseUrl, apiKey: null, model: "small-model" });
  seen.length = 0;
  await keyless.step(input);
  expect("a service that needs no key gets no authorization header", seen[0].auth, undefined);

  expect("the connection test finds a listed model", await testOpenAiCompatible(baseUrl, null, "big-model"), "big-model");
  expect("and reports a model the service does not list", (await errorOf(() => testOpenAiCompatible(baseUrl, null, "huge-model")))?.includes("does not list"), true);
  mode = "locked";
  expect("a rejected key is reported as such", (await errorOf(() => testOpenAiCompatible(baseUrl, "wrong", "big-model")))?.includes("rejected the API key"), true);
  expect("during a step too", (await errorOf(() => runtime.step(input)))?.includes("rejected the API key"), true);
  await new Promise((resolve) => server.close(resolve));
  expect("a service that is down is reported as unreachable", (await errorOf(() => testOpenAiCompatible(baseUrl, null, "big-model")))?.includes("could not be reached"), true);

  console.log("\n-- an Anthropic compatible service at its own address --");
  const calls: { path: string; key: string | undefined; model?: string; maxTokens?: number; system?: string }[] = [];
  let listsModels = false;
  let claudeMode: "ok" | "fenced" | "garbage" | "locked" = "ok";
  const gateway = createServer(async (request, response) => {
    const send = (status: number, data: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(data));
    };
    const key = request.headers["x-api-key"] as string | undefined;
    const fault = (status: number, type: string) => send(status, { type: "error", error: { type, message: type } });
    if (claudeMode === "locked") return fault(401, "authentication_error");
    if (request.method === "GET") {
      calls.push({ path: request.url ?? "", key });
      return listsModels
        ? send(200, { id: "house-model", type: "model", display_name: "House Model", created_at: "2026-01-01T00:00:00Z" })
        : fault(404, "not_found_error");
    }
    const sent = JSON.parse(await body(request)) as { model: string; max_tokens: number; system?: string };
    calls.push({ path: request.url ?? "", key, model: sent.model, maxTokens: sent.max_tokens, system: sent.system });
    if (sent.model !== "house-model") return fault(404, "not_found_error");
    const text =
      claudeMode === "garbage"
        ? "Happy to help!"
        : claudeMode === "fenced"
          ? "```json\n" + JSON.stringify(answer) + "\n```"
          : JSON.stringify(answer);
    send(200, {
      id: "msg_stand_in",
      type: "message",
      role: "assistant",
      model: sent.model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  const claudeLike = new ModelRuntime({ apiKey: "test-key-for-the-gateway", model: "house-model", baseUrl: `${gatewayUrl}/v1/` });

  result = await claudeLike.step(input);
  expect("the reply becomes the agent's step", result.statusNote, "Checked the request");
  expect("with its output", result.output?.body, "Two heads returned.");
  expect("the Messages address is used, with one /v1 even when the address ends in it", calls[0].path, "/v1/messages");
  expect("the key is sent as an x-api-key header", calls[0].key, "test-key-for-the-gateway");
  expect("the provider's own model id is asked for", calls[0].model, "house-model");
  expect("the reply format is described in the instructions", calls[0].system?.includes("Reply with one JSON object"), true);
  const tagOf = (system: string | undefined): string => system?.match(/Everything inside <(data_[0-9a-f]{12})> tags/)?.[1] ?? "";
  const firstTag = tagOf(calls[0].system);
  await claudeLike.step(input);
  expect("each call marks data with a tag made up for that call", firstTag !== "" && tagOf(calls.at(-1)?.system) !== "" && tagOf(calls.at(-1)?.system) !== firstTag, true);
  claudeMode = "fenced";
  expect("a reply wrapped in a code fence is read", (await claudeLike.step(input)).statusNote, "Checked the request");
  claudeMode = "garbage";
  expect("a reply that cannot be read stops the step, after a second try", (await errorOf(() => claudeLike.step(input)))?.includes("could not be understood twice in a row (its answer was not valid JSON)"), true);

  calls.length = 0;
  expect(
    "in a conversation the service's plain reply is the answer",
    await claudeLike.chat("Nova", "You are Nova.", [{ role: "user", content: "What are you working on?" }]),
    "Happy to help!",
  );
  expect("with the conversation's own instructions and no reply format", calls[0].system, "You are Nova.");

  claudeMode = "ok";
  calls.length = 0;
  expect("with no model list, the test asks for a single token", await testProvider("test-key-for-the-gateway", "house-model", gatewayUrl), "house-model");
  expect("after trying the model list first", calls.map((c) => c.path).join(), "/v1/models/house-model,/v1/messages");
  expect("and never asks for more than one token", calls[1].maxTokens, 1);
  expect("an unknown model fails the test", (await errorOf(() => testProvider("test-key-for-the-gateway", "ghost-model", gatewayUrl)))?.includes("does not know that model"), true);
  listsModels = true;
  calls.length = 0;
  expect("where the service lists its models, the test reads the list", await testProvider("test-key-for-the-gateway", "house-model", gatewayUrl), "House Model");
  expect("and generates nothing", calls.length, 1);
  claudeMode = "locked";
  expect("a rejected key is reported as such", (await errorOf(() => testProvider("wrong", "house-model", gatewayUrl)))?.includes("rejected the API key"), true);
  await new Promise((resolve) => gateway.close(resolve));
  expect("a service that is down is reported as unreachable", (await errorOf(() => testProvider("k", "house-model", gatewayUrl)))?.includes("could not be reached"), true);

  console.log(`\n${failures === 0 ? "all provider checks passed" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
