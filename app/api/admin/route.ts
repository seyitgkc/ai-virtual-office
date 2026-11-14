import { parseAdminOp } from "@/lib/admin";
import { readJson, withSession } from "@/lib/server/http";
import { applyAdminOperation, OfficeError } from "@/lib/server/officeService";

/** Change how the office is set up: rooms, roles, people and agents. */
export async function POST(request: Request) {
  return withSession(request, async (session) => {
    const op = parseAdminOp((await readJson(request))?.op);
    if (!op) throw new OfficeError(400, "That is not a valid change.");
    return applyAdminOperation(session, op);
  });
}
