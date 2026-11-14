import { readJson, withSession } from "@/lib/server/http";
import { createOffice, OfficeError, removeOffice, switchOffice } from "@/lib/server/officeService";

/** Add an office, switch to another of your offices, or remove one. */
export async function POST(request: Request) {
  return withSession(request, async (session) => {
    const body = await readJson(request);
    const officeId = typeof body?.officeId === "string" ? body.officeId : "";
    switch (body?.operation) {
      case "create":
        return createOffice(session, typeof body.name === "string" ? body.name : "");
      case "switch":
        switchOffice(session, officeId);
        return { ok: true };
      case "remove":
        return removeOffice(session, officeId);
      default:
        throw new OfficeError(400, "Unknown operation.");
    }
  });
}
