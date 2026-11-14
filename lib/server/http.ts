import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { readSession, SESSION_COOKIE, SESSION_HOURS, type Session } from "./auth";
import { OfficeError, officeDatabase } from "./officeService";

/** The session behind the current request, or null when not signed in. */
export async function currentSession(): Promise<Session | null> {
  const store = await cookies();
  return readSession(officeDatabase(), store.get(SESSION_COOKIE)?.value);
}

export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  // Marked Secure whenever the visitor is on HTTPS. A reverse proxy normally
  // reports that in a forwarded header. Some proxy chains replace that header
  // with "http", so the Origin the browser sends with the sign-in request is
  // accepted as evidence too.
  const request = await headers();
  const viaHttps =
    request.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https" ||
    request.get("origin")?.startsWith("https://") === true;
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: viaHttps || process.env.COOKIE_SECURE === "1",
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/**
 * Refuse a state-changing request that did not come from this site. With a
 * SameSite cookie this is a second line of defence against forged requests.
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export const fail = (status: number, error: string): NextResponse =>
  NextResponse.json({ error }, { status });

/** Run a handler that needs a signed-in person, turning errors into responses. */
export async function withSession(
  request: Request,
  handler: (session: Session) => Promise<unknown> | unknown,
): Promise<NextResponse> {
  if (request.method !== "GET" && !sameOrigin(request)) return fail(403, "Cross-site request refused.");
  const session = await currentSession();
  if (!session) return fail(401, "Sign in to continue.");
  try {
    return NextResponse.json(await handler(session));
  } catch (error) {
    if (error instanceof OfficeError) return fail(error.status, error.message);
    console.error(error);
    return fail(500, "Something went wrong on the server.");
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
