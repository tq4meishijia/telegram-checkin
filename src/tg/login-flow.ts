import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { computeCheck } from "telegram/Password";
import type { Env } from "../bindings";

/**
 * 网页交互式登录的 Telegram 驱动层。
 *
 * 为什么不用 client.start()：start() 是**交互式阻塞**流程（内部用回调等输入），
 * 在 Worker 里会挂死（项目红线 #2）。这里用底层 API 手工分三步：
 *   sendCode → auth.SignIn →（可选）account.GetPassword + auth.CheckPassword
 *
 * 为什么每一步都要重建 client：Worker 请求之间不共享内存，只有 StringSession
 * （含 authKey）能跨请求传递；phoneCodeHash 与 authKey 绑定，所以两者必须配对使用。
 */

export interface TgLoginUser {
  id: string;
  username: string | null;
  firstName: string | null;
}

export interface SendCodeResult {
  /** 未授权的 StringSession（含新生成的 authKey），SignIn 时必须原样带回 */
  session: string;
  phoneCodeHash: string;
  isCodeViaApp: boolean;
}

export interface SignInResult {
  session: string;
  user: TgLoginUser | null;
  /** true = 该账号开启了两步验证，需要再走密码步骤 */
  needPassword: boolean;
}

export interface CheckPasswordResult {
  session: string;
  user: TgLoginUser;
}

/** 凭据来源：账户级覆盖优先，空则回退 Worker Secret */
export interface TgCredRef {
  api_id?: string | null;
  api_hash?: string | null;
}

export interface LoginDriver {
  sendCode(phone: string, cred?: TgCredRef): Promise<SendCodeResult>;
  signIn(p: {
    session: string;
    phone: string;
    phoneCodeHash: string;
    code: string;
    cred?: TgCredRef;
  }): Promise<SignInResult>;
  checkPassword(p: { session: string; password: string; cred?: TgCredRef }): Promise<CheckPasswordResult>;
  getMe(p: { session: string; cred?: TgCredRef }): Promise<TgLoginUser>;
}

/** 可预期的登录错误（带对外错误码与 HTTP 状态） */
export class LoginError extends Error {
  constructor(public code: string, public status: number, public retryAfterSec?: number, public detail?: string) {
    super(code);
    this.name = "LoginError";
  }
}

/** 从 Telegram RPCError 里提取错误串（GramJS 用 errorMessage，原生 Error 用 message） */
function errText(err: unknown): string {
  const anyErr = err as any;
  return String(anyErr?.errorMessage || anyErr?.message || err || "");
}

/** 该错误是否表示「需要两步验证密码」 */
export function isPasswordNeeded(err: unknown): boolean {
  return errText(err).includes("SESSION_PASSWORD_NEEDED");
}

/**
 * 把 Telegram / 网络错误映射成对外错误码。
 * 未识别的错误统一 502，并保留截断后的原文便于排查（这是单管理员后台，不担心信息泄露）。
 */
export function mapTelegramError(err: unknown): LoginError {
  if (err instanceof LoginError) return err;
  const text = errText(err);
  const upper = text.toUpperCase();

  // 精确错误优先：API_ID_PUBLISHED_FLOOD / PHONE_NUMBER_FLOOD 都含 "FLOOD"，
  // 若先跑通用 FLOOD 规则会被误判成可重试的 flood_wait。
  const table: Array<[string, string, number]> = [
    ["API_ID_PUBLISHED_FLOOD", "api_id_restricted", 500],
    ["API_ID_INVALID", "invalid_api_credentials", 500],
    ["PHONE_NUMBER_FLOOD", "phone_flood", 429],
    ["PHONE_CODE_INVALID", "invalid_code", 400],
    ["PHONE_CODE_EMPTY", "invalid_code", 400],
    ["PHONE_CODE_EXPIRED", "code_expired", 400],
    ["PHONE_NUMBER_INVALID", "invalid_phone", 400],
    ["PHONE_NUMBER_BANNED", "phone_banned", 400],
    ["PHONE_NUMBER_UNOCCUPIED", "phone_not_registered", 400],
    ["PASSWORD_HASH_INVALID", "invalid_2fa_password", 400],
    ["SESSION_PASSWORD_NEEDED", "password_required", 400],
    ["AUTH_KEY_UNREGISTERED", "session_invalid", 400],
    ["AUTH_KEY_INVALID", "session_invalid", 400],
    ["AUTH_KEY_DUPLICATED", "session_duplicated", 400],
    ["USER_DEACTIVATED", "user_deactivated", 400],
  ];
  for (const [needle, code, status] of table) {
    if (upper.includes(needle)) return new LoginError(code, status, undefined, text.slice(0, 200));
  }

  // 通用限流：FLOOD_WAIT_42 / FLOOD_WAIT / FLOOD
  const flood = upper.match(/FLOOD_WAIT_?(\d+)?/);
  if (flood) {
    return new LoginError("flood_wait", 429, flood[1] ? Number(flood[1]) : 60, text.slice(0, 200));
  }
  if (upper.includes("FLOOD")) {
    return new LoginError("flood_wait", 429, 60, text.slice(0, 200));
  }

  // 连接类错误：区分开给前端，提示网络/代理问题
  if (/CONNECTION|TIMEOUT|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|websocket/i.test(text)) {
    return new LoginError("network_error", 502, undefined, text.slice(0, 200));
  }

  return new LoginError("tg_error", 502, undefined, text.slice(0, 200));
}

function extractUser(u: any): TgLoginUser | null {
  if (!u || typeof u !== "object") return null;
  const id = u.id ?? u.userId;
  if (id === undefined || id === null) return null;
  return {
    id: String(id),
    username: u.username ?? null,
    firstName: u.firstName ?? u.first_name ?? null,
  };
}

/** 真实驱动：每次操作独立建连接，用完即断（与 cron/verify 同一套纪律） */
export function createGramDriver(env: Env): LoginDriver {
  function open(session: string, cred?: TgCredRef) {
    const apiId = Number(cred?.api_id || env.TG_API_ID);
    const apiHash = cred?.api_hash || env.TG_API_HASH;
    if (!apiId || !apiHash) {
      throw new LoginError("tg_credentials_missing", 500, undefined, "TG_API_ID / TG_API_HASH 未配置");
    }
    // 自己持有 StringSession 实例：抽象基类把 save() 声明为 void，
    // 只有 StringSession 的实现返回 string，直接用实例取才能拿到类型正确的值。
    const stringSession = new StringSession(session);
    const client = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 2,
      autoReconnect: false,
      // 0 = 不自动 sleep 等待，FLOOD_WAIT 直接抛出由上层映射成 429
      floodSleepThreshold: 0,
    });
    return { client, stringSession, apiId, apiHash };
  }

  function save(stringSession: StringSession): string {
    const s = stringSession.save();
    if (!s) throw new LoginError("session_save_failed", 500, undefined, "StringSession 为空");
    return s;
  }

  return {
    async sendCode(phone, cred) {
      const { client, stringSession, apiId, apiHash } = open("", cred);
      await client.connect();
      try {
        const res = await client.sendCode({ apiId, apiHash }, phone);
        return {
          session: save(stringSession),
          phoneCodeHash: res.phoneCodeHash,
          isCodeViaApp: Boolean(res.isCodeViaApp),
        };
      } finally {
        await client.disconnect();
      }
    },

    async signIn({ session, phone, phoneCodeHash, code, cred }) {
      const { client, stringSession } = open(session, cred);
      await client.connect();
      try {
        const res: any = await client.invoke(
          new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code })
        );
        return { session: save(stringSession), user: extractUser(res?.user), needPassword: false };
      } catch (err) {
        if (isPasswordNeeded(err)) {
          // authKey 已存在，保存后交给密码步骤继续用
          return { session: save(stringSession), user: null, needPassword: true };
        }
        throw err;
      } finally {
        await client.disconnect();
      }
    },

    async checkPassword({ session, password, cred }) {
      const { client, stringSession } = open(session, cred);
      await client.connect();
      try {
        const pwd: any = await client.invoke(new Api.account.GetPassword());
        const check = await computeCheck(pwd, password);
        const res: any = await client.invoke(new Api.auth.CheckPassword({ password: check }));
        const user = extractUser(res?.user);
        if (!user) throw new LoginError("login_incomplete", 502, undefined, "CheckPassword 未返回用户");
        return { session: save(stringSession), user };
      } finally {
        await client.disconnect();
      }
    },

    async getMe({ session, cred }) {
      const { client } = open(session, cred);
      await client.connect();
      try {
        const me: any = await client.getMe();
        const user = extractUser(me);
        if (!user) throw new LoginError("login_incomplete", 502, undefined, "getMe 未返回用户");
        return user;
      } finally {
        await client.disconnect();
      }
    },
  };
}
