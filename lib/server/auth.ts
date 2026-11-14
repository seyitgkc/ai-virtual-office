/**
 * Accounts and sessions.
 *
 * Passwords are stored as scrypt hashes with a per-password salt. A session is
 * a signed JWT kept in an HttpOnly cookie. The token says who the person is.
 * It does not say what they may do: permissions are resolved from the
 * database on every request, so a role change or a revoked rule takes effect
 * at once. Each token also has a row in `sessions`, which is what makes
 * signing out and revoking possible for a token that is otherwise stateless.
 */
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SignJWT, jwtVerify } from "jose";
import { all, databasePath, get, run, type Db } from "./db";

export const SESSION_COOKIE = "office_session";
export const SESSION_HOURS = 12;
const ISSUER = "ai-virtual-office";
const SESSION_AUDIENCE = "session";

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, keyLength: 64 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keyLength, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A password policy small enough to state in one sentence on the form. */
export function passwordProblem(password: string): string | null {
  if (password.length < 10) return "Use at least 10 characters.";
  if (password.length > 200) return "Use at most 200 characters.";
  return null;
}

// ---------------------------------------------------------------------------
// Signing key
// ---------------------------------------------------------------------------

const keyHolder = globalThis as unknown as { __officeAuthKey?: Uint8Array };

/**
 * The key that signs every token. Taken from AUTH_SECRET when set. Otherwise
 * a random key is generated once and kept in a file next to the database, so
 * tokens survive a restart without a secret ever living in the repository.
 */
export function signingKey(): Uint8Array {
  if (keyHolder.__officeAuthKey) return keyHolder.__officeAuthKey;

  let secret = process.env.AUTH_SECRET;
  if (secret && secret.length < 32) {
    throw new Error("AUTH_SECRET must be at least 32 characters.");
  }
  if (!secret) {
    const file = join(dirname(databasePath()), "auth-secret");
    if (existsSync(file)) {
      secret = readFileSync(file, "utf8").trim();
    } else {
      secret = randomBytes(48).toString("base64url");
      writeFileSync(file, secret, { mode: 0o600 });
    }
  }
  keyHolder.__officeAuthKey = new TextEncoder().encode(secret);
  return keyHolder.__officeAuthKey;
}

/** For tests: use a fixed key instead of reading the environment or disk. */
export function useSigningKeyForTests(secret: string): void {
  keyHolder.__officeAuthKey = new TextEncoder().encode(secret);
}

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

// ---------------------------------------------------------------------------
// Users and seats
// ---------------------------------------------------------------------------

/** A sign-in. It exists on its own and may hold a seat in several offices. */
export interface User {
  id: string;
  email: string;
  displayName: string;
  hasPassword: boolean;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  hasPassword: row.password_hash !== null,
});

export function createUser(
  db: Db,
  input: { email: string; displayName: string; password: string | null },
): User {
  const id = `u-${randomUUID()}`;
  const email = input.email.trim().toLowerCase();
  run(
    db,
    "INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)",
    id,
    email,
    input.password === null ? null : hashPassword(input.password),
    input.displayName,
    Date.now(),
  );
  return { id, email, displayName: input.displayName, hasPassword: input.password !== null };
}

export function setPassword(db: Db, userId: string, password: string): void {
  run(db, "UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(password), userId);
}

export function userByEmail(db: Db, email: string): User | null {
  const row = get<UserRow>(db, "SELECT * FROM users WHERE email = ?", email.trim().toLowerCase());
  return row ? toUser(row) : null;
}

export function userById(db: Db, id: string): User | null {
  const row = get<UserRow>(db, "SELECT * FROM users WHERE id = ?", id);
  return row ? toUser(row) : null;
}

/** The sign-in that holds this seat, if any. */
export function userByParticipant(db: Db, participantId: string): User | null {
  const row = get<UserRow>(
    db,
    "SELECT u.* FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.participant_id = ?",
    participantId,
  );
  return row ? toUser(row) : null;
}

/** Give a user the seat of one human participant. */
export function addMembership(db: Db, userId: string, participantId: string): void {
  run(db, "INSERT INTO memberships (participant_id, user_id) VALUES (?, ?)", participantId, userId);
}

export interface Seat {
  participantId: string;
  officeId: string;
  officeName: string;
  supervises: boolean;
}

/** Every office this user has a seat in, oldest first. */
export function seatsOf(db: Db, userId: string): Seat[] {
  return all<{ participant_id: string; office_id: string; name: string; supervises: number }>(
    db,
    `SELECT m.participant_id, p.office_id, o.name, r.supervises
       FROM memberships m
       JOIN participants p ON p.id = m.participant_id
       JOIN offices o ON o.id = p.office_id
       JOIN roles r ON r.id = p.role_id
      WHERE m.user_id = ?
      ORDER BY o.rowid`,
    userId,
  ).map((r) => ({
    participantId: r.participant_id,
    officeId: r.office_id,
    officeName: r.name,
    supervises: r.supervises === 1,
  }));
}

/** Sign-ins that hold a seat in this office. */
export function usersInOffice(db: Db, officeId: string): (User & { participantId: string })[] {
  return all<UserRow & { participant_id: string }>(
    db,
    `SELECT u.*, m.participant_id
       FROM users u
       JOIN memberships m ON m.user_id = u.id
       JOIN participants p ON p.id = m.participant_id
      WHERE p.office_id = ?
      ORDER BY u.created_at`,
    officeId,
  ).map((row) => ({ ...toUser(row), participantId: row.participant_id }));
}

/** Check an email and password. The same answer is given for every failure. */
export function authenticate(db: Db, email: string, password: string): User | null {
  const row = get<UserRow>(db, "SELECT * FROM users WHERE email = ?", email.trim().toLowerCase());
  // Hash even when the account is missing, so timing does not reveal which
  // addresses exist.
  const stored = row?.password_hash ?? hashPasswordForTiming();
  const ok = verifyPassword(password, stored);
  return row && row.password_hash && ok ? toUser(row) : null;
}

let timingHash: string | null = null;
function hashPasswordForTiming(): string {
  timingHash ??= hashPassword(randomBytes(12).toString("hex"));
  return timingHash;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface Session {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  /** False for a demo account, which has no password. */
  hasPassword: boolean;
  /** The seat this session is looking at, or null when the user has no office. */
  participantId: string | null;
  officeId: string | null;
  expiresAt: number;
}

/** Create a session row and return the signed token for the cookie. */
export async function issueSession(
  db: Db,
  user: User,
  participantId: string | null,
): Promise<{ token: string; expiresAt: number }> {
  const sessionId = randomUUID();
  const issuedAt = Date.now();
  const expiresAt = issuedAt + SESSION_HOURS * 3_600_000;
  run(
    db,
    "INSERT INTO sessions (id, user_id, issued_at, expires_at, participant_id) VALUES (?, ?, ?, ?, ?)",
    sessionId,
    user.id,
    issuedAt,
    expiresAt,
    participantId,
  );
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setSubject(user.id)
    .setJti(sessionId)
    .setIssuedAt(Math.floor(issuedAt / 1000))
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .sign(signingKey());
  return { token, expiresAt };
}

/**
 * Verify a session token: the signature, the expiry, and that its row still
 * exists and has not been revoked. Returns null for anything else.
 *
 * The seat is checked on every read. If the session's seat is gone, or was
 * never set, it moves to the user's first remaining office.
 */
export async function readSession(db: Db, token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  let sessionId: string | undefined;
  try {
    const { payload } = await jwtVerify(token, signingKey(), {
      issuer: ISSUER,
      audience: SESSION_AUDIENCE,
      algorithms: ["HS256"],
    });
    sessionId = payload.jti;
  } catch {
    return null;
  }
  if (!sessionId) return null;

  const row = get<{
    id: string;
    user_id: string;
    expires_at: number;
    revoked_at: number | null;
    participant_id: string | null;
  }>(db, "SELECT * FROM sessions WHERE id = ?", sessionId);
  if (!row || row.revoked_at !== null || row.expires_at <= Date.now()) return null;
  const user = userById(db, row.user_id);
  if (!user) return null;

  const seats = seatsOf(db, user.id);
  let seat = seats.find((s) => s.participantId === row.participant_id) ?? null;
  if (!seat && seats.length > 0) {
    seat = seats[0];
    run(db, "UPDATE sessions SET participant_id = ? WHERE id = ?", seat.participantId, row.id);
  }
  return {
    sessionId: row.id,
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    hasPassword: user.hasPassword,
    participantId: seat?.participantId ?? null,
    officeId: seat?.officeId ?? null,
    expiresAt: row.expires_at,
  };
}

/** Point a session at another of the user's seats. False when it is not theirs. */
export function switchSeat(db: Db, session: Session, officeId: string): boolean {
  const seat = seatsOf(db, session.userId).find((s) => s.officeId === officeId);
  if (!seat) return false;
  run(db, "UPDATE sessions SET participant_id = ? WHERE id = ?", seat.participantId, session.sessionId);
  return true;
}

export function revokeSession(db: Db, sessionId: string): void {
  run(db, "UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", Date.now(), sessionId);
}

// ---------------------------------------------------------------------------
// Sign-in throttling
// ---------------------------------------------------------------------------

const attempts = new Map<string, number[]>();
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 8;

/** True when this key (an address plus an email) has tried too often. */
export function tooManyAttempts(key: string): boolean {
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  attempts.set(key, recent);
  return recent.length > MAX_ATTEMPTS;
}
