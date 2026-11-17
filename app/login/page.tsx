import { redirect } from "next/navigation";
import { LoginForm } from "@/components/LoginForm";
import { may } from "@/lib/model";
import { usersInOffice } from "@/lib/server/auth";
import { currentSession } from "@/lib/server/http";
import { DEMO_OFFICE_ID, demoLoginEnabled, officeDatabase, signupEnabled } from "@/lib/server/officeService";
import { loadEngineState } from "@/lib/server/officeStore";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await currentSession()) redirect("/");

  // The people of the demo office can be entered without a password.
  const db = officeDatabase();
  const demo = demoLoginEnabled() ? loadEngineState(db, DEMO_OFFICE_ID)?.office : undefined;
  const demoAccounts = demo
    ? usersInOffice(db, demo.id)
        .filter((u) => !u.hasPassword)
        .flatMap((u) => {
          const p = demo.participants.find((x) => x.id === u.participantId);
          return p
            ? [
                {
                  participantId: p.id,
                  displayName: p.displayName,
                  title: p.title,
                  role: demo.roles[p.roleId]?.name ?? p.roleId,
                  managesAccess: may(demo, p, "manage_access"),
                },
              ]
            : [];
        })
    : [];

  return <LoginForm demoAccounts={demoAccounts} canSignUp={signupEnabled()} />;
}
