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
// Users
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  participantId: string;
  email: string;
  hasPassword: boolean;
}

interface UserRow {
  id: string;
  participant_id: string;
  email: string;
  password_hash: string | null;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  participantId: row.participant_id,
  email: row.email,
  hasPassword: row.password_hash !== null,
});

export function createUser(
  db: Db,
  input: { participantId: string; email: string; password: string | null },
): User {
  const id = `u-${randomUUID()}`;
  run(
    db,
    "INSERT INTO users (id, participant_id, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    id,
    input.participantId,
    input.email.trim().toLowerCase(),
    input.password === null ? null : hashPassword(input.password),
    Date.now(),
  );
  return { id, participantId: input.participantId, email: input.email, hasPassword: input.password !== null };
}

export function setCredentials(db: Db, userId: string, email: string, password: string): void {
  run(
    db,
    "UPDATE users SET email = ?, password_hash = ? WHERE id = ?",
    email.trim().toLowerCase(),
    hashPassword(password),
    userId,
  );
}

export function userByParticipant(db: Db, participantId: string): User | null {
  const row = get<UserRow>(db, "SELECT * FROM users WHERE participant_id = ?", participantId);
  return row ? toUser(row) : null;
}

export function listUsers(db: Db): User[] {
  return all<UserRow>(db, "SELECT * FROM users ORDER BY created_at").map(toUser);
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
  participantId: string;
  email: string;
  expiresAt: number;
}

/** Create a session row and return the signed token for the cookie. */
export async function issueSession(db: Db, user: User): Promise<{ token: string; expiresAt: number }> {
  const sessionId = randomUUID();
  const issuedAt = Date.now();
  const expiresAt = issuedAt + SESSION_HOURS * 3_600_000;
  run(
    db,
    "INSERT INTO sessions (id, user_id, issued_at, expires_at) VALUES (?, ?, ?, ?)",
    sessionId,
    user.id,
    issuedAt,
    expiresAt,
  );
  const token = await new SignJWT({ pid: user.participantId })
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
    participant_id: string;
    email: string;
  }>(
    db,
    `SELECT s.id, s.user_id, s.expires_at, s.revoked_at, u.participant_id, u.email
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`,
    sessionId,
  );
  if (!row || row.revoked_at !== null || row.expires_at <= Date.now()) return null;
  return {
    sessionId: row.id,
    userId: row.user_id,
    participantId: row.participant_id,
    email: row.email,
    expiresAt: row.expires_at,
  };
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
