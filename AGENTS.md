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
| `server/` | **mcp.ko.io** 的 Cloudflare Worker 本体（唯一 MCP 入口，**24 tools**，Streamable HTTP） | CF Worker `ko-mcp-server` | server.json + package.json = 1.0.0 |
| `python/` | `ko-edgar` PyPI SDK（httpx，同步+异步） | PyPI `ko-edgar` | 0.1.0 |
| `typescript/sdk/` | `@ko-io/sdk`（TS REST 客户端） | npm | 0.1.0 |
| `typescript/mcp-proxy/` | `@ko-io/mcp-sec-data`（stdio→mcp.ko.io 代理，**动态转发 tool 列表**） | npm | 0.1.0 |

数据链：`ko-api (api.ko.io serving) → server/ tools 代理 → MCP client（Claude / ChatGPT / …）`。
worker 本身不碰 ClickHouse / D1，只是 ko-api 的薄客户端（`koFetch`）。

## 2. 环境事实（每个 session 都必须知道）

- **分支纪律**：永远 `git fetch && git switch -c <type>/<slug> origin/main`。一分支 = 一任务 = 一 PR，squash merge。
- **部署**：
  - **server** = push `server/**` 到 main → `.github/workflows/deploy-server.yml`（`wrangler versions deploy 100%` + 部署后 `tools/list >= 24` 健康门）。没有手动部署这回事。
  - **SDK（python + 2 个 npm 包）** = 发 GitHub Release 才 publish（`publish-python.yml` / `publish-npm.yml`，各自带 test 门：`pytest` / `npm test`）。
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
| 6 | **单测禁触网**：单元测试一律 `vi.mock("../ko-fetch.js")` / `vi.stubGlobal("fetch", …)`，不连真 CH/ko-api。live 探测归 deploy 后的健康门 | dev 机活服务让坏测试假绿 | `no-network` 守卫（如已挂） |
| 7 | **验证必须真跑**：SDK / worker 改动 `npm test`（server）/`pytest`（python）绿；新/改 tool 的 ko-api 路径**部署后 curl 过**。眼看 ≠ verified——从没 curl 过的 tool 路径上线后可能全 500 | #191 教训（ko-api） | PR 模板"验证证据"必填 |
| 8 | **版本 lockstep**：`server/server.json` + `server/package.json` 一起动（registry id `io.github.SharpLu/ko-mcp`）。三个 SDK 包各自独立，但应保持同一版本号齐步走 | registry / 发布一致性 | 人工 / PR review |

## 4. 任务怎么做（新 tool 五步）

Claude Code 用户可用 `/new-tool` skill（同一内容的快捷入口）。

1. **核对 ko-api 路径**：tool 要代理的 `/api/v1/...` 在 ko-api 存在且 live——**先 curl 一次**（`https://api.ko.io/api/v1/... ?demo=true` 或带 key）。路径不对/没上线，别写 tool（铁律 #3）。
2. **写 tool**：在 `server/src/tools/<area>.ts` 加 `server.tool(name, desc, schema, handler)`。金额/份额字段先 `num()` 再 `fmt*`（铁律 #2）；列表响应做 `Array.isArray()` 双形态分支（铁律 #5）。
3. **更新 24-count 契约**：把新 tool 加进 `tools-proxy.test.ts` 的 `EXPECTED_TOOLS` 并改数字断言（铁律 #1）。
4. **写单测**：`vi.mock("../ko-fetch.js")`，断言代理路径 + 参数 + 渲染（`crypto.test.ts` / `stocks.test.ts` 是模板）。禁触网（铁律 #6）。
5. **本地门 + 部署后实测**：`server` 目录 `npm run type-check && npm test` 全绿 → merge `server/**` → deploy-server.yml 跑 `tools/list>=24` 健康门 → 对 live mcp.ko.io 打一次该 tool（铁律 #7）。

## 5. Definition of Done（全部勾完才算完成）

- [ ] 代码 + 测试同一个 PR；改动包各自的门全绿（`server`: `npm run type-check` + `npm test`；`python`: `ruff`+`mypy`+`pytest`；`typescript/*`: `npm run build`+`npm test`）
- [ ] 新/改/删 tool：`tools-proxy.test.ts` 的 24-count 契约已同步（铁律 #1）
- [ ] 新/改 tool 的 ko-api 路径已 curl 实测（铁律 #3/#7），证据贴 PR
- [ ] 版本齐步（server.json + package.json；SDK 三包同版本）（铁律 #8）
- [ ] 教训回写：普适 → 本文件 §3 加一行；能机器化 → 加守卫测试

## 6. 常用验证命令

```bash
# server 本地门（deploy-server.yml 同款）
cd server && npm run type-check && npm test

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
| `.github/workflows/deploy-server.yml` | server 部署 + 健康门 | |
| `.github/workflows/publish-{python,npm}.yml` | SDK 发布（带 test 门） | |
| `../ko-api/AGENTS.md` | serving 端点侧规范 | tool 代理到的路径以那边为准 |
| `../CLAUDE.md`（KO 根） | 运维手册（服务器/集群/域名单一真相） | 基础设施问题先读它 |
