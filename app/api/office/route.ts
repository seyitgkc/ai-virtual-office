import { withSession } from "@/lib/server/http";
import { getView } from "@/lib/server/officeService";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Someone is looking at the office, so its briefing is brought up to date if a model is there to write it.
  return withSession(request, (session) => getView(session, { brief: true }));
}
