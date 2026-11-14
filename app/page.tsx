import { redirect } from "next/navigation";
import { OfficeApp } from "@/components/OfficeApp";
import { currentSession } from "@/lib/server/http";
import { getView } from "@/lib/server/officeService";
import type { OfficeView } from "@/lib/view";

export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await currentSession();
  if (!session) redirect("/login");

  let view: OfficeView;
  try {
    view = getView(session);
  } catch {
    redirect("/login");
  }
  return <OfficeApp initial={view} />;
}
