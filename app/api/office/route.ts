import { withSession } from "@/lib/server/http";
import { getView } from "@/lib/server/officeService";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withSession(request, (session) => getView(session));
}
