import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withAccountSession: vi.fn(),
}));
vi.mock("../src/tg/client", () => ({
  withAccountSession: mocks.withAccountSession,
  withClient: mocks.withAccountSession,
  getDefaultAccount: vi.fn(),
}));

import { runDueTasks, executeWithClaim, executeOneTask } from "../src/cron/runner";
import { createFakeDb } from "./helpers/fake-db";
import type { Env } from "../src/bindings";

const PAST = new Date(Date.now() - 60_000).toISOString(); // 1 分钟前（已到点）
const LONG_PAST = new Date(Date.now() - 2 * 3600_000).toISOString(); // 2 小时前（迟到超 30 分钟）
const FUTURE = new Date(Date.now() + 3600_000).toISOString(); // 1 小时后（未到点）

const SESSION_A = "session-account-1";
const SESSION_B = "session-account-2";

/** 两个账户，用于验证任务按账户隔离取 session */
const ACCOUNTS = [
  { id: 1, name: "账户A", session: SESSION_A, status: "ok", is_default: 1, enabled: 1 },
  { id: 2, name: "账户B", session: SESSION_B, status: "ok", enabled: 1 },
];

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "每日签到",
    bot_username: "me",
    command: "/checkin",
    schedule_type: "interval",
    schedule_value: "30",
    timezone: "UTC",
    jitter_minutes: 0,
    capture_reply: 0,
    reply_wait_sec: 10,
    enabled: 1,
    next_run_at: PAST,
    fail_streak: 0,
    account_id: 1,
    account_session: SESSION_A,
    account_api_id: "",
    account_api_hash: "",
    account_status: "ok",
    ...overrides,
  };
}

const sent: Array<{ session: string; target: string; message: string }> = [];

function mockClientOk() {
  sent.length = 0;
  mocks.withAccountSession.mockImplementation(async (_env: unknown, cred: any, fn: any) =>
    fn({
      sendMessage: async (target: string, opts: { message: string }) => {
        sent.push({ session: cred.session, target, message: opts.message });
        return { id: 100 };
      },
      getMessages: async () => [],
    })
  );
}

function makeEnv(tasks: Array<Record<string, unknown>>, accounts: Array<Record<string, unknown>> = ACCOUNTS) {
  const fake = createFakeDb({ tasks, accounts });
  const env = {
    DB: fake.db,
    ASSETS: { fetch: async () => new Response("") },
    TG_API_ID: "12345",
    TG_API_HASH: "hash",
    ADMIN_PASSWORD: "pw",
  } as unknown as Env;
  return { env, fake };
}

beforeEach(() => {
  mocks.withAccountSession.mockReset();
  sent.length = 0;
});

describe("runner - cron 正常路径", () => {
  it("发送指令、写 success 日志、重排 next_run_at 到未来", async () => {
    mockClientOk();
    const { env, fake } = makeEnv([baseTask()]);

    await runDueTasks(env);

    expect(sent).toEqual([{ session: SESSION_A, target: "me", message: "/checkin" }]);
    const task = fake.state.tasks[0];
    expect(task.last_status).toBe("success");
    expect(task.next_run_at).not.toBe(PAST);
    expect(new Date(task.next_run_at).getTime()).toBeGreaterThan(Date.now());
    expect(fake.state.logs.at(-1)!.status).toBe("success");
  });

  it("多账户隔离：两个任务各用自己的 session 发送", async () => {
    mockClientOk();
    const { env } = makeEnv([
      baseTask({ id: 1, name: "任务A", account_id: 1, account_session: SESSION_A }),
      baseTask({ id: 2, name: "任务B", account_id: 2, account_session: SESSION_B, next_run_at: new Date(Date.now() - 30_000).toISOString() }),
    ]);

    await runDueTasks(env);

    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.session).sort()).toEqual([SESSION_A, SESSION_B].sort());
  });

  it("账户被停用时，其任务不被选中", async () => {
    mockClientOk();
    const { env } = makeEnv(
      [baseTask({ id: 2, account_id: 2, account_session: SESSION_B })],
      [{ id: 1, name: "A", session: SESSION_A, is_default: 1, enabled: 1 }, { id: 2, name: "B", session: SESSION_B, enabled: 0 }]
    );

    await runDueTasks(env);

    expect(sent).toHaveLength(0);
  });

  it("迟到超过 30 分钟：不执行，记 skipped 日志并重排", async () => {
    mockClientOk();
    const { env, fake } = makeEnv([baseTask({ next_run_at: LONG_PAST })]);

    await runDueTasks(env);

    expect(sent).toHaveLength(0);
    expect(new Date(fake.state.tasks[0].next_run_at).getTime()).toBeGreaterThan(Date.now());
    expect(
      fake.state.logs.some((l) => l.status === "skipped" && l.detail === "missed,rescheduled")
    ).toBe(true);
  });

  it("乐观锁：next_run_at 已被改动（并发抢占）→ 不执行", async () => {
    mockClientOk();
    const { env } = makeEnv([baseTask({ next_run_at: FUTURE })]);

    // 快照里是 PAST，但库里已是 FUTURE → 抢占 changes=0
    const result = await executeWithClaim(env, baseTask({ next_run_at: PAST }));

    expect(result).toEqual({ status: "skipped", detail: "already_claimed" });
    expect(sent).toHaveLength(0);
  });
});

describe("runner - T1 回归：占位后异常不得导致永久停跑", () => {
  it("执行后日志写入失败，next_run_at 仍被重排（不停留在占位租约值）", async () => {
    mockClientOk();
    const { env, fake } = makeEnv([baseTask()]);
    fake.failOn("INSERT INTO run_logs"); // batch 写日志+状态整体失败 → executeOneTask 抛错

    await runDueTasks(env);

    const task = fake.state.tasks[0];
    expect(task.next_run_at).not.toBeNull();
    // interval 30min：重排值应约在 now+30min，而非占位租约 now+60min
    expect(new Date(task.next_run_at).getTime()).toBeLessThan(Date.now() + 45 * 60_000);
  });

  it("抢占后连重排写入也失败：租约值保证一小时后自愈（永不失选）", async () => {
    mockClientOk();
    const { env, fake } = makeEnv([baseTask()]);
    fake.failOn("INSERT INTO run_logs");
    fake.failOn("next_run_at=?, updated_at"); // 只命中重排语句，不影响抢占语句

    await runDueTasks(env);

    const task = fake.state.tasks[0];
    expect(task.next_run_at).not.toBeNull();
    expect(new Date(task.next_run_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("单任务编排异常不阻断整轮（后续任务继续处理）", async () => {
    mockClientOk();
    const { env, fake } = makeEnv([baseTask({ id: 1 }), baseTask({ id: 2, name: "第二个任务" })]);
    fake.failOn("INSERT INTO run_logs");

    await runDueTasks(env);

    expect(
      fake.state.tasks.every((t) => new Date(t.next_run_at).getTime() > Date.now())
    ).toBe(true);
  });
});

describe("runner - 手动运行语义", () => {
  it("未到点任务：执行但原样恢复 next_run_at（不影响排期）", async () => {
    mockClientOk();
    const { env, fake } = makeEnv([baseTask({ next_run_at: FUTURE })]);

    const result = await executeWithClaim(env, baseTask({ next_run_at: FUTURE }), { manual: true });

    expect(result.status).toBe("success");
    expect(sent).toHaveLength(1);
    expect(fake.state.tasks[0].next_run_at).toBe(FUTURE);
  });

  it("已到点任务：执行并消耗本次 slot（重排到下一个）", async () => {
    mockClientOk();
    const { env, fake } = makeEnv([baseTask({ next_run_at: PAST })]);

    await executeWithClaim(env, baseTask({ next_run_at: PAST }), { manual: true });

    const next = fake.state.tasks[0].next_run_at;
    expect(next).not.toBe(PAST);
    expect(new Date(next).getTime()).toBeGreaterThan(Date.now());
  });

  it("next_run_at 原本为空（历史遗留）：执行后顺带修复为重排", async () => {
    mockClientOk();
    const { env, fake } = makeEnv([baseTask({ next_run_at: null })]);

    const result = await executeWithClaim(env, baseTask({ next_run_at: null }), { manual: true });

    expect(result.status).toBe("success");
    expect(new Date(fake.state.tasks[0].next_run_at).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("runner - 失败告警与回复抓取", () => {
  it("连续失败 3 次：向 me 发送告警", async () => {
    const task = baseTask({ fail_streak: 2 });
    const { env, fake } = makeEnv([task]);
    let call = 0;
    mocks.withAccountSession.mockImplementation(async (_env: unknown, _cred: any, fn: any) => {
      call += 1;
      if (call === 1) throw new Error("FLOOD_WAIT_X");
      return fn({ sendMessage: async () => ({ id: 1 }) });
    });

    const result = await executeWithClaim(env, task);

    expect(result.status).toBe("failed");
    expect(call).toBe(2); // 一次执行尝试 + 一次告警
    expect(fake.state.tasks[0].fail_streak).toBe(3);
  });

  it("告警通过本任务所属账户发送，不用别的账户", async () => {
    const task = baseTask({ fail_streak: 2, account_id: 2, account_session: SESSION_B });
    const { env } = makeEnv([task]);
    const used: string[] = [];
    mocks.withAccountSession.mockImplementation(async (_env: unknown, cred: any, fn: any) => {
      used.push(cred.session);
      return fn({ sendMessage: async () => ({ id: 1 }) });
    });

    await executeWithClaim(env, task);

    expect(used.every((s) => s === SESSION_B)).toBe(true);
  });

  it("告警自身失败只记录，不递归告警", async () => {
    const task = baseTask({ fail_streak: 2 });
    const { env } = makeEnv([task]);
    mocks.withAccountSession.mockImplementation(async () => {
      throw new Error("session_dead");
    });

    const result = await executeWithClaim(env, task);

    expect(result.status).toBe("failed");
  });

  it("成功后 fail_streak 清零", async () => {
    mockClientOk();
    const task = baseTask({ fail_streak: 5 });
    const { env, fake } = makeEnv([task]);

    await executeWithClaim(env, task);

    expect(fake.state.tasks[0].fail_streak).toBe(0);
  });

  it("capture_reply 只取本次发送之后、非自己的消息", async () => {
    // fake timers：消除对真实 1s 计时的依赖（QA 报告 N2，偶发 flaky 根因）
    vi.useFakeTimers();
    try {
      const task = baseTask({ capture_reply: 1, reply_wait_sec: 1 });
      const { env } = makeEnv([task]);
      mocks.withAccountSession.mockImplementation(async (_env: unknown, _cred: any, fn: any) =>
        fn({
          sendMessage: async () => ({ id: 100 }),
          getMessages: async () => [
            { id: 300, out: true, message: "我自己发的指令" },
            { id: 50, out: false, message: "历史旧回复" },
            { id: 200, out: false, message: "本次新回复" },
          ],
        })
      );

      const p = executeWithClaim(env, task);
      await vi.advanceTimersByTimeAsync(1000); // 推进 reply_wait_sec = 1s 的等待
      const result = await p;

      expect(result.detail).toBe("本次新回复");
    } finally {
      vi.useRealTimers();
    }
  });

  it("单任务 25 秒超时：记 failed 且不挂起整轮", async () => {
    vi.useFakeTimers();
    try {
      const task = baseTask();
      const { env, fake } = makeEnv([task]);
      mocks.withAccountSession.mockImplementation(() => new Promise(() => {})); // 永远挂起

      const p = executeOneTask(env, task);
      await vi.advanceTimersByTimeAsync(26_000);
      const result = await p;

      expect(result.status).toBe("failed");
      expect(result.detail).toContain("task_timeout");
      expect(fake.state.tasks[0].last_status).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runner - 账户状态跃迁", () => {
  it("会话失效类错误把账户标为 invalid", async () => {
    const task = baseTask();
    const { env, fake } = makeEnv([task]);
    mocks.withAccountSession.mockImplementation(async () => {
      throw new Error("AUTH_KEY_UNREGISTERED");
    });

    await executeWithClaim(env, task);

    expect(fake.state.accounts[0].status).toBe("invalid");
  });

  it("非会话类错误不动账户状态", async () => {
    const task = baseTask();
    const { env, fake } = makeEnv([task]);
    mocks.withAccountSession.mockImplementation(async () => {
      throw new Error("network unreachable");
    });

    await executeWithClaim(env, task);

    expect(fake.state.accounts[0].status).toBe("ok");
  });

  it("成功后账户状态恢复为 ok", async () => {
    mockClientOk();
    const task = baseTask({ account_status: "invalid" });
    const { env, fake } = makeEnv([task]);

    await executeWithClaim(env, task);

    expect(fake.state.accounts[0].status).toBe("ok");
  });

  it("账户未配置 session：任务记 failed 且不崩溃", async () => {
    mockClientOk();
    const task = baseTask({ account_session: "" });
    const { env, fake } = makeEnv([task]);
    mocks.withAccountSession.mockImplementation(async () => {
      throw new Error("account_session_not_configured");
    });

    const result = await executeWithClaim(env, task);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("account_session_not_configured");
    expect(new Date(fake.state.tasks[0].next_run_at).getTime()).toBeGreaterThan(Date.now());
  });
});
