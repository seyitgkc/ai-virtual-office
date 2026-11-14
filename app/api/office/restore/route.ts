import { withSession } from "@/lib/server/http";
import { restoreDemo } from "@/lib/server/officeService";

export async function POST(request: Request) {
  return withSession(request, (session) => restoreDemo(session));
}
