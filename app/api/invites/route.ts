import { readJson, withSession } from "@/lib/server/http";
import { createInvite, renewInvite, withdrawInvite } from "@/lib/server/invites";
import { OfficeError } from "@/lib/server/officeService";

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Invite a person, give a waiting invitation a new link, or withdraw one.
 * A link is sent back once, when it is made, and is never stored.
 */
export async function POST(request: Request) {
  return withSession(request, async (session) => {
    const body = await readJson(request);
    switch (body?.operation ?? "create") {
      case "create":
        return createInvite(session, {
          displayName: text(body?.displayName),
          title: text(body?.title),
          roleId: text(body?.roleId),
          roomId: text(body?.roomId),
        });
      case "renew":
        return renewInvite(session, text(body?.inviteId));
      case "withdraw":
        return withdrawInvite(session, text(body?.inviteId));
      default:
        throw new OfficeError(400, "Unknown operation.");
    }
  });
}
