import { NextResponse } from "next/server";
import { issueSession, seatsOf, userByParticipant } from "@/lib/server/auth";
import { fail, readJson, sameOrigin, setSessionCookie } from "@/lib/server/http";
import { demoLoginEnabled, isDemoOffice, officeDatabase } from "@/lib/server/officeService";

/** Enter the demo office as one of its seeded people, without a password. */
export async function POST(request: Request): Promise<NextResponse> {
  if (!sameOrigin(request)) return fail(403, "Cross-site request refused.");
  if (!demoLoginEnabled()) return fail(403, "Demo sign-in is turned off.");

  const body = await readJson(request);
  const participantId = typeof body?.participantId === "string" ? body.participantId : "";
  const db = officeDatabase();
  const user = userByParticipant(db, participantId);
  // Only a password-free account with a seat in the demo office qualifies.
  const seat = user ? seatsOf(db, user.id).find((s) => s.participantId === participantId) : undefined;
  if (!user || user.hasPassword || !seat || !isDemoOffice(seat.officeId)) {
    return fail(404, "That demo account is not available.");
  }

  const { token } = await issueSession(db, user, participantId);
  await setSessionCookie(token);
  return NextResponse.json({ ok: true });
}
