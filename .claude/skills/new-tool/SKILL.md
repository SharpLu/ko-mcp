---
name: new-tool
description: 新建或修改 ko-mcp 的 MCP tool（server/src/tools/）或触碰 tool→ko-api 代理。任何加/改/删 tool 的任务都先调用本 skill。
---

# 新 MCP tool 变更流程

本 skill 是 [AGENTS.md](../../../AGENTS.md) 的快捷入口：五步清单见 **§4**，铁律见 **§3**，
验证命令见 **§6**，Definition of Done 见 **§5**。

动手前自检这五件事（ko-mcp 事故/约束 Top5）：

1. **24-count 契约**：加/删/改名 tool 必须同步 `server/src/__tests__/tools-proxy.test.ts`
   的 `EXPECTED_TOOLS`（恰好 24 + 全名）。漏改 CI 直接 fail（铁律 #1）。

2. **Int64 是字符串**：ko-api 的 Int64/UInt64（net_value / shares_held / holding_value…）
   以字符串到达——喂给 `fmtMoney/fmtShares/fmtPct` 前先 `num()` 强转，别当 number 用。
   `crypto.ts` 是范本，`num()` 在 `format.ts`（铁律 #2）。

3. **ko-api 路径必须 LIVE**：契约门只查 tool 是否注册（调 `/api/` 路径），**不查 liveness**。
   新/改 tool 的 `/api/v1/...` 要对着 ko-api 路由核对并 **curl 过**
   （`https://api.ko.io/api/v1/...?demo=true`），别写一个打不通的 tool（铁律 #3/#7）。

4. **动态代理，别硬编码**：`mcp-proxy` 动态转发 mcp.ko.io 的 `tools/list`；
   `KO_API_URL = api.ko.io` 是地理路由（正确，别改）。不在代理里写死 tool 列表（铁律 #4）。

5. **跑 server 测试**：`cd server && npm run type-check && npm test` 全绿再提。
   单测禁触网（`vi.mock("../ko-fetch.js")`）。眼看 ≠ verified——没 curl 过的路径别声称好使（铁律 #6/#7）。

收尾必做：`tools-proxy.test.ts` 24-count 同步 + 验证证据贴 PR；版本齐步
（`server.json` + `package.json`，SDK 三包同版本，铁律 #8）；普适教训回写 AGENTS.md §3。
