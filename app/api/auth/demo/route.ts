import { NextResponse } from "next/server";
import { issueSession, userByParticipant } from "@/lib/server/auth";
import { fail, readJson, sameOrigin, setSessionCookie } from "@/lib/server/http";
import { demoLoginEnabled, officeDatabase } from "@/lib/server/officeService";

/** Enter as one of the seeded people, without a password. Demo offices only. */
export async function POST(request: Request): Promise<NextResponse> {
  if (!sameOrigin(request)) return fail(403, "Cross-site request refused.");
  if (!demoLoginEnabled()) return fail(403, "Demo sign-in is turned off for this office.");

  const body = await readJson(request);
  const participantId = typeof body?.participantId === "string" ? body.participantId : "";
  const db = officeDatabase();
  const user = userByParticipant(db, participantId);
  // An account that has set a password is no longer a demo account.
  if (!user || user.hasPassword) return fail(404, "That demo account is not available.");

  const { token } = await issueSession(db, user);
  await setSessionCookie(token);
  return NextResponse.json({ ok: true });
}
