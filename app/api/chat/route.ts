import { readJson, withSession } from "@/lib/server/http";
import { markOpened, sendDirectMessage } from "@/lib/server/officeService";

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Send a direct message to a person or an agent, or mark a conversation or a
 * note as opened. An agent's reply comes back in the view.
 */
export async function POST(request: Request) {
  return withSession(request, async (session) => {
    const body = await readJson(request);
    if (body?.operation === "read") {
      return markOpened(session, { otherId: text(body.otherId) || undefined, noteId: text(body.noteId) || undefined });
    }
    return sendDirectMessage(session, text(body?.toId), text(body?.body));
  });
}
