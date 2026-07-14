## 目标

Closes #<issue>

## 改了什么

<!-- 面向下一个接手的人/agent，不是面向 diff。改了哪个包（server / python / sdk / mcp-proxy）？ -->

## 验证证据（必填）

<!-- 红线（AGENTS.md 铁律 #7）：实际执行的命令 + 关键输出。未真跑不得声称 verified。
     至少覆盖: ① 改动包的门（server: npm run type-check + npm test / python: ruff+mypy+pytest /
     typescript/*: npm run build + npm test）② 新/改 tool 的 ko-api 路径 curl 过（demo 或带 key） -->

```text
$ <命令>
<输出>
```

## 契约与版本

- [ ] 新/改/删 tool：`server/src/__tests__/tools-proxy.test.ts` 的 24-count `EXPECTED_TOOLS` 已同步（铁律 #1）
- [ ] 版本齐步：`server.json` + `server/package.json`；SDK 三包同版本（铁律 #8）
- [ ] 无 tool/版本影响（一句话说明理由）：

## 风险与回滚

<!-- server 改动 = merge server/** 即部署（deploy-server.yml + tools/list>=24 健康门）。
     SDK 改动 = 发 Release 才 publish。破坏性操作必填回滚方式；纯增量可写"无"。 -->
