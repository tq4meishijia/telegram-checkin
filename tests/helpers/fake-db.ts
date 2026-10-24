/**
 * 内存版 fake D1：只实现项目实际用到的 SQL 子集（按语句特征路由）。
 * 用于 runner / auth / api / accounts / password 单测，不依赖 miniflare。
 */

type Row = Record<string, any>;

export interface FakeDbInit {
  tasks?: Row[];
  run_logs?: Row[];
  settings?: Record<string, string>;
  login_attempts?: Record<string, { fail_count: number; window_start: number }>;
  accounts?: Row[];
}

export interface FakeDb {
  db: any;
  state: {
    tasks: Row[];
    logs: Row[];
    settings: Map<string, string>;
    attempts: Map<string, { fail_count: number; window_start: number }>;
    accounts: Row[];
  };
  /** 让包含指定子串的语句抛错，用于模拟 D1 瞬时故障 */
  failOn(substr: string): void;
}

const NOW = "2026-01-01 00:00:00";

function accountDefaults(t: Row): Row {
  return {
    session: "",
    api_id: "",
    api_hash: "",
    tg_user_id: null,
    tg_username: null,
    status: "unknown",
    last_error: null,
    last_verified_at: null,
    enabled: 1,
    is_default: 0,
    ...t,
  };
}

/** 按顶层 ", " 切分，忽略引号与括号内的分隔 */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; i++; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 把 SQL 字面量/占位符转换成值；? 从 params 顺序取 */
function literal(token: string, params: any[], pi: { i: number }): any {
  if (token === "?") return params[pi.i++];
  if (token === "NULL") return null;
  if (token.startsWith("datetime('now')")) return NOW;
  if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1);
  const n = Number(token);
  return Number.isNaN(n) ? token : n;
}

/** 按 SQL 的 SELECT 列清单投影结果行（模拟 D1 只返回选中的列，避免把 session 带出去） */
function project(sql: string, row: Row): Row {
  const m = sql.match(/SELECT\s+(.+?)\s+FROM\s+accounts/i);
  if (!m) return { ...row };
  const cols = splitTop(m[1]).filter((c) => c !== "*" && !c.includes("("));
  if (cols.length === 0) return { ...row };
  const out: Row = {};
  for (const c of cols) {
    const key = c.trim().split(/\s+AS\s+/i).pop()!.trim();
    if (key in row) out[key] = row[key];
  }
  return out;
}

export function createFakeDb(init: FakeDbInit = {}): FakeDb {
  const state = {
    tasks: (init.tasks ?? []).map((t) => ({ ...t })),
    logs: (init.run_logs ?? []).map((l) => ({ ...l })),
    settings: new Map(Object.entries(init.settings ?? {})),
    attempts: new Map(Object.entries(init.login_attempts ?? {})),
    accounts: (init.accounts ?? []).map((a) => accountDefaults(a)),
  };
  let autoId = 0;
  const failures: string[] = [];

  function failOn(substr: string) { failures.push(substr); }
  function maybeFail(sql: string) {
    if (failures.some((f) => sql.includes(f))) {
      throw new Error(`fake_db_forced_failure: ${sql.slice(0, 60)}`);
    }
  }
  const nextId = () => ++autoId;

  function select(sql: string, params: any[]): Row[] {
    const pi = { i: 0 };

    // ---------- settings ----------
    if (sql.includes("SELECT value FROM settings WHERE key = ?")) {
      const v = state.settings.get(params[0]);
      return v === undefined ? [] : [{ value: v }];
    }

    // ---------- accounts ----------
    if (sql.includes("FROM accounts")) {
      if (sql.includes("WHERE is_default = 1")) {
        const a = state.accounts.find((x) => Number(x.is_default) === 1);
        return a ? [project(sql, a)] : [];
      }
      if (sql.includes("WHERE tg_user_id = ?")) {
        const uid = params[0];
        const idNe = sql.includes("AND id != ?") ? params[1] : null;
        const hit = state.accounts.find((x) => Number(x.tg_user_id) === Number(uid) && (idNe === null || Number(x.id) !== Number(idNe)));
        return hit ? [project(sql, hit)] : [];
      }
      if (sql.includes("WHERE id = ?")) {
        const a = state.accounts.find((x) => x.id === params[0]);
        return a ? [project(sql, a)] : [];
      }
      if (sql.includes("COUNT(*)")) return [{ n: state.accounts.length }];
      if (sql.includes("ORDER BY id ASC")) {
        const sorted = [...state.accounts].sort((a, b) => a.id - b.id);
        const rows = sql.includes("LIMIT 1") ? (sorted[0] ? [sorted[0]] : []) : sorted;
        return rows.map((a) => project(sql, a));
      }
      throw new Error(`fake_db: unsupported accounts SELECT: ${sql}`);
    }

    // ---------- tasks JOIN accounts（runner 与手动运行） ----------
    if (sql.includes("FROM tasks t JOIN accounts")) {
      if (sql.includes("WHERE t.id = ?")) {
        const t = state.tasks.find((x) => x.id === params[0]);
        if (!t) return [];
        const a = state.accounts.find((x) => x.id === t.account_id);
        return [{ ...t, account_session: a?.session ?? "", account_api_id: a?.api_id ?? "", account_api_hash: a?.api_hash ?? "" }];
      }
      const now = params[0];
      const limit = params[1] ?? 10;
      return state.tasks
        .filter((t) => Number(t.enabled) === 1
          && t.next_run_at != null
          && String(t.next_run_at) <= String(now)
          && state.accounts.some((a) => a.id === t.account_id && Number(a.enabled) === 1))
        .sort((a, b) => (String(a.next_run_at) < String(b.next_run_at) ? -1 : 1))
        .slice(0, limit)
        .map((t) => {
          const a = state.accounts.find((x) => x.id === t.account_id);
          return { ...t, account_session: a?.session ?? "", account_api_id: a?.api_id ?? "", account_api_hash: a?.api_hash ?? "", account_status: a?.status };
        });
    }

    // ---------- tasks ----------
    if (sql.includes("SELECT * FROM tasks WHERE id = ?")) {
      const t = state.tasks.find((x) => x.id === params[0]);
      return t ? [{ ...t }] : [];
    }
    if (sql.includes("SELECT * FROM tasks ORDER BY id ASC")) {
      return [...state.tasks].sort((a, b) => a.id - b.id).map((t) => ({ ...t }));
    }
    if (sql.includes("FROM tasks") && sql.includes("LIMIT 5")) {
      // overview upcoming：params = [lowerBound, upperBound]
      const lower = params[0];
      const upper = params[1];
      return state.tasks
        .filter((t) => Number(t.enabled) === 1 && t.next_run_at != null
          && String(t.next_run_at) >= String(lower) && String(t.next_run_at) <= String(upper))
        .sort((a, b) => (String(a.next_run_at) < String(b.next_run_at) ? -1 : 1))
        .slice(0, 5)
        .map((t) => ({ id: t.id, name: t.name, bot_username: t.bot_username, command: t.command, account_id: t.account_id, next_run_at: t.next_run_at }));
    }
    if (sql.includes("SELECT COUNT(*) AS n FROM tasks")) return [{ n: state.tasks.length }];

    // ---------- run_logs ----------
    if (sql.includes("FROM run_logs l LEFT JOIN")) {
      let rows = state.logs.map((l) => ({
        ...l,
        task_name: state.tasks.find((t) => t.id === l.task_id)?.name ?? null,
      }));
      const where = sql.match(/ WHERE (.*?) ORDER BY /);
      if (where) {
        let p = 0;
        for (const cond of where[1].split(" AND ")) {
          const m = cond.match(/^l\.(\w+) (=|<) \?$/);
          if (!m) throw new Error(`fake_db: unsupported log condition: ${cond}`);
          const val = params[p++];
          rows = rows.filter((r) => (m[2] === "=" ? r[m[1]] === val : r[m[1]] < val));
        }
      }
      rows.sort((a, b) => b.id - a.id);
      return rows.slice(0, params[params.length - 1]);
    }
    if (sql.includes("FROM run_logs WHERE created_at")) {
      const from = params[0];
      const to = params.length > 1 ? params[1] : null;
      const rows = state.logs.filter((l) => l.created_at >= from && (to === null || l.created_at < to));
      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
      return Object.entries(counts).map(([status, count]) => ({ status, count }));
    }

    // ---------- login_attempts ----------
    if (sql.includes("SELECT fail_count, window_start FROM login_attempts")) {
      const a = state.attempts.get(params[0]);
      return a ? [{ ...a }] : [];
    }

    throw new Error(`fake_db: unsupported SELECT: ${sql}`);
  }

  function write(sql: string, params: any[]): number {
    // ---------- INSERT ----------
    if (sql.startsWith("INSERT INTO")) {
      // 先剥掉 ON CONFLICT 尾巴，避免 VALUES(...) 的贪婪匹配越界
      const bare = sql.replace(/\s+ON CONFLICT[\s\S]*$/, "");
      const m = bare.match(/^INSERT INTO (\w+)\s*\(([^)]*)\)\s*VALUES\s*\((.*)\)$/);
      if (!m) throw new Error(`fake_db: unsupported INSERT: ${sql}`);
      const table = m[1];
      const cols = splitTop(m[2]);
      const tokens = splitTop(m[3]);
      const pi = { i: 0 };
      const values = tokens.map((t) => literal(t, params, pi));
      const row: Row = { id: nextId() };
      cols.forEach((c, i) => { row[c] = values[i]; });

      if (table === "settings") {
        // ON CONFLICT DO NOTHING（setSettingIfAbsent）：已存在则不覆盖
        if (sql.includes("DO NOTHING")) {
          if (!state.settings.has(row.key)) state.settings.set(row.key, row.value);
        } else {
          state.settings.set(row.key, row.value);
        }
        return 1;
      }
      if (table === "accounts") { state.accounts.push(row); autoId = Math.max(autoId, row.id); return 1; }
      if (table === "run_logs") { state.logs.push(row); return 1; }
      if (table === "tasks") { state.tasks.push(row); autoId = Math.max(autoId, row.id); return 1; }
      if (table === "login_attempts") {
        const cur = state.attempts.get(row.ip);
        if (!cur) state.attempts.set(row.ip, { fail_count: 1, window_start: row.window_start });
        else if (cur.window_start < params[2]) state.attempts.set(row.ip, { fail_count: 1, window_start: row.window_start });
        else state.attempts.set(row.ip, { fail_count: cur.fail_count + 1, window_start: cur.window_start });
        return 1;
      }
      throw new Error(`fake_db: unsupported INSERT table: ${table}`);
    }

    // ---------- 乐观锁抢占：UPDATE tasks SET next_run_at=? WHERE id=? AND next_run_at=? ----------
    if (/^UPDATE tasks SET next_run_at=\? WHERE id=\? AND next_run_at=\?$/.test(sql)) {
      const [lease, id, expected] = params;
      const t = state.tasks.find((x) => x.id === id);
      if (!t || t.next_run_at !== expected) return 0;
      t.next_run_at = lease;
      return 1;
    }

    // ---------- accounts 特殊语句 ----------
    if (sql === "UPDATE accounts SET is_default = 0, updated_at = datetime('now')") {
      for (const a of state.accounts) a.is_default = 0;
      return 1;
    }
    if (/^UPDATE accounts SET is_default = 1, updated_at = datetime\('now'\) WHERE id = \?$/.test(sql)) {
      const id = params[0];
      for (const a of state.accounts) if (a.id === id) a.is_default = 1;
      return 1;
    }

    if (/^UPDATE accounts SET is_default = 1, updated_at = datetime\('now'\) WHERE id = \(SELECT MIN\(id\) FROM accounts\)$/.test(sql)) {
      const min = state.accounts.length ? Math.min(...state.accounts.map((a) => a.id)) : null;
      for (const a of state.accounts) a.is_default = a.id === min ? 1 : 0;
      return 1;
    }

    // ---------- 通用：UPDATE <table> SET <col=expr, ...> WHERE id = ? ----------
    const um = sql.match(/^UPDATE (tasks|accounts) SET (.+?) WHERE id\s*=\s*\?$/);
    if (um) {
      const table = um[1];
      const id = params[params.length - 1];
      const rows = table === "tasks" ? state.tasks : state.accounts;
      const t = rows.find((x) => x.id === id);
      if (!t) return 0;
      const pi = { i: 0 };
      for (const a of splitTop(um[2])) {
        const am = a.match(/^(\w+)\s*=\s*(.+)$/);
        if (!am) throw new Error(`fake_db: unsupported assignment: ${a}`);
        t[am[1]] = literal(am[2], params, pi);
      }
      return 1;
    }

    // ---------- DELETE ----------
    if (sql === "DELETE FROM tasks WHERE id = ?") {
      const i = state.tasks.findIndex((t) => t.id === params[0]);
      if (i >= 0) state.tasks.splice(i, 1);
      return i >= 0 ? 1 : 0;
    }
    if (sql.startsWith("DELETE FROM run_logs WHERE task_id IN")) {
      const before = state.logs.length;
      const ids = state.tasks.filter((t) => t.account_id === params[0]).map((t) => t.id);
      state.logs = state.logs.filter((l) => !ids.includes(l.task_id));
      return before - state.logs.length;
    }
    if (sql === "DELETE FROM tasks WHERE account_id = ?") {
      const before = state.tasks.length;
      state.tasks = state.tasks.filter((t) => t.account_id !== params[0]);
      return before - state.tasks.length;
    }
    if (sql === "DELETE FROM accounts WHERE id = ?") {
      const i = state.accounts.findIndex((a) => a.id === params[0]);
      if (i >= 0) state.accounts.splice(i, 1);
      return i >= 0 ? 1 : 0;
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
      for (const [ip, a] of state.attempts) if (a.window_start < params[0]) state.attempts.delete(ip);
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
        bind(...p: any[]) { params.push(...p); return stmt; },
        async all() { maybeFail(sql); return { results: select(sql, params), success: true, meta: {} }; },
        async first() { maybeFail(sql); const rows = select(sql, params); return rows[0] ?? null; },
        async run() { maybeFail(sql); return { success: true, meta: { changes: write(sql, params), last_row_id: autoId } }; },
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
