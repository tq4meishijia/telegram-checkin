import { describe, it, expect } from "vitest";
import { createFakeDb } from "./helpers/fake-db";
import type { Env } from "../src/bindings";
import {
  DEFAULT_ADMIN_PASSWORD,
  hashPassword,
  validatePasswordStrength,
  verifyAdminPassword,
  verifyPassword,
} from "../src/password";

function makeEnv(settings: Record<string, string> = {}, adminPassword = "secret-pw") {
  const fake = createFakeDb({ settings });
  const env = {
    DB: fake.db,
    ASSETS: { fetch: async () => new Response("") },
    TG_API_ID: "1",
    TG_API_HASH: "h",
    ADMIN_PASSWORD: adminPassword,
  } as unknown as Env;
  return { env, fake };
}

describe("hashPassword / verifyPassword", () => {
  it("生成 pbkdf2$iterations$salt$hash 格式，且不含明文", async () => {
    const stored = await hashPassword("MyStr0ngPass!2026");
    expect(stored.startsWith("pbkdf2$")).toBe(true);
    expect(stored.split("$")).toHaveLength(4);
    expect(stored).not.toContain("MyStr0ngPass!2026");
    // 迭代次数记录在串里，将来可调强度而不使旧哈希失效
    expect(stored.split("$")[1]).toBe("100000");
  });

  it("同一密码两次哈希结果不同（随机盐）", async () => {
    const a = await hashPassword("MyStr0ngPass!2026");
    const b = await hashPassword("MyStr0ngPass!2026");
    expect(a).not.toBe(b);
  });

  it("正确密码通过，错误密码拒绝", async () => {
    const stored = await hashPassword("MyStr0ngPass!2026");
    expect(await verifyPassword("MyStr0ngPass!2026", stored)).toBe(true);
    expect(await verifyPassword("MyStr0ngPass!2027", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("畸形存储串一律拒绝，不抛异常", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$abc$00$00")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$10$zz$zz")).toBe(false);
    expect(await verifyPassword("x", "md5$1000$00$00")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$999999999999$00$00")).toBe(false);
  });
});

describe("validatePasswordStrength", () => {
  it("少于 12 位 → password_too_short", () => {
    expect(validatePasswordStrength("Ab1!Ab1!")).toBe("password_too_short");
  });
  it("只有一类字符 → password_too_weak", () => {
    expect(validatePasswordStrength("aaaaaaaaaaaa")).toBe("password_too_weak");
    expect(validatePasswordStrength("123456789012")).toBe("password_too_weak");
  });
  it("12 位以上且两类字符 → null（通过）", () => {
    expect(validatePasswordStrength("abcdefgh1234")).toBeNull();
    expect(validatePasswordStrength("MyStr0ngPass!2026")).toBeNull();
  });
  it("非字符串 / 超长 → 错误码", () => {
    expect(validatePasswordStrength(undefined)).toBe("invalid_new_password");
    expect(validatePasswordStrength("a".repeat(200))).toBe("password_too_long");
  });
});

describe("verifyAdminPassword — 三级回退", () => {
  it("未设置哈希时：以 ADMIN_PASSWORD secret 为准", async () => {
    const { env } = makeEnv();
    expect(await verifyAdminPassword(env, "secret-pw")).toBe(true);
    expect(await verifyAdminPassword(env, "admin")).toBe(false);
  });

  it("未设置哈希且无 secret 时：初始口令为 admin", async () => {
    const { env } = makeEnv({}, "");
    expect(await verifyAdminPassword(env, DEFAULT_ADMIN_PASSWORD)).toBe(true);
    expect(await verifyAdminPassword(env, "anything-else")).toBe(false);
  });

  it("设置哈希后：只认哈希，不再回退 secret 或默认口令", async () => {
    const { env } = makeEnv();
    const stored = await hashPassword("BrandNewPass!2026");
    await env.DB.prepare(
      "INSERT INTO settings(key, value, updated_at) VALUES('admin_pw_hash', ?, datetime('now'))"
    ).bind(stored).run();

    expect(await verifyAdminPassword(env, "BrandNewPass!2026")).toBe(true);
    expect(await verifyAdminPassword(env, "secret-pw")).toBe(false);
    expect(await verifyAdminPassword(env, "admin")).toBe(false);
  });

  it("空口令直接拒绝", async () => {
    const { env } = makeEnv();
    expect(await verifyAdminPassword(env, "")).toBe(false);
  });
});
