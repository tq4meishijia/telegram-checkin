/**
 * 任务创建/更新的输入校验。
 * 原则：严格类型检查，不做隐式转换（"5" → 5、true → 1 之外一律拒绝），
 * 从源头杜绝 NaN/非法组合把任务写进"静默停跑"状态。
 */

export interface TaskInput {
  name: string;
  bot_username: string;
  command: string;
  schedule_type: "daily" | "interval";
  schedule_value: string;
  timezone: string;
  jitter_minutes: number;
  capture_reply: 0 | 1;
  reply_wait_sec: number;
  enabled: 0 | 1;
}

export type ValidationResult =
  | { ok: true; value: Partial<TaskInput> }
  | { ok: false; error: string };

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const USERNAME_RE = /^@?[A-Za-z0-9_]{4,32}$/;

const TASK_DEFAULTS: Omit<TaskInput, "name" | "bot_username" | "command" | "schedule_type" | "schedule_value"> = {
  timezone: "Asia/Shanghai",
  jitter_minutes: 0,
  capture_reply: 0,
  reply_wait_sec: 10,
  enabled: 1,
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyStr(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 && s.length <= max ? s : null;
}

function bool01(v: unknown): 0 | 1 | null {
  if (v === true) return 1;
  if (v === false) return 0;
  if (v === 0 || v === 1) return v;
  return null;
}

function intInRange(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 校验排期组合：type 与 value 必须配套且合法；合法返回 null，否则返回错误码。 */
export function validateSchedule(scheduleType: unknown, scheduleValue: unknown): string | null {
  if (scheduleType !== "daily" && scheduleType !== "interval") return "invalid_schedule_type";
  if (typeof scheduleValue !== "string" || scheduleValue.trim().length === 0 || scheduleValue.length > 100) {
    return "invalid_schedule_value";
  }
  const value = scheduleValue.trim();
  if (scheduleType === "daily") {
    const times = value.split(",").map((s) => s.trim());
    if (times.length === 0 || !times.every((t) => TIME_RE.test(t))) return "invalid_time_format";
    return null;
  }
  const mins = Number(value);
  if (!Number.isInteger(mins) || mins < 1 || mins > 1440) return "interval_must_be_positive_integer";
  return null;
}

/**
 * 校验任务 body。
 * partial=false（POST）：必填字段缺失即报错，可选字段用默认值，返回完整 TaskInput。
 * partial=true（PATCH）：只校验出现的字段，返回 Partial<TaskInput>（调用方负责与存量合并）。
 */
export function validateTaskBody(body: unknown, opts: { partial: boolean }): ValidationResult {
  if (!isPlainObject(body)) return { ok: false, error: "invalid_body" };

  const out: Partial<TaskInput> = {};

  // —— 字符串字段 ——
  const name = nonEmptyStr(body.name, 100);
  if (body.name !== undefined || !opts.partial) {
    if (!name) return { ok: false, error: "invalid_name" };
    out.name = name;
  }

  if (body.bot_username !== undefined || !opts.partial) {
    const v = nonEmptyStr(body.bot_username, 64);
    if (!v || !(v === "me" || USERNAME_RE.test(v))) return { ok: false, error: "invalid_bot_username" };
    out.bot_username = v;
  }

  if (body.command !== undefined || !opts.partial) {
    const v = nonEmptyStr(body.command, 500);
    if (!v) return { ok: false, error: "invalid_command" };
    out.command = v;
  }

  // —— 排期（组合校验由调用方在合并存量后执行）——
  if (body.schedule_type !== undefined || !opts.partial) {
    if (body.schedule_type !== "daily" && body.schedule_type !== "interval") {
      return { ok: false, error: "invalid_schedule_type" };
    }
    out.schedule_type = body.schedule_type;
  }

  if (body.schedule_value !== undefined || !opts.partial) {
    const v = nonEmptyStr(body.schedule_value, 100);
    if (!v) return { ok: false, error: "invalid_schedule_value" };
    out.schedule_value = v;
  }

  // —— 可选字段：PATCH 缺省不动，POST 缺省取默认值 ——
  if (body.timezone !== undefined) {
    const v = nonEmptyStr(body.timezone, 64);
    if (!v || !isValidTimezone(v)) return { ok: false, error: "invalid_timezone" };
    out.timezone = v;
  } else if (!opts.partial) {
    out.timezone = TASK_DEFAULTS.timezone;
  }

  if (body.jitter_minutes !== undefined) {
    const v = intInRange(body.jitter_minutes, 0, 1439);
    if (v === null) return { ok: false, error: "invalid_jitter_minutes" };
    out.jitter_minutes = v;
  } else if (!opts.partial) {
    out.jitter_minutes = TASK_DEFAULTS.jitter_minutes;
  }

  if (body.capture_reply !== undefined) {
    const v = bool01(body.capture_reply);
    if (v === null) return { ok: false, error: "invalid_capture_reply" };
    out.capture_reply = v;
  } else if (!opts.partial) {
    out.capture_reply = TASK_DEFAULTS.capture_reply;
  }

  if (body.reply_wait_sec !== undefined) {
    const v = intInRange(body.reply_wait_sec, 1, 120);
    if (v === null) return { ok: false, error: "invalid_reply_wait_sec" };
    out.reply_wait_sec = v;
  } else if (!opts.partial) {
    out.reply_wait_sec = TASK_DEFAULTS.reply_wait_sec;
  }

  if (body.enabled !== undefined) {
    const v = bool01(body.enabled);
    if (v === null) return { ok: false, error: "invalid_enabled" };
    out.enabled = v;
  } else if (!opts.partial) {
    out.enabled = TASK_DEFAULTS.enabled;
  }

  // POST：组合校验（daily 必须配 HH:MM，interval 必须配分钟数）
  if (!opts.partial) {
    const scheduleError = validateSchedule(out.schedule_type, out.schedule_value);
    if (scheduleError) return { ok: false, error: scheduleError };
  }

  return { ok: true, value: out };
}
