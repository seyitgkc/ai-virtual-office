/**
 * Scoped permission tokens.
 *
 * Every allow rule yields one token per scope: a signed statement that one
 * participant may use one scope on one room, optionally for one task. A
 * program acting for that participant presents the token to read a room's
 * thread through the API.
 *
 * A token is a credential, and the access model stays the authority. To be
 * accepted a token must carry a valid signature, have a live row here, and
 * the access model must still say "allow" for that participant, room and
 * scope at the moment of use. So a token dies when its rule is revoked, when
 * its task closes, when it expires, and when a deny rule outranks it.
 */
import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { resolveAccess, type AccessContext, type AccessScope, type Office } from "../model";
import { signingKey } from "./auth";
import { all, get, run, type Db } from "./db";

const ISSUER = "ai-virtual-office";
const ACCESS_AUDIENCE = "room-access";

export interface AccessTokenInfo {
  id: string;
  ruleId: string;
  participantId: string;
  /** Null means every room. */
  roomId: string | null;
  scope: AccessScope;
  taskId: string | null;
  reason: string;
  issuedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

interface TokenRow {
  id: string;
  rule_id: string;
  scope: AccessScope;
  issued_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
  participant_id: string;
  room_id: string | null;
  expires_on_task_id: string | null;
  reason: string;
}

const SELECT = `
  SELECT t.id, t.rule_id, t.scope, t.issued_at, t.expires_at, t.revoked_at, t.last_used_at,
         r.participant_id, r.room_id, r.expires_on_task_id, r.reason
    FROM access_tokens t JOIN access_rules r ON r.id = t.rule_id`;

const toInfo = (row: TokenRow): AccessTokenInfo => ({
  id: row.id,
  ruleId: row.rule_id,
  participantId: row.participant_id,
  roomId: row.room_id,
  scope: row.scope,
  taskId: row.expires_on_task_id,
  reason: row.reason,
  issuedAt: row.issued_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  lastUsedAt: row.last_used_at,
});

/**
 * Make sure every scope of every allow rule has a token. Tokens of a revoked
 * rule are removed by the database when the rule row goes.
 */
export function syncAccessTokens(db: Db): void {
  const missing = all<{ rule_id: string; scope: AccessScope; expires_at: number | null }>(
    db,
    `SELECT s.rule_id, s.scope, r.expires_at
       FROM access_rule_scopes s JOIN access_rules r ON r.id = s.rule_id
      WHERE r.effect = 'allow'
        AND NOT EXISTS (SELECT 1 FROM access_tokens t WHERE t.rule_id = s.rule_id AND t.scope = s.scope)`,
  );
  for (const m of missing) {
    run(
      db,
      "INSERT INTO access_tokens (id, rule_id, scope, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      randomUUID(),
      m.rule_id,
      m.scope,
      Date.now(),
      m.expires_at,
    );
  }
}

/** The tokens held by people and agents of one office. */
export function listAccessTokens(db: Db, officeId: string): AccessTokenInfo[] {
  return all<TokenRow>(
    db,
    `${SELECT} JOIN participants p ON p.id = r.participant_id
      WHERE p.office_id = ?
      ORDER BY t.issued_at, t.id`,
    officeId,
  ).map(toInfo);
}

/** The office a token belongs to, through its rule and that rule's holder. */
export function officeOfToken(db: Db, tokenId: string): string | null {
  const row = get<{ office_id: string }>(
    db,
    `SELECT p.office_id FROM access_tokens t
       JOIN access_rules r ON r.id = t.rule_id
       JOIN participants p ON p.id = r.participant_id
      WHERE t.id = ?`,
    tokenId,
  );
  return row?.office_id ?? null;
}

/** Why a token would be refused right now, or null when it would be accepted. */
export function tokenProblem(info: AccessTokenInfo, office: Office, ctx: AccessContext): string | null {
  if (info.revokedAt !== null) return "revoked";
  if (info.expiresAt !== null && info.expiresAt <= ctx.now) return "expired";
  if (info.taskId !== null && ctx.closedTaskIds.has(info.taskId)) return "its task has closed";
  const participant = office.participants.find((p) => p.id === info.participantId);
  if (!participant) return "its holder no longer exists";
  const rooms = info.roomId === null ? office.floorplan.rooms.map((r) => r.id) : [info.roomId];
  const blocked = rooms.every(
    (room) => resolveAccess(participant, room, info.scope, ctx).effect === "deny",
  );
  return blocked ? "outranked by a deny rule" : null;
}

/** Sign the token string for an existing token row. */
export async function signAccessToken(db: Db, tokenId: string): Promise<string | null> {
  const row = get<TokenRow>(db, `${SELECT} WHERE t.id = ?`, tokenId);
  if (!row) return null;
  const jwt = new SignJWT({
    room: row.room_id ?? "*",
    scope: row.scope,
    ...(row.expires_on_task_id ? { task: row.expires_on_task_id } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(ACCESS_AUDIENCE)
    .setSubject(row.participant_id)
    .setJti(row.id)
    .setIssuedAt(Math.floor(row.issued_at / 1000));
  if (row.expires_at !== null) jwt.setExpirationTime(Math.floor(row.expires_at / 1000));
  return jwt.sign(signingKey());
}

export type TokenCheck =
  | { ok: true; token: AccessTokenInfo }
  | { ok: false; status: 401 | 403; reason: string };

/**
 * Decide whether a presented token allows `scope` on `roomId` right now.
 * The claims inside the token are not trusted on their own: the row and the
 * access model are consulted every time.
 */
export async function checkAccessToken(
  db: Db,
  presented: string,
  office: Office,
  ctx: AccessContext,
  roomId: string,
  scope: AccessScope,
): Promise<TokenCheck> {
  let tokenId: string | undefined;
  try {
    const { payload } = await jwtVerify(presented, signingKey(), {
      issuer: ISSUER,
      audience: ACCESS_AUDIENCE,
      algorithms: ["HS256"],
    });
    tokenId = payload.jti;
  } catch {
    return { ok: false, status: 401, reason: "The token is not valid." };
  }
  const row = tokenId ? get<TokenRow>(db, `${SELECT} WHERE t.id = ?`, tokenId) : undefined;
  if (!row) return { ok: false, status: 401, reason: "The token is no longer recognised." };

  const info = toInfo(row);
  if (info.scope !== scope || (info.roomId !== null && info.roomId !== roomId)) {
    return { ok: false, status: 403, reason: `This token does not grant ${scope} on ${roomId}.` };
  }
  const problem = tokenProblem(info, office, ctx);
  if (problem) return { ok: false, status: 403, reason: `Token refused: ${problem}.` };

  const participant = office.participants.find((p) => p.id === info.participantId)!;
  const decision = resolveAccess(participant, roomId, scope, ctx);
  if (decision.effect !== "allow") {
    return { ok: false, status: 403, reason: decision.explanation };
  }
  run(db, "UPDATE access_tokens SET last_used_at = ? WHERE id = ?", Date.now(), info.id);
  return { ok: true, token: info };
}

export function revokeAccessToken(db: Db, tokenId: string): boolean {
  const before = get<{ id: string }>(db, "SELECT id FROM access_tokens WHERE id = ? AND revoked_at IS NULL", tokenId);
  if (!before) return false;
  run(db, "UPDATE access_tokens SET revoked_at = ? WHERE id = ?", Date.now(), tokenId);
  return true;
}
