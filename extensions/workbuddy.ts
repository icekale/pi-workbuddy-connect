// WorkBuddy AI 国际版 + CodeBuddy 国内版：pi 双 provider 扩展。
//
// 同一个扩展注册两个 provider：
//   workbuddy — 国际版，chat 走 https://www.workbuddy.ai
//   codebuddy — 国内版，chat 走 https://copilot.tencent.com，积分走 https://www.codebuddy.cn
// 区域判定只看凭据自己的 domain（移植自上游 iceloon/dsh-workbuddyai-connect 的
// regionOf 规则），两个版本各走各的凭据文件、登录态、设置与命令，互不干扰。
//
// 国内版事实来源（均已对源码实证）：
// - 上游 DSH 的 upstream.ts：regionOf / CN_CHAT_BASE / CN_BILLING_BASE /
//   按区域切换的 Origin-Referer / 刷新走各区域 chatBase 下的 /v2/plugin/auth/token/refresh。
// - ShouZhuo0413/codebuddy2api：国内版插件登录链路
//   POST /v2/plugin/auth/state?platform=CLI → authUrl(copilot.tencent.com/login) →
//   GET /v2/plugin/auth/token?state= → GET /v2/plugin/login/account?state=（Bearer）。
// - 桌面凭据同目录 CodeBuddyExtension/Data/Public/auth/ 下两个文件：
//   workbuddy-desktop-ai.info（国际）/ workbuddy-desktop.info（国内）。
// - 桌面 App 5.6.0+ 起 .info 里的 token 可能是 $wbEncrypted 信封（AES-256-GCM），
//   解密逻辑移植自 codebuddy2api 的 workbuddy_atrest_crypto.py。
//
// 待在用户 Mac 上验证的两处（先以最可能的默认值占位，README 有说明）：
// 1. 国内版产品配置缓存路径（默认先试 ~/.codebuddy-ai，再回退 ~/.workbuddy-ai）。
// 2. 国内版内置免费模型清单（默认空，缓存命中时以缓存为准）。
import { readFileSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type Region = "global" | "cn";

interface RegionConfig {
  region: Region;
  /** pi provider id，也是 /login 的参数 */
  providerId: string;
  productName: string;
  editionLabel: string;
  chatBase: string;
  billingBase: string;
  originBase: string;
  desktopAuthBasename: string;
  /** 产品配置缓存的候选数据目录，按序尝试 */
  dataDirNames: string[];
  authFileEnv: string;
  productConfigEnv: string;
  ownAuthFilename: string;
  settingsFilename: string;
  /** /workbuddy 或 /codebuddy */
  command: string;
  widgetKey: string;
  /** 区分两个 provider 请求的打标头 */
  marker: string;
  builtinModels: ProductModel[];
  freeIds: readonly string[];
}

/**
 * 凭据 domain → 区域（移植自上游）。空 domain 视为 global：历史凭据与
 * 插件登录都可能不带 domain，保守起见不把它判给国内。
 */
export function regionOf(domain: string): Region {
  const lowered = domain.trim().toLowerCase();
  if (lowered === "" || lowered.endsWith("workbuddy.ai") || lowered.endsWith("codebuddy.ai")) {
    return "global";
  }
  return "cn";
}

const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
const AUTH_DIR_REL = ["CodeBuddyExtension", "Data", "Public", "auth"] as const;
const PRODUCT_CONFIG_BASENAME = "acc-product-config-v3.json";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  maxTokensField: "max_tokens" as const,
};
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];
type Scope = "free" | "all";

export function thinkingLevelMap(efforts: readonly string[], canDisable = false) {
  return {
    off: canDisable ? "off" : null,
    minimal: null,
    low: efforts.includes("low") ? "low" : null,
    medium: efforts.includes("medium") ? "medium" : null,
    high: efforts.includes("high") ? "high" : null,
    xhigh: efforts.includes("xhigh") ? "xhigh" : null,
    max: efforts.includes("max") ? "max" : null,
  } as const;
}

const HIGH_ONLY = thinkingLevelMap(["high"]);
const LOW_HIGH = thinkingLevelMap(["low", "high"]);

type Cred = {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  domain: string;
  uid: string;
  enterpriseId?: string;
  nickname?: string;
};

type ProductModel = {
  id: string;
  name: string;
  credits?: string;
  contextWindow: number;
  maxTokens: number;
  supportsImages: boolean;
  supportsReasoning: boolean;
  supportedEfforts?: Effort[];
  canDisableThinking: boolean;
};

type ProductConfig = { source: "cache" | "builtin"; models: ProductModel[]; path?: string };

// 国际版内置免费模型（与之前版本一致）。
const BUILTIN_GLOBAL_MODELS: ProductModel[] = [
  {
    id: "deepseek-v4.1-flash",
    name: "Deepseek-V4.1-Flash",
    credits: "x0.00",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    supportsImages: true,
    supportsReasoning: true,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    canDisableThinking: false,
  },
  {
    id: "hy4-preview-f",
    name: "Hy4 preview",
    credits: "x0.00",
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsReasoning: true,
    supportedEfforts: ["high"],
    canDisableThinking: false,
  },
  {
    id: "hy3",
    name: "Hy3",
    credits: "x0.00",
    contextWindow: 192_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsReasoning: true,
    supportedEfforts: ["low", "high"],
    canDisableThinking: false,
  },
];

const FREE_GLOBAL_IDS = ["hy3", "deepseek-v4.1-flash", "hy4-preview-f"] as const;
// ponytail: flash reasoning loops (OK/Let me write/Go) eat 128k max_tokens; 16k stops the stall. Raise if long answers get cut.
const FLASH_MAX_TOKENS = 16_384;

export const REGIONS: Record<Region, RegionConfig> = {
  global: {
    region: "global",
    providerId: "workbuddy",
    productName: "WorkBuddy AI",
    editionLabel: "国际版",
    chatBase: "https://www.workbuddy.ai",
    billingBase: "https://www.workbuddy.ai",
    originBase: "https://www.workbuddy.ai",
    desktopAuthBasename: "workbuddy-desktop-ai.info",
    dataDirNames: [".workbuddy-ai"],
    authFileEnv: "WORKBUDDY_AUTH_FILE",
    productConfigEnv: "WORKBUDDYAI_PRODUCT_CONFIG",
    ownAuthFilename: ".workbuddy-auth.json",
    settingsFilename: ".workbuddy-settings.json",
    command: "workbuddy",
    widgetKey: "workbuddy",
    marker: "X-Pi-WorkBuddy",
    builtinModels: BUILTIN_GLOBAL_MODELS,
    freeIds: FREE_GLOBAL_IDS,
  },
  cn: {
    region: "cn",
    providerId: "codebuddy",
    productName: "CodeBuddy",
    editionLabel: "国内版",
    chatBase: "https://copilot.tencent.com",
    billingBase: "https://www.codebuddy.cn",
    originBase: "https://www.codebuddy.cn",
    desktopAuthBasename: "workbuddy-desktop.info",
    // 待用户 Mac 验证：国内版桌面 App 的产品配置缓存目录。
    dataDirNames: [".codebuddy-ai", ".workbuddy-ai"],
    authFileEnv: "CODEBUDDY_AUTH_FILE",
    productConfigEnv: "CODEBUDDY_PRODUCT_CONFIG",
    ownAuthFilename: ".codebuddy-auth.json",
    settingsFilename: ".codebuddy-settings.json",
    command: "codebuddy",
    widgetKey: "codebuddy",
    marker: "X-Pi-CodeBuddy",
    // 待用户 Mac 验证：国内版免费模型以桌面缓存为准，缺缓存时暂不提供内置兜底。
    builtinModels: [],
    freeIds: [],
  },
};

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function productConfigPaths(cfg: RegionConfig): string[] {
  const override = process.env[cfg.productConfigEnv]?.trim();
  if (override) return [override];
  return cfg.dataDirNames.map((dir) => join(homedir(), dir, "cache", PRODUCT_CONFIG_BASENAME));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function creditsAreFree(credits: string | undefined): boolean {
  if (credits === undefined) return false;
  return /^x?0(?:\.0+)?$/u.test(credits.trim());
}

function parseEffort(value: unknown): Effort | undefined {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value)
    ? value as Effort
    : undefined;
}

function parseProductModel(value: unknown): ProductModel | undefined {
  const row = asRecord(value);
  if (!row) return undefined;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (id === "") return undefined;
  const reasoning = asRecord(row.reasoning);
  const rawEfforts = reasoning?.supportedEfforts;
  let supportedEfforts: Effort[] | undefined;
  if (Array.isArray(rawEfforts)) {
    const efforts = rawEfforts.map(parseEffort).filter((e): e is Effort => e !== undefined);
    if (efforts.length > 0) supportedEfforts = efforts;
  }
  return {
    id,
    name: typeof row.name === "string" && row.name !== "" ? row.name : id,
    ...(typeof row.credits === "string" && row.credits.trim() !== "" ? { credits: row.credits.trim() } : {}),
    contextWindow: positiveNumber(row.maxInputTokens) ?? positiveNumber(row.maxAllowedSize) ?? 0,
    maxTokens: positiveNumber(row.maxOutputTokens) ?? 0,
    supportsImages: row.supportsImages === true && row.disabledMultimodal !== true,
    supportsReasoning: row.supportsReasoning === true,
    ...supportedEfforts ? { supportedEfforts } : {},
    canDisableThinking: reasoning?.canDisableThinking === true,
  };
}

export function parseProductConfig(text: string): ProductConfig | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const document = asRecord(parsed);
  if (!document || !Array.isArray(document.models)) return undefined;
  const models = document.models.map(parseProductModel).filter((m): m is ProductModel => m !== undefined);
  if (models.length === 0) return undefined;
  return { source: "cache", models };
}

export function loadProductConfig(cfg: RegionConfig, overridePath?: string): ProductConfig {
  const candidates = overridePath ? [overridePath] : productConfigPaths(cfg);
  for (const path of candidates) {
    try {
      const parsed = parseProductConfig(readFileSync(path, "utf8"));
      if (parsed) return { ...parsed, path };
    } catch { /* try next candidate, then builtin */ }
  }
  return { source: "builtin", models: cfg.builtinModels };
}

export function freeModelIds(cfg: RegionConfig, config: ProductConfig): readonly string[] {
  if (config.source === "builtin") return cfg.freeIds;
  const free = config.models.filter((m) => creditsAreFree(m.credits)).map((m) => m.id);
  return free.length > 0 ? free : cfg.freeIds;
}

function settingsPath(cfg: RegionConfig): string {
  return join(agentDir(), cfg.settingsFilename);
}

export function loadSettings(cfg: RegionConfig): { scope: Scope } {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(cfg), "utf8")) as { scope?: string };
    if (parsed.scope === "all") return { scope: "all" };
  } catch { /* default free */ }
  return { scope: "free" };
}

async function saveSettings(cfg: RegionConfig, scope: Scope): Promise<void> {
  await writeFile(settingsPath(cfg), `${JSON.stringify({ scope }, null, 2)}\n`, { mode: 0o600 });
}

export function buildPiModels(cfg: RegionConfig, config: ProductConfig, scope: Scope) {
  const byId = new Map<string, ProductModel>();
  if (config.source === "cache") {
    for (const model of config.models) byId.set(model.id, model);
  }
  for (const model of cfg.builtinModels) {
    if (!byId.has(model.id)) byId.set(model.id, model);
  }
  const free = new Set(freeModelIds(cfg, config));
  const rows = [...byId.values()].filter((model) => scope === "all" || free.has(model.id));
  return rows.flatMap((row) => {
    if (row.contextWindow <= 0 || row.maxTokens <= 0) return [];
    const efforts = row.supportsReasoning
      ? (row.supportedEfforts?.length ? row.supportedEfforts : EFFORTS)
      : [];
    const credits = row.credits ?? "x?";
    return [{
      id: row.id,
      name: `${row.name} · ${credits}`,
      reasoning: row.supportsReasoning,
      thinkingLevelMap: thinkingLevelMap(efforts, row.canDisableThinking),
      input: (row.supportsImages ? ["text", "image"] : ["text"]) as ("text" | "image")[],
      cost: ZERO_COST,
      contextWindow: row.contextWindow,
      maxTokens: row.id === "deepseek-v4.1-flash" ? Math.min(row.maxTokens, FLASH_MAX_TOKENS) : row.maxTokens,
      compat: COMPAT,
    }];
  });
}

function desktopCandidates(cfg: RegionConfig): string[] {
  const env = process.env[cfg.authFileEnv]?.trim();
  if (env) return [env];
  const home = homedir();
  const rel = [...AUTH_DIR_REL, cfg.desktopAuthBasename] as const;
  if (process.platform === "darwin") return [join(home, "Library", "Application Support", ...rel)];
  if (process.platform === "win32") {
    return [join(home, "AppData", "Local", ...rel), join(home, "AppData", "Roaming", ...rel)];
  }
  return [join(home, ".config", ...rel)];
}

function ownPath(cfg: RegionConfig): string {
  return join(agentDir(), cfg.ownAuthFilename);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function expiryToMs(value: number): number {
  if (value <= 0) return 0;
  return value > 1e12 ? value : value * 1000;
}

function credFromAuthDoc(document: Record<string, unknown>): Cred | undefined {
  const nested = typeof document.auth === "object" && document.auth !== null;
  const auth = (nested ? document.auth : document) as Record<string, unknown>;
  const identity = (
    nested && typeof document.account === "object" && document.account !== null
      ? document.account
      : document
  ) as Record<string, unknown>;
  const accessToken = optionalString(auth.accessToken);
  if (!accessToken) return undefined;
  const enterpriseId = optionalString(identity.enterpriseId);
  const nickname = optionalString(identity.nickname);
  return {
    accessToken,
    refreshToken: optionalString(auth.refreshToken) ?? "",
    expiresAtMs: typeof auth.expiresAt === "number" ? expiryToMs(auth.expiresAt) : 0,
    domain: optionalString(auth.domain) ?? "",
    uid: optionalString(identity.uid) ?? "",
    ...(enterpriseId ? { enterpriseId } : {}),
    ...(nickname ? { nickname } : {}),
  };
}

export function parseWorkBuddyAuth(text: string): Cred | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const document = asRecord(parsed);
  if (!document) return undefined;
  return credFromAuthDoc(document);
}

// ---------------------------------------------------------------------------
// $wbEncrypted at-rest 解密（移植自 codebuddy2api/core/workbuddy_atrest_crypto.py）
// 桌面 App 5.6.0+ 起 .info 里的 accessToken/refreshToken 可能是加密信封：
//   {"$wbEncrypted": 1, "envelope": "<base64 of JSON>"}
// envelope: {suite:1, keyId:"<16 hex>", nonce:"<b64 12B>", authTag:"<b64 16B>", ciphertext:"<b64>"}
// 密钥 = sha256(utf8(atRestSecretKey))，atRestSecretKey 来自桌面 App 自带 Electron 的
// 原生 loggerGet，或环境变量 WORKBUDDY_AT_REST_SECRET 直接提供。
// ---------------------------------------------------------------------------

const AT_REST_SECRET_ENV = "WORKBUDDY_AT_REST_SECRET";
const ELECTRON_PATH_ENV = "WORKBUDDY_ELECTRON_PATH";
const LOGGER_GET_JS =
  "const b=process._linkedBinding('electron_browser_workbuddy_storage');" +
  "process.stdout.write(b.loggerGet().toString('utf8'));";

type EncryptedField = { $wbEncrypted: 1; envelope: string };

export function isEncryptedField(value: unknown): value is EncryptedField {
  const record = asRecord(value);
  return record !== undefined
    && record.$wbEncrypted === 1
    && typeof record.envelope === "string";
}

function electronCandidates(): string[] {
  const env = process.env[ELECTRON_PATH_ENV]?.trim();
  const list = env ? [env] : [];
  if (process.platform === "darwin") {
    list.push("/Applications/WorkBuddy.app/Contents/MacOS/Electron");
  } else if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA?.trim();
    if (local) list.push(join(local, "Programs", "WorkBuddy", "WorkBuddy.exe"));
  } else {
    list.push("/opt/WorkBuddy/workbuddy", "/usr/bin/workbuddy");
  }
  return list;
}

const execFileAsync = promisify(execFile);

async function fetchAtRestSecret(): Promise<string> {
  let lastError = "no candidate binary";
  for (const exe of electronCandidates()) {
    try {
      const { stdout } = await execFileAsync(exe, ["-e", LOGGER_GET_JS], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        timeout: 20_000,
      });
      const payload = asRecord(JSON.parse(stdout.trim()));
      const secret = optionalString(payload?.atRestSecretKey);
      if (secret) return secret;
      lastError = `${exe}: empty atRestSecretKey`;
    } catch (error) {
      lastError = `${exe}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  throw new Error(`无法获取桌面端 at-rest 密钥（${lastError}）`);
}

let cachedAtRestSecret: string | null | undefined;

async function atRestSecret(): Promise<string | undefined> {
  if (cachedAtRestSecret !== undefined) return cachedAtRestSecret ?? undefined;
  const env = process.env[AT_REST_SECRET_ENV]?.trim();
  if (env) {
    cachedAtRestSecret = env;
    return env;
  }
  try {
    const secret = await fetchAtRestSecret();
    cachedAtRestSecret = secret;
    return secret;
  } catch {
    cachedAtRestSecret = null;
    return undefined;
  }
}

function uint32be(n: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(n, 0);
  return buffer;
}

/** sym-v1 field framing 的 AAD，与 Python 实现逐字节一致。 */
export function atRestAad(keyId: string): Buffer {
  const lp = (b: Buffer) => Buffer.concat([uint32be(b.length), b]);
  return Buffer.concat([
    Buffer.from("WB-AAD\x00", "utf8"),
    Buffer.from([0x01]),
    lp(Buffer.from("WBEV1", "utf8")),
    lp(Buffer.from("sym-v1", "utf8")),
    uint32be(1),
    lp(Buffer.from(keyId, "ascii")),
    Buffer.from([0x02, 0x00, 0x00]),
  ]);
}

export function decryptAtRestEnvelope(envelopeB64: string, secretB64: string): string | undefined {
  let env: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(envelopeB64, "base64").toString("utf8"));
    const record = asRecord(parsed);
    if (!record) return undefined;
    env = record;
  } catch {
    return undefined;
  }
  if (env.suite !== 1 || typeof env.keyId !== "string") return undefined;
  const key = createHash("sha256").update(secretB64, "utf8").digest();
  const keyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
  if (keyId !== env.keyId) return undefined;
  if (typeof env.nonce !== "string" || typeof env.authTag !== "string" || typeof env.ciphertext !== "string") {
    return undefined;
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(env.nonce, "base64"));
    decipher.setAAD(atRestAad(keyId));
    decipher.setAuthTag(Buffer.from(env.authTag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(env.ciphertext, "base64")),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  } catch {
    return undefined;
  }
}

async function expandEncryptedFields(document: Record<string, unknown>): Promise<void> {
  const nested = typeof document.auth === "object" && document.auth !== null;
  const auth = (nested ? document.auth : document) as Record<string, unknown>;
  for (const field of ["accessToken", "refreshToken"] as const) {
    const value = auth[field];
    if (!isEncryptedField(value)) continue;
    const secret = await atRestSecret();
    if (!secret) {
      throw new Error(
        `桌面凭据里的 ${field} 已加密但拿不到解密密钥：请确认桌面 App 已装好，` +
        `或设置 ${AT_REST_SECRET_ENV} 环境变量，或改用弹窗登录`,
      );
    }
    const plain = decryptAtRestEnvelope(value.envelope, secret);
    if (plain === undefined) throw new Error(`桌面凭据里的 ${field} 解密失败，凭据可能已损坏`);
    auth[field] = plain;
  }
}

/** 桌面 .info 解析（含 $wbEncrypted 解密）；插件自存文件走同步的 parseWorkBuddyAuth。 */
export async function parseWorkBuddyAuthAsync(text: string): Promise<Cred | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const document = asRecord(parsed);
  if (!document) return undefined;
  await expandEncryptedFields(document);
  return credFromAuthDoc(document);
}

function parseOwn(text: string): Cred | undefined {
  const document = asRecord((() => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  })());
  if (!document) return undefined;
  if (document.version !== 1 || typeof document.credential !== "object" || document.credential === null) {
    return undefined;
  }
  const stored = document.credential as Record<string, unknown>;
  const accessToken = optionalString(stored.accessToken);
  if (!accessToken) return undefined;
  const enterpriseId = optionalString(stored.enterpriseId);
  const nickname = optionalString(stored.nickname);
  return {
    accessToken,
    refreshToken: optionalString(stored.refreshToken) ?? "",
    expiresAtMs: typeof stored.expiresAtMs === "number" ? stored.expiresAtMs : 0,
    domain: optionalString(stored.domain) ?? "",
    uid: optionalString(stored.uid) ?? "",
    ...(enterpriseId ? { enterpriseId } : {}),
    ...(nickname ? { nickname } : {}),
  };
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function current(cfg: RegionConfig): Promise<Cred | undefined> {
  const own = await readText(ownPath(cfg)).then((text) => (text ? parseOwn(text) : undefined));
  let desktop: Cred | undefined;
  for (const path of desktopCandidates(cfg)) {
    const text = await readText(path);
    if (!text) continue;
    const cred = await parseWorkBuddyAuthAsync(text).catch(() => undefined);
    // 凭据的 domain 与本 provider 区域明显冲突时不用它，避免把国内 token 发往国际端点。
    if (cred && cred.domain !== "" && regionOf(cred.domain) !== cfg.region) continue;
    if (cred) {
      desktop = cred;
      break;
    }
  }
  if (!desktop) return own;
  if (!own) return desktop;
  return own.expiresAtMs > desktop.expiresAtMs ? own : desktop;
}

async function saveOwn(cfg: RegionConfig, cred: Cred): Promise<void> {
  await writeFile(ownPath(cfg), JSON.stringify({ version: 1, credential: cred }), { mode: 0o600 });
}

export function refreshEndpoint(cfg: RegionConfig): string {
  return `${cfg.chatBase}/v2/plugin/auth/token/refresh`;
}

async function refreshAccess(cfg: RegionConfig, cred: Cred): Promise<Cred> {
  const response = await fetch(refreshEndpoint(cfg), {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest",
      Origin: cfg.originBase,
      Referer: `${cfg.originBase}/`,
      "User-Agent": CLIENT_UA,
      "X-Refresh-Token": cred.refreshToken,
      "X-Auth-Refresh-Source": "workbuddy",
      ...(cred.enterpriseId ? { "X-Enterprise-Id": cred.enterpriseId } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const envelope = (await response.json()) as { code?: number; msg?: string; data?: Record<string, unknown> };
  const data = envelope.data ?? {};
  const accessToken = typeof data.accessToken === "string" ? data.accessToken : "";
  if (!response.ok || envelope.code !== 0 || accessToken === "") {
    throw new Error(envelope.msg || `${cfg.productName} token 刷新失败，请重新登录`);
  }
  return {
    ...cred,
    accessToken,
    refreshToken: typeof data.refreshToken === "string" && data.refreshToken !== "" ? data.refreshToken : cred.refreshToken,
    expiresAtMs: typeof data.expiresIn === "number" && data.expiresIn > 0
      ? Date.now() + data.expiresIn * 1000
      : cred.expiresAtMs,
    domain: typeof data.domain === "string" && data.domain !== "" ? data.domain : cred.domain,
  };
}

const inflight = new Map<string, Promise<Cred>>();

async function resolveCred(cfg: RegionConfig): Promise<Cred> {
  const cred = await current(cfg);
  if (!cred) {
    throw new Error(
      `${cfg.productName}：未登录。设置 → 模型 → ${cfg.productName} → Connect 弹出登录页，` +
      `或登录桌面应用 / 设 ${cfg.authFileEnv}`,
    );
  }
  if (cred.expiresAtMs > 0 && Date.now() + REFRESH_MARGIN_MS < cred.expiresAtMs) return cred;
  if (cred.refreshToken === "") {
    if (cred.expiresAtMs > Date.now() + 30_000) return cred;
    throw new Error(`${cfg.productName}：access token 已过期，请重新登录`);
  }
  const key = cfg.providerId;
  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const next = await refreshAccess(cfg, cred);
        await saveOwn(cfg, next);
        return next;
      } catch (error) {
        if (cred.expiresAtMs > Date.now() + 30_000) return cred;
        throw error;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, pending);
  }
  return pending;
}

function chatHeaders(cfg: RegionConfig, cred: Cred): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: cfg.originBase,
    Referer: `${cfg.originBase}/`,
    "User-Agent": CLIENT_UA,
    Authorization: `Bearer ${cred.accessToken}`,
    ...(cred.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": cred.uid }),
    ...(cred.enterpriseId ? { "X-Enterprise-Id": cred.enterpriseId } : { "X-No-Enterprise-Id": "1" }),
    ...(cred.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": cred.domain }),
    "X-Product": "SaaS",
  };
}

function stripAssistantReasoning(messages: unknown[]): void {
  for (const item of messages) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const msg = item as Record<string, unknown>;
    if (msg.role !== "assistant") continue;
    delete msg.reasoning;
    delete msg.thinking;
    delete msg.reasoning_content;
    if (!Array.isArray(msg.content)) continue;
    msg.content = msg.content.filter((part) => {
      if (typeof part !== "object" || part === null) return true;
      const type = (part as { type?: string }).type;
      return type !== "reasoning" && type !== "thinking";
    });
    if (Array.isArray(msg.content) && msg.content.length === 0) msg.content = "";
  }
}

export function prepareChatPayload(payload: Record<string, unknown>): Record<string, unknown> {
  payload.stream = true;
  const messages = payload.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (typeof message === "object" && message !== null && !Array.isArray(message)
        && (message as Record<string, unknown>).role === "developer") {
        (message as Record<string, unknown>).role = "system";
      }
    }
    if (messages.length > 0 && (messages[0] as { role?: string } | undefined)?.role !== "system") {
      messages.unshift({ role: "system", content: "You are a helpful assistant." });
    }
    stripAssistantReasoning(messages);
  }
  if (payload.model === "deepseek-v4.1-flash") {
    const current = Number(payload.max_tokens);
    payload.max_tokens = Number.isFinite(current) && current > 0
      ? Math.min(current, FLASH_MAX_TOKENS)
      : FLASH_MAX_TOKENS;
  }
  if ("tool_choice" in payload) {
    const choice = payload.tool_choice;
    if (typeof choice === "string") {
      if (choice.trim().toLowerCase() === "none") {
        delete payload.tool_choice;
        delete payload.tools;
        delete payload.functions;
      }
    } else if (typeof choice === "object" && choice !== null && !Array.isArray(choice)) {
      const wrapped = choice as Record<string, unknown>;
      const type = typeof wrapped.type === "string" ? wrapped.type.trim().toLowerCase() : "";
      if (type === "none") {
        delete payload.tool_choice;
        delete payload.tools;
        delete payload.functions;
      } else if (type === "auto" || type === "required") {
        payload.tool_choice = type;
      } else if (type === "function") {
        const fn = typeof wrapped.function === "object" && wrapped.function !== null
          ? (wrapped.function as Record<string, unknown>)
          : undefined;
        const name = (typeof fn?.name === "string" ? fn.name : typeof wrapped.name === "string" ? wrapped.name : "").trim();
        payload.tool_choice = name || "auto";
      } else {
        delete payload.tool_choice;
      }
    } else {
      delete payload.tool_choice;
    }
  }
  // ponytail: never inject reasoning_effort — upstream sends a bare request when no
  // level is chosen, so "Default" must stay Default instead of silently becoming high.
  return payload;
}

/** `before_provider_request` carries no provider, so payloads are scoped by model id.
 *  Without this the hook rewrites every other provider's request (developer role,
 *  tool_choice, stream). */
export function isWorkBuddyModel(modelId: unknown, ids: ReadonlySet<string>): boolean {
  return typeof modelId === "string" && ids.has(modelId);
}

function asObject(payload: unknown): Record<string, unknown> | undefined {
  const value = typeof payload === "string"
    ? (() => {
      try {
        return JSON.parse(payload) as unknown;
      } catch {
        return undefined;
      }
    })()
    : payload;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function hasMarker(headers: Record<string, string | null>, marker: string): boolean {
  return headers[marker] === "1" || headers[marker.toLowerCase()] === "1";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Pack = { name: string; remain: number; size: number };

function unwrap(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function parseCredits(envelope: unknown): { total: number; packs: Pack[] } {
  const inner = unwrap(unwrap(unwrap(unwrap(envelope).data).Response).Data);
  const raw = Array.isArray(inner.Accounts) ? inner.Accounts : [];
  const packs: Pack[] = [];
  let total = 0;
  for (const item of raw) {
    const account = unwrap(item);
    const num = (key: string): number => typeof account[key] === "number" ? account[key] as number : 0;
    const size = num("CycleCapacitySize");
    const cycleRemain = num("CycleCapacityRemain");
    const cycleUsed = num("CycleCapacityUsed");
    let remain = size > 0 || cycleRemain > 0 || cycleUsed > 0 ? cycleRemain : num("CapacityRemain");
    if (remain < 0) remain = 0;
    total += remain;
    packs.push({
      name: typeof account.PackageName === "string" ? account.PackageName : "(unnamed)",
      remain,
      size: size > 0 ? size : num("CapacitySize"),
    });
  }
  return { total, packs };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtStamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtExpiry(ms: number): string {
  if (ms <= 0) return "未知";
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function bar(remain: number, size: number, width = 28): string {
  if (size <= 0) return "";
  const n = Math.round(Math.min(1, Math.max(0, remain / size)) * width);
  return `${"█".repeat(n)}${"░".repeat(width - n)}`;
}

export function widgetLines(cfg: RegionConfig, input: {
  cred?: Cred;
  credits?: { total: number; packs: Pack[] };
  error?: string;
  scope?: Scope;
  models?: { name: string }[];
}): string[] {
  const scope = input.scope ?? "free";
  const lines = [`${cfg.productName} · ${cfg.editionLabel} · ${scope === "all" ? "全部模型" : "仅免费模型"}`];
  if (!input.cred) {
    lines.push(`未登录。设置 → 模型 → ${cfg.productName} → Connect，或 /login ${cfg.providerId}`);
    if (input.error) lines.push(input.error);
    lines.push(`设置  /${cfg.command}`);
    return lines;
  }
  lines.push(`账号  已登录  ${input.cred.nickname || input.cred.uid}`);
  lines.push(`令牌  ${fmtExpiry(input.cred.expiresAtMs)} 过期（自动续期）`);
  if (input.credits) {
    lines.push(`积分  合计 ${input.credits.total}`);
    for (const pack of input.credits.packs) {
      const right = pack.size > 0 ? `${pack.remain} / ${pack.size}` : String(pack.remain);
      lines.push(`  ${pack.name}  剩余 ${right}`);
      const drawn = bar(pack.remain, pack.size);
      if (drawn) lines.push(`  ${drawn}`);
    }
  } else if (input.error) {
    lines.push(`积分  ${input.error}`);
  }
  const names = (input.models ?? []).map((model) => model.name).join("  |  ") || "（无模型）";
  lines.push(`模型  ${names}`);
  lines.push(`设置  /${cfg.command}`);
  return lines;
}

async function fetchCredits(cfg: RegionConfig, cred: Cred): Promise<{ total: number; packs: Pack[] }> {
  const now = new Date();
  const response = await fetch(`${cfg.billingBase}/v2/billing/meter/get-user-resource`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cred.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(cred.uid === "" ? {} : { "X-User-Id": cred.uid }),
      ...(cred.enterpriseId
        ? { "X-Enterprise-Id": cred.enterpriseId, "X-Tenant-Id": cred.enterpriseId }
        : {}),
      ...(cred.domain === "" ? {} : { "X-Domain": cred.domain }),
    },
    body: JSON.stringify({
      PageNumber: 1,
      PageSize: 100,
      ProductCode: "p_tcaca",
      Status: [0, 3],
      PackageEndTimeRangeBegin: fmtStamp(now),
      PackageEndTimeRangeEnd: fmtStamp(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const envelope: unknown = await response.json();
  const msg = unwrap(envelope).msg;
  if (!response.ok || unwrap(envelope).code !== 0) {
    throw new Error(typeof msg === "string" && msg !== "" ? msg : `credits ${response.status}`);
  }
  return parseCredits(envelope);
}

type Ui = {
  setWidget(key: string, content: string[] | undefined): void;
  setStatus(key: string, text: string | undefined): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
};

/** The card belongs to sessions actually running this edition's models. */
export function showsWorkBuddyCard(cfg: RegionConfig, provider: unknown, force = false): boolean {
  return force || provider === cfg.providerId;
}

type PaintCtx = { ui: Ui; model?: { provider?: string } };

/** Paints the card and returns the lines drawn, or undefined when hidden. */
async function paint(
  cfg: RegionConfig,
  ctx: PaintCtx,
  notify = false,
  extra: { scope: Scope; models: { name: string }[] } = { scope: "free", models: [] },
  force = false,
): Promise<string[] | undefined> {
  const { ui } = ctx;
  if (!showsWorkBuddyCard(cfg, ctx.model?.provider, force)) {
    ui.setWidget(cfg.widgetKey, undefined);
    ui.setStatus(cfg.widgetKey, undefined);
    return undefined;
  }
  let cred: Cred | undefined;
  let credits: { total: number; packs: Pack[] } | undefined;
  let error: string | undefined;
  try {
    cred = await resolveCred(cfg);
    credits = await fetchCredits(cfg, cred);
  } catch (caught) {
    cred = await current(cfg);
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const lines = widgetLines(cfg, { cred, credits, error, ...extra });
  ui.setWidget(cfg.widgetKey, lines);
  ui.setStatus(
    cfg.widgetKey,
    credits ? `积分 ${credits.total}` : cred ? `${cfg.productName} 已登录` : `${cfg.productName} 未登录`,
  );
  if (notify) {
    ui.notify(
      error ? `${cfg.productName}：${error}` : `${cfg.productName} 已刷新 · 积分 ${credits?.total ?? "?"}`,
      error ? "warning" : "info",
    );
  }
  return lines;
}

function pluginAuthHeaders(cfg: RegionConfig): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    Origin: cfg.originBase,
    Referer: `${cfg.originBase}/`,
    "User-Agent": CLIENT_UA,
    "X-Requested-With": "XMLHttpRequest",
    "X-Product": "SaaS",
    "X-No-Authorization": "true",
    "X-No-User-Id": "1",
    "X-No-Enterprise-Id": "1",
    "X-No-Department-Info": "1",
  };
}

export function jwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    const padded = part.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const parsed: unknown = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function credFromPluginToken(
  data: Record<string, unknown>,
  accessToken: string,
  now = Date.now(),
): Cred {
  const jwt = jwtPayload(accessToken);
  const uid = optionalString(data.uid)
    ?? optionalString(jwt.uid)
    ?? optionalString(jwt.sub)
    ?? optionalString(jwt.email)
    ?? "";
  const enterpriseId = optionalString(data.enterpriseId) ?? optionalString(data.enterprise_id);
  const nickname = optionalString(data.nickname) ?? optionalString(jwt.email) ?? optionalString(jwt.name);
  return {
    accessToken,
    refreshToken: optionalString(data.refreshToken) ?? "",
    expiresAtMs: typeof data.expiresIn === "number" && data.expiresIn > 0 ? now + data.expiresIn * 1000 : 0,
    domain: optionalString(data.domain) ?? "www.workbuddy.ai",
    uid,
    ...(enterpriseId ? { enterpriseId } : {}),
    ...(nickname ? { nickname } : {}),
  };
}

// --- 国际版插件登录（原有链路，参数化 base/headers） ---

async function startIntlPluginLogin(cfg: RegionConfig): Promise<{ state: string; authUrl: string }> {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const response = await fetch(`${cfg.chatBase}/v2/plugin/auth/state?platform=CLI&nonce=${nonce}`, {
    method: "POST",
    headers: pluginAuthHeaders(cfg),
    body: JSON.stringify({ nonce }),
    signal: AbortSignal.timeout(30_000),
  });
  const envelope = unwrap(await response.json());
  const data = unwrap(envelope.data);
  const state = typeof data.state === "string" ? data.state : "";
  const authUrl = typeof data.authUrl === "string" ? data.authUrl : "";
  if (!response.ok || envelope.code !== 0 || state === "" || authUrl === "") {
    throw new Error(typeof envelope.msg === "string" && envelope.msg !== "" ? envelope.msg : "workbuddy login start failed");
  }
  return { state, authUrl };
}

async function pollIntlPluginToken(cfg: RegionConfig, state: string): Promise<Cred> {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const response = await fetch(`${cfg.chatBase}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
      headers: pluginAuthHeaders(cfg),
      signal: AbortSignal.timeout(30_000),
    });
    const envelope = unwrap(await response.json());
    if (envelope.code === 11217) {
      await sleep(2000);
      continue;
    }
    const data = unwrap(envelope.data);
    const accessToken = typeof data.accessToken === "string" ? data.accessToken : "";
    if (!response.ok || envelope.code !== 0 || accessToken === "") {
      throw new Error(typeof envelope.msg === "string" && envelope.msg !== "" ? envelope.msg : "workbuddy login failed");
    }
    return credFromPluginToken(data, accessToken);
  }
  throw new Error("workbuddy login timed out");
}

async function loginGlobal(cfg: RegionConfig, callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  callbacks.onProgress?.("正在打开 WorkBuddy 登录页…");
  const { state, authUrl } = await startIntlPluginLogin(cfg);
  callbacks.onAuth({ url: authUrl });
  callbacks.onProgress?.("请在弹出的页面完成登录，完成后会自动继续");
  const cred = await pollIntlPluginToken(cfg, state);
  await saveOwn(cfg, cred);
  return { access: cred.accessToken, refresh: cred.refreshToken, expires: cred.expiresAtMs };
}

// --- 国内版插件登录（链路取自 codebuddy2api 的 browser_login.py，已验证可用） ---

async function startCnPluginLogin(cfg: RegionConfig): Promise<{ state: string; authUrl: string }> {
  const response = await fetch(`${cfg.chatBase}/v2/plugin/auth/state?platform=CLI`, {
    method: "POST",
    headers: pluginAuthHeaders(cfg),
    body: "{}",
    signal: AbortSignal.timeout(30_000),
  });
  const envelope = unwrap(await response.json());
  const data = unwrap(envelope.data);
  const state = typeof data.state === "string" ? data.state : "";
  const authUrl = typeof data.authUrl === "string" ? data.authUrl : "";
  if (!response.ok || envelope.code !== 0 || state === "" || authUrl === "") {
    throw new Error(typeof envelope.msg === "string" && envelope.msg !== "" ? envelope.msg : "codebuddy login start failed");
  }
  return { state, authUrl };
}

type CnToken = { accessToken: string; refreshToken: string; domain: string; expiresAtMs: number };

async function pollCnPluginToken(cfg: RegionConfig, state: string): Promise<CnToken> {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const response = await fetch(`${cfg.chatBase}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
      headers: pluginAuthHeaders(cfg),
      signal: AbortSignal.timeout(30_000),
    });
    const envelope = unwrap(await response.json());
    if (envelope.code === 11217) {
      await sleep(2000);
      continue;
    }
    const data = unwrap(envelope.data);
    const accessToken = typeof data.accessToken === "string" ? data.accessToken : "";
    const refreshToken = typeof data.refreshToken === "string" ? data.refreshToken : "";
    if (!response.ok || envelope.code !== 0 || accessToken === "" || refreshToken === "") {
      throw new Error(typeof envelope.msg === "string" && envelope.msg !== "" ? envelope.msg : "codebuddy login failed");
    }
    const domain = typeof data.domain === "string" ? data.domain : "";
    if (domain.toLowerCase().includes("workbuddy.ai")) {
      throw new Error("检测到 WorkBuddy 国际版账号，国内版请用 /login workbuddy 登录");
    }
    const expiresAtMs = typeof data.expiresAt === "number" && data.expiresAt > 0
      ? expiryToMs(data.expiresAt)
      : typeof data.expiresIn === "number" && data.expiresIn > 0
        ? Date.now() + data.expiresIn * 1000
        : 0;
    return { accessToken, refreshToken, domain: domain === "" ? "www.codebuddy.cn" : domain, expiresAtMs };
  }
  throw new Error("codebuddy login timed out");
}

async function fetchCnAccount(cfg: RegionConfig, state: string, accessToken: string): Promise<{ uid: string; nickname?: string }> {
  const response = await fetch(`${cfg.chatBase}/v2/plugin/login/account?state=${encodeURIComponent(state)}`, {
    headers: { ...pluginAuthHeaders(cfg), Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  const envelope = unwrap(await response.json());
  const data = unwrap(envelope.data);
  if (!response.ok || envelope.code !== 0 || typeof data.uid !== "string" || data.uid === "") {
    throw new Error(typeof envelope.msg === "string" && envelope.msg !== "" ? envelope.msg : "codebuddy account fetch failed");
  }
  const nickname = optionalString(data.nickname);
  return { uid: data.uid, ...(nickname ? { nickname } : {}) };
}

async function loginCn(cfg: RegionConfig, callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  callbacks.onProgress?.("正在打开 CodeBuddy 登录页…");
  const { state, authUrl } = await startCnPluginLogin(cfg);
  callbacks.onAuth({ url: authUrl });
  callbacks.onProgress?.("请在弹出的页面完成登录，完成后会自动继续");
  const tok = await pollCnPluginToken(cfg, state);
  const acct = await fetchCnAccount(cfg, state, tok.accessToken);
  const cred: Cred = {
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken,
    expiresAtMs: tok.expiresAtMs,
    domain: tok.domain,
    uid: acct.uid,
    ...(acct.nickname ? { nickname: acct.nickname } : {}),
  };
  await saveOwn(cfg, cred);
  return { access: cred.accessToken, refresh: cred.refreshToken, expires: cred.expiresAtMs };
}

async function refreshOAuth(cfg: RegionConfig, credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const prev = await current(cfg);
  const next = await refreshAccess(cfg, {
    accessToken: credentials.access,
    refreshToken: credentials.refresh,
    expiresAtMs: credentials.expires ?? 0,
    domain: prev?.domain ?? cfg.originBase.replace(/^https:\/\//, ""),
    uid: prev?.uid ?? "",
    ...(prev?.enterpriseId ? { enterpriseId: prev.enterpriseId } : {}),
    ...(prev?.nickname ? { nickname: prev.nickname } : {}),
  });
  await saveOwn(cfg, next);
  return { access: next.accessToken, refresh: next.refreshToken, expires: next.expiresAtMs };
}

/** 各版本当前注册的模型 id；before_provider_request 用它做全集判定。 */
const editionModelIds = new Map<string, Set<string>>();

export function isAnyEditionModel(modelId: unknown): boolean {
  if (typeof modelId !== "string") return false;
  for (const ids of editionModelIds.values()) {
    if (ids.has(modelId)) return true;
  }
  return false;
}

function registerEdition(pi: ExtensionAPI, cfg: RegionConfig) {
  let scope = loadSettings(cfg).scope;
  let models = buildPiModels(cfg, loadProductConfig(cfg), scope);
  /** Last painted card lines for this session, reused on model switch. */
  let card: string[] | undefined;
  const extra = () => ({ scope, models });
  const oauth = {
    name: cfg.productName,
    login: cfg.region === "cn"
      ? (callbacks: OAuthLoginCallbacks) => loginCn(cfg, callbacks)
      : (callbacks: OAuthLoginCallbacks) => loginGlobal(cfg, callbacks),
    refreshToken: (credentials: OAuthCredentials) => refreshOAuth(cfg, credentials),
    getApiKey: (credentials: OAuthCredentials) => credentials.access,
  };

  function apply(next?: Scope) {
    if (next) scope = next;
    models = buildPiModels(cfg, loadProductConfig(cfg), scope);
    editionModelIds.set(cfg.providerId, new Set(models.map((model) => model.id)));
    pi.registerProvider(cfg.providerId, {
      name: cfg.productName,
      baseUrl: `${cfg.chatBase}/v2`,
      api: "openai-completions",
      headers: { [cfg.marker]: "1" },
      oauth,
      models,
      async refreshModels() {
        scope = loadSettings(cfg).scope;
        models = buildPiModels(cfg, loadProductConfig(cfg), scope);
        editionModelIds.set(cfg.providerId, new Set(models.map((model) => model.id)));
        return models;
      },
    });
  }

  apply();

  pi.on("before_provider_headers", async (event) => {
    if (!hasMarker(event.headers, cfg.marker)) return;
    const cred = await resolveCred(cfg);
    event.headers[cfg.marker] = null;
    event.headers[cfg.marker.toLowerCase()] = null;
    for (const [key, value] of Object.entries(chatHeaders(cfg, cred))) event.headers[key] = value;
  });

  pi.on("session_start", (_event, ctx) => {
    // Never block session startup on the optional account/credits card.
    void paint(cfg, ctx, false, extra())
      .then((lines) => { card = lines; })
      .catch(() => undefined);
  });

  // setModel awaits this handler, so it must never block on network I/O:
  // redraw from the cached card and refresh in the background.
  pi.on("model_select", (_event, ctx) => {
    if (!showsWorkBuddyCard(cfg, ctx.model?.provider)) {
      card = undefined;
      ctx.ui.setWidget(cfg.widgetKey, undefined);
      ctx.ui.setStatus(cfg.widgetKey, undefined);
      return;
    }
    if (card) ctx.ui.setWidget(cfg.widgetKey, card);
    void paint(cfg, ctx, false, extra()).then((lines) => { card = lines; }).catch(() => undefined);
  });

  pi.registerCommand(cfg.command, {
    description: `${cfg.productName} 设置：刷新积分、免费/全部模型、断开登录`,
    handler: async (args, ctx) => {
      const cmd = String(args ?? "").trim().toLowerCase();
      if (cmd === "free" || cmd === "all") {
        await saveSettings(cfg, cmd);
        apply(cmd);
        await paint(cfg, ctx, true, extra(), true);
        return;
      }
      if (cmd === "logout" || cmd === "disconnect") {
        await unlink(ownPath(cfg)).catch(() => undefined);
        await paint(cfg, ctx, true, extra(), true);
        return;
      }
      const pick = await ctx.ui.select(`${cfg.productName} 设置`, [
        "刷新积分与账号",
        scope === "free" ? "列出全部模型（含付费）" : "只列出免费模型",
        "断开登录",
      ]);
      if (pick === undefined) return;
      if (pick.startsWith("列出全部")) {
        await saveSettings(cfg, "all");
        apply("all");
      } else if (pick.startsWith("只列出")) {
        await saveSettings(cfg, "free");
        apply("free");
      } else if (pick === "断开登录") {
        await unlink(ownPath(cfg)).catch(() => undefined);
      }
      await paint(cfg, ctx, true, extra(), true);
    },
  });
}

export default async function (pi: ExtensionAPI) {
  registerEdition(pi, REGIONS.global);
  registerEdition(pi, REGIONS.cn);

  pi.on("before_provider_request", (event) => {
    const payload = asObject(event.payload);
    if (!payload || !isAnyEditionModel(payload.model)) return;
    return prepareChatPayload(payload);
  });
}

if (process.argv.includes("--self-check")) {
  const global = REGIONS.global;
  const cn = REGIONS.cn;

  // --- 区域路由 ---
  if (regionOf("www.workbuddy.ai") !== "global") throw new Error("region: intl domain");
  if (regionOf("WWW.WORKBUDDY.AI") !== "global") throw new Error("region: case-insensitive");
  if (regionOf("") !== "global") throw new Error("region: empty defaults to global");
  if (regionOf("www.codebuddy.cn") !== "cn") throw new Error("region: cn domain");
  if (regionOf("WWW.CODEBUDDY.CN ") !== "cn") throw new Error("region: cn trim");
  if (global.providerId === cn.providerId) throw new Error("provider ids must differ");
  if (global.command === cn.command) throw new Error("commands must differ");
  if (global.marker === cn.marker || global.marker.toLowerCase() === cn.marker.toLowerCase()) {
    throw new Error("markers must differ");
  }
  if (global.widgetKey === cn.widgetKey) throw new Error("widget keys must differ");
  if (global.ownAuthFilename === cn.ownAuthFilename) throw new Error("own auth files must differ");
  if (global.settingsFilename === cn.settingsFilename) throw new Error("settings files must differ");
  if (global.desktopAuthBasename === cn.desktopAuthBasename) throw new Error("desktop basenames must differ");

  // --- 各区域端点 ---
  if (global.chatBase !== "https://www.workbuddy.ai") throw new Error("intl chat base");
  if (cn.chatBase !== "https://copilot.tencent.com") throw new Error("cn chat base");
  if (cn.billingBase !== "https://www.codebuddy.cn") throw new Error("cn billing base");
  if (cn.originBase !== "https://www.codebuddy.cn") throw new Error("cn origin base");
  if (refreshEndpoint(global) !== "https://www.workbuddy.ai/v2/plugin/auth/token/refresh") {
    throw new Error("intl refresh endpoint");
  }
  if (refreshEndpoint(cn) !== "https://copilot.tencent.com/v2/plugin/auth/token/refresh") {
    throw new Error("cn refresh endpoint");
  }
  const cnHeaders = chatHeaders(cn, {
    accessToken: "a", refreshToken: "r", expiresAtMs: 0, domain: "www.codebuddy.cn", uid: "u",
  });
  if (cnHeaders.Origin !== "https://www.codebuddy.cn") throw new Error("cn chat origin");
  if (cnHeaders.Referer !== "https://www.codebuddy.cn/") throw new Error("cn chat referer");
  if (cnHeaders["X-Domain"] !== "www.codebuddy.cn") throw new Error("cn X-Domain");
  const intlHeaders = chatHeaders(global, {
    accessToken: "a", refreshToken: "r", expiresAtMs: 0, domain: "www.workbuddy.ai", uid: "u",
  });
  if (intlHeaders.Origin !== "https://www.workbuddy.ai") throw new Error("intl chat origin");

  // --- 凭据解析（原有行为保持） ---
  const nested = parseWorkBuddyAuth(JSON.stringify({
    auth: { accessToken: "a", refreshToken: "r", expiresAt: 2000, domain: "www.workbuddy.ai" },
    account: { uid: "u1", nickname: "n" },
  }));
  if (nested?.uid !== "u1" || nested.expiresAtMs !== 2_000_000) throw new Error("parse nested");
  const cnCred = parseWorkBuddyAuth(JSON.stringify({
    auth: { accessToken: "a", refreshToken: "r", expiresAt: 2_000_000_000, domain: "www.codebuddy.cn" },
    account: { uid: "cn-u1" },
  }));
  if (!cnCred || regionOf(cnCred.domain) !== "cn") throw new Error("cn cred region");

  // --- $wbEncrypted ---
  if (!isEncryptedField({ $wbEncrypted: 1, envelope: "e" })) throw new Error("encrypted detect");
  if (isEncryptedField({ accessToken: "plain" })) throw new Error("plain not encrypted");
  // 自洽性 round-trip：用固定密钥按 Python 的信封格式加密，再用本实现解密。
  const testSecret = Buffer.from("test-at-rest-secret-key-44-chars-padding!!").toString("base64");
  const testKey = createHash("sha256").update(testSecret, "utf8").digest();
  const testKeyId = createHash("sha256").update(testKey).digest("hex").slice(0, 16);
  const nonce = Buffer.from("0123456789ab", "utf8");
  const cipher = createCipheriv("aes-256-gcm", testKey, nonce);
  cipher.setAAD(atRestAad(testKeyId));
  const ciphertext = Buffer.concat([cipher.update("secret-token-value", "utf8"), cipher.final()]);
  const envelope = Buffer.from(JSON.stringify({
    suite: 1,
    keyId: testKeyId,
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  })).toString("base64");
  if (decryptAtRestEnvelope(envelope, testSecret) !== "secret-token-value") {
    throw new Error("at-rest round trip");
  }
  if (decryptAtRestEnvelope(envelope, Buffer.from("wrong-secret").toString("base64")) !== undefined) {
    throw new Error("at-rest wrong secret must fail");
  }
  // AAD 向量：与 Python 实现逐字节一致（WB-AAD\0 \x01 len+WBEV1 len+sym-v1 suite keyId \x02 \x00 \x00）。
  const aadHex = atRestAad("0123456789abcdef").toString("hex");
  const expectedAad = Buffer.concat([
    Buffer.from("WB-AAD\x00", "utf8"), Buffer.from([0x01]),
    Buffer.from([0, 0, 0, 5]), Buffer.from("WBEV1"),
    Buffer.from([0, 0, 0, 6]), Buffer.from("sym-v1"),
    Buffer.from([0, 0, 0, 1]),
    Buffer.from([0, 0, 0, 16]), Buffer.from("0123456789abcdef", "ascii"),
    Buffer.from([0x02, 0x00, 0x00]),
  ]).toString("hex");
  if (aadHex !== expectedAad) throw new Error("aad vector");

  // --- payload 规整（原有行为保持） ---
  const payload = prepareChatPayload({
    model: "hy3",
    messages: [{ role: "developer", content: "sys" }, { role: "user", content: "hi" }],
    tool_choice: { type: "function", function: { name: "foo" } },
  });
  if (payload.stream !== true) throw new Error("stream");
  if ((payload.messages as { role: string }[])[0].role !== "system") throw new Error("system");
  if (payload.tool_choice !== "foo") throw new Error("tool_choice");
  if (payload.reasoning_effort !== undefined) throw new Error("no injected effort");
  const kept = prepareChatPayload({ messages: [], reasoning_effort: "max" });
  if (kept.reasoning_effort !== "max") throw new Error("explicit effort preserved");
  if (LOW_HIGH.low !== "low" || HIGH_ONLY.low !== null || HIGH_ONLY.high !== "high") throw new Error("effort map");
  if (!showsWorkBuddyCard(global, "workbuddy")) throw new Error("card: intl provider shown");
  if (showsWorkBuddyCard(global, "codebuddy")) throw new Error("card: intl hidden for cn provider");
  if (!showsWorkBuddyCard(cn, "codebuddy")) throw new Error("card: cn provider shown");
  if (showsWorkBuddyCard(cn, undefined) || showsWorkBuddyCard(cn, null) || showsWorkBuddyCard(cn, 42)) {
    throw new Error("card: unknown provider hidden");
  }
  if (!showsWorkBuddyCard(cn, "workbuddy", true)) throw new Error("card: explicit command overrides");
  const ours = new Set(["hy3", "deepseek-v4.1-flash"]);
  if (!isWorkBuddyModel("hy3", ours)) throw new Error("scope: own model accepted");
  if (isWorkBuddyModel("grok-4.6", ours)) throw new Error("scope: foreign model must be rejected");
  if (isWorkBuddyModel(undefined, ours) || isWorkBuddyModel(42, ours)) throw new Error("scope: non-string rejected");
  if (thinkingLevelMap(["high"], true).off !== "off") throw new Error("off");
  const prepended = prepareChatPayload({ messages: [{ role: "user", content: "hi" }] });
  if ((prepended.messages as { role: string }[])[0].role !== "system") throw new Error("prepend");
  if (FREE_GLOBAL_IDS.length !== 3) throw new Error("count");
  if (!creditsAreFree("x0.00") || creditsAreFree("x1.00")) throw new Error("credits free");
  const flash = buildPiModels(global, { source: "builtin", models: BUILTIN_GLOBAL_MODELS }, "free")
    .find((model) => model.id === "deepseek-v4.1-flash");
  if (flash?.thinkingLevelMap.low !== "low" || flash.thinkingLevelMap.xhigh !== "xhigh" || flash.thinkingLevelMap.max !== "max") {
    throw new Error("flash efforts");
  }
  if (flash.maxTokens !== FLASH_MAX_TOKENS) throw new Error("flash cap");
  const looped = prepareChatPayload({
    model: "deepseek-v4.1-flash",
    max_tokens: 128_000,
    messages: [{ role: "assistant", content: "done", reasoning: "OK.\nLet me write.", thinking: "Go." }],
  });
  const assistant = (looped.messages as Record<string, unknown>[])[1];
  if (assistant.reasoning !== undefined || assistant.thinking !== undefined) throw new Error("reasoning replay");
  if (looped.max_tokens !== FLASH_MAX_TOKENS) throw new Error("flash payload cap");
  const fromCache = parseProductConfig(JSON.stringify({
    models: [{
      id: "deepseek-v4.1-flash",
      name: "Deepseek-V4.1-Flash",
      credits: "x0.00",
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000,
      supportsReasoning: true,
      reasoning: { supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
    }],
  }));
  if (!fromCache) throw new Error("parse config");
  const cachedFlash = buildPiModels(global, fromCache, "free")[0];
  if (cachedFlash.thinkingLevelMap.medium !== "medium" || cachedFlash.thinkingLevelMap.max !== "max") {
    throw new Error("cache efforts");
  }
  const implied = parseProductConfig(JSON.stringify({
    models: [{
      id: "implied",
      name: "Implied",
      credits: "x0.00",
      maxInputTokens: 1000,
      maxOutputTokens: 100,
      supportsReasoning: true,
    }],
  }));
  if (buildPiModels(global, implied!, "free")[0].thinkingLevelMap.xhigh !== "xhigh") throw new Error("implied efforts");
  // 国内版无缓存时暂无内置模型：行为明确，不静默套用国际版清单。
  if (buildPiModels(cn, loadProductConfig(cn, "/nonexistent-path-xyz"), "free").length !== 0) {
    throw new Error("cn builtin must be empty until verified");
  }
  const credits = parseCredits({
    code: 0,
    data: {
      Response: {
        Data: {
          Accounts: [
            { PackageName: "Bonus Pack", CycleCapacitySize: 250, CycleCapacityRemain: 249 },
            { PackageName: "Free Plan Subscription", CycleCapacitySize: 100, CycleCapacityRemain: 100 },
          ],
        },
      },
    },
  });
  if (credits.total !== 349 || credits.packs.length !== 2) throw new Error("credits");
  const lines = widgetLines(global, {
    cred: {
      accessToken: "a",
      refreshToken: "r",
      expiresAtMs: Date.UTC(2027, 8, 12, 1, 30, 0),
      domain: "www.workbuddy.ai",
      uid: "u",
      nickname: "user@example.com",
    },
    credits,
  });
  if (!lines.some((line) => line.includes("user@example.com"))) throw new Error("account");
  if (!lines.some((line) => line.includes("合计 349"))) throw new Error("total");
  if (!lines[0].includes("国际版")) throw new Error("intl edition label");
  const cnLines = widgetLines(cn, {});
  if (!cnLines[0].includes("国内版")) throw new Error("cn edition label");
  if (!cnLines.some((line) => line.includes("/login codebuddy"))) throw new Error("cn login hint");
  const token = `x.${Buffer.from(JSON.stringify({ email: "a@b.c", sub: "u9" })).toString("base64url")}.y`;
  const fromTok = credFromPluginToken(
    { refreshToken: "r", expiresIn: 10, domain: "www.workbuddy.ai", enterpriseId: "e1" },
    token,
    1000,
  );
  if (fromTok.uid !== "u9" || fromTok.nickname !== "a@b.c" || fromTok.expiresAtMs !== 11_000) throw new Error("plugin token");
  if (fromTok.enterpriseId !== "e1") throw new Error("enterprise");
  console.log("ok");
}
