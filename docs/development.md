# 开发

## 环境

- Node.js 24 或更高（直接运行 `.ts`：`--experimental-strip-types`）。
- 冒烟测试使用本机浏览器：
  - Chromium：默认使用 Playwright 缓存中最新的 `chromium-*`（Windows 路径布局），或用环境变量 `OSHAWATT_CHROME` 指定可执行文件。
  - Firefox：默认 `C:/Program Files/Mozilla Firefox/firefox.exe`，或用 `OSHAWATT_FIREFOX` 指定。

## 构建

```sh
node scripts/build.mjs [chromium|firefox] [--dev]
```

- 不带目标时两端都构建，输出到 `dist/<target>/`。每次构建前会清空该目录。
- 每个入口单独打一个 esbuild 包：`page.js` 是 IIFE（经 `scripting.executeScript` 注入），其余是 ES module。
- 正式构建会压缩代码，不带 source map 和测试钩子；`--dev` 构建不压缩，带内联 source map、测试钩子、演示模型和 `<all_urls>` host 权限。
- 静态文件（`static/` 下的页面、`panel.css`、图标）和 `quickjs.wasm` 原样拷贝，清单由 `src/manifest.ts` 生成。
- `__OSHAWATT_TARGET__`（`chromium` / `firefox`）在构建时固定，每个包只含自己浏览器的分支；`__OSHAWATT_DEV__` 只在 `--dev` 构建中为真，测试钩子写在 `if (__OSHAWATT_DEV__)` 块里，正式构建会把整块删掉。
- chord 只从 `src/lib/chord.ts` 引入；当前 chord 1.5.0 的新版 API 在 `@earendil-works/chord/next`，上游移到根入口后只改这一个文件。
- 图标的源文件是 `static/icons/icon.svg`，PNG 由 `node scripts/icons.mjs` 生成后一起提交。

## 测试

**单元测试**（`npm test`）在 Node 中搭起整个拓扑。浏览器 API 用假的 Port 代替（`test/fake-port.ts`，按 Chromium 的语义做 JSON 序列化并异步投递）；chord、Durable、pi-ai 都是真实实现，模型用 pi-ai 的 faux provider。文件使用内存后端；Code Mode 的读写测试运行真实 QuickJS WASM；网络测试使用 stub 或本机 HTTP 服务器，不访问外部站点。

| 文件 | 覆盖内容 |
|---|---|
| `test/port-link.test.ts` | Port Link：字节顺序、监听器设置前的消息排队、关闭语义、非法帧、base64 |
| `test/engine.test.ts` | 面板提问 → 模型调用页面工具 → Engine 路由到对应标签页 → 回答回到面板；`armWake` 被调用；新对话以第一条消息命名；移除对话；面板无法访问 `Page` |
| `test/eviction.test.ts` | 模型请求进行中关闭 Engine，用同一份存储启动新 Engine，运行续完，请求只重发一次，面板自动恢复 |
| `test/markdown.test.ts` | 面板的 Markdown 解析：各类块与行内元素、只保留安全链接、裸链接的边界、流式时补全截断的标记 |
| `test/files.test.ts` | 支持的环境一致性用例、对话文件隔离、目录与大小限制；fetch 保存 → Code Mode 读/写/编辑/列出 → 面板读取/删除；拒绝未授权站点与面板越界路径 |
| `test/files-tools.test.ts` | fetch 的请求选项、文本截断、二进制与字符集、响应上限、拒绝重定向；完整文本分段读取、BOM、Unicode；站点匹配与大小格式 |
| `test/files-idb.test.ts` | fake-indexeddb 下的真实后端一致性、同步/异步/克隆异常回滚、重开连接、并发追加、目录移动和隔离清理 |
| `test/files-lifecycle.test.ts` | 删除意图跨 Engine 恢复、旧引用/旧环境被拒绝、运行中工具取消、跨面板删除与输入提交竞态 |

**冒烟测试**在真实浏览器里加载开发构建：

- `npm run smoke:chromium`：用 puppeteer-core 加载 `dist/chromium`。验证面板与页面工具、演示模型的页面问答、fetch → Code Mode 读写 → 文件面板自动刷新、实际浏览器下载、文件删除与新对话隔离；关闭 offscreen 文档后下载原对话的文件，确认新 Engine 保留数据并可继续对话。CDP 下载会话保持到测试结束，避免断开时下载策略被重置。文件截图在 `dist/smoke-chromium-files.png`，失败截图在 `dist/smoke-chromium-failure.png`。
- `npm run smoke:firefox`：用 WebDriver BiDi 安装 `dist/firefox`。BiDi 进不了扩展页面，所以由开发版的 `src/panel/selftest.ts` 执行页面问答和完整文件流程，重开 IndexedDB 连接检查保存的字节；结果与截图 POST 回本机服务器，驱动再检查实际下载文件。这里不模拟 Firefox 事件页回收。截图在 `dist/smoke-firefox-panel.png`、`dist/smoke-firefox-files.png`。
- 两端额外验证超过百万字符的单行下载可由 `read_text` 完整处理，并用本机 GET 302 / POST 307 端点证明重定向目标没有收到请求。Chromium 还检查 280 / 420 px 面板不会被长 URL 和 JSON 撑出水平溢出；截图脚本对所有状态检查页面宽度。
- 两端都用 `tool-selftest.ts` 检查文件工具卡片和 fetch 授权按钮。权限调用被 stub，用于验证参数、点击时同步调用和不会自动重跑；不替代原生权限弹窗的手动验证。

**截图**：`node scripts/build.mjs chromium --dev && node scripts/screenshots.mjs [目录]` 截取空状态、流式中、对话、模型菜单、对话列表、设置、文件工具对话和文件面板的浅色和深色版本，默认输出到 `dist/screenshots`；`OSHAWATT_LANG=en` 可切换界面语言。改了界面后用它检查效果，README 里的截图也来自这里。

## 调试

- Engine 所在文档的全局对象 `oshawatt`（正式构建也保留）：
  - `await oshawatt.page(tabId, "page_snapshot", {})`：直接调用页面工具。
  - `await oshawatt.codemode("return 1 + 1")`：在 Code Mode 沙箱里执行代码。
  - `oshawatt.engine.harness`：Durable Harness。
  - `oshawatt.files(chatId)`：该对话的 `ChatFiles`（低层文件环境）。调试用的 `oshawatt.codemode()` 不经过 Harness，不能调用对话工具；要测 `tools.read/write`，通过面板发送含网址的消息。
- 打开 Engine 的 devtools：
  - Chromium：在 `chrome://extensions` 的 Oshawatt 卡片上，从“检查视图”中选 `engine.html`。
  - Firefox：在 `about:debugging` 中点 Oshawatt 的“检查”，打开的就是事件页（Broker 和 Engine 都在这里）。
- 各宿主的错误输出带前缀：`[oshawatt engine]`、`[oshawatt broker]`、`[oshawatt page]`、`[oshawatt panel]`。其中 Broker、Page、Panel 用的是 `console.debug`。

## 常见改动

**新增页面工具**

1. 在 `src/tools/page-tools.ts` 加规格：描述、参数、返回值、`replay`。凡是会改变页面的操作都标 `unsafe`。
2. 在 `src/contracts/page.ts` 的 `methods` 里加一项（`satisfies Record<PageToolName, unknown>` 会提示是否漏了）。
3. 在 `src/page/dom.ts` 实现，在 `src/page/main.ts` 的 `members` 里接上（契约类型会检查）。
4. 在 `src/engine/tools.ts` 的 `tools` 列表里加 `pageTool("<name>")`。

**新增浏览器能力**：在 `src/contracts/browser.ts` 加方法，在 `src/broker/broker.ts` 实现；如果需要新权限，改 `src/manifest.ts`。Engine 文档里不要直接调用扩展 API，因为 Chromium 的 offscreen 文档只有 `runtime`。

**新增面板功能**：在 `src/contracts/chat.ts` 加 state 或方法，在 `src/engine/facet.ts` 实现。需要持久化的状态放进 Durable 文档（`src/engine/docs.ts`），用 `self.follow` 暴露给面板，不要另存一份。界面文字加在 `src/panel/i18n.ts`，中英文都要写（类型会检查缺项）；颜色只用 `static/panel.css` 顶部的变量，浅色和深色两套都要给值。

**新增工具的展示**：在 `src/panel/tool-card.ts` 的 `look()` 里给工具配图标和说明文字，没有配置的工具按名称显示。

**修改文件系统或网络工具**：`src/engine/files.ts` 定义环境与事务后端接口，`files-idb.ts` 是真实存储，`files-tools.ts` 注册工具。跑文件单测与两端冒烟测试：只测内存后端不能发现 IndexedDB 的事务生命周期问题。不可让事务回调等待非 IndexedDB 的异步工作；不要把 fetch 改成未经逐跳权限检查的自动重定向。

**升级 chord**：上游把新版 API 移到根入口后，只需把 `src/lib/chord.ts` 里的 `@earendil-works/chord/next` 改为 `@earendil-works/chord`，然后跑 `npm run check`，并根据报错调整 API 差异。
