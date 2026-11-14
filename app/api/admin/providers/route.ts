import { readJson, withSession } from "@/lib/server/http";
import {
  OfficeError,
  removeProviderSettings,
  saveProviderSettings,
  testProviderSettings,
} from "@/lib/server/officeService";

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Add, change, remove or test one of the office's AI providers.
 * An API key can be sent in, and is never sent back.
 */
export async function POST(request: Request) {
  return withSession(request, async (session) => {
    const body = await readJson(request);
    switch (body?.operation) {
      case "save": {
        const kind = body.kind;
        if (kind !== "anthropic" && kind !== "openai_compatible") throw new OfficeError(400, "Choose a provider type.");
        return saveProviderSettings(session, {
          ...(typeof body.id === "string" ? { id: body.id } : {}),
          name: text(body.name),
          kind,
          baseUrl: text(body.baseUrl),
          defaultModel: text(body.defaultModel),
          ...(typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {}),
          removeKey: body.removeKey === true,
        });
      }
      case "remove":
        return removeProviderSettings(session, text(body.id));
      case "test":
        return testProviderSettings(session, text(body.id));
      default:
        throw new OfficeError(400, "Unknown operation.");
    }
  });
}
