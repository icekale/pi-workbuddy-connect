# pi-workbuddy-connect

WorkBuddy AI 国际版 + CodeBuddy 国内版 providers for [pi](https://pi.dev)。在 pi 里直接使用两个版本桌面 App 的模型。

移植自 [iceloon/dsh-workbuddyai-connect](https://github.com/iceloon/dsh-workbuddyai-connect)（DSH 插件），现在是 pi 原生扩展：无 shim、无 loopback 代理，直接注册 provider。国内版的区域路由与登录链路另参考了 [ShouZhuo0413/codebuddy2api](https://github.com/ShouZhuo0413/codebuddy2api) 的实测结论。

## 双版本

| | 国际版 | 国内版 |
| --- | --- | --- |
| provider id | `workbuddy` | `codebuddy` |
| 聊天端点 | `https://www.workbuddy.ai/v2` | `https://copilot.tencent.com/v2` |
| 积分端点 | `https://www.workbuddy.ai/v2/billing/meter` | `https://www.codebuddy.cn/v2/billing/meter` |
| 桌面凭据 | `…/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop-ai.info` | `…/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` |
| 插件自存凭据 | `~/.pi/agent/.workbuddy-auth.json` | `~/.pi/agent/.codebuddy-auth.json` |
| 设置 | `~/.pi/agent/.workbuddy-settings.json` | `~/.pi/agent/.codebuddy-settings.json` |
| 命令 | `/workbuddy` | `/codebuddy` |
| 登录 | `/login workbuddy` | `/login codebuddy` |

区域只看凭据自己的 `domain`（`workbuddy.ai`/`codebuddy.ai` 后缀 → 国际，其余 → 国内），两个版本各走各的凭据、登录态、设置与命令，互不干扰。桌面凭据文件名冲突时（`domain` 与 provider 区域明显不符）会被跳过，避免把国内 token 发往国际端点。

桌面 App 5.6.0+ 起 `.info` 里的 token 可能是 `$wbEncrypted` 加密信封，扩展内建 AES-256-GCM 解密（密钥来自桌面 App 自带 Electron 的原生 `loggerGet`，或 `WORKBUDDY_AT_REST_SECRET` 环境变量直接提供）。拿不到密钥时桌面凭据回退不可用，请改用弹窗登录。

## 安装

```bash
pi install git:github.com/huyaro/pi-workbuddy-connect
```

或本地加载：

```bash
pi -e /path/to/pi-workbuddy-connect
```

## 登录

设置 → 模型 → WorkBuddy AI / CodeBuddy → **Connect**（弹出浏览器登录页），或：

```
/login workbuddy
/login codebuddy
```

凭据按优先级解析：环境变量（`WORKBUDDY_AUTH_FILE` / `CODEBUDDY_AUTH_FILE`）→ pi 自存的插件凭据 → 对应版本桌面 App 的 `.info`。access token 过期前 5 分钟自动续期。

## 模型与推理档

默认只列出免费模型（`x0.00`）。每个模型的推理档来自桌面 App 的产品配置缓存（`~/.workbuddy-ai/cache/acc-product-config-v3.json`；国内版按 `CODEBUDDY_PRODUCT_CONFIG` 环境变量或 `~/.codebuddy-ai/cache/acc-product-config-v3.json`，见下）；缓存不存在时回退到内置清单：

| 模型 | 上下文 | 推理档 |
| --- | --- | --- |
| Deepseek-V4.1-Flash | 1M / 128k | low · medium · high · xhigh · max |
| Hy4 preview | 1M / 64k | high |
| Hy3 | 192k / 64k | low · high |

没声明 `supportedEfforts` 的模型（`supportsReasoning: true`）默认给全套 low/medium/high/xhigh/max。

> 国内版待验证：产品配置缓存的实际路径与国内版免费模型清单，需在装有国内版桌面 App 的机器上确认。当前实现先按 `~/.codebuddy-ai/cache/acc-product-config-v3.json`（回退 `~/.workbuddy-ai/...`）查找；找不到缓存时国内版暂不提供内置模型（不静默套用国际版清单）。可用 `CODEBUDDY_PRODUCT_CONFIG` 环境变量直接指定。

## 设置

- **侧栏 widget** — 账号、token 过期时间、各积分包余量，以及当前模型列表（两个版本各一张卡片）。
- **`/workbuddy`** / **`/codebuddy`** — 弹出选择菜单：

  ```
  刷新积分与账号
  列出全部模型（含付费）   ← 切换范围，scope 存各自的 settings 文件
  断开登录
  ```

  也接受参数：`/workbuddy free` · `/workbuddy all` · `/workbuddy logout`（codebuddy 同理）。

切换范围后 provider 立即重新注册模型，无需 `/reload`。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `WORKBUDDY_AUTH_FILE` | 国际版凭据文件路径，优先于所有其他来源 |
| `CODEBUDDY_AUTH_FILE` | 国内版凭据文件路径，优先于所有其他来源 |
| `WORKBUDDYAI_PRODUCT_CONFIG` | 国际版产品配置 JSON 路径 |
| `CODEBUDDY_PRODUCT_CONFIG` | 国内版产品配置 JSON 路径 |
| `WORKBUDDY_AT_REST_SECRET` | 桌面凭据 `$wbEncrypted` 解密密钥（44 字符 base64），免去调用桌面 App 自带 Electron |
| `WORKBUDDY_ELECTRON_PATH` | 桌面 App 自带 Electron 可执行文件路径（解密密钥获取用） |
| `PI_CODING_AGENT_DIR` | pi agent 目录，影响自存凭据与设置文件位置 |

## 自检

```bash
node --experimental-strip-types extensions/workbuddy.ts --self-check
```

覆盖区域路由、两版端点/请求头、认证解析（含 `$wbEncrypted` round-trip 与 AAD 向量）、payload 规整、推理档映射、积分解析与 widget 渲染。

## 与上游的差异

- 直接 `pi.registerProvider`，去掉 DSH 的 shim 与 loopback 端口转发。
- 一个扩展注册两个 provider（`workbuddy`/`codebuddy`），`before_provider_request` 按两版模型 id 全集圈定（该事件本身不带 provider 信息）。
- 内置模型清单与上游 `BUILTIN_FREE_MODELS` 一致（国际版）。
- 推理档由 pi-ai 的 `thinkingLevelMap` 驱动，选择器直接读 `getSupportedThinkingLevels`。
- 选 Default（auto）时**不发送** `reasoning_effort`，与上游一致；选具体档位时原样透传，不做任何改写。
- Deepseek-V4.1-Flash 的 `max_tokens` 封顶 16k（`FLASH_MAX_TOKENS`）：该模型会陷入 `OK. / Let me write. / Go.` 式推理循环，把 128k 预算烧完才停。长答案被截断时调大此常量。
- 发送前剔除 assistant 消息里回放的 `reasoning` / `thinking` / `reasoning_content` 字段，上游端点会拒绝这些字段。
- 未移植上游的 reasoning-effort 探测（probe）功能：需要联网发真实请求，且当前免费模型都已声明 `supportedEfforts`，探测无增益。

## 测试

```bash
node --experimental-strip-types test/scope.test.mts   # 断言双版本注册隔离 + hook 不污染其他 provider 的请求
node --experimental-strip-types test/session-start.test.mts  # 断言两版 session_start 都不阻塞启动
npx tsc -p tsconfig.json                              # 类型检查
```

## License

MIT
