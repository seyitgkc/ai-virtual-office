import { readJson, withSession } from "@/lib/server/http";
import { talkToAgent } from "@/lib/server/officeService";

/** Say something to an agent at its desk. The reply comes back in the view. */
export async function POST(request: Request) {
  return withSession(request, async (session) => {
    const body = await readJson(request);
    return talkToAgent(
      session,
      typeof body?.agentId === "string" ? body.agentId : "",
      typeof body?.body === "string" ? body.body : "",
    );
  });
}
