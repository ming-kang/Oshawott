# 开发

命令见 `package.json` 的 `scripts`，产物都在 `dist/` 下；打包、签名和发布见[分发](distribution.md)

开发构建（`--dev`）额外包含演示模型、演示账号和面板自测，并申请 `<all_urls>` 权限，因此 `npm run package` 拒绝打包开发构建

## 测试

- **单元测试**（`test/`）：默认选择。在 Node 中运行 Engine 和 Panel 连接，Broker、Page、`runtime.Port` 和 IndexedDB 用 `test/support/` 中的假实现，模型用 Pi-AI 的 faux provider。单个文件用 `node --test test/<name>.test.ts`
- **冒烟测试**（`npm run smoke:chromium`、`smoke:firefox`）：只用于必须在真实浏览器中观察的行为。使用本地测试站点和本地 OpenAI 兼容模型 API（`scripts/lib/site.mjs`）。面板中的检查写成 `src/panel/selftest/` 中的自测：Chromium 由 Puppeteer 调用；Firefox 的 WebDriver BiDi 无法访问扩展页面，由开发构建自动打开面板运行自测，再把结果回报给测试站点
- **浏览器**：默认使用 Playwright 安装的 Chromium（`npx playwright@1 install chromium`）和系统安装的 Firefox，可以用 `OSHAWOTT_CHROME`、`OSHAWOTT_FIREFOX` 指定可执行文件。下载的文件和截图保存在 `dist/test/<浏览器>/`，每次运行前清空

## 界面截图

`npm run screenshots -- [输出目录]` 生成界面截图，设置 `OSHAWOTT_LANG=en` 生成英文界面。README 用到的截图需要手动复制到 `docs/screenshots/`

## 调试

- 在 Chromium 的 `chrome://extensions`“检查视图”或 Firefox 的 `about:debugging` 中检查 Engine（`engine.html`）和 Broker（Service Worker）
- Engine 暴露全局对象 `oshawott`（`src/engine/browser.ts`），可以在控制台调用页面工具、Code Mode 和文件环境，例如 `await oshawott.page(tabId, "page_snapshot", {})`
- 日志以 `[oshawott <组件>]` 开头
