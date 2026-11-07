# 开发

## 环境与构建

要求 Node.js 24+、Chromium 120+ 或桌面 Firefox 128+。

```sh
npm install
npm run build                        # 两端普通构建
node scripts/build.mjs chromium --dev
node scripts/build.mjs firefox --dev
```

- 输出到 `dist/<target>/`，每次构建前清空对应目录；两种构建都直接作为已解压扩展加载，不生成安装包。
- 普通构建压缩代码；`--dev` 增加 source map、测试钩子、演示模型和 `<all_urls>` host 权限。
- Chromium 通过 manifest `key` 固定扩展 ID，移动构建目录不会切换本地存储。未知构建选项会直接报错。
- `src/manifest.ts` 生成清单；`static/` 与 `quickjs.wasm` 原样拷贝。每个入口独立打包，`page.js` 为 IIFE，其余为 ES module。
- `__OSHAWATT_TARGET__` 固定浏览器分支，`__OSHAWATT_DEV__` 控制开发代码；普通构建会移除测试钩子。
- 图标由 `node scripts/icons.mjs` 从 `static/icons/icon.svg` 生成。

## 验证

| 命令 | 用途 |
|---|---|
| `npm run check` | TypeScript 类型检查 |
| `npm test` | Node 单元测试 |
| `npm run smoke:chromium` | 构建并用 Puppeteer 验证真实 Chromium |
| `npm run smoke:firefox` | 构建并用 WebDriver BiDi 验证真实 Firefox |

单元测试使用真实 chord、Durable、pi-ai 和 QuickJS，以 faux provider、fake Port、内存或 fake-indexeddb 后端隔离浏览器环境。重点覆盖 Port Link、Engine 恢复、Markdown、manifest、模型选择与 Provider 认证，以及文件与 fetch 的一致性、权限和删除竞态。

冒烟测试加载 `--dev` 构建，覆盖页面工具、fetch → Code Mode → 文件面板、下载、删除与对话隔离，并检查设置、模型菜单、overlay 生命周期和 Transcript 状态。Chromium 还验证 offscreen 重建；Firefox 由 `src/panel/selftest.ts` 执行扩展页面内检查。原生权限弹窗和真实模型 API 仍需手动验证。

浏览器路径可用 `OSHAWATT_CHROME`、`OSHAWATT_FIREFOX` 指定。默认分别寻找 Playwright Chromium 缓存和 `C:/Program Files/Mozilla Firefox/firefox.exe`。

界面改动后运行：

```sh
node scripts/build.mjs chromium --dev
node scripts/screenshots.mjs [目录]   # 默认 dist/screenshots；OSHAWATT_LANG=en 可切换英文
```

## 调试

Engine 全局对象 `oshawatt` 在普通构建中也可用：

- `await oshawatt.page(tabId, "page_snapshot", {})`：调用页面工具。
- `await oshawatt.codemode("return 1 + 1")`：直接执行 Code Mode，不经过 Harness 或对话工具。
- `oshawatt.engine.harness`：Durable Harness。
- `oshawatt.files(chatId)`：该对话的低层文件环境。

Chromium 在 `chrome://extensions` 的“检查视图”中打开 `engine.html`；Firefox 在 `about:debugging` 中检查扩展。日志前缀为 `[oshawatt engine]`、`[oshawatt broker]`、`[oshawatt page]`、`[oshawatt panel]`。

## 修改入口

| 改动 | 主要位置与约束 |
|---|---|
| 页面工具 | 在 `src/tools/page-tools.ts` 声明规格，依次更新 `src/contracts/page.ts`、`src/page/dom.ts`、`src/page/main.ts`、`src/engine/tools.ts`；副作用操作标 `unsafe` |
| 浏览器能力 | 更新 `src/contracts/browser.ts` 与 `src/broker/broker.ts`；需要新权限时修改 `src/manifest.ts`。Engine 不直接调用扩展 API |
| Panel 功能 | 契约在 `src/contracts/chat.ts`，实现在 `src/engine/facet.ts`；持久状态放入 `src/engine/docs.ts` 并用 `self.follow` 暴露，不另存副本 |
| Panel 组件 | `src/panel/main.ts` 只协调连接、当前对话与输入；内容与本地状态在 `chats.ts`、`settings.ts`、`model-menu.ts`、`files.ts`；`overlays.ts` 统一关闭与焦点，`models.ts` 定义选择策略 |
| 界面 | 文案集中在 `src/panel/i18n.ts`，中英文同步；颜色与圆角使用 `static/panel.css` 变量；工具卡片配置在 `src/panel/tool-card.ts` |
| 文件与 fetch | `src/engine/files.ts` 定义环境与事务接口，`files-idb.ts` 是 IndexedDB 后端，`files-tools.ts` 注册工具；事务回调不得等待非 IndexedDB 异步工作，fetch 不得自动跟随重定向 |
| chord 升级 | 只从 `src/lib/chord.ts` 引入；上游新版 API 移到根入口后在此调整，再运行类型检查与测试 |

修改文件或网络工具后，必须同时运行文件单测和两端冒烟测试；内存后端无法发现 IndexedDB 事务生命周期问题。
