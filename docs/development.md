# 开发

## 环境

- Node.js 24 或更高（直接运行 `.ts`：`--experimental-strip-types`）。
- 冒烟测试需要本机浏览器，不会自动下载：
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
- 图标的源文件是 `static/icons/icon.svg`，PNG 由 `node scripts/icons.mjs` 生成后一起提交。

## 测试

**单元测试**（`npm test`）在一个 Node 进程里搭起整个拓扑。浏览器 API 用假的 Port 代替（`test/fake-port.ts`，按 Chromium 的语义做 JSON 序列化并异步投递）；chord、Durable、pi-ai 都是真实实现，模型用 pi-ai 的 faux provider。

| 文件 | 覆盖内容 |
|---|---|
| `test/port-link.test.ts` | Port Link：字节顺序、监听器设置前的消息排队、关闭语义、非法帧、base64 |
| `test/engine.test.ts` | 面板提问 → 模型调用页面工具 → Engine 路由到对应标签页 → 回答回到面板；`armWake` 被调用；新对话以第一条消息命名；移除对话；面板无法访问 `Page` |
| `test/eviction.test.ts` | 模型请求进行中关闭 Engine，用同一份存储启动新 Engine，运行续完，请求只重发一次，面板自动恢复 |
| `test/markdown.test.ts` | 面板的 Markdown 解析：各类块与行内元素、只保留安全链接、裸链接的边界、流式时补全截断的标记 |

**冒烟测试**在真实浏览器里加载开发构建：

- `npm run smoke:chromium`：用 puppeteer-core 加载 `dist/chromium`，通过面板界面和 offscreen 文档里的调试对象依次检查：面板连上 Engine；页面工具真实作用于测试页；Code Mode 运行；在面板提问后演示模型对测试页调用 `page_snapshot`，回答流式显示，对话以问题命名；关闭 offscreen 文档后在新 Engine 上再问一轮，两个对话都在。失败时把面板截图存为 `dist/smoke-chromium-failure.png`。
- `npm run smoke:firefox`：用 WebDriver BiDi 安装 `dist/firefox`。BiDi 进不了扩展页面，所以改由扩展自测：开发构建安装时如果发现 URL 含 `oshawatt-selftest` 的标签页，就打开 `panel.html?selftest=<origin>`，由 `src/panel/selftest.ts` 执行同样的步骤（没有回收那一步），再把结果和面板截图 POST 回测试服务器（截图存为 `dist/smoke-firefox-panel.png`）。

**截图**：`node scripts/build.mjs chromium --dev && node scripts/screenshots.mjs [目录]` 截取空状态、流式中、对话、模型菜单、对话列表、设置的浅色和深色版本，默认输出到 `dist/screenshots`；`OSHAWATT_LANG=en` 可切换界面语言。改了界面后用它检查效果，README 里的截图也来自这里。

## 调试

- Engine 所在文档的全局对象 `oshawatt`（正式构建也保留）：
  - `await oshawatt.page(tabId, "page_snapshot", {})`：直接调用页面工具。
  - `await oshawatt.codemode("return 1 + 1")`：在 Code Mode 沙箱里执行代码。
  - `oshawatt.engine.harness`：Durable Harness。
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

**升级 chord**：上游把新版 API 移到根入口后，只需把 `src/lib/chord.ts` 里的 `@earendil-works/chord/next` 改为 `@earendil-works/chord`，然后跑 `npm run check`，并根据报错调整 API 差异。

## 发布前清单

- [ ] 把 `src/manifest.ts` 中的 gecko ID `oshawatt@example.org` 换成正式 ID，并补充 AMO 要求的 `data_collection_permissions`。
- [ ] 在两端用正式构建手动验证站点授权：点「允许访问此站点」、接受浏览器弹窗后页面工具可用。
- [ ] 用正式构建（不带 `--dev`）打包，确认 `<all_urls>` 只出现在 `optional_host_permissions` 中。
- [ ] 用真实 API key 在两端各跑一轮带页面工具的对话。
