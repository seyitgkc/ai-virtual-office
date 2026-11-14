import { readJson, setSessionCookie, withSession } from "@/lib/server/http";
import { OfficeError, startOver } from "@/lib/server/officeService";

/** Replace the office with an empty one or with the demo. */
export async function POST(request: Request) {
  return withSession(request, async (session) => {
    const kind = (await readJson(request))?.kind;
    if (kind !== "empty" && kind !== "demo") throw new OfficeError(400, "Choose empty or demo.");
    const { token } = await startOver(session, kind);
    await setSessionCookie(token);
    return { ok: true };
  });
}
