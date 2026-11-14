import { NextResponse } from "next/server";
import { authenticate, issueSession, tooManyAttempts } from "@/lib/server/auth";
import { fail, readJson, sameOrigin, setSessionCookie } from "@/lib/server/http";
import { officeDatabase } from "@/lib/server/officeService";

export async function POST(request: Request): Promise<NextResponse> {
  if (!sameOrigin(request)) return fail(403, "Cross-site request refused.");
  const body = await readJson(request);
  const email = typeof body?.email === "string" ? body.email : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email || !password) return fail(400, "Enter your email and password.");

  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (tooManyAttempts(`${address}:${email.toLowerCase()}`)) {
    return fail(429, "Too many attempts. Wait a minute and try again.");
  }

  const db = officeDatabase();
  const user = authenticate(db, email, password);
  if (!user) return fail(401, "That email and password do not match an account.");

  const { token } = await issueSession(db, user);
  await setSessionCookie(token);
  return NextResponse.json({ ok: true });
}
