import { readJson, withSession } from "@/lib/server/http";
import { OfficeError, saveAiSettings } from "@/lib/server/officeService";

/** Set how this office's agents think, and optionally store a new API key. */
export async function POST(request: Request) {
  return withSession(request, async (session) => {
    const body = await readJson(request);
    const runtime = body?.runtime;
    if (runtime !== "scripted" && runtime !== "model") throw new OfficeError(400, "Choose scripted or model.");
    return saveAiSettings(session, {
      runtime,
      model: typeof body?.model === "string" ? body.model : "",
      ...(typeof body?.apiKey === "string" ? { apiKey: body.apiKey } : {}),
      removeKey: body?.removeKey === true,
    });
  });
}
