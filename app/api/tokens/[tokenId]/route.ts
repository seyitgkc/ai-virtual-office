import { listAccessTokens, officeOfToken, revokeAccessToken, signAccessToken } from "@/lib/server/accessTokens";
import { readJson, withSession } from "@/lib/server/http";
import { may } from "@/lib/model";
import { getView, OfficeError, officeDatabase, recordAudit } from "@/lib/server/officeService";
import { loadEngineState } from "@/lib/server/officeStore";

/**
 * Reveal or revoke one permission token of the office you are in.
 * Someone who manages access may do both. A token's own holder may reveal it.
 */
export async function POST(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  const { tokenId } = await params;
  return withSession(request, async (session) => {
    const operation = (await readJson(request))?.operation;
    const db = officeDatabase();
    const officeId = officeOfToken(db, tokenId);
    // A token of another office is treated as not existing.
    if (!officeId || officeId !== session.officeId) throw new OfficeError(404, "No such token.");
    const state = loadEngineState(db, officeId);
    const token = listAccessTokens(db, officeId).find((t) => t.id === tokenId);
    const viewer = state?.office.participants.find((p) => p.id === session.participantId);
    if (!state || !token || !viewer) throw new OfficeError(404, "No such token.");
    const managesAccess = may(state.office, viewer, "manage_access");

    if (operation === "reveal") {
      if (!managesAccess && token.participantId !== viewer.id) {
        throw new OfficeError(403, "You can only reveal your own tokens.");
      }
      return { token: await signAccessToken(db, tokenId) };
    }

    if (operation === "revoke") {
      if (!managesAccess) throw new OfficeError(403, "Your role does not have the permission to manage access.");
      if (!revokeAccessToken(db, tokenId)) throw new OfficeError(409, "That token is already revoked.");
      const holder = state.office.participants.find((p) => p.id === token.participantId);
      const room = state.office.floorplan.rooms.find((r) => r.id === token.roomId)?.name ?? "every room";
      recordAudit(db, {
        officeId,
        officeClock: state.now,
        actorId: viewer.id,
        actionType: "REVOKE_TOKEN",
        subject: {
          taskId: token.taskId,
          subjectParticipantId: token.participantId,
          ruleId: token.ruleId,
          roomId: token.roomId,
        },
        notes: [
          `Token for ${token.scope} on ${room} revoked for ${holder?.displayName ?? token.participantId} by ${viewer.displayName}`,
        ],
      });
      return getView(session);
    }

    throw new OfficeError(400, "Unknown operation.");
  });
}
