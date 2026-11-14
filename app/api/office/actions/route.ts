import { parseAction } from "@/lib/policy";
import { readJson, withSession } from "@/lib/server/http";
import { applyAction, OfficeError } from "@/lib/server/officeService";

export async function POST(request: Request) {
  return withSession(request, async (session) => {
    const action = parseAction((await readJson(request))?.action);
    if (!action) throw new OfficeError(400, "That is not a valid action.");
    return applyAction(session, action);
  });
}
