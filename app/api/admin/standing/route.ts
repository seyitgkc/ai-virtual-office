import { readJson, withSession } from "@/lib/server/http";
import { changeStandingRequest, fileStandingNow, OfficeError, saveStandingRequest } from "@/lib/server/officeService";

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Set up, change, pause or remove a request the office files by itself, or
 * have one filed now.
 */
export async function POST(request: Request) {
  return withSession(request, async (session) => {
    const body = await readJson(request);
    switch (body?.operation) {
      case "save":
        return saveStandingRequest(session, {
          ...(typeof body.id === "string" ? { id: body.id } : {}),
          title: text(body.title),
          detail: text(body.detail),
          urgent: body.urgent === true,
          every: text(body.every),
          firstAt: typeof body.firstAt === "number" ? body.firstAt : Number.NaN,
        });
      case "remove":
      case "pause":
      case "resume":
        return changeStandingRequest(session, text(body.id), body.operation);
      case "file":
        return fileStandingNow(session, text(body.id));
      default:
        throw new OfficeError(400, "Unknown operation.");
    }
  });
}
