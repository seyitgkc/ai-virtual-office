import { redirect } from "next/navigation";
import { NoOffice } from "@/components/NoOffice";
import { OfficeApp } from "@/components/OfficeApp";
import { currentSession } from "@/lib/server/http";
import { getView } from "@/lib/server/officeService";
import type { OfficeView } from "@/lib/view";

export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await currentSession();
  if (!session) redirect("/login");

  // An account can exist without an office: before its first one, or after
  // removing its last.
  if (!session.officeId) {
    return <NoOffice displayName={session.displayName} canCreate={session.hasPassword} />;
  }

  let view: OfficeView;
  try {
    view = getView(session);
  } catch {
    redirect("/login");
  }
  return <OfficeApp initial={view} />;
}
