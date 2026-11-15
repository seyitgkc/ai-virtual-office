import { readJson, withSession } from "@/lib/server/http";
import { createOffice, OfficeError, removeOffice, resetDemoOffice, switchOffice } from "@/lib/server/officeService";

/** Add an office, switch to another of your offices, remove one, or reset the demo office. */
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
      case "reset_demo":
        return resetDemoOffice(session);
      default:
        throw new OfficeError(400, "Unknown operation.");
    }
  });
}
