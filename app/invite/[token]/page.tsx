import { InviteForm } from "@/components/InviteForm";
import { readInvite } from "@/lib/server/invites";

export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = readInvite(token);

  if (!invite) {
    return (
      <main className="login">
        <div className="login-card">
          <h1>Virtual Office</h1>
          <p>This invite link has expired or was already used. Ask whoever invited you for a new one.</p>
          <a className="btn" href="/login">
            Go to sign in
          </a>
        </div>
      </main>
    );
  }
  return <InviteForm token={token} invite={invite} />;
}
