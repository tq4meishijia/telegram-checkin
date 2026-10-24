import type { Env } from "../bindings";
import { withClient } from "../tg/client";
import { computeNextRun } from "./schedule";

const MAX_TASKS_PER_RUN = 10;
const TASK_TIMEOUT_MS = 25000;
const MAX_LATE_MINUTES = 30;
const LOG_RETENTION_DAYS = 30;
const LOG_CLEANUP_PROBABILITY = 0.01;
const REPLY_DETAIL_MAX_LEN = 500;
// 抢占租约：占位期间 next_run_at 指向「now + 租约」。即使执行中 isolate 被 kill、
// 租约到期后任务也会被重新选中（自愈），绝不会停留在"永远失选"的 NULL 状态。
const CLAIM_LEASE_MS = 60 * 60 * 1000;
// 失败告警：连续失败达阈值后，每 ALERT_EVERY 次向自己的"已保存消息"发一条
const ALERT_THRESHOLD = 3;
const ALERT_EVERY = 3;
// computeNextRun 返回 null（排期非法，理论上已被 API 写入校验拦截）时的兜底重排间隔
const FALLBACK_RESCHEDULE_MS = 60 * 60 * 1000;

interface DueTask {
  id: number;
  name: string;
  bot_username: string;
  command: string;
  schedule_type: string;
  schedule_value: string;
  timezone: string;
  jitter_minutes: number;
  capture_reply: number;
  reply_wait_sec: number;
  next_run_at: string | null;
  fail_streak?: number;
}

function scheduleInputOf(task: DueTask) {
  return {
    scheduleType: task.schedule_type as "daily" | "interval",
    scheduleValue: task.schedule_value,
    timezone: task.timezone,
    jitterMinutes: task.jitter_minutes,
  };
}

export async function runDueTasks(env: Env): Promise<void> {
  const nowIso = new Date().toISOString();
  const rows = await env.DB.prepare(
    `SELECT * FROM tasks WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT ?`
  ).bind(nowIso, MAX_TASKS_PER_RUN).all<DueTask>();

  for (const task of rows.results) {
    try {
      await executeWithClaim(env, task);
    } catch (err) {
      // 单个任务的编排异常不能阻断整轮（其余任务继续）；
      // 抢占采用租约制，本轮异常的任务一小时后会自愈重试。
      console.error(
        `task ${task.id}: orchestration threw:`,
        err instanceof Error ? err.stack || err.message : err
      );
    }
  }

  // 1% 概率清理过期数据：30 天前日志、1 小时前的登录限流记录
  if (Math.random() < LOG_CLEANUP_PROBABILITY) {
    await env.DB.prepare(
      `DELETE FROM run_logs WHERE created_at < datetime('now', '-${LOG_RETENTION_DAYS} days')`
    ).run();
    await env.DB.prepare(
      "DELETE FROM login_attempts WHERE window_start < ?"
    ).bind(Math.floor(Date.now() / 1000) - 3600).run();
  }
}

/**
 * 执行编排（cron 与手动共用）：
 * 1. cron 路径先做「迟到 30 分钟」判定，超时跳过并重排到未来；
 * 2. 乐观锁抢占（把 next_run_at 改成租约值，防并发重复执行）；
 * 3. 执行；无论成功/失败/抛异常，finally 都会把 next_run_at 写回合法未来值。
 *
 * manual=true（「立即运行」）语义：
 * - 同样抢占，避免与同一分钟的 cron 重复发送；
 * - 原排期未到点：执行后原样恢复 next_run_at（不影响排期）；
 * - 原排期已到点：执行后消耗该 slot（从原时间点起算下一个）。
 */
export async function executeWithClaim(
  env: Env,
  task: DueTask,
  opts: { manual?: boolean } = {}
): Promise<{ status: string; detail: string }> {
  const originalNextRunAt = task.next_run_at;

  // 迟到超过 30 分钟：不补发，重排到未来并记 skipped 日志
  if (!opts.manual && originalNextRunAt) {
    const lateMs = Date.now() - new Date(originalNextRunAt).getTime();
    if (lateMs > MAX_LATE_MINUTES * 60000) {
      const next = computeNextRun(scheduleInputOf(task), new Date());
      const nextIso = (next ?? new Date(Date.now() + FALLBACK_RESCHEDULE_MS)).toISOString();
      await env.DB.batch([
        env.DB.prepare("UPDATE tasks SET next_run_at=?, updated_at=datetime('now') WHERE id = ?").bind(nextIso, task.id),
        env.DB.prepare("INSERT INTO run_logs(task_id, status, detail, duration_ms) VALUES(?, ?, ?, ?)").bind(task.id, "skipped", "missed,rescheduled", 0),
      ]);
      return { status: "skipped", detail: "missed,rescheduled" };
    }
  }

  // 乐观锁抢占：期望值不匹配说明已被其他执行抢走
  if (originalNextRunAt) {
    const lease = new Date(Date.now() + CLAIM_LEASE_MS).toISOString();
    const claim = await env.DB.prepare(
      "UPDATE tasks SET next_run_at=? WHERE id=? AND next_run_at=?"
    ).bind(lease, task.id, originalNextRunAt).run();
    if (claim.meta.changes === 0) {
      return { status: "skipped", detail: "already_claimed" };
    }
  }

  try {
    return await executeOneTask(env, task);
  } finally {
    if (opts.manual && originalNextRunAt && new Date(originalNextRunAt).getTime() > Date.now()) {
      // 手动运行且原排期未到点：恢复原排期
      await writeNextRunAt(env, task.id, originalNextRunAt);
    } else {
      // cron 路径 / 手动消耗已到点 slot / next_run_at 原本为空（顺带修复）：重排到未来
      const from = originalNextRunAt && opts.manual ? new Date(originalNextRunAt) : new Date();
      await rescheduleTask(env, task, from);
    }
  }
}

/**
 * 执行单个任务：25s 超时包装 → 写日志 + 更新任务状态（含连续失败计数）→ 达阈值发告警。
 * 不做抢占/重排（由 executeWithClaim 负责），手动与 cron 触发行为一致。
 */
export async function executeOneTask(
  env: Env,
  task: DueTask
): Promise<{ status: string; detail: string }> {
  const startedAt = Date.now();
  const rawStreak = Number(task.fail_streak);
  const prevStreak = Number.isFinite(rawStreak) && rawStreak > 0 ? Math.floor(rawStreak) : 0;

  let status = "success";
  let detail = "";

  let timer: number | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`task_timeout_${TASK_TIMEOUT_MS / 1000}s`)), TASK_TIMEOUT_MS);
  });

  const workPromise = (async () => {
    try {
      detail = await withClient(env, async (client) => {
        const target = task.bot_username === "me" ? "me" : task.bot_username;
        const sent = await client.sendMessage(target, { message: task.command });
        const sentId = (sent as { id?: number } | undefined)?.id ?? 0;

        // 可选：等待并抓取机器人回复。只认「本次发送之后、非自己发出」的消息，
        // 避免机器人本次没回复时把历史旧消息当成本次结果。
        if (task.capture_reply && task.reply_wait_sec > 0) {
          await new Promise((r) => setTimeout(r, task.reply_wait_sec * 1000));
          try {
            const messages = (await client.getMessages(target, { limit: 10 })) as unknown as Array<{
              id?: number;
              out?: boolean;
              message?: string;
            }>;
            const reply = messages.find((m) => !m.out && (m.id ?? 0) > sentId);
            return reply ? (reply.message || "").slice(0, REPLY_DETAIL_MAX_LEN) : "";
          } catch {
            return "[failed to capture reply]";
          }
        }
        return "";
      });
    } catch (err) {
      status = "failed";
      detail = (err instanceof Error ? err.message : String(err)).slice(0, REPLY_DETAIL_MAX_LEN);
    }
  })();

  try {
    await Promise.race([workPromise, timeoutPromise]);
  } catch (err) {
    if (status === "success") {
      status = "failed";
      detail = (err instanceof Error ? err.message : String(err)).slice(0, REPLY_DETAIL_MAX_LEN);
    }
  } finally {
    clearTimeout(timer); // 正常路径也必须清除，否则 25s 后会产生无人处理的 rejection
  }

  const durationMs = Date.now() - startedAt;
  const failStreak = status === "failed" ? prevStreak + 1 : 0;

  // 日志 + 任务状态合并为一次 batch（减少 D1 往返与写放大）
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO run_logs(task_id, status, detail, duration_ms) VALUES(?, ?, ?, ?)"
    ).bind(task.id, status, detail, durationMs),
    env.DB.prepare(
      "UPDATE tasks SET last_run_at=datetime('now'), last_status=?, last_error=?, fail_streak=?, updated_at=datetime('now') WHERE id = ?"
    ).bind(status, status === "failed" ? detail : null, failStreak, task.id),
  ]);

  // 连续失败告警：发给自己的"已保存消息"；告警自身失败只记日志，绝不递归告警
  if (status === "failed" && failStreak >= ALERT_THRESHOLD && failStreak % ALERT_EVERY === 0) {
    await sendFailureAlert(env, task, detail, failStreak);
  }

  return { status, detail };
}

/** 写回 next_run_at（恢复/重排共用）；失败重试一次，仍失败只记录——租约保证任务不会静默停跑 */
async function writeNextRunAt(env: Env, id: number, value: string): Promise<void> {
  const sql = "UPDATE tasks SET next_run_at=?, updated_at=datetime('now') WHERE id = ?";
  try {
    await env.DB.prepare(sql).bind(value, id).run();
  } catch (err) {
    console.error(`task ${id}: write next_run_at failed, retrying:`, err instanceof Error ? err.message : err);
    try {
      await env.DB.prepare(sql).bind(value, id).run();
    } catch (err2) {
      console.error(`task ${id}: write next_run_at failed again (lease will self-heal):`, err2 instanceof Error ? err2.message : err2);
    }
  }
}

/** 重排 next_run_at 到未来；computeNextRun 返回 null 时兜底 +1h，绝不留下 NULL */
async function rescheduleTask(env: Env, task: DueTask, from: Date): Promise<void> {
  let next = computeNextRun(scheduleInputOf(task), from);
  if (!next) {
    console.error(
      `task ${task.id}: computeNextRun returned null (schedule_type=${task.schedule_type}, schedule_value=${task.schedule_value}), fallback +1h`
    );
    next = new Date(from.getTime() + FALLBACK_RESCHEDULE_MS);
  }
  await writeNextRunAt(env, task.id, next.toISOString());
}

async function sendFailureAlert(env: Env, task: DueTask, detail: string, streak: number): Promise<void> {
  try {
    const text = [
      "⚠️ TG Checkin 任务连续失败",
      `任务: ${task.name} (#${task.id})`,
      `连续失败: ${streak} 次`,
      `错误: ${detail.slice(0, 200)}`,
    ].join("\n");
    await withClient(env, async (client) => {
      await client.sendMessage("me", { message: text });
    });
  } catch (err) {
    console.error(`task ${task.id}: failure alert send failed (ignored):`, err instanceof Error ? err.message : err);
  }
}
