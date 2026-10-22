/**
 * SQLite implementation of Repo (offline storage, spec 2.1). Node-only: it
 * loads the native better-sqlite3 binding, so it is exported from the
 * '@standin/core/sqlite' subpath, never from the root entry.
 *
 * All reads are re-validated with zod; all writes are validated before insert.
 */
import Database from 'better-sqlite3';
import { GENESIS_HASH, computeEventHash } from './event-log.js';
import { JobSchema, type Job } from './interfaces.js';
import { RepoError, type Repo } from './repo-types.js';
import {
  CallEventSchema,
  CallSchema,
  CaseSchema,
  type Call,
  type CallEvent,
  type Case,
} from './types.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  business_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS calls_by_case ON calls(case_id);
CREATE INDEX IF NOT EXISTS calls_by_business ON calls(business_id, started_at_ms);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  call_id TEXT NOT NULL,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_call ON events(call_id, seq);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  status TEXT NOT NULL,
  run_at_ms INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, run_at_ms);
`;

const JsonRow = (r: unknown): string => {
  if (typeof r === 'object' && r !== null && 'json' in r && typeof r.json === 'string') return r.json;
  throw new Error('SqliteRepo: malformed row');
};

interface EventRow {
  id: string;
  call_id: string;
  at: string;
  type: string;
  data_json: string;
  prev_hash: string;
  hash: string;
}

function rowToEvent(r: EventRow): CallEvent {
  return CallEventSchema.parse({
    id: r.id,
    callId: r.call_id,
    at: r.at,
    type: r.type,
    data: JSON.parse(r.data_json) as unknown,
    prevHash: r.prev_hash,
    hash: r.hash,
  });
}

function toMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError(`invalid ISO date: ${iso}`);
  return ms;
}

export interface SqliteRepoOptions {
  /** File path, or ':memory:' (default) for tests. */
  filename?: string;
}

export class SqliteRepo implements Repo {
  readonly db: Database.Database;

  constructor(opts: SqliteRepoOptions = {}) {
    this.db = new Database(opts.filename ?? ':memory:');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  /* ---------------- cases ---------------- */

  async createCase(c: Case): Promise<Case> {
    const v = CaseSchema.parse(c);
    try {
      this.db
        .prepare('INSERT INTO cases (id, status, business_id, updated_at, json) VALUES (?, ?, ?, ?, ?)')
        .run(v.id, v.status, v.businessId, v.updatedAt, JSON.stringify(v));
    } catch (err) {
      if (err instanceof Database.SqliteError && err.code.startsWith('SQLITE_CONSTRAINT')) {
        throw new RepoError('conflict', `case ${v.id} already exists`);
      }
      throw err;
    }
    return v;
  }

  async getCase(id: string): Promise<Case | undefined> {
    const row: unknown = this.db.prepare('SELECT json FROM cases WHERE id = ?').get(id);
    return row === undefined ? undefined : CaseSchema.parse(JSON.parse(JsonRow(row)));
  }

  async updateCase(c: Case): Promise<Case> {
    const v = CaseSchema.parse(c);
    const r = this.db
      .prepare('UPDATE cases SET status = ?, business_id = ?, updated_at = ?, json = ? WHERE id = ?')
      .run(v.status, v.businessId, v.updatedAt, JSON.stringify(v), v.id);
    if (r.changes === 0) throw new RepoError('not_found', `case ${v.id} not found`);
    return v;
  }

  async listCases(): Promise<Case[]> {
    const rows: unknown[] = this.db.prepare('SELECT json FROM cases ORDER BY updated_at DESC, id').all();
    return rows.map((r) => CaseSchema.parse(JSON.parse(JsonRow(r))));
  }

  async deleteCase(id: string): Promise<boolean> {
    const tx = this.db.transaction((caseId: string): boolean => {
      const callIds = (this.db.prepare('SELECT id FROM calls WHERE case_id = ?').all(caseId) as { id: string }[]).map(
        (r) => r.id,
      );
      const delEvents = this.db.prepare('DELETE FROM events WHERE call_id = ?');
      for (const cid of callIds) delEvents.run(cid);
      this.db.prepare('DELETE FROM calls WHERE case_id = ?').run(caseId);
      this.db.prepare('DELETE FROM jobs WHERE case_id = ?').run(caseId);
      return this.db.prepare('DELETE FROM cases WHERE id = ?').run(caseId).changes > 0;
    });
    return tx(id);
  }

  /* ---------------- calls ---------------- */

  async createCall(c: Call): Promise<Call> {
    const v = CallSchema.parse(c);
    try {
      this.db
        .prepare('INSERT INTO calls (id, case_id, business_id, started_at_ms, json) VALUES (?, ?, ?, ?, ?)')
        .run(v.id, v.caseId, v.businessId, toMs(v.startedAt), JSON.stringify(v));
    } catch (err) {
      if (err instanceof Database.SqliteError && err.code.startsWith('SQLITE_CONSTRAINT')) {
        throw new RepoError('conflict', `call ${v.id} already exists`);
      }
      throw err;
    }
    return v;
  }

  async getCall(id: string): Promise<Call | undefined> {
    const row: unknown = this.db.prepare('SELECT json FROM calls WHERE id = ?').get(id);
    return row === undefined ? undefined : CallSchema.parse(JSON.parse(JsonRow(row)));
  }

  async updateCall(c: Call): Promise<Call> {
    const v = CallSchema.parse(c);
    const r = this.db
      .prepare('UPDATE calls SET case_id = ?, business_id = ?, started_at_ms = ?, json = ? WHERE id = ?')
      .run(v.caseId, v.businessId, toMs(v.startedAt), JSON.stringify(v), v.id);
    if (r.changes === 0) throw new RepoError('not_found', `call ${v.id} not found`);
    return v;
  }

  async listCallsByCase(caseId: string): Promise<Call[]> {
    const rows: unknown[] = this.db
      .prepare('SELECT json FROM calls WHERE case_id = ? ORDER BY started_at_ms, id')
      .all(caseId);
    return rows.map((r) => CallSchema.parse(JSON.parse(JsonRow(r))));
  }

  async countCallsForBusiness(businessId: string, fromIso: string, toIso: string): Promise<number> {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM calls WHERE business_id = ? AND started_at_ms >= ? AND started_at_ms < ?')
      .get(businessId, toMs(fromIso), toMs(toIso)) as { n: number };
    return row.n;
  }

  /* ---------------- events ---------------- */

  async appendEvent(event: CallEvent): Promise<CallEvent> {
    const e = CallEventSchema.parse(event);
    const tx = this.db.transaction((): void => {
      const head = this.db
        .prepare('SELECT hash FROM events WHERE call_id = ? ORDER BY seq DESC LIMIT 1')
        .get(e.callId) as { hash: string } | undefined;
      if (e.prevHash !== (head?.hash ?? GENESIS_HASH)) {
        throw new RepoError('chain_violation', `event ${e.id}: prevHash does not match head of call ${e.callId}`);
      }
      if (e.hash !== computeEventHash(e.prevHash, e)) {
        throw new RepoError('chain_violation', `event ${e.id}: hash does not match its contents`);
      }
      this.db
        .prepare(
          'INSERT INTO events (id, call_id, at, type, data_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(e.id, e.callId, e.at, e.type, JSON.stringify(e.data ?? null), e.prevHash, e.hash);
    });
    tx();
    return e;
  }

  async listEvents(callId: string): Promise<CallEvent[]> {
    const rows = this.db
      .prepare('SELECT id, call_id, at, type, data_json, prev_hash, hash FROM events WHERE call_id = ? ORDER BY seq')
      .all(callId) as EventRow[];
    return rows.map(rowToEvent);
  }

  async headHash(callId: string): Promise<string | undefined> {
    const row = this.db
      .prepare('SELECT hash FROM events WHERE call_id = ? ORDER BY seq DESC LIMIT 1')
      .get(callId) as { hash: string } | undefined;
    return row?.hash;
  }

  /* ---------------- jobs ---------------- */

  async putJob(job: Job): Promise<Job> {
    const v = JobSchema.parse(job);
    this.db
      .prepare(
        `INSERT INTO jobs (id, case_id, status, run_at_ms, json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET case_id = excluded.case_id, status = excluded.status,
           run_at_ms = excluded.run_at_ms, json = excluded.json`,
      )
      .run(v.id, v.caseId, v.status, toMs(v.runAt), JSON.stringify(v));
    return v;
  }

  async getJob(id: string): Promise<Job | undefined> {
    const row: unknown = this.db.prepare('SELECT json FROM jobs WHERE id = ?').get(id);
    return row === undefined ? undefined : JobSchema.parse(JSON.parse(JsonRow(row)));
  }

  async dueJobs(nowIso: string, limit = 50): Promise<Job[]> {
    const rows: unknown[] = this.db
      .prepare("SELECT json FROM jobs WHERE status = 'pending' AND run_at_ms <= ? ORDER BY run_at_ms, id LIMIT ?")
      .all(toMs(nowIso), limit);
    return rows.map((r) => JobSchema.parse(JSON.parse(JsonRow(r))));
  }

  async listJobs(caseId?: string): Promise<Job[]> {
    const rows: unknown[] =
      caseId === undefined
        ? this.db.prepare('SELECT json FROM jobs ORDER BY run_at_ms, id').all()
        : this.db.prepare('SELECT json FROM jobs WHERE case_id = ? ORDER BY run_at_ms, id').all(caseId);
    return rows.map((r) => JobSchema.parse(JSON.parse(JsonRow(r))));
  }

  async setJobStatus(id: string, status: Job['status']): Promise<boolean> {
    const existing = await this.getJob(id);
    if (existing === undefined) return false;
    await this.putJob({ ...existing, status });
    return true;
  }
}
