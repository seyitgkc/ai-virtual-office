import { readJson, withSession } from "@/lib/server/http";
import { createInvite } from "@/lib/server/invites";

const text = (value: unknown): string => (typeof value === "string" ? value : "");

export async function POST(request: Request) {
  return withSession(request, async (session) => {
    const body = await readJson(request);
    return createInvite(session, {
      displayName: text(body?.displayName),
      title: text(body?.title),
      roleId: text(body?.roleId),
      roomId: text(body?.roomId),
    });
  });
}
