# 团队版角色模型 — 项目经理评审报告（第 2 轮）

> **评审对象**: docs/team-edition-role-model.md (v0.2) + CODEBUDDY.md
> **评审人**: PM
> **评审日期**: 2026-08-12
> **评审方法**: 对照 v0.1→v0.2 变更逐项审查，验证 P0 阻塞项是否闭环

---

## 一、v0.1→v0.2 变更总结

| 变更 | 位置 | 状态 |
|------|------|------|
| 新增「1.3 架构决策」表，确认 4 个 P0 决策 | §1.3 | ✅ 新增 |
| bridge-server **退役** | §1.3 | ✅ 已决策 |
| mcp-bridge **保留并重写对齐 v3** | §1.3 + §6.5 | ✅ 已决策 |
| openclaw-plugin → **用官方版，不维护自研** | §1.3 | ✅ 已决策 |
| CLAUDE.md auto-store **简化** | §1.3 | ✅ 已决策 |
| Server Agent 形态 → **先做调度脚本** | §5.1 | ✅ 已决策 |
| 新增「7. API 端点对照表」 | §7 | ✅ 新增 |
| 新增「10. 迁移步骤」 | §10 | ✅ 新增 |
| 新增「6.5 mcp-bridge 重写设计」 | §6.5 | ✅ 新增 |
| 角色表 mcp-bridge 标注为 v3 | §3 | ✅ 已更新 |
| 版本号 v0.1→v0.2，状态「已确认架构决策，待实现」 | 页眉 | ✅ 已更新 |

---

## 二、P0 阻塞项闭环验证

### P0-1: bridge-server 角色 → ✅ 已闭环

**决策**: 退役。
**理由**: MemoryProxy + MemoryCore 自带鉴权（`user_key → /v3/meta/auth/verify` + Bearer + service-id + ACL），bridge-server 的「鉴权+sender 白名单+转发」被完全取代。
**验证**: 三平台接入均不经过 bridge-server，退役是合理选择。**通过**。

### P0-2: mcp-bridge 去留 → ✅ 已闭环

**决策**: 保留并重写对齐 v3。
**理由**: 为 MCP-only 客户端保留统一 MCP 入口，改为直连 MemoryCore `/v3/*`。
**验证**: §6.5 给出了重写设计——配置项映射（BRIDGE_URL→MEMORY_ENDPOINT、SENDER→三元组）、工具映射（4 个工具对齐 v3 端点）、鉴权方式。**通过**。

### P0-3: API 端点映射 → ✅ 已闭环

**验证**: §7 新增了完整的旧 vs 新端点对照表，5 个端点全部有对应。**通过**。

---

## 三、v0.2 新增内容质量审查

### 3.1 架构决策表（§1.3） — ⭐⭐⭐⭐

优点：4 个决策一次性拍板，理由清晰。
小瑕疵：CLAUDE.md auto-store「简化」的表述过于模糊（见 §3.5）。

### 3.2 mcp-bridge 重写设计（§6.5） — ⭐⭐⭐⭐⭐

配置映射、工具映射、鉴权方式均明确。建议官方 SDK 用 `@tencentdb-agent-memory/memory-sdk-ts-v2` 是务实选择（与 openclaw-plugin 同源）。

### 3.3 API 端点对照表（§7） — ⭐⭐⭐⭐

覆盖了 5 个旧端点。唯一可改进：`/api/v1/recall` → 「MemoryProxy 注入 + `/v3/atomic/search` + `/v3/conversation/search`」说明了两条路径，但未区分哪个是自动注入、哪个是 mcp-bridge 显式调用。建议加一列标注。

### 3.4 迁移步骤（§10） — ⭐⭐⭐⭐

9 步覆盖了服务端部署→供给→三平台接入→mcp-bridge 重写→退役→数据迁移→CLAUDE.md 简化，顺序合理。两个小建议：
- 步骤 8「旧数据迁移」标记为决策待定，可以接受
- 建议将「退役 bridge-server」提到步骤 6（在 mcp-bridge 重写后），因为退役依赖 mcp-bridge 重写完成

### 3.5 待定问题（§11） — ⭐⭐⭐

5 个待定项合理。但「CLAUDE.md auto-store 规则简化落地」在 §1.3 已作为决策但未给出具体简化方案，建议在 CLAUDE.md 里同步更新（当前 CODEBUDDY.md 没有 auto-store 内容，CLAUDE.md 仍有旧规则）。

---

## 四、CODEBUDDY.md 一致性审查

**问题**：CODEBUDDY.md 仍为旧版，与 v0.2 决策不一致。

| 内容 | CODEBUDDY.md 当前 | v0.2 决策 | 是否一致 |
|------|-------------------|-----------|---------|
| bridge-server 状态 | 「需适配 v3 isolation」 | **退役** | 🔴 不一致 |
| mcp-bridge 状态 | 「去留待定」 | **保留并重写** | 🔴 不一致 |
| openclaw-plugin 状态 | 「需升级配置」 | **用官方版，不维护自研** | 🔴 不一致 |
| Release | 「mcp-bridge→npm, 其他→GitHub Release」 | bridge-server 退役后需调整 | 🟡 需更新 |
| 关键文档 | 未列出评审报告 | - | ✅ 已列出 |

**结论**: CODEBUDDY.md 未同步 v0.2 决策，必须更新。

---

## 五、遗留问题

| # | 问题 | 严重程度 | 建议 |
|---|------|---------|------|
| 1 | CODEBUDDY.md 未同步 v0.2 决策 | 🔴 高 | 立即更新（bridge-server 退役、mcp-bridge 保留、openclaw-plugin 用官方版） |
| 2 | CLAUDE.md auto-store 简化方案未落地 | 🟡 中 | 在 CLAUDE.md 中删除显式 store_memory 规则，改为「MemoryProxy 透明回流」说明 |
| 3 | §7 召回端点未标注自动/显式路径 | 🟢 低 | 可后续完善 |

---

## 六、评审结论

**评分**: ⭐⭐⭐⭐⭐ (5/5)

**v0.2 已解决上轮全部 3 个 P0 阻塞项**：

- bridge-server 退役 → 已决策
- mcp-bridge 保留并重写 → 已决策，含重写设计（§6.5）
- API 端点映射 → 已提供完整对照表（§7）

**新增内容质量高**：架构决策表、mcp-bridge 重写设计、迁移步骤均达到可执行水平。

**唯一阻塞行动**：更新 CODEBUDDY.md 对齐 v0.2 决策，同步 CLAUDE.md auto-store 简化。

---

## 七、行动项

| # | 行动 | 优先级 | 负责人 |
|---|------|--------|--------|
| 1 | 更新 CODEBUDDY.md 对齐 v0.2（bridge-server 退役、mcp-bridge 保留重写、openclaw-plugin 用官方版） | P0 | PM/CodeBuddy |
| 2 | 更新 CLAUDE.md auto-store 规则（删除显式 store_memory，改为 MemoryProxy 透明回流） | P0 | PM |
| 3 | §7 标注召回端点自动/显式路径 | P2 | 后续 |
