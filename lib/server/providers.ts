/**
 * The AI providers an office has connected, and the runtime an AI agent gets
 * from its provider.
 *
 * An office can hold several providers. A provider is any service that speaks
 * one of two interfaces, OpenAI chat completions or Anthropic Messages, and
 * both kinds are set up the same way: an address, a model id and a key if the
 * service wants one. Each AI agent names the provider it uses. API keys are
 * stored encrypted and never leave the server.
 */
import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "../engine";
import type { Participant } from "../model";
import type { ProviderKind, ProviderView } from "../view";
import { all, get, run, type Db } from "./db";
import { ModelRuntime, testProvider, type ConversationRuntime } from "./modelRuntime";
import { OpenAiCompatibleRuntime, testOpenAiCompatible } from "./openaiRuntime";
import { seal, unseal } from "./secrets";

interface ProviderRow {
  id: string;
  office_id: string | null;
  owner_user_id: string | null;
  name: string;
  kind: ProviderKind;
  base_url: string;
  default_model: string;
  api_key_cipher: string | null;
  key_hint: string | null;
  updated_at: number;
}

/** Thrown for input a person can correct. The message is shown to them. */
export class ProviderError extends Error {}

/** Who a provider belongs to: one office, or one account. */
export type ProviderOwner = { officeId: string } | { userId: string };

const rows = (db: Db, owner: ProviderOwner): ProviderRow[] =>
  "officeId" in owner
    ? all<ProviderRow>(db, "SELECT * FROM ai_providers WHERE office_id = ? ORDER BY position", owner.officeId)
    : all<ProviderRow>(db, "SELECT * FROM ai_providers WHERE owner_user_id = ? ORDER BY position", owner.userId);

const row = (db: Db, owner: ProviderOwner, id: string): ProviderRow | undefined =>
  rows(db, owner).find((r) => r.id === id);

/**
 * Providers that belong to an account and can be used in this office: those
 * whose owner has a seat here.
 */
const sharedRows = (db: Db, officeId: string): (ProviderRow & { owner_name: string })[] =>
  all<ProviderRow & { owner_name: string }>(
    db,
    `SELECT v.*, u.display_name AS owner_name
       FROM ai_providers v
       JOIN users u ON u.id = v.owner_user_id
      WHERE v.owner_user_id IN (
              SELECT m.user_id FROM memberships m JOIN participants p ON p.id = m.participant_id
               WHERE p.office_id = ?)
      ORDER BY v.position`,
    officeId,
  );

/** A provider an agent in this office can run on, wherever it belongs. */
const usableIn = (db: Db, officeId: string, id: string): ProviderRow | undefined =>
  row(db, { officeId }, id) ?? sharedRows(db, officeId).find((r) => r.id === id);

/**
 * The providers this person may give to an agent here: the office's own, the
 * ones from their own account, and other people's when their role allows it.
 */
export function providerIds(db: Db, officeId: string, userId: string, mayUseOthers: boolean): Set<string> {
  return new Set([
    ...rows(db, { officeId }).map((r) => r.id),
    ...sharedRows(db, officeId)
      .filter((r) => mayUseOthers || r.owner_user_id === userId)
      .map((r) => r.id),
  ]);
}

/** A provider can be used once it holds a readable key, or needs none. */
/** A provider can be used when its key can be read, or when it was given none. */
const usable = (r: ProviderRow): boolean => unseal(r.api_key_cipher) !== null || r.api_key_cipher === null;

const toView = (r: ProviderRow, sharedBy: string | null, selectable: boolean): ProviderView => {
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
    sharedBy,
    selectable,
  };
};

/**
 * The providers agents in an office can run on, without their keys: the
 * office's own, then those brought in from the accounts of people seated
 * here. A key's last characters are shown only to its owner.
 */
export function providerViews(db: Db, officeId: string, userId: string, mayUseOthers: boolean): ProviderView[] {
  return [
    ...rows(db, { officeId }).map((r) => toView(r, null, true)),
    ...sharedRows(db, officeId).map((r) => {
      const mine = r.owner_user_id === userId;
      const view = toView(r, mine ? "you" : r.owner_name, mine || mayUseOthers);
      return mine ? view : { ...view, keyHint: null, baseUrl: null };
    }),
  ];
}

/** The providers that belong to one account, without their keys. */
export const accountProviderViews = (db: Db, userId: string): ProviderView[] =>
  rows(db, { userId }).map((r) => toView(r, "you", true));

/**
 * Whether addresses inside the server's own network may be named. They may
 * when the installation is private, with sign-up turned off, or when it says
 * so outright. A server that lets anyone create an account must not fetch
 * whatever internal address such an account types in.
 */
export const internalAddressesAllowed = (): boolean =>
  process.env.ALLOW_PRIVATE_ADDRESSES === "1" || process.env.SIGNUP === "0";

/**
 * True for a host that can only be inside the server's own network: this
 * machine, a private or link-local range, or a name with no dot in it, which
 * is how one container reaches another. A public name that resolves to a
 * private address is not caught here.
 */
export function internalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "" || host === "localhost" || /\.(localhost|local|internal|lan|home|intranet)$/.test(host)) return true;
  if (host.includes(":")) {
    // IPv6: loopback, unspecified, unique local, link-local, and IPv4 written inside IPv6.
    if (host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true;
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? internalHost(mapped[1]) : /^::ffff:/.test(host);
  }
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  // A whole number is an IPv4 address in another spelling. A single label is a local name.
  return /^(0x[0-9a-f]+|\d+)$/.test(host) || !host.includes(".");
}

/**
 * Refuse addresses that are malformed, point at a machine's own metadata, or
 * lie inside the server's own network. `kept` is the address already stored
 * for the thing being changed: saving it again unchanged is always allowed,
 * so a system the server connected by itself can still be edited.
 */
export function checkedBaseUrl(input: string, whose = "the provider's", kept: string | null = null): string {
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
  const address = url.toString().replace(/\/+$/, "");
  if (address !== kept && !internalAddressesAllowed() && internalHost(url.hostname)) {
    throw new ProviderError(
      "That address is inside the server's own network, which this server does not call. Use an address that is reachable from the internet.",
    );
  }
  return address;
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
export function saveProvider(db: Db, owner: ProviderOwner, input: ProviderInput): string {
  const existing = input.id ? row(db, owner, input.id) : undefined;
  if (input.id && !existing) throw new ProviderError("That AI provider does not exist here.");
  if (!existing && rows(db, owner).length >= 12) {
    throw new ProviderError(`${"officeId" in owner ? "An office" : "An account"} can hold up to 12 AI providers.`);
  }

  const name = input.name.trim();
  if (name.length < 2 || name.length > 40) throw new ProviderError("Give the provider a name (2 to 40 characters).");
  if (input.kind !== "anthropic_compatible" && input.kind !== "openai_compatible") {
    throw new ProviderError("Choose the interface the provider speaks.");
  }
  // Every provider is set up the same way: the address of its API, the model
  // id it expects, and its key if it wants one. No service is assumed.
  const baseUrl = checkedBaseUrl(input.baseUrl ?? "", "the provider's", existing?.base_url ?? null);
  const model = input.defaultModel.trim();
  if (!/^[\w.:/@-]{1,100}$/.test(model)) throw new ProviderError("Enter the model id the provider expects.");

  const typed = input.apiKey?.trim();
  if (typed && (typed.length < 8 || typed.length > 400 || /\s/.test(typed))) {
    throw new ProviderError("That does not look like an API key.");
  }
  const cipher = input.removeKey ? null : typed ? seal(typed) : (existing?.api_key_cipher ?? null);
  const hint = input.removeKey ? null : typed ? typed.slice(-4) : (existing?.key_hint ?? null);

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
         (id, office_id, owner_user_id, position, name, kind, base_url, default_model, api_key_cipher, key_hint, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      "officeId" in owner ? owner.officeId : null,
      "userId" in owner ? owner.userId : null,
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
export function removeProvider(db: Db, owner: ProviderOwner, id: string): string {
  const existing = row(db, owner, id);
  if (!existing) throw new ProviderError("That AI provider does not exist here.");
  run(db, "DELETE FROM ai_providers WHERE id = ?", id);
  return existing.name;
}

/** Check a stored provider with the service itself. Nothing is generated. */
export async function testStoredProvider(db: Db, owner: ProviderOwner, id: string): Promise<string> {
  const r = row(db, owner, id);
  if (!r) throw new ProviderError("That AI provider does not exist here.");
  const key = unseal(r.api_key_cipher);
  return r.kind === "anthropic_compatible"
    ? testProvider(key, r.default_model, r.base_url)
    : testOpenAiCompatible(r.base_url, key, r.default_model);
}

const cache = new Map<string, { stamp: string; runtime: ConversationRuntime }>();

/**
 * The runtime for one AI agent, from the provider it names. Throws a plain
 * sentence when the agent has no provider or the provider cannot be used.
 */
export function runtimeForAgent(db: Db, officeId: string, agent: Participant): ConversationRuntime {
  const r = agent.providerId ? usableIn(db, officeId, agent.providerId) : undefined;
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

  const runtime: ConversationRuntime =
    r.kind === "anthropic_compatible"
      ? new ModelRuntime({ apiKey: key, model, baseUrl: r.base_url })
      : new OpenAiCompatibleRuntime({ baseUrl: r.base_url, apiKey: key, model });
  cache.set(`${r.id}:${model}`, { stamp, runtime });
  return runtime;
}
