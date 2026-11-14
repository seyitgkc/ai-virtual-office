import { redirect } from "next/navigation";
import { LoginForm } from "@/components/LoginForm";
import { supervises } from "@/lib/policy";
import { listUsers } from "@/lib/server/auth";
import { currentSession } from "@/lib/server/http";
import { demoLoginEnabled, officeDatabase } from "@/lib/server/officeService";
import { loadEngineState } from "@/lib/server/officeStore";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await currentSession()) redirect("/");

  // Seeded people who have not set a password can be entered as a demo.
  const db = officeDatabase();
  const office = loadEngineState(db)?.office;
  const demoAccounts =
    office && demoLoginEnabled()
      ? listUsers(db)
          .filter((u) => !u.hasPassword)
          .flatMap((u) => {
            const p = office.participants.find((x) => x.id === u.participantId);
            return p
              ? [
                  {
                    participantId: p.id,
                    displayName: p.displayName,
                    title: p.title,
                    role: office.roles[p.roleId]?.name ?? p.roleId,
                    supervises: supervises(office, p),
                  },
                ]
              : [];
          })
      : [];

  return <LoginForm demoAccounts={demoAccounts} />;
}
