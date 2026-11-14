import { NextResponse } from "next/server";
import { tooManyAttempts } from "@/lib/server/auth";
import { fail, readJson, sameOrigin, setSessionCookie } from "@/lib/server/http";
import { acceptInvite } from "@/lib/server/invites";
import { OfficeError } from "@/lib/server/officeService";

export async function POST(request: Request): Promise<NextResponse> {
  if (!sameOrigin(request)) return fail(403, "Cross-site request refused.");
  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (tooManyAttempts(`invite:${address}`)) return fail(429, "Too many attempts. Wait a minute and try again.");

  const body = await readJson(request);
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  try {
    const { token } = await acceptInvite(text(body?.token), text(body?.email), text(body?.password));
    await setSessionCookie(token);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof OfficeError) return fail(error.status, error.message);
    console.error(error);
    return fail(500, "Something went wrong on the server.");
  }
}
