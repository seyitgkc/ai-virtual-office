import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { MIGRATIONS, SCHEMA, SCHEMA_VERSION } from "./schema";

export type Db = DatabaseSync;
export type Row = Record<string, unknown>;

/** Where the database file lives. One file holds the whole office. */
export function databasePath(): string {
  const configured = process.env.OFFICE_DB_PATH;
  // The path is only known at run time. The marker stops the bundler from
  // treating it as a file to include in the build.
  return configured
    ? resolve(/* turbopackIgnore: true */ configured)
    : join(/* turbopackIgnore: true */ process.cwd(), "data", "office.db");
}

/** Open a database and make sure the schema exists. `:memory:` is allowed. */
export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  const hasMeta = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
    .get();
  if (!hasMeta) {
    transaction(db, () => {
      db.exec(SCHEMA);
      db.prepare("INSERT INTO schema_meta (version) VALUES (?)").run(SCHEMA_VERSION);
    });
  } else {
    const row = db.prepare("SELECT version FROM schema_meta").get() as { version: number };
    if (row.version > SCHEMA_VERSION) {
      throw new Error(
        `Database schema is version ${row.version}, newer than this build (${SCHEMA_VERSION}). ` +
          `Deploy a newer build, or move ${path} aside to start from a fresh office.`,
      );
    }
    // Bring an older database forward one version at a time. Each step and
    // its version bump commit together, so a failure leaves it untouched.
    for (let version = row.version; version < SCHEMA_VERSION; version++) {
      const step = MIGRATIONS[version];
      if (!step) throw new Error(`No migration from schema version ${version}.`);
      transaction(db, () => {
        db.exec(step);
        db.prepare("UPDATE schema_meta SET version = ?").run(version + 1);
      });
    }
  }
  return db;
}

/**
 * Run `work` atomically. Foreign keys are checked when the transaction
 * commits, so rows that refer to each other can be written in any order.
 */
export function transaction<T>(db: Db, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  db.exec("PRAGMA defer_foreign_keys = ON");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export const run = (db: Db, sql: string, ...params: SQLInputValue[]): void => {
  db.prepare(sql).run(...params);
};

export const all = <T = Row>(db: Db, sql: string, ...params: SQLInputValue[]): T[] =>
  db.prepare(sql).all(...params) as T[];

export const get = <T = Row>(db: Db, sql: string, ...params: SQLInputValue[]): T | undefined =>
  db.prepare(sql).get(...params) as T | undefined;

// One connection per server process. Kept on globalThis so a development
// reload reuses it instead of opening the file again.
const holder = globalThis as unknown as { __officeDb?: Db };

export function database(): Db {
  holder.__officeDb ??= openDatabase(databasePath());
  return holder.__officeDb;
}
