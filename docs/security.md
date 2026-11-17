# Security

Part of the documentation of the [AI Virtual Office](../README.md).

- Passwords are stored as salted scrypt hashes and compared in constant time.
  An unknown email takes as long to reject as a wrong password.
- The session is a signed JWT in an HttpOnly, SameSite=Lax cookie, marked
  Secure over HTTPS. It expires after twelve hours.
- State-changing requests are refused when their Origin header names another
  site.
- Sign-in attempts are throttled per address and email.
- Invite links and permission tokens are never stored. Only a hash of an
  invite token, and only the id of a permission token, are kept. A link can
  therefore not be shown a second time: a new one is made, and the old one
  stops working.
- An invitation puts nobody in the office. The person exists there only once
  they have accepted. Someone may change or withdraw only the invitations
  into roles whose permissions they hold themselves, so a link into a stronger
  role cannot be taken over by renewing it.
- Input is parsed into known actions field by field. Unknown fields never
  reach the engine.
- A provider's API key is entered in Settings, encrypted with AES-256-GCM
  under a key derived from the server's signing key, and never sent back to a
  browser. It is not written to the audit log. If the signing key changes,
  stored keys become unreadable and must be entered again.
- A provider's address is fetched by the server. Only http
  and https addresses are accepted, addresses carrying a user name or password
  are refused, and so are link-local addresses, where cloud machines keep
  their metadata service. An address on the server's own network is allowed on
  purpose, for a model served locally, so give Manage AI providers only to
  people you would trust with that.
- What a model is told and what it can do are kept apart. Its instructions say
  to ask before guessing, to wait for any check a request calls for, and never
  to go past its access. Those are requests to a model and can fail. The limits
  that cannot fail are enforced outside it: a model is never shown what its
  agent may not read, its reply is parsed into known fields and checked, an
  action is carried out only if the engine finds the agent holds `act`, and a
  system set to need approval waits for a person whatever the model says.
- Text from people, records and outside systems is marked as data before a
  model sees it. A request, each record, each line from a connected system and
  each message in a thread is wrapped in a tag, and the model is told that
  nothing inside the tag is an instruction. The tag's name is random and made
  up afresh for every call, such as `<data_3f9c1a7be402>`, so text written
  beforehand cannot contain it and cannot close the wrapper. Anything in the
  text that looks like such a tag is removed all the same. This
  lowers the chance that a planted sentence, such as a product name reading
  "ignore your rules", is obeyed. It does not make that impossible, which is
  why the limits above do not depend on it.
- Each kind of set-up change needs its own permission, and nobody can grant a
  permission, or give or invite into a role, beyond what they hold.
- Offices are isolated on the server. Every request acts on the office of the
  session's seat, and ids from another office are treated as not existing.
- Demo access cannot add offices, cannot remove the demo office and cannot
  store an API key. It cannot hand out a password account either: a person
  added to the demo office enters without a password like its seeded people,
  gets no invite link, and is gone at the next reset.
- A person removed from an office cannot sign in to it from that moment. An
  open session of theirs falls back to another office they have a seat in, or
  to none.
- The signing key comes from `AUTH_SECRET`, or is generated once and kept
  beside the database with owner-only permissions.
- The container runs as a non-root user on a read-only filesystem, with one
  writable volume for data.
- Demo sign-in is on by default. It lets anyone enter as a seeded person.
  That suits a public demo and nothing else. Set `DEMO_LOGIN=0` for any office
  that holds something you care about.
- Sign-up is on by default. Anyone who reaches the sign-in page can create
  an account and offices of their own. One address can create five accounts an
  hour and the whole server sixty. Set `SIGNUP=0` to leave invites as the only
  way in.
- While sign-up is on, a connected system or an AI provider cannot sit at an
  address inside the server's own network: this machine, a private or
  link-local range, or a bare host name of the kind one container uses to
  reach another. A stranger's account could otherwise make the server call
  services that were never published. The mock services are connected by
  the server itself and are not affected. A private installation, with
  `SIGNUP=0` or `ALLOW_PRIVATE_ADDRESSES=1`, may name its own network, for a
  model running on the same machine for example. The check reads the address
  as typed. A public name that resolves to a private address is not caught.
