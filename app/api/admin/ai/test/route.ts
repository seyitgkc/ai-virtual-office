import { withSession } from "@/lib/server/http";
import { testAiSettings } from "@/lib/server/officeService";

/** Check the stored API key and model with the provider. Nothing is generated. */
export async function POST(request: Request) {
  return withSession(request, (session) => testAiSettings(session));
}
