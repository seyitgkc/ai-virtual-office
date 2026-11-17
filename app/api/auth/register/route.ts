import { NextResponse } from "next/server";
import { overLimit } from "@/lib/server/auth";
import { fail, readJson, sameOrigin, setSessionCookie } from "@/lib/server/http";
import { OfficeError, registerAccount, signupEnabled } from "@/lib/server/officeService";

const HOUR = 3_600_000;

/** Create an account with an empty office of its own, and sign in. */
export async function POST(request: Request): Promise<NextResponse> {
  if (!sameOrigin(request)) return fail(403, "Cross-site request refused.");
  if (!signupEnabled()) return fail(403, "Creating an account is turned off here. Ask someone in an office to invite you.");

  // A few accounts an hour from one address, and a ceiling for the whole
  // server, so that a script cannot fill the database with offices.
  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (overLimit(`signup:${address}`, 5, HOUR) || overLimit("signup:all", 60, HOUR)) {
    return fail(429, "Too many accounts were created from here in the last hour. Try again later.");
  }

  const body = await readJson(request);
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  try {
    const { token } = await registerAccount({
      displayName: text(body?.displayName),
      email: text(body?.email),
      password: text(body?.password),
    });
    await setSessionCookie(token);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof OfficeError) return fail(error.status, error.message);
    console.error(error);
    return fail(500, "Something went wrong on the server.");
  }
}
