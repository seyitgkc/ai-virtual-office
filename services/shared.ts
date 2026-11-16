/**
 * What the sample services have in common: one small HTTP server that serves
 * a manifest, the service's current records as plain lines, and the
 * operations the manifest lists.
 *
 *   GET  /health          open, for container health checks
 *   GET  /v1/manifest     what the service is for and what can be done in it
 *   GET  <recordsPath>    { lines: string[] }, the records as sentences
 *   <operation>           { summary: string, ... } on success
 *
 * Every /v1 call needs "Authorization: Bearer <API_KEY>". A call that changes
 * something may carry an Idempotency-Key header: the same key gets the same
 * answer back and changes nothing a second time. A refusal answers with
 * { error: { code, message } } and a status that says what kind it is.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface Field {
  name: string;
  label: string;
  hint: string;
  place: "path" | "body";
}

export interface Operation {
  id: string;
  label: string;
  method: "POST" | "PUT" | "DELETE";
  path: string;
  fields: Field[];
  /** The operation this one reverses, when it is the way to take that one back. */
  undoes?: string;
}

export interface Manifest {
  name: string;
  description: string;
  recordsPath: string;
  operations: Operation[];
}

/** A request the service will not carry out, with the reason a person can act on. */
export class Refusal extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type Json = Record<string, unknown>;

/**
 * What an operation answers: a sentence for people, and the record it made or
 * changed. `record` is that record's number. An operation that takes another
 * back answers with the number of the record it took back, so a caller can
 * tell which one no longer stands.
 */
export interface Done {
  summary: string;
  record?: string;
  [key: string]: unknown;
}

const send = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const readBody = (request: IncomingMessage): Promise<Json> =>
  new Promise((resolve, reject) => {
    let text = "";
    request.on("data", (chunk) => {
      text += chunk;
      if (text.length > 20_000) reject(new Refusal(413, "too_large", "The request body is too large."));
    });
    request.on("end", () => {
      try {
        const parsed: unknown = text ? JSON.parse(text) : {};
        if (!parsed || typeof parsed !== "object") throw new Error("not an object");
        resolve(parsed as Json);
      } catch {
        reject(new Refusal(400, "bad_json", "Send a JSON object."));
      }
    });
  });

/** Money as people write it: 1,240 CAD or 4,652.68 CAD. */
export const cad = (amount: number): string =>
  `${amount.toLocaleString("en-CA", { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 })} CAD`;

/** A number with its unit: 1 day, 3 days. */
export const count = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"}`;

/**
 * The lines of a list, or one line saying there are none. A reader told that
 * nothing is on record does not go on believing something it heard earlier.
 */
export const orNone = (lines: string[], none: string): string[] => (lines.length > 0 ? lines : [none]);

/** A calendar date some days from now, as YYYY-MM-DD. */
export const dayFromNow = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** Read a required piece of text from a call, or refuse. */
export function need(input: Json, name: string, what: string = name): string {
  const value = input[name];
  const text = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  if (!text) throw new Refusal(422, `missing_${name}`, `This needs ${what}.`);
  return text.slice(0, 200);
}

/** Read a required number from a call, or refuse. Units and commas are ignored. */
export function needNumber(input: Json, name: string, what: string, min: number, max: number): number {
  const value = Number(String(input[name] ?? "").replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Refusal(422, `bad_${name}`, `${what} must be a number from ${min} to ${max}.`);
  }
  return value;
}

/** Match a path against a template such as /v1/orders/{order}/cancel. */
function matchPath(template: string, path: string): Record<string, string> | null {
  const wanted = template.split("/");
  const given = path.split("/");
  if (wanted.length !== given.length) return null;
  const found: Record<string, string> = {};
  for (let i = 0; i < wanted.length; i++) {
    const name = wanted[i].match(/^\{(\w+)\}$/)?.[1];
    if (name) found[name] = decodeURIComponent(given[i]);
    else if (wanted[i] !== given[i]) return null;
  }
  return found;
}

export interface ServiceDefinition {
  apiKey: string;
  manifest: Manifest;
  /** The service's records right now, one sentence each. */
  records: () => string[];
  /** One handler per operation in the manifest, by its id. */
  operations: Record<string, (input: Json) => Done>;
  /** Further read-only endpoints, by path, for programs that want the data itself. */
  reads?: Record<string, (query: URLSearchParams) => unknown>;
  /** Put the sample data back. Called once a day, so shared use does not wear it out. */
  reset: () => void;
}

/** Build the HTTP server for one service. */
export function serve(definition: ServiceDefinition): Server {
  const { manifest } = definition;
  // What each repeat-safe request answered, by its key.
  let answered = new Map<string, Done>();
  setInterval(() => {
    answered = new Map();
    definition.reset();
  }, 24 * 60 * 60 * 1000).unref();

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://service");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (request.method === "GET" && path === "/health") {
        return send(response, 200, { ok: true, service: manifest.name });
      }
      if (request.headers.authorization !== `Bearer ${definition.apiKey}`) {
        throw new Refusal(401, "unauthorized", "Send the API key as a Bearer token.");
      }

      if (request.method === "GET") {
        if (path === "/v1/manifest") return send(response, 200, manifest);
        if (path === manifest.recordsPath) return send(response, 200, { lines: definition.records() });
        const read = definition.reads?.[path];
        if (read) return send(response, 200, read(url.searchParams));
        throw new Refusal(404, "not_found", "No such endpoint.");
      }

      for (const operation of manifest.operations) {
        if (operation.method !== request.method) continue;
        const inPath = matchPath(operation.path, path);
        if (!inPath) continue;
        const key = String(request.headers["idempotency-key"] ?? "");
        const earlier = key ? answered.get(`${operation.id}:${key}`) : undefined;
        if (earlier) {
          return send(response, 200, {
            ...earlier,
            repeated: true,
            summary: `this was already done for the same request: ${earlier.summary}`,
          });
        }
        const done = definition.operations[operation.id]({ ...(await readBody(request)), ...inPath });
        if (key) answered.set(`${operation.id}:${key}`, done);
        return send(response, 201, done);
      }
      throw new Refusal(404, "not_found", "No such endpoint.");
    } catch (error) {
      if (error instanceof Refusal) {
        return send(response, error.status, { error: { code: error.code, message: error.message } });
      }
      return send(response, 500, { error: { code: "internal", message: `${manifest.name} failed.` } });
    }
  });
}

/** Start a service when its file is the one being run. */
export function startWhenRun(moduleUrl: string, defaultPort: number, build: (apiKey: string) => Server, name: string): void {
  const entry = process.argv[1] ?? "";
  if (!entry || !moduleUrl.endsWith(entry.split("/").slice(-2).join("/"))) return;
  const apiKey = process.env.API_KEY ?? "";
  if (apiKey.length < 8) {
    console.error(`Set API_KEY (at least 8 characters) before starting the ${name}.`);
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? defaultPort);
  build(apiKey).listen(port, "0.0.0.0", () => console.log(`${name} listening on ${port}`));
}
