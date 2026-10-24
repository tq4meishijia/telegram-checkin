/**
 * 内存版 fake D1：只实现项目实际用到的 SQL 子集（按语句特征路由）。
 * 用于 runner / auth / api 单测，不依赖 miniflare。
 */

type Row = Record<string, any>;

export interface FakeDbInit {
  tasks?: Row[];
  run_logs?: Row[];
  settings?: Record<string, string>;
  login_attempts?: Record<string, { fail_count: number; window_start: number }>;
}

export interface FakeDb {
  db: any;
  state: {
    tasks: Row[];
    logs: Row[];
    settings: Map<string, string>;
    attempts: Map<string, { fail_count: number; window_start: number }>;
  };
  /** 让包含指定子串的语句抛错，用于模拟 D1 瞬时故障 */
  failOn(substr: string): void;
}

export function createFakeDb(init: FakeDbInit = {}): FakeDb {
  const state = {
    tasks: (init.tasks ?? []).map((t) => ({ ...t })),
    logs: (init.run_logs ?? []).map((l) => ({ ...l })),
    settings: new Map(Object.entries(init.settings ?? {})),
    attempts: new Map(Object.entries(init.login_attempts ?? {})),
  };
  let autoId = 0;
  const failures: string[] = [];

  function failOn(substr: string) {
    failures.push(substr);
  }
  function maybeFail(sql: string) {
    if (failures.some((f) => sql.includes(f))) {
      throw new Error(`fake_db_forced_failure: ${sql.slice(0, 60)}`);
    }
  }

  function select(sql: string, params: any[]): Row[] {
    if (sql.includes("SELECT value FROM settings WHERE key = ?")) {
      const v = state.settings.get(params[0]);
      return v === undefined ? [] : [{ value: v }];
    }
    if (sql.includes("SELECT * FROM tasks WHERE id = ?")) {
      const t = state.tasks.find((x) => x.id === params[0]);
      return t ? [{ ...t }] : [];
    }
    if (sql.includes("SELECT * FROM tasks ORDER BY id ASC")) {
      return [...state.tasks].sort((a, b) => a.id - b.id);
    }
    if (sql.includes("FROM run_logs l LEFT JOIN")) {
      let rows = state.logs.map((l) => ({
        ...l,
        task_name: state.tasks.find((t) => t.id === l.task_id)?.name ?? null,
      }));
      const where = sql.match(/ WHERE (.*?) ORDER BY /);
      if (where) {
        let pi = 0;
        for (const cond of where[1].split(" AND ")) {
          const m = cond.match(/^l\.(\w+) (=|<) \?$/);
          if (!m) throw new Error(`fake_db: unsupported log condition: ${cond}`);
          const val = params[pi++];
          rows = rows.filter((r) => (m[2] === "=" ? r[m[1]] === val : r[m[1]] < val));
        }
      }
      rows.sort((a, b) => b.id - a.id);
      return rows.slice(0, params[params.length - 1]);
    }
    if (sql.includes("SELECT fail_count, window_start FROM login_attempts")) {
      const a = state.attempts.get(params[0]);
      return a ? [{ ...a }] : [];
    }
    if (sql.includes("SELECT * FROM tasks WHERE enabled=1")) {
      const now = params[0];
      return state.tasks
        .filter((t) => t.enabled === 1 && t.next_run_at != null && t.next_run_at <= now)
        .sort((a, b) => (a.next_run_at < b.next_run_at ? -1 : 1))
        .slice(0, params[1])
        .map((t) => ({ ...t }));
    }
    if (sql.includes("FROM run_logs WHERE created_at")) {
      const from = params[0];
      const to = params.length > 1 ? params[1] : null;
      const rows = state.logs.filter((l) => l.created_at >= from && (to === null || l.created_at < to));
      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
      return Object.entries(counts).map(([status, count]) => ({ status, count }));
    }
    if (sql.includes("FROM tasks") && sql.includes("LIMIT 5")) {
      const bound = params[0];
      return state.tasks
        .filter((t) => t.enabled === 1 && t.next_run_at != null && t.next_run_at <= bound)
        .sort((a, b) => (a.next_run_at < b.next_run_at ? -1 : 1))
        .slice(0, 5)
        .map((t) => ({
          id: t.id,
          name: t.name,
          bot_username: t.bot_username,
          command: t.command,
          next_run_at: t.next_run_at,
        }));
    }
    throw new Error(`fake_db: unsupported SELECT: ${sql}`);
  }

  function write(sql: string, params: any[]): number {
    if (sql.includes("INSERT INTO settings")) {
      state.settings.set(params[0], params[1]);
      return 1;
    }
    if (sql.includes("INSERT INTO login_attempts")) {
      const ip = params[0];
      const nowSec = params[1];
      const cutoff = params[2];
      const cur = state.attempts.get(ip);
      if (!cur) {
        state.attempts.set(ip, { fail_count: 1, window_start: nowSec });
      } else if (cur.window_start < cutoff) {
        state.attempts.set(ip, { fail_count: 1, window_start: nowSec });
      } else {
        state.attempts.set(ip, { fail_count: cur.fail_count + 1, window_start: cur.window_start });
      }
      return 1;
    }
    if (sql.includes("INSERT INTO run_logs")) {
      autoId += 1;
      state.logs.push({
        id: autoId,
        task_id: params[0],
        status: params[1],
        detail: params[2],
        duration_ms: params[3],
        created_at: "2026-01-01 00:00:00",
      });
      return 1;
    }
    if (sql.includes("INSERT INTO tasks")) {
      const cols = sql.match(/INSERT INTO tasks\(([^)]+)\)/)?.[1].split(", ") ?? [];
      const row: Row = { id: Math.max(0, ...state.tasks.map((t) => t.id)) + 1 };
      cols.forEach((c, i) => {
        row[c] = params[i];
      });
      state.tasks.push(row);
      autoId = row.id;
      return 1;
    }
    // 乐观锁抢占：UPDATE tasks SET next_run_at=? WHERE id=? AND next_run_at=?
    if (/^UPDATE tasks SET next_run_at=\? WHERE id=\? AND next_run_at=\?$/.test(sql)) {
      const [lease, id, expected] = params;
      const t = state.tasks.find((x) => x.id === id);
      if (!t || t.next_run_at !== expected) return 0;
      t.next_run_at = lease;
      return 1;
    }
    // 通用：UPDATE tasks SET <col=expr, ...> WHERE id = ?
    const m = sql.match(/^UPDATE tasks SET (.+) WHERE id = \?$/);
    if (m) {
      const id = params[params.length - 1];
      const t = state.tasks.find((x) => x.id === id);
      if (!t) return 0;
      let pi = 0;
      for (const a of m[1].split(", ")) {
        const am = a.match(/^(\w+)\s*=\s*(.+)$/);
        if (!am) throw new Error(`fake_db: unsupported assignment: ${a}`);
        const [, col, expr] = am;
        if (expr === "?") t[col] = params[pi++];
        else if (expr === "NULL") t[col] = null;
        else if (expr.startsWith("datetime('now')")) t[col] = "2026-01-01 00:00:00";
        else t[col] = expr.replace(/^'|'$/g, "");
      }
      return 1;
    }
    if (sql === "DELETE FROM tasks WHERE id = ?") {
      const i = state.tasks.findIndex((t) => t.id === params[0]);
      if (i >= 0) state.tasks.splice(i, 1);
      return 1;
    }
    if (sql === "DELETE FROM settings WHERE key = ?") {
      state.settings.delete(params[0]);
      return 1;
    }
    if (sql === "DELETE FROM login_attempts WHERE ip = ?") {
      state.attempts.delete(params[0]);
      return 1;
    }
    if (sql.startsWith("DELETE FROM login_attempts WHERE window_start < ?")) {
      for (const [ip, a] of state.attempts) {
        if (a.window_start < params[0]) state.attempts.delete(ip);
      }
      return 0;
    }
    if (sql.startsWith("DELETE FROM run_logs")) {
      state.logs = [];
      return 0;
    }
    throw new Error(`fake_db: unsupported WRITE: ${sql}`);
  }

  const db = {
    prepare(sql: string) {
      const params: any[] = [];
      const stmt: any = {
        bind(...p: any[]) {
          params.push(...p);
          return stmt;
        },
        async all() {
          maybeFail(sql);
          return { results: select(sql, params), success: true, meta: {} };
        },
        async first() {
          maybeFail(sql);
          const rows = select(sql, params);
          return rows[0] ?? null;
        },
        async run() {
          maybeFail(sql);
          return { success: true, meta: { changes: write(sql, params), last_row_id: autoId } };
        },
      };
      return stmt;
    },
    async batch(stmts: any[]) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };

  return { db, state, failOn };
}
