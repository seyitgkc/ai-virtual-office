import { NextResponse } from "next/server";
import { revokeSession } from "@/lib/server/auth";
import { clearSessionCookie, currentSession, fail, sameOrigin } from "@/lib/server/http";
import { officeDatabase } from "@/lib/server/officeService";

export async function POST(request: Request): Promise<NextResponse> {
  if (!sameOrigin(request)) return fail(403, "Cross-site request refused.");
  const session = await currentSession();
  if (session) revokeSession(officeDatabase(), session.sessionId);
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
