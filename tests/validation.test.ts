import { describe, it, expect } from "vitest";
import { validateSchedule, validateTaskBody, isValidTimezone } from "../src/validation";

describe("validateSchedule", () => {
  it("daily + HH:MM 合法", () => {
    expect(validateSchedule("daily", "08:00")).toBeNull();
    expect(validateSchedule("daily", "08:00,20:30")).toBeNull();
  });

  it("daily + 非法时间 → invalid_time_format", () => {
    expect(validateSchedule("daily", "8:00")).toBe("invalid_time_format");
    expect(validateSchedule("daily", "25:00")).toBe("invalid_time_format");
    expect(validateSchedule("daily", "720")).toBe("invalid_time_format");
    expect(validateSchedule("daily", "08:60")).toBe("invalid_time_format");
  });

  it("interval + 分钟数合法（1..1440）", () => {
    expect(validateSchedule("interval", "60")).toBeNull();
    expect(validateSchedule("interval", "1")).toBeNull();
    expect(validateSchedule("interval", "1440")).toBeNull();
  });

  it("interval + 非法值", () => {
    expect(validateSchedule("interval", "0")).toBe("interval_must_be_positive_integer");
    expect(validateSchedule("interval", "-5")).toBe("interval_must_be_positive_integer");
    expect(validateSchedule("interval", "abc")).toBe("interval_must_be_positive_integer");
    expect(validateSchedule("interval", "1.5")).toBe("interval_must_be_positive_integer");
    expect(validateSchedule("interval", "99999")).toBe("interval_must_be_positive_integer");
  });

  it("非法 schedule_type / 空 value", () => {
    expect(validateSchedule("weekly", "08:00")).toBe("invalid_schedule_type");
    expect(validateSchedule("daily", "")).toBe("invalid_schedule_value");
    expect(validateSchedule("daily", null)).toBe("invalid_schedule_value");
  });
});

describe("validateTaskBody - POST 全量", () => {
  const valid = {
    name: "每日签到",
    bot_username: "me",
    command: "/checkin",
    schedule_type: "daily",
    schedule_value: "08:00",
    timezone: "Asia/Shanghai",
    jitter_minutes: 0,
    capture_reply: 0,
    reply_wait_sec: 10,
    enabled: 1,
  };

  it("合法 body 通过，缺省字段填默认值", () => {
    const res = validateTaskBody(valid, { partial: false });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.timezone).toBe("Asia/Shanghai");
    expect(res.value.jitter_minutes).toBe(0);
    expect(res.value.capture_reply).toBe(0);
    expect(res.value.reply_wait_sec).toBe(10);
    expect(res.value.enabled).toBe(1);
  });

  it("缺必填字段 → 对应错误码", () => {
    expect(validateTaskBody({}, { partial: false })).toEqual({ ok: false, error: "invalid_name" });
    expect(
      validateTaskBody({ ...valid, name: undefined }, { partial: false })
    ).toEqual({ ok: false, error: "invalid_name" });
  });

  it("T4 回归：jitter_minutes 传字符串 'abc' → invalid_jitter_minutes", () => {
    const res = validateTaskBody({ ...valid, jitter_minutes: "abc" }, { partial: false });
    expect(res).toEqual({ ok: false, error: "invalid_jitter_minutes" });
  });

  it("T4 回归：schedule_value 传数字 → invalid_schedule_value", () => {
    const res = validateTaskBody({ ...valid, schedule_value: 720 }, { partial: false });
    expect(res).toEqual({ ok: false, error: "invalid_schedule_value" });
  });

  it("T4 回归：daily 配分钟数 → invalid_time_format", () => {
    const res = validateTaskBody({ ...valid, schedule_value: "720" }, { partial: false });
    expect(res).toEqual({ ok: false, error: "invalid_time_format" });
  });

  it("bot_username 格式校验", () => {
    expect(validateTaskBody({ ...valid, bot_username: "@some_bot" }, { partial: false }).ok).toBe(true);
    expect(validateTaskBody({ ...valid, bot_username: "me" }, { partial: false }).ok).toBe(true);
    expect(validateTaskBody({ ...valid, bot_username: "ab" }, { partial: false })).toEqual({
      ok: false,
      error: "invalid_bot_username",
    });
    expect(validateTaskBody({ ...valid, bot_username: "https://t.me/x" }, { partial: false })).toEqual({
      ok: false,
      error: "invalid_bot_username",
    });
  });

  it("时区校验：非法 IANA 名拒绝", () => {
    expect(validateTaskBody({ ...valid, timezone: "Not/AZone" }, { partial: false })).toEqual({
      ok: false,
      error: "invalid_timezone",
    });
  });

  it("布尔型 capture_reply / enabled 归一化为 0/1", () => {
    const res = validateTaskBody(
      { ...valid, capture_reply: true, enabled: false },
      { partial: false }
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.capture_reply).toBe(1);
    expect(res.value.enabled).toBe(0);
  });

  it("非对象 body → invalid_body", () => {
    expect(validateTaskBody(null, { partial: false })).toEqual({ ok: false, error: "invalid_body" });
    expect(validateTaskBody([1, 2], { partial: false })).toEqual({ ok: false, error: "invalid_body" });
  });
});

describe("validateTaskBody - PATCH 部分更新", () => {
  it("只更新 enabled，其余字段不出现", () => {
    const res = validateTaskBody({ enabled: 0 }, { partial: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual({ enabled: 0 });
  });

  it("出现的字段非法 → 拒绝", () => {
    expect(validateTaskBody({ jitter_minutes: "x" }, { partial: true })).toEqual({
      ok: false,
      error: "invalid_jitter_minutes",
    });
    expect(validateTaskBody({ reply_wait_sec: 0 }, { partial: true })).toEqual({
      ok: false,
      error: "invalid_reply_wait_sec",
    });
    expect(validateTaskBody({ schedule_value: "" }, { partial: true })).toEqual({
      ok: false,
      error: "invalid_schedule_value",
    });
  });
});

describe("isValidTimezone", () => {
  it("常见时区有效", () => {
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Asia/Shanghai")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
  });

  it("无效时区 false", () => {
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});
