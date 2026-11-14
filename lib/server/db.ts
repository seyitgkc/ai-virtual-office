import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { SCHEMA, SCHEMA_VERSION } from "./schema";

export type Db = DatabaseSync;
export type Row = Record<string, unknown>;

/** Where the database file lives. One file holds the whole office. */
export function databasePath(): string {
  return resolve(process.env.OFFICE_DB_PATH ?? "./data/office.db");
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
    if (row.version !== SCHEMA_VERSION) {
      throw new Error(
        `Database schema is version ${row.version}, this build expects ${SCHEMA_VERSION}. ` +
          `Move ${path} aside to start from a fresh office.`,
      );
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
