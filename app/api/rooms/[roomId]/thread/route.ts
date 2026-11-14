import { NextResponse } from "next/server";
import { contextOf } from "@/lib/policy";
import { ROOM_RECORDS } from "@/lib/referenceData";
import { checkAccessToken } from "@/lib/server/accessTokens";
import { fail } from "@/lib/server/http";
import { officeDatabase } from "@/lib/server/officeService";
import { loadEngineState } from "@/lib/server/officeStore";

export const dynamic = "force-dynamic";

/**
 * Read what has been said in a room, as a program holding a permission token.
 *
 *   GET /api/rooms/finance/thread
 *   Authorization: Bearer <token>
 *
 * The token must grant `read` on this room and still be good at this moment.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ roomId: string }> },
): Promise<NextResponse> {
  const { roomId } = await params;
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented) return fail(401, "Send a permission token as a Bearer token.");

  const db = officeDatabase();
  const state = loadEngineState(db);
  if (!state) return fail(404, "No office has been set up.");
  const room = state.office.floorplan.rooms.find((r) => r.id === roomId);
  if (!room) return fail(404, "No such room.");

  const ctx = contextOf(state.office, state.now);
  const check = await checkAccessToken(db, presented, state.office, ctx, roomId, "read");
  if (!check.ok) return fail(check.status, check.reason);

  const messages = state.office.messages
    .filter((m) => m.audience.to === "room" && m.audience.id === roomId)
    .filter((m) => check.token.taskId === null || m.taskId === check.token.taskId)
    .map((m) => ({ id: m.id, kind: m.kind, taskId: m.taskId, from: m.fromId, at: m.at, body: m.body }));

  return NextResponse.json({
    room: { id: room.id, name: room.name },
    holder: check.token.participantId,
    limitedToTask: check.token.taskId,
    records: ROOM_RECORDS[room.id] ?? [],
    messages,
  });
}
