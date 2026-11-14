import { supervises } from "@/lib/policy";
import { listAccessTokens, revokeAccessToken, signAccessToken } from "@/lib/server/accessTokens";
import { readJson, withSession } from "@/lib/server/http";
import { getView, OfficeError, officeDatabase, recordAudit } from "@/lib/server/officeService";
import { loadEngineState } from "@/lib/server/officeStore";

/**
 * Reveal or revoke one permission token.
 * A supervisor may do both. A token's own holder may reveal it.
 */
export async function POST(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  const { tokenId } = await params;
  return withSession(request, async (session) => {
    const operation = (await readJson(request))?.operation;
    const db = officeDatabase();
    const state = loadEngineState(db);
    const token = listAccessTokens(db).find((t) => t.id === tokenId);
    const viewer = state?.office.participants.find((p) => p.id === session.participantId);
    if (!state || !token || !viewer) throw new OfficeError(404, "No such token.");
    const isSupervisor = supervises(state.office, viewer);

    if (operation === "reveal") {
      if (!isSupervisor && token.participantId !== viewer.id) {
        throw new OfficeError(403, "You can only reveal your own tokens.");
      }
      return { token: await signAccessToken(db, tokenId) };
    }

    if (operation === "revoke") {
      if (!isSupervisor) throw new OfficeError(403, "Only a supervising role can revoke a token.");
      if (!revokeAccessToken(db, tokenId)) throw new OfficeError(409, "That token is already revoked.");
      const holder = state.office.participants.find((p) => p.id === token.participantId);
      recordAudit(db, {
        officeId: state.office.id,
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
          `Token for ${token.scope} on ${token.roomId ?? "every room"} revoked for ${holder?.displayName ?? token.participantId} by ${viewer.displayName}`,
        ],
      });
      return getView(session);
    }

    throw new OfficeError(400, "Unknown operation.");
  });
}
