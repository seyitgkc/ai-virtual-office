import { readJson, withSession } from "@/lib/server/http";
import {
  OfficeError,
  readSystemRecords,
  removeSystemSettings,
  saveSystemSettings,
} from "@/lib/server/officeService";
import { SYSTEM_KINDS, type SystemKind } from "@/lib/systems";

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Connect, change or disconnect a system in one of the office's rooms, or
 * read what one holds right now. An API key can be sent in, and is never sent
 * back.
 */
export async function POST(request: Request) {
  return withSession(request, async (session) => {
    const body = await readJson(request);
    switch (body?.operation) {
      case "save": {
        if (!SYSTEM_KINDS.includes(body.kind as SystemKind)) throw new OfficeError(400, "Choose what kind of system this is.");
        return saveSystemSettings(session, {
          ...(typeof body.id === "string" ? { id: body.id } : {}),
          name: text(body.name),
          kind: body.kind as SystemKind,
          roomId: text(body.roomId),
          baseUrl: text(body.baseUrl),
          ...(typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {}),
        });
      }
      case "remove":
        return removeSystemSettings(session, text(body.id));
      case "read":
        return readSystemRecords(session, text(body.id));
      default:
        throw new OfficeError(400, "Unknown operation.");
    }
  });
}
