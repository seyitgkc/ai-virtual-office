/**
 * Exercises the server with several offices in one database: the
 * administrator's own empty office, the separate demo office, isolation
 * between offices, AI provider settings and removing an office.
 * Run: npx tsx scripts/offices.ts
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function expect(label: string, actual: unknown, wanted: unknown): void {
  const ok = actual === wanted;
  if (!ok) failures++;
  console.log(`${ok ? "pass" : "FAIL"}  ${label}${ok ? "" : `  (got ${String(actual)})`}`);
}

async function main(): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), "office-check-"));
  const databaseFile = join(folder, "office.db");
  const adminPassword = randomBytes(18).toString("base64url");
  process.env.OFFICE_DB_PATH = databaseFile;
  process.env.AUTH_SECRET = randomBytes(40).toString("base64url");
  process.env.ADMIN_EMAIL = "owner@example.test";
  process.env.ADMIN_PASSWORD = adminPassword;
  process.env.ADMIN_NAME = "Alex Kim";
  delete process.env.DEMO_LOGIN;

  // Imported after the environment is set, because the server reads it once.
  const service = await import("../lib/server/officeService");
  const auth = await import("../lib/server/auth");
  const { all } = await import("../lib/server/db");
  const db = service.officeDatabase();
  const count = (sql: string, ...params: string[]): number => (all(db, sql, ...params)[0] as { n: number }).n;
  const refusal = async (work: () => unknown): Promise<number | null> => {
    try {
      await work();
      return null;
    } catch (error) {
      if (error instanceof service.OfficeError) return error.status;
      throw error;
    }
  };
  const sessionFor = async (email: string, participantId: string | null) => {
    const user = auth.userByEmail(db, email)!;
    const { token } = await auth.issueSession(db, user, participantId);
    return { token, read: async () => (await auth.readSession(db, token))! };
  };

  console.log("\n-- a new database --");
  const admin = auth.authenticate(db, "owner@example.test", adminPassword)!;
  const adminSeats = auth.seatsOf(db, admin.id);
  expect("the administrator can sign in with the configured password", admin.displayName, "Alex Kim");
  expect("and starts with exactly one office", adminSeats.length, 1);
  expect("which is not the demo office", service.isDemoOffice(adminSeats[0].officeId), false);
  expect("the demo office exists separately", count("SELECT COUNT(*) AS n FROM offices"), 2);
  const demoPeople = auth.usersInOffice(db, service.DEMO_OFFICE_ID);
  expect("the demo has its two demo sign-ins", demoPeople.length, 2);
  expect("neither of them has a password", demoPeople.some((u) => u.hasPassword), false);
  expect("the administrator has no seat in the demo", demoPeople.some((u) => u.email === admin.email), false);

  const owner = await sessionFor("owner@example.test", adminSeats[0].participantId);
  let view = service.getView(await owner.read());
  expect("the administrator's office is empty: no tasks", view.office.tasks.length, 0);
  expect("no rules", view.office.rules.length, 0);
  expect("one room", view.office.floorplan.rooms.length, 1);
  expect("one person, the administrator", view.office.participants.map((p) => p.displayName).join(), "Alex Kim");
  expect("nothing from the demo leaked in", JSON.stringify(view).includes("Dana Reyes") || JSON.stringify(view).includes("Northline"), false);
  expect("it supervises its own office", view.viewer.supervises, true);

  console.log("\n-- demo access is limited --");
  const dana = await sessionFor(demoPeople.find((u) => u.participantId === "p-dana")!.email, "p-dana");
  const demoView = service.getView(await dana.read());
  expect("the demo office still has its three tasks", demoView.office.tasks.length, 3);
  expect("a demo sign-in sees only the demo office", demoView.offices.length, 1);
  expect("demo access cannot add an office", await refusal(async () => service.createOffice(await dana.read(), "Sneaky")), 403);
  expect("nor remove the demo office", await refusal(async () => service.removeOffice(await dana.read(), service.DEMO_OFFICE_ID)), 403);
  expect("nor store an API key in it", await refusal(async () => service.saveAiSettings(await dana.read(), { runtime: "scripted", model: "claude-opus-5-5", apiKey: "sk-test-not-a-real-key-000000000000" })), 403);

  console.log("\n-- several offices on one account --");
  const second = await service.createOffice(await owner.read(), "Second branch");
  expect("adding an office switches to it", (await owner.read()).officeId, second.officeId);
  view = service.getView(await owner.read());
  expect("the account now lists two offices", view.offices.length, 2);
  expect("the new one is empty too", view.office.tasks.length + view.office.rules.length, 0);
  expect("an office needs a name", await refusal(async () => service.createOffice(await owner.read(), " ")), 400);

  const mainRoom = view.office.floorplan.rooms[0].id;
  const memberRole = Object.values(view.office.roles).find((r) => !r.supervises)!.id;
  view = await service.applyAdminOperation(await owner.read(), { type: "ADD_AGENT", displayName: "Nova", title: "Assistant", roleId: memberRole, roomId: mainRoom, capabilities: [] });
  view = await service.applyAction(await owner.read(), { type: "SUBMIT_REQUEST", title: "First job", detail: "Do the thing.", requestedById: "" });
  const task = view.office.tasks[0];
  expect("work in the new office gets ids of its own", /^T-[a-z0-9]{4}-1$/.test(task.id), true);
  expect("stamped with the real time", Math.abs(task.createdAt - Date.now()) < 60_000, true);
  service.switchOffice(await owner.read(), adminSeats[0].officeId);
  expect("the first office is untouched", service.getView(await owner.read()).office.tasks.length, 0);
  expect("and so is the demo", service.getView(await dana.read()).office.tasks.length, 3);
  expect(
    "an action naming another office's task does nothing there",
    await refusal(async () => service.applyAction(await owner.read(), { type: "ADVANCE", taskId: "T-1001" })),
    409,
  );
  expect("the demo task did not move", service.getView(await dana.read()).office.tasks[0].stage, "execution");
  expect("switching to an office you have no seat in is refused", await refusal(async () => service.switchOffice(await owner.read(), service.DEMO_OFFICE_ID)), 404);

  console.log("\n-- AI provider settings --");
  service.switchOffice(await owner.read(), second.officeId);
  const fakeKey = `sk-ant-test-${randomBytes(24).toString("hex")}`;
  expect("a live model needs a key first", await refusal(async () => service.saveAiSettings(await owner.read(), { runtime: "model", model: "claude-opus-5-5" })), 400);
  expect("a malformed model id is refused", await refusal(async () => service.saveAiSettings(await owner.read(), { runtime: "scripted", model: "gpt please" })), 400);
  view = await service.saveAiSettings(await owner.read(), { runtime: "model", model: "claude-sonnet-5-5", apiKey: fakeKey });
  expect("the office now runs on a model", view.runtime, "model");
  expect("the view says a key is stored", view.ai?.hasKey, true);
  expect("and shows only its last four characters", view.ai?.keyHint, fakeKey.slice(-4));
  expect("the key is nowhere in what the browser receives", JSON.stringify(view).includes(fakeKey), false);
  expect("nor in the audit log", JSON.stringify(all(db, "SELECT note FROM audit_notes")).includes(fakeKey), false);
  expect("nor readable in the database file", readFileSync(databaseFile).includes(fakeKey) || readFileSync(`${databaseFile}-wal`).includes(fakeKey), false);
  expect("agents are labelled with the model", view.office.participants.find((p) => p.kind === "agent")?.backing?.model, "claude-sonnet-5-5");
  expect("the other office still follows the script", count("SELECT COUNT(*) AS n FROM office_ai"), 1);
  view = await service.saveAiSettings(await owner.read(), { runtime: "scripted", model: "claude-sonnet-5-5" });
  expect("switching back to the script keeps the key", `${view.runtime}/${view.ai?.hasKey}`, "scripted/true");
  expect("and unlabels the agents", view.office.participants.find((p) => p.kind === "agent")?.backing, null);
  view = await service.saveAiSettings(await owner.read(), { runtime: "scripted", model: "claude-sonnet-5-5", removeKey: true });
  expect("the key can be removed", view.ai?.hasKey, false);

  console.log("\n-- removing offices --");
  const participantsBefore = count("SELECT COUNT(*) AS n FROM participants WHERE office_id = ?", second.officeId);
  expect("the office has rows before removal", participantsBefore > 0, true);
  await service.removeOffice(await owner.read(), second.officeId);
  expect("removing an office deletes its people", count("SELECT COUNT(*) AS n FROM participants WHERE office_id = ?", second.officeId), 0);
  expect("its work", count("SELECT COUNT(*) AS n FROM tasks WHERE office_id = ?", second.officeId), 0);
  expect("and its audit log", count("SELECT COUNT(*) AS n FROM audit_log WHERE office_id = ?", second.officeId), 0);
  expect("the session falls back to the remaining office", (await owner.read()).officeId, adminSeats[0].officeId);
  expect("the account itself survives", auth.authenticate(db, "owner@example.test", adminPassword) !== null, true);
  await service.removeOffice(await owner.read(), adminSeats[0].officeId);
  expect("with no office left the session has no seat", (await owner.read()).officeId, null);
  expect("and asking for a view says so", await refusal(async () => service.getView(await owner.read())), 409);
  await service.createOffice(await owner.read(), "Fresh start");
  expect("a new office can be added from nothing", service.getView(await owner.read()).office.name, "Fresh start");
  expect("the demo is still intact", service.getView(await dana.read()).office.tasks.length, 3);
  expect("no dangling references anywhere", all(db, "PRAGMA foreign_key_check").length, 0);

  db.close();
  rmSync(folder, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? "all office checks passed" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
