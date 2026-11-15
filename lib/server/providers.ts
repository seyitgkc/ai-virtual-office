/**
 * The AI providers an office has connected, and the runtime an AI agent gets
 * from its provider.
 *
 * An office can hold several providers of two kinds: Anthropic, and anything
 * that speaks the OpenAI chat completions API. Each AI agent names the one it
 * uses. API keys are stored encrypted and never leave the server.
 */
import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "../engine";
import type { Participant } from "../model";
import type { ProviderKind, ProviderView } from "../view";
import { all, get, run, type Db } from "./db";
import { ModelRuntime, testProvider, validModelId } from "./modelRuntime";
import { OpenAiCompatibleRuntime, testOpenAiCompatible } from "./openaiRuntime";
import { seal, unseal } from "./secrets";

interface ProviderRow {
  id: string;
  office_id: string;
  name: string;
  kind: ProviderKind;
  base_url: string | null;
  default_model: string;
  api_key_cipher: string | null;
  key_hint: string | null;
  updated_at: number;
}

/** Thrown for input a person can correct. The message is shown to them. */
export class ProviderError extends Error {}

const rows = (db: Db, officeId: string): ProviderRow[] =>
  all<ProviderRow>(db, "SELECT * FROM ai_providers WHERE office_id = ? ORDER BY position", officeId);

const row = (db: Db, officeId: string, id: string): ProviderRow | undefined =>
  get<ProviderRow>(db, "SELECT * FROM ai_providers WHERE office_id = ? AND id = ?", officeId, id);

export const providerIds = (db: Db, officeId: string): Set<string> => new Set(rows(db, officeId).map((r) => r.id));

/** A provider can be used once it holds a readable key, or needs none. */
const usable = (r: ProviderRow): boolean =>
  unseal(r.api_key_cipher) !== null || (r.kind === "openai_compatible" && r.api_key_cipher === null);

/** The providers of an office, without their keys. */
export function providerViews(db: Db, officeId: string): ProviderView[] {
  return rows(db, officeId).map((r) => {
    const key = unseal(r.api_key_cipher);
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      baseUrl: r.base_url,
      defaultModel: r.default_model,
      hasKey: key !== null,
      keyHint: key !== null ? r.key_hint : null,
      keyUnreadable: r.api_key_cipher !== null && key === null,
      usable: usable(r),
    };
  });
}

/** Refuse addresses that are malformed or point at a machine's own metadata. */
export function checkedBaseUrl(input: string, whose = "the provider's"): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ProviderError(`Enter ${whose} address, starting with https:// or http://.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProviderError("The address must start with https:// or http://.");
  }
  if (url.username || url.password) throw new ProviderError("Do not put a user name or password in the address.");
  if (/^169\.254\./.test(url.hostname) || url.hostname === "metadata.google.internal") {
    throw new ProviderError("That address is not allowed.");
  }
  return url.toString().replace(/\/+$/, "");
}

export interface ProviderInput {
  id?: string;
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  defaultModel: string;
  apiKey?: string;
  removeKey?: boolean;
}

/** Add a provider, or change one when `id` is given. Returns its id. */
export function saveProvider(db: Db, officeId: string, input: ProviderInput): string {
  const existing = input.id ? row(db, officeId, input.id) : undefined;
  if (input.id && !existing) throw new ProviderError("That AI provider does not exist in this office.");
  if (!existing && rows(db, officeId).length >= 12) throw new ProviderError("An office can hold up to 12 AI providers.");

  const name = input.name.trim();
  if (name.length < 2 || name.length > 40) throw new ProviderError("Give the provider a name (2 to 40 characters).");
  if (input.kind !== "anthropic" && input.kind !== "openai_compatible") throw new ProviderError("Choose a provider type.");
  // An Anthropic provider may sit at its own address: a gateway or another
  // service that speaks the same interface. Its model ids are its own.
  const baseUrl =
    input.kind === "openai_compatible" || input.baseUrl?.trim() ? checkedBaseUrl(input.baseUrl ?? "") : null;
  const model = input.defaultModel.trim();
  const official = input.kind === "anthropic" && baseUrl === null;
  if (official ? !validModelId(model) : !/^[\w.:/@-]{1,100}$/.test(model)) {
    throw new ProviderError(
      official ? "Enter a model id such as claude-opus-5-5." : "Enter the model id the provider expects.",
    );
  }

  const typed = input.apiKey?.trim();
  if (typed && (typed.length < 8 || typed.length > 400 || /\s/.test(typed))) {
    throw new ProviderError("That does not look like an API key.");
  }
  const cipher = input.removeKey ? null : typed ? seal(typed) : (existing?.api_key_cipher ?? null);
  const hint = input.removeKey ? null : typed ? typed.slice(-4) : (existing?.key_hint ?? null);
  if (input.kind === "anthropic" && cipher === null && !existing) {
    throw new ProviderError("An Anthropic provider needs an API key.");
  }

  const id = existing?.id ?? `prov-${randomUUID().slice(0, 8)}`;
  if (existing) {
    run(
      db,
      `UPDATE ai_providers
          SET name = ?, kind = ?, base_url = ?, default_model = ?, api_key_cipher = ?, key_hint = ?, updated_at = ?
        WHERE id = ?`,
      name,
      input.kind,
      baseUrl,
      model,
      cipher,
      hint,
      Date.now(),
      id,
    );
  } else {
    const next = get<{ next: number }>(db, "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM ai_providers");
    run(
      db,
      `INSERT INTO ai_providers
         (id, office_id, position, name, kind, base_url, default_model, api_key_cipher, key_hint, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      officeId,
      next?.next ?? 0,
      name,
      input.kind,
      baseUrl,
      model,
      cipher,
      hint,
      Date.now(),
    );
  }
  return id;
}

/** Remove a provider. Agents that used it are left with none. */
export function removeProvider(db: Db, officeId: string, id: string): string {
  const existing = row(db, officeId, id);
  if (!existing) throw new ProviderError("That AI provider does not exist in this office.");
  run(db, "DELETE FROM ai_providers WHERE id = ?", id);
  return existing.name;
}

/** Check a stored provider with the service itself. Nothing is generated. */
export async function testStoredProvider(db: Db, officeId: string, id: string): Promise<string> {
  const r = row(db, officeId, id);
  if (!r) throw new ProviderError("That AI provider does not exist in this office.");
  const key = unseal(r.api_key_cipher);
  if (r.kind === "anthropic") {
    if (!key) throw new ProviderError("No readable API key is stored for this provider.");
    return testProvider(key, r.default_model, r.base_url);
  }
  return testOpenAiCompatible(r.base_url ?? "", key, r.default_model);
}

const cache = new Map<string, { stamp: string; runtime: AgentRuntime }>();

/**
 * The runtime for one AI agent, from the provider it names. Throws a plain
 * sentence when the agent has no provider or the provider cannot be used.
 */
export function runtimeForAgent(db: Db, officeId: string, agent: Participant): AgentRuntime {
  const r = agent.providerId ? row(db, officeId, agent.providerId) : undefined;
  if (!r) {
    throw new Error(
      `${agent.displayName} has no AI provider. Choose one under Settings, People and agents.`,
    );
  }
  const key = unseal(r.api_key_cipher);
  if (!usable(r)) {
    throw new Error(`${agent.displayName}'s provider, ${r.name}, has no readable API key. Enter it again in Settings.`);
  }
  const model = agent.model ?? r.default_model;
  const stamp = `${r.updated_at}:${model}`;
  const cached = cache.get(`${r.id}:${model}`);
  if (cached && cached.stamp === stamp) return cached.runtime;

  const runtime: AgentRuntime =
    r.kind === "anthropic"
      ? new ModelRuntime({ apiKey: key!, model, baseUrl: r.base_url })
      : new OpenAiCompatibleRuntime({ baseUrl: r.base_url ?? "", apiKey: key, model });
  cache.set(`${r.id}:${model}`, { stamp, runtime });
  return runtime;
}
