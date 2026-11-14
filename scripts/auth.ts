/**
 * Exercises accounts, sessions, the permission policy and permission tokens
 * against an in-memory database. Run: npx tsx scripts/auth.ts
 */
import { reduce, ScriptedRuntime, type Action, type EngineState } from "../lib/engine";
import { initialState } from "../lib/initialState";
import { authorize, contextOf, parseAction, stampActor, viewFor } from "../lib/policy";
import {
  authenticate,
  createUser,
  hashPassword,
  issueSession,
  readSession,
  revokeSession,
  setCredentials,
  userByParticipant,
  useSigningKeyForTests,
  verifyPassword,
} from "../lib/server/auth";
import {
  checkAccessToken,
  listAccessTokens,
  revokeAccessToken,
  signAccessToken,
  syncAccessTokens,
} from "../lib/server/accessTokens";
import { openDatabase, transaction } from "../lib/server/db";
import { loadEngineState, saveEngineState, seedDatabase } from "../lib/server/officeStore";

let failures = 0;
function expect(label: string, actual: unknown, wanted: unknown): void {
  const ok = actual === wanted;
  if (!ok) failures++;
  console.log(`${ok ? "pass" : "FAIL"}  ${label}${ok ? "" : `  (got ${String(actual)})`}`);
}

async function main(): Promise<void> {
  useSigningKeyForTests("a-fixed-key-used-only-by-this-check-script");
  const db = openDatabase(":memory:");
  seedDatabase(db, initialState);
  let state: EngineState = loadEngineState(db)!;
  const person = (id: string) => state.office.participants.find((p) => p.id === id)!;
  const ctx = () => contextOf(state.office, state.now);

  console.log("\n-- passwords --");
  const phrase = "correct horse battery staple";
  const stored = hashPassword(phrase);
  expect("hash is not the password", stored.includes(phrase), false);
  expect("two hashes of one password differ (salted)", stored === hashPassword(phrase), false);
  expect("right password verifies", verifyPassword(phrase, stored), true);
  expect("wrong password is refused", verifyPassword("correct horse battery stapler", stored), false);
  expect("an account with no password cannot sign in", verifyPassword("", null), false);

  console.log("\n-- accounts and sessions --");
  const dana = createUser(db, { participantId: "p-dana", email: "dana@office.test", password: null });
  createUser(db, { participantId: "p-sam", email: "sam@office.test", password: null });
  expect("no password set: sign-in refused", authenticate(db, "dana@office.test", "anything") === null, true);
  setCredentials(db, dana.id, "Dana@Office.test", phrase);
  expect("sign-in with the right password", authenticate(db, "dana@office.test", phrase)?.participantId, "p-dana");
  expect("email match ignores case", authenticate(db, "DANA@OFFICE.TEST", phrase)?.participantId, "p-dana");
  expect("unknown email refused", authenticate(db, "nobody@office.test", phrase), null);

  const { token } = await issueSession(db, userByParticipant(db, "p-dana")!);
  const session = await readSession(db, token);
  expect("session token reads back its participant", session?.participantId, "p-dana");
  expect("tampered token refused", await readSession(db, token.slice(0, -3) + "abc"), null);
  expect("missing token refused", await readSession(db, undefined), null);
  revokeSession(db, session!.sessionId);
  expect("signed-out token refused", await readSession(db, token), null);

  console.log("\n-- who may do what --");
  const may = (who: string, action: Action) =>
    authorize(state.office, ctx(), person(who), stampActor(action, who)).allowed;
  const grant: Action = {
    type: "GRANT_ACCESS",
    participantId: "p-sam",
    room: "finance",
    scopes: ["read"],
    effect: "allow",
    reason: "self-service",
    grantedBy: "",
  };
  expect("supervisor may grant access", may("p-dana", grant), true);
  expect("intake rep may not grant access", may("p-sam", grant), false);
  expect("intake rep may not approve", may("p-sam", { type: "DECIDE", taskId: "T-1001", byId: "", verdict: "approved" }), false);
  expect("intake rep may file a request", may("p-sam", { type: "SUBMIT_REQUEST", title: "t", detail: "d", requestedById: "" }), true);
  expect("intake rep may not advance work in Fulfilment", may("p-sam", { type: "ADVANCE", taskId: "T-1001" }), false);
  expect("an agent cannot take supervisor actions", may("p-ledger", { type: "ADVANCE", taskId: "T-1003" }), false);
  expect(
    "actor ids from the browser are overwritten",
    (stampActor({ ...grant, grantedBy: "p-dana" }, "p-sam") as { grantedBy: string }).grantedBy,
    "p-sam",
  );

  console.log("\n-- untrusted input --");
  expect("unknown action type rejected", parseAction({ type: "DROP_TABLES" }), null);
  expect("missing fields rejected", parseAction({ type: "ADVANCE" }), null);
  expect("unknown scope dropped, empty grant rejected", parseAction({ ...grant, scopes: ["admin"] }), null);
  expect("extra fields are not copied", "isAdmin" in (parseAction({ type: "ADVANCE", taskId: "T-1", isAdmin: true }) ?? {}), false);

  console.log("\n-- what each viewer may read --");
  const total = state.office.messages.length;
  expect("supervisor reads every message", viewFor(state.office, ctx(), person("p-dana")).office.messages.length, total);
  const samView = viewFor(state.office, ctx(), person("p-sam"));
  const withheld = Object.values(samView.hiddenMessages).reduce((a, b) => a + b, 0);
  expect("intake rep is shown fewer messages", samView.office.messages.length < total, true);
  expect("shown plus withheld equals all", samView.office.messages.length + withheld, total);

  console.log("\n-- permission tokens --");
  const apply = async (action: Action) => {
    const next = (await reduce(state, action, new ScriptedRuntime())).state;
    transaction(db, () => {
      saveEngineState(db, state, next);
      syncAccessTokens(db);
    });
    state = next;
  };
  transaction(db, () => syncAccessTokens(db));
  const tokenFor = (who: string, room: string) =>
    listAccessTokens(db).find((t) => t.participantId === who && t.roomId === room && t.scope === "read");
  const check = async (signed: string, room: string) =>
    checkAccessToken(db, signed, state.office, ctx(), room, "read");

  expect("deny rules issue no token", listAccessTokens(db).some((t) => t.ruleId === "r-02"), false);
  const veraSigned = (await signAccessToken(db, tokenFor("p-vera", "finance")!.id))!;
  expect("a token outranked by a deny is refused", (await check(veraSigned, "finance")).ok, false);

  await apply({ ...grant, participantId: "p-quill", reason: "Dealer tier lookup", grantedBy: "p-dana", expiresOnTaskId: "T-1001" });
  const quillToken = tokenFor("p-quill", "finance")!;
  const quillSigned = (await signAccessToken(db, quillToken.id))!;
  expect("granting access issues a token", quillToken.taskId, "T-1001");
  expect("the token opens the room it names", (await check(quillSigned, "finance")).ok, true);
  expect("the token does not open another room", (await check(quillSigned, "operations")).ok, false);
  expect("a session token is not a permission token", (await check(token, "finance")).ok, false);
  expect("a forged token is refused", (await check(quillSigned.slice(0, -4) + "AAAA", "finance")).ok, false);

  await apply({ type: "ADVANCE", taskId: "T-1001" });
  await apply({ type: "DECIDE", taskId: "T-1001", byId: "p-dana", verdict: "approved" });
  expect("the token dies when its task closes", (await check(quillSigned, "finance")).ok, false);

  await apply({ type: "REVOKE_RULE", ruleId: "r-02", revokedBy: "p-dana" });
  expect("revoking the deny brings the older token back", (await check(veraSigned, "finance")).ok, true);
  expect("revoking one token", revokeAccessToken(db, tokenFor("p-vera", "finance")!.id), true);
  expect("a revoked token is refused", (await check(veraSigned, "finance")).ok, false);
  await apply({ type: "REVOKE_RULE", ruleId: "r-01", revokedBy: "p-dana" });
  expect("revoking a rule removes its tokens", tokenFor("p-vera", "finance"), undefined);

  console.log(`\n${failures === 0 ? "all auth checks passed" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
