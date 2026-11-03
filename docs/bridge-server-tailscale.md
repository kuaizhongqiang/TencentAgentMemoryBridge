# bridge-server：Tailscale / 多地址监听 + v3 透明转发

> **版本**: bridge-server 0.3.0（issue [#43](https://github.com/kuaizhongqiang/TencentAgentMemoryBridge/issues/43) 服务端部分）
> **范围**: 仅 `packages/bridge-server/**`。不涉及 `packages/mcp-bridge`（客户端回落见 task-5）、不改部署单元、不写死任何 IP。

## 背景

之前 bridge-server 只有一种监听方式：`app.listen(PORT)` 通配所有网卡，客户端一律绕公网
Cloudflare 访问。Tailnet 内的机器因此不能直连私有 mesh。本次改动：

1. **A. 多监听**：`LISTEN_MODE=wan|tailscale|both`，按模式绑定公网地址和/或 Tailscale 地址；
   `wan` 且未显式配置 host 时与旧行为逐字节一致（回归安全）。
2. **B. v3 透明转发**：若配置 `V3_UPSTREAM`，把 `/v3/*` 反向代理到 MemoryCore Gateway。
   没有它，mcp-bridge v3 客户端连到 Tailscale 监听只会 404。
3. **C. `AUTH_MODE=tailscale`**（默认关）：`tailscale serve` 场景下用 `Tailscale-User-Login`
   作为 legacy sender 免共享 key；无可信 header 时回落到原 shared-key 校验。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 所有监听地址共用端口。 |
| `LISTEN_MODE` | `wan` | `wan` = 公网/显式地址；`tailscale` = 只绑 Tailscale IP；`both` = 显式公网 host + Tailscale IP。 |
| `LISTEN_HOSTS` | 空 | 逗号分隔的显式绑定地址（去空格、丢空项、去重），如 `0.0.0.0,192.168.1.10`。 |
| `HOST` | 空 | 单地址别名，等价 `LISTEN_HOSTS` 一项。两者同时给出时 **`LISTEN_HOSTS` 优先**，并在 stderr 输出警告。 |
| `TAILSCALE_LISTEN` | `false` | `true` 等价 `LISTEN_MODE=tailscale`。与显式 `LISTEN_MODE=wan` 同时出现视为矛盾配置，**启动报错**。 |
| `AUTH_MODE` | `shared-key` | `shared-key` = 原 Bearer + `X-Sender` 校验；`tailscale` = 额外信任 `Tailscale-User-Login`。 |
| `V3_UPSTREAM` | 空 | MemoryCore Gateway 基地址，如 `http://127.0.0.1:8422`。设置后启用 `/v3/*` 透明转发；末尾 `/` 会被规范化。 |
| `V3_PROXY_TIMEOUT_MS` | `30000` | 单次 `/v3/*` 代理请求超时（毫秒，正整数）。 |
| `TENCENTDB_URL` | `http://localhost:8080` | legacy `/api/v1/*` 转发目标。 |
| `AGENTS` / `AGENTS_FILE` | 空 | 原 legacy 共享 key 的 agent 列表，格式不变。 |

配置非法（未知 `LISTEN_MODE`/`AUTH_MODE`、`both` 却没给显式公网 host、非法 URL/超时）都会
**启动失败并打印明确原因**，不会静默降级。

## 监听矩阵

| 配置 | 实际绑定 |
| --- | --- |
| `LISTEN_MODE=wan`（默认，无 `LISTEN_HOSTS`/`HOST`） | 单 server，`app.listen(PORT)` 通配（行为与 0.2.0 完全一致） |
| `LISTEN_MODE=wan` + `LISTEN_HOSTS=0.0.0.0,10.0.0.5` | 每个 host 一个 server、同 PORT |
| `LISTEN_MODE=tailscale` 或 `TAILSCALE_LISTEN=true` | 只绑运行时解析出的 Tailscale IPv4（同 PORT） |
| `LISTEN_MODE=both` + 显式 host | 显式 host 每人一个 server + Tailscale IP（重复地址自动去重） |
| `LISTEN_MODE=both` 但没有 `LISTEN_HOSTS`/`HOST` | **启动报错**，提示改用 `wan` |

任一 server 绑定失败（端口占用、地址不存在）→ 关闭已启动的 server 并以非 0 退出，不留半开状态。
启动日志打印的是 `server.address()` 的真实 `host:port`，不是配置回显。

### Tailscale IPv4 解析顺序

`src/tailscale.ts`，全部失败才报错（错误信息逐条列出失败原因，并提示设置 `TAILSCALE_IP`）：

1. `tailscale ip -4`（`execFile`，2s 超时，取第一行非空 IPv4）；
2. 网卡 `tailscale0` 的非 internal IPv4（CLI 不在 PATH 时的兜底，如 systemd 服务用户）；
3. 环境变量 `TAILSCALE_IP`（运维显式覆盖）。

严格 IPv4 校验（`999.1.1.1`、`010.1.1.1`、简写形式一律拒绝），**没有任何写死的地址**。
测试通过依赖注入 mock，不依赖真实 tailnet。

## `/v3/*` 透明转发

设置 `V3_UPSTREAM` 后：

- `POST /v3/*`（也支持 `GET /v3/*`）转发到 `${V3_UPSTREAM}${pathname+query}`；
- 转发 `Authorization`、`x-tdai-service-id`、`Content-Type`、`Accept`；
- 请求体由 `express.json()` 解析后重新 `JSON.stringify` 转发（**仅支持 JSON 请求体**；非 JSON 请求体返回 400 而不是静默丢 body）；
- 上游的 status / `content-type` / body 原样透传（含上游的 4xx/5xx，例如 HTML 502）；
- 超时、连接失败、响应体读取失败 → 返回 502 JSON，并写 stderr；
- 该路由挂在 legacy `authMiddleware` **之前**：`/v3/*` 由 MemoryCore Gateway 用自己的 Bearer apiKey
  鉴权，bridge-server 不重复校验，也不套 legacy sender 域隔离。

> ⚠️ **安全边界**：`/v3/*` 应只通过 Tailscale 监听暴露。`AUTH_MODE=tailscale` 或 `V3_UPSTREAM`
> 都不是给公网匿名访问准备的；上游 8422 仍有 Bearer apiKey 兜底，但公网暴露会放大攻击面。

## `AUTH_MODE=tailscale`（可选，默认关）

- 仅作用于 legacy `/api/v1/*`。
- 请求带 `Tailscale-User-Login`（`tailscale serve` 注入）时：以其值作为 sender，
  `allowedEndpoints` 视为 `*`，**免共享 key**；
- 没有该 header：完全回落到原 `Authorization: Bearer` + `X-Sender` 校验（行为不变）；
- 该身份下 `crossDomainRecall` 仍为 `false`，显式跨域 `sender(s)` 过滤依旧会被 legacy proxy 拒绝。

> ⚠️ 只有 `tailscale serve` 注入的场景可信。**直连 tailnet 的请求可以伪造该 header**，
> 不要在不可信 mesh / 共享 tailnet 上开启 `AUTH_MODE=tailscale`。默认关闭即为此原因。

## health / 优雅关闭

- `GET /health`：设置 `V3_UPSTREAM` 时探 `V3_UPSTREAM/health`，否则维持探 `TENCENTDB_URL/health`；
  响应结构不变 `{ status: 'ok', upstream: 'reachable' | 'error' | 'unreachable' }`。
- `SIGTERM` / `SIGINT`：关闭**所有** server，全部 close 后 `exit 0`；5s 未完成强制退出（非 0）。
  关闭函数幂等。

## 示例

```bash
# 1) 回归：保持旧行为（通配监听，legacy 代理）
PORT=3000 TENCENTDB_URL=http://127.0.0.1:8080 \
  AGENTS_FILE=./agents.json pnpm start

# 2) 只给 Tailscale 用（mac / tailnet 直连），并把 /v3/* 转给本机网关
LISTEN_MODE=tailscale \
V3_UPSTREAM=http://127.0.0.1:8422 \
TENCENTDB_URL=http://127.0.0.1:8080 \
AGENTS_FILE=./agents.json pnpm start

# 3) 公网 + Tailscale 并存（显式公网地址是 both 模式的硬性要求）
LISTEN_MODE=both LISTEN_HOSTS=0.0.0.0 \
V3_UPSTREAM=http://127.0.0.1:8422 \
TENCENTDB_URL=http://127.0.0.1:8080 \
AGENTS_FILE=./agents.json pnpm start

# 4) 只绑指定多网卡（不用 Tailscale）
LISTEN_HOSTS=0.0.0.0,192.168.1.10 pnpm start
```

客户端（mcp-bridge v3）只需把 `MEMORY_ENDPOINT` 指到 Tailscale 地址，例如
`http://100.x.y.z:3000`。端点顺序与回落策略属于 mcp-bridge 侧改动，见 `docs/mcp-bridge-v3.md`。

## 测试与构建

```bash
cd packages/bridge-server
pnpm test    # vitest: config / tailscale 解析 / 多监听 / v3 代理 / auth 模式
pnpm build   # tsup -> dist/index.js
```

测试不依赖真实 Tailscale：解析器用依赖注入 mock；多监听用 `127.0.0.1` + `127.0.0.2` 临时端口；
v3 代理用本地 mock 上游 http server；所有临时 server 在测试结束前 close。

真实 Tailscale 监听验证（需在实际节点上手工执行）：

```bash
tailscale ip -4                                   # 期望 100.x.y.z
LISTEN_MODE=tailscale V3_UPSTREAM=http://127.0.0.1:8422 pnpm --filter @tencent-agent-memory/bridge-server start
ss -ltnp | grep :3000                             # 期望只出现 100.x.y.z:3000
curl -s http://100.x.y.z:3000/health
curl -s -X POST http://100.x.y.z:3000/v3/atomic/search \
  -H 'Authorization: Bearer <apiKey>' -H 'x-tdai-service-id: <service>' \
  -H 'Content-Type: application/json' -d '{"query":"test","limit":1}'
```

## 部署示例（systemd user 单元）

模板在 `examples/tailscale/`：

- `bridge-server-tailscale.service` — 用户级 systemd 单元，`ExecStart` 指向本仓库 `packages/bridge-server/dist/index.js`（系统 `/usr/bin/node`）
- `bridge-server-tailscale.env.example` — env 模板（`LISTEN_MODE=tailscale`、`V3_UPSTREAM=http://127.0.0.1:8422`）

安装（本机已装 Tailscale、MemoryCore 在 8422）：

```bash
# 0) 构建
cd packages/bridge-server && pnpm install && pnpm build

# 1) env + unit
mkdir -p ~/.config/tencent-memory
cp examples/tailscale/bridge-server-tailscale.env.example \
   ~/.config/tencent-memory/bridge-server-tailscale.env
cp examples/tailscale/bridge-server-tailscale.service ~/.config/systemd/user/

# 2) 启动并验收
systemctl --user daemon-reload
systemctl --user enable --now bridge-server-tailscale.service
systemctl --user status bridge-server-tailscale.service --no-pager
ss -ltnp | grep :3000        # 期望只有 <tailscale-ip>:3000（不应出现 0.0.0.0）
curl -s http://<tailscale-ip>:3000/health
```

客户端（任一 mcp-bridge ≥0.6.0 的 harness，如 DSH / Claude Code / CodeBuddy / Octop）：

```bash
MEMORY_ENDPOINTS="http://<tailscale-ip>:3000,https://memory.kuai-private.top"
```

写路径（`store_memory` 与自动入库）只使用第一个端点，建议把最近/最可靠的地址放第一位；
读路径失败会自动回落。详细语义见 [mcp-bridge-v3.md](mcp-bridge-v3.md#端点顺序与回落060)。

## 遗留风险 / 未做

- **`AUTH_MODE=tailscale` header 可伪造**（直连 tailnet），仅限 `tailscale serve` 场景；默认关闭。
- v3 代理是**缓冲式**转发（先 `text()` 再返回），不支持 SSE/streaming；上游大响应会占内存。
- 请求体受 `express.json()` 默认 100kb 限制；`/v3/*` 也只支持 JSON body。
- `/v3/*` 请求不经过 legacy `loggerMiddleware`（它挂在 auth 之后），访问日志需看上游网关。
- Tailscale IPv4 在节点重新注册/迁移后可能变化，服务需重启才能绑到新地址；可用 `TAILSCALE_IP` 显式覆盖。
- `both` 模式刻意不支持「通配 + Tailscale」：通配已包含 Tailscale 地址，再绑会 `EADDRINUSE`；
  需要通配直接用 `wan`。
- 仓库只提供 systemd 单元模板；实际安装/启用/停用由运维侧执行（本 PR 未自动安装任何服务）。

## 回滚

本改动全在 `packages/bridge-server/**` 与本文档内；不设置任何新环境变量时监听行为与 0.3.0 之前
完全一致。回滚只需 `git revert` 对应提交（或退回旧版本），无数据迁移。
