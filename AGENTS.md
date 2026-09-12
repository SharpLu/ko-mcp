# AGENTS.md — ko-mcp 作业规范（所有 AI agent 的唯一入口）

> 无论你是 Claude、Codex 还是其他 agent，无论在哪台机器、哪个 session：
> **开始任何任务前先读完本文件**。这是一个 monorepo，一份 AGENTS.md 管全仓。
>
> 任何事实只写一处。运维全景（服务器 / 集群 / 域名）见 `/Users/l/KO/CLAUDE.md`（运维手册）。
> serving 端点的合约在另一个 repo：`ko-api/AGENTS.md`（tool 代理到的 ko-api 路径以那边为准）。

## 1. 这个仓库是什么

`ko-mcp` = KO 的 MCP + SDK monorepo，四个独立可发布的包：

| 目录 | 是什么 | 发布到 | 版本 |
|------|--------|--------|------|
| `server/` | **mcp.ko.io** 的 Cloudflare Worker 本体（唯一 MCP 入口，**24 tools**，Streamable HTTP） | CF Worker `ko-mcp-server` | server.json + package.json + src/index.ts = 1.1.0 |
| `python/` | `ko-edgar` PyPI SDK（httpx，同步+异步） | PyPI `ko-edgar` | 0.1.0 |
| `typescript/sdk/` | `@ko-io/sdk`（TS REST 客户端） | npm | 0.1.0 |
| `typescript/mcp-proxy/` | `@ko-io/mcp-sec-data`（stdio→mcp.ko.io 代理，**动态转发 tool 列表**） | npm | 0.1.0 |

数据链：`ko-api (api.ko.io serving) → server/ tools 代理 → MCP client（Claude / ChatGPT / …）`。
worker 本身不碰 ClickHouse / D1，只是 ko-api 的薄客户端（`koFetch`）。

## 2. 环境事实（每个 session 都必须知道）

- **分支纪律**：永远 `git fetch && git switch -c <type>/<slug> origin/main`。一分支 = 一任务 = 一 PR，squash merge。
- **部署**：
  - **server** = push `server/**` 到 main → `.github/workflows/deploy-server.yml`（`wrangler versions deploy 100%` + 部署后 `tools/list >= 24` 健康门）。没有手动部署这回事。
    健康门失败 = **自动 rollback**：部署前先抓当前 serving 版本 id 并把 rollback 命令打进日志，失败后 `wrangler rollback <id>`（**不是** `wrangler versions rollback`，该子命令不存在）→ 重新跑健康门 → Discord `#deploys`。坏版本永不删除。运维细节见 `docs/deploy-rollback.md`。
  - **SDK（python + 2 个 npm 包）** = 发 GitHub Release 才 publish（`publish-python.yml` / `publish-npm.yml`，各自带 test 门：`pytest` / `npm test`）。`publish-mcp-registry.yml` 由 tag `v*` 触发。
  - **CI 跑在 GitHub-hosted `ubuntu-latest`**（`ci.yml` 三个 job + `deploy-server.yml` 全部如此）。**ko-mcp 是 public repo，Actions 分钟数免费**，私仓那次 Actions 账单中断从未波及它——这正是 PR #12 revert 掉 PR #8（迁 A3 自建 runner）的理由。别再把本仓的 gate 往自建 runner 上搬。
- **`KO_API_URL = https://api.ko.io` 是正确的**——`api.ko.io` 本身就是地理路由 Worker（`api-geo-router`），不是某个 origin。**不要改成 origin IP / origin-api-eu 之类**。
- **ko-api envelope**：ko-api 把响应包成 `{ data, meta }`；`koFetch` 自动剥掉顶层 `data`。**Int64/UInt64 列以字符串到达**（net_value / shares_held / holding_value…）。
- 没有 SSH / 无法打 live 的环境：把需要 prod 验证的 curl 写出来交给用户，**不得跳过验证环节**。

## 3. 铁律

每条都来自真实生产事故或架构约束。带机器强制的违反即挡 CI；不带的违反即事故复发。

| # | 规则 | 出处 | 机器强制 |
|---|------|------|----------|
| 1 | **24-tool 契约**：新增/删除/改名 tool 必须同步更新 `server/src/__tests__/tools-proxy.test.ts` 的 `EXPECTED_TOOLS`（断言恰好 24 个 + 全名）。漏改 = CI 直接 fail | tool 契约门 | `tools-proxy.test.ts` |
| 2 | ko-api 的 **Int64/UInt64 以字符串到达**——喂给数字格式化前必须 `num()` 强转（`Number(String(v))`），别当 number 用。`fmtMoney/fmtShares/fmtPct` 已在 `format.ts` 顶部集中 coerce；`num()` 是参照（`crypto.ts` 是范本） | net_value 类（stock_activity / crypto 溢出误渲染） | `format.ts` coerce + 单测 |
| 3 | 每个 tool 代理到一条 **LIVE ko-api 路径**。契约门只查 tool **注册**（是否调 `/api/` 路径），**不查 liveness**——ko-api 端点改动会静默打断 tool。新增/改动 tool 的路径必须对着 ko-api 路由核对并 curl 过 | 契约门覆盖面局限 | 人工（§6 curl） |
| 4 | **别硬编码 tool 列表**：`mcp-proxy` 动态转发 mcp.ko.io 的 `tools/list`。`KO_API_URL = api.ko.io` 是地理路由（正确），也别在代理里写死路径 | 架构约定 | 人工 / PR review |
| 5 | ko-api response **两种形态都要能吃**：`koFetch` 剥掉顶层 `{data}` 后，可能拿到 `{data:[...],meta}`（→ 裸数组）或双层嵌套（→ 对象）。读列表的 tool 要 `Array.isArray()` 分支，否则 shape 一变就静默"No results found" | #192 stock-holders FINAL 事故的同类 serving 脆弱性 | `stocks.test.ts` |
| 6 | **单测禁触网**：单元测试一律 `vi.mock("../ko-fetch.js")` / `vi.stubGlobal("fetch", …)`，不连真 CH/ko-api。live 探测归 deploy 后的健康门。**模块 mock 必须 `...(await vi.importActual(...))` 打底再覆盖那一个导出**——手写导出清单的工厂会让新导出静默变 `undefined`（#127 的 `KO_FETCH_TIMEOUT_MS` 就这样在 `filings.ts` 里读成 undefined，令一条已声明的上游腿从 registry 行为门里凭空消失） | dev 机活服务让坏测试假绿；#127 的残缺 mock | `no-network` 守卫（如已挂） |
| 7 | **验证必须真跑**：SDK / worker 改动 `npm test`（server）/`pytest`（python）绿；新/改 tool 的 ko-api 路径**部署后 curl 过**。眼看 ≠ verified——从没 curl 过的 tool 路径上线后可能全 500 | #191 教训（ko-api） | PR 模板"验证证据"必填 |
| 8 | **版本 lockstep 三处**：`server/server.json` + `server/package.json` + **`server/src/index.ts` 的 `new McpServer({version})`** 一起动（registry id `io.github.SharpLu/ko-mcp`）。第三处最容易漏——它才是 `initialize` 回给客户端的版本号（2026-09-12 审计实测：前两处 1.0.0、线上自报 1.1.0）。三个 SDK 包各自独立，但应保持同一版本号齐步走 | registry / 发布一致性 | 人工 / PR review |
| 9 | **黄金契约不许钉 bug**：`src/contract/golden/` 里任何一条已知缺陷的用例必须带 `knownDefect` + probe（断言"缺陷仍在"），或在 `EXCLUDED` 里写明理由。把今天的错答案钉成契约 = 这道门会挡住它自己的修复。修好缺陷时在**同一个 PR** 里删注解 + `npm run golden:capture` 重钉 | M1 黄金契约门（ko-api#231 / #236 的同形教训） | `golden.test.ts`（注解/排除/原值三道断言）+ `golden-gate.mjs`（缺陷被修 = 红） |
| 10 | **出站 fetch 必须有界，且界要小于上游**：每个 `fetch`（含 tool 层的裸 fetch）带 `AbortSignal.timeout()`，默认 `KO_FETCH_TIMEOUT_MS`=20s，**必须小于上游 route 声明的 `timeoutMs`(30s)**——代理要先于被代理者失败，否则拿回来的是别人的 5xx。超时抛独立的 `KoTimeoutError`（"我们不等了"），绝不能和 `ko.io API error (5xx)`（"上游坏了"）同形。配套：**hang 测试必须真 hang**——mock 立即 reject 的 "no hang" 测试对零超时实现同样绿（#127 的假绿正是如此），要用只听 signal、自己永不 settle 的 fetch | #127：单次调用实测阻塞 60,222 ms；同一输入跑出 404 / 502 两种错误类，卡死过一次 main 部署 | `registry-defects.test.ts`（AbortSignal + 上界断言）+ `mcp-errors.test.ts`（真 hang，2s 内红） |

## 4. 任务怎么做（新 tool 五步）

Claude Code 用户可用 `/new-tool` skill（同一内容的快捷入口）。

1. **核对 ko-api 路径**：tool 要代理的 `/api/v1/...` 在 ko-api 存在且 live——**先 curl 一次**（`https://api.ko.io/api/v1/... ?demo=true` 或带 key）。路径不对/没上线，别写 tool（铁律 #3）。
2. **写 tool**：在 `server/src/tools/<area>.ts` 加 `server.tool(name, desc, schema, handler)`。金额/份额字段先 `num()` 再 `fmt*`（铁律 #2）；列表响应做 `Array.isArray()` 双形态分支（铁律 #5）。
3. **登记注册表 + 24-count 契约**：把新 tool 加进 `server/src/registry/tools.ts` 的 `TOOL_REGISTRY`（上游 route / 参数 / plan）和 `src/__tests__/registry/probes.ts` 的 `PROBES`，再加进 `tools-proxy.test.ts` 的 `EXPECTED_TOOLS` 并改数字断言（铁律 #1）。注册表的门会告诉你缺什么：**tool 发出而上游 handler 不读的参数 = 红门**（不是注释）。
4. **写单测**：`vi.mock("../ko-fetch.js")`，断言代理路径 + 参数 + 渲染（`crypto.test.ts` / `stocks.test.ts` 是模板）。禁触网（铁律 #6）。
5. **本地门 + 部署后实测**：`server` 目录 `npm run type-check && npm test` 全绿 → 新 tool 进 `src/contract/cases.mjs` 三个用例（normal/empty/error）并 `npm run golden:capture` → `npm run golden:gate` 绿 → merge `server/**` → deploy-server.yml 先跑黄金契约门再部署，最后 `tools/list>=24` 健康门 → 对 live mcp.ko.io 打一次该 tool（铁律 #7）。

## 5. Definition of Done（全部勾完才算完成）

- [ ] 代码 + 测试同一个 PR；改动包各自的门全绿（`server`: `npm run type-check` + `npm test`；`python`: `ruff`+`mypy`+`pytest`；`typescript/*`: `npm run build`+`npm test`）
- [ ] 新/改/删 tool：`src/registry/tools.ts` 注册表 + `probes.ts` 探针 + `tools-proxy.test.ts` 的 24-count 契约全部同步（铁律 #1）
- [ ] 触碰上游契约时：`npm test -- src/__tests__/registry` 全绿；改了 ko-api 侧 route/参数则 `KO_API_REPO=../ko-api npm run registry:refresh-pin` 重钉并在 PR 里贴 diff
- [ ] 黄金契约：新/改 tool 进 `src/contract/cases.mjs` 并重钉 fixture；已知缺陷带 `knownDefect` probe 或写明排除理由（铁律 #9）
- [ ] 新/改 tool 的 ko-api 路径已 curl 实测（铁律 #3/#7），证据贴 PR
- [ ] 版本齐步（server.json + package.json + src/index.ts 的 `McpServer({version})`；SDK 三包同版本）（铁律 #8）
- [ ] 教训回写：普适 → 本文件 §3 加一行；能机器化 → 加守卫测试

## 6. 常用验证命令

```bash
# server 本地门（deploy-server.yml 同款）
cd server && npm run type-check && npm test && npm run golden:gate

# SDK 门
cd python && pip install -e ".[dev]" && ruff check src tests && mypy src && pytest -q
cd typescript/sdk && npm ci && npm run build && npm test
cd typescript/mcp-proxy && npm ci && npm run build && npm test

# 部署后 tool liveness（打真 MCP + 底层 ko-api 路径）
curl -s https://mcp.ko.io/health
curl -s "https://api.ko.io/api/v1/<tool-backing-path>?demo=true" | head   # tool 路径必须 curl 过

# MCP tools/list（应 >= 24）
curl -s -X POST https://mcp.ko.io/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | python3 -m json.tool | grep -c '"name"'
```

## 7. 文档地图

| 文件 | 是什么 | 注意 |
|------|--------|------|
| 本文件 | 铁律 + 入口 | 每个 session 开始读 |
| `CLAUDE.md` | 指向本文件的薄壳 | 别往里加规则 |
| `server/README.md` | worker / tool 说明 | 新 tool 同步 |
| `README.md`（根） | 面向用户的门面：24 tool 清单 / 数据表 / 套餐表 | 数字改动要同步 |
| `llms.txt` | 机器可读的 tool + REST 端点地图 | 新 tool 同步 |
| `docs/clients/*.md`（7 份） | 各 MCP 客户端接入配置 | server 名一律 `ko-sec-data` |
| `cookbook/*.py`（10 个） | 可直接跑的 SDK 示例（01–09 免 key，10 需 Pro） | 改 SDK 要真跑一遍 |
| `server/src/registry/tools.ts` | 24 个 tool → ko-api route/参数/plan 的唯一声明 | 新/改 tool 必改；异常表只许缩小 |
| `server/src/registry/upstream/` | 按 blob SHA 钉住的 ko-api 快照（`pin.json` 是钉子） | 只能由 `registry:refresh-pin` 生成，不手改 |
| `server/docs/GOLDEN_CONTRACT.md` | 黄金契约门：钉什么/不钉什么、两条防陈旧性质、已知缺陷注解、重录规程 | 改 tool 渲染前先读 §7 |
| `.github/workflows/deploy-server.yml` | server 部署：部署前黄金契约门 → 捕获 rollback 目标 → upload → deploy → 健康门 + 自动 rollback | 逻辑在 `server/scripts/deploy-guard.mjs`，YAML 只是调用 |
| `docs/deploy-rollback.md` | rollback runbook（自动化本身坏了怎么办） | wrangler 4.100.0 两个坑写在里面 |
| `server/scripts/mcp-contract-scan.mjs` | 对 live mcp.ko.io 的全 tool 合约扫描（铁律 #3/#7 的工具化） | 手动跑，无 CI 引用 |
| `server/Dockerfile` | Glama.ai 目录收录用的本地 miniflare 容器 | 非生产路径，别删 |
| `.github/workflows/ci.yml` | python / typescript / server 三个 gate（ubuntu-latest） | |
| `.github/workflows/publish-{python,npm}.yml` | SDK 发布（带 test 门） | |
| `../ko-api/AGENTS.md` | serving 端点侧规范 | tool 代理到的路径以那边为准 |
| `../CLAUDE.md`（KO 根） | 运维手册（服务器/集群/域名单一真相） | 基础设施问题先读它 |
