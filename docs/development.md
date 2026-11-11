# 开发

需要 Node.js 24 或更高版本。构建和脚本产生的文件都在 `dist/` 下。

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run build` | 构建两端；`build:chromium`、`build:firefox` 只构建一端 |
| `npm run build:dev` | 开发构建两端 |
| `npm run package` | 构建正式版并打包为 Chromium zip、Firefox xpi 和源码包，见[分发](distribution.md) |
| `npm run sign:firefox` | 打包后经 AMO 不公开渠道签名 Firefox xpi，需要 `.env` 中的 AMO 凭据 |
| `npm run check` | TypeScript 类型检查 |
| `npm test` | 单元测试；单个文件用 `node --test test/<name>.test.ts` |
| `npm run smoke:chromium` | 开发构建后，在真实 Chromium 中运行冒烟测试 |
| `npm run smoke:firefox` | 开发构建后，在真实 Firefox 中运行冒烟测试 |
| `npm run screenshots` | 开发构建后生成界面截图 |
| `npm run icons` | 从 SVG 重新生成 PNG 图标 |

开发构建包含 source map、演示模型、演示账号（设备码 `DEMO-1234`，授权码 `demo`）和测试钩子，并声明 `<all_urls>` 权限。加载方式见 [README](../README.md#快速开始)。

## 测试

- **单元测试**：位于 `test/`，共用的夹具在 `test/support/`：`world.ts` 提供假 Broker、Page 和 Engine / Panel 连接，`wait.ts` 提供 `until`，`fake-port.ts` 模拟 `runtime.Port`，`files.ts` 用 Durable 的 `ExecutionEnv` 一致性用例检查两种文件后端。模型用 Pi-AI 的 faux provider。
- **冒烟测试**：使用本地测试站点和本地 OpenAI 兼容模型 API（`scripts/lib/site.mjs`），不需要真实账号。一部分检查以面板内自测的形式写在 `src/panel/selftest/`，只进入开发构建。Chromium 由 Puppeteer 驱动面板并调用这些自测；Firefox 中 WebDriver BiDi 无法访问扩展页面，由开发构建自动打开面板运行自测，再把结果回报给测试站点。
- **浏览器**：默认使用 Playwright 安装的 Chromium 和系统安装的 Firefox，可以用 `OSHAWOTT_CHROME`、`OSHAWOTT_FIREFOX` 指定可执行文件。
- **测试产物**：下载的文件和截图分别保存在 `dist/test/chromium/`、`dist/test/firefox/`，每次运行前清空。

## 界面截图

```sh
npm run screenshots                  # 输出到 dist/screenshots
npm run screenshots -- <输出目录>
```

设置 `OSHAWOTT_LANG=en` 生成英文界面。README 用到的几张截图需要手动复制到 `docs/screenshots/`。

## 调试

- Chromium：在 `chrome://extensions` 中打开扩展的“检查视图”，调试 Engine（`engine.html`）或 Broker（Service Worker）。
- Firefox：在 `about:debugging` 中检查扩展。
- Engine 暴露全局对象 `oshawott`，可以在控制台调用页面工具、Code Mode、Harness 和文件环境，例如 `await oshawott.page(tabId, "page_snapshot", {})`。
- 各组件日志分别以 `[oshawott engine]`、`[oshawott broker]`、`[oshawott page]`、`[oshawott panel]` 开头。
