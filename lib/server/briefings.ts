/**
 * The stored side of the briefing: the one a model last wrote for an office,
 * and the state of the office it was written for.
 */
import { createHash } from "node:crypto";
import type { AgentLoad } from "../agentState";
import { briefingFacts, composeBriefing, type BriefedOffice, type Briefing } from "../briefing";
import { get, run, type Db } from "./db";

interface BriefingRow {
  office_id: string;
  fingerprint: string;
  body: string;
  written_by: string;
  written_at: number;
}

/**
 * What a briefing was written from, as one value. It changes when a task is
 * filed, moves, halts, is marked urgent, is given a day to wait for or
 * closes, and at no other time.
 */
export function briefingFingerprint(office: BriefedOffice, load: AgentLoad): string {
  return createHash("sha256")
    .update(briefingFacts(office, load, (_kind, text) => text).join("\n"))
    .digest("hex")
    .slice(0, 32);
}

/** The briefing to show: the model's, if it was written for the office as it stands, and otherwise the composed one. */
export function briefingFor(db: Db, office: BriefedOffice & { id: string }, load: AgentLoad): Briefing {
  const row = get<BriefingRow>(db, "SELECT * FROM briefings WHERE office_id = ?", office.id);
  if (row && row.fingerprint === briefingFingerprint(office, load)) {
    return { text: row.body, by: row.written_by, at: row.written_at };
  }
  return { text: composeBriefing(office, load), by: null, at: null };
}

/** The state of the office the stored briefing was written for, if there is one. */
export const briefedFingerprint = (db: Db, officeId: string): string | null =>
  get<{ fingerprint: string }>(db, "SELECT fingerprint FROM briefings WHERE office_id = ?", officeId)?.fingerprint ?? null;

export function saveBriefing(db: Db, officeId: string, fingerprint: string, body: string, writtenBy: string, at: number): void {
  run(
    db,
    `INSERT INTO briefings (office_id, fingerprint, body, written_by, written_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(office_id) DO UPDATE SET
       fingerprint = excluded.fingerprint, body = excluded.body, written_by = excluded.written_by, written_at = excluded.written_at`,
    officeId,
    fingerprint,
    body,
    writtenBy,
    at,
  );
}
