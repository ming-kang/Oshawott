# Oshawatt

基于 [Pi Durable](https://github.com/earendil-works/pi) 的浏览器智能体扩展，同时支持 Chromium（120+）和 Firefox（128+）。

- 对话、工具调用、运行状态全部记在 Durable 里，扩展的任何上下文被浏览器回收后都能从最后一次提交继续。
- 模型通过页面工具读取和操作当前标签页（快照、点击、输入、滚动），也能列出和打开标签页。
- Code Mode：模型写的 JS 在独立 Worker 中的 QuickJS 里运行。
- 支持 Anthropic、OpenAI、Google、OpenRouter、DeepSeek，API key 只保存在 Engine 所在的文档里。
- 侧边栏界面：Markdown 回答流式显示，工具调用以卡片呈现，思考过程可折叠；输入框上方显示当前标签页，未授权的站点可一键授权；浅色和深色主题；中文和英文界面。

> 状态：0.1.0，框架和界面已在真实 Chromium 和 Firefox 中跑通（开发构建的演示模型）；尚未用真实模型做端到端验证。见 [已知限制](docs/architecture.md#已知限制)。

| 空状态 | 对话 | 对话（深色） | 设置（深色） |
|---|---|---|---|
| ![空状态](docs/screenshots/empty-light.png) | ![对话](docs/screenshots/chat-top-light.png) | ![对话（深色）](docs/screenshots/chat-top-dark.png) | ![设置（深色）](docs/screenshots/settings-dark.png) |

## 快速开始

```sh
npm install
npm run build                       # 正式构建：dist/chromium 和 dist/firefox
node scripts/build.mjs --dev        # 开发构建：带全站权限、source map 和测试钩子
```

加载扩展：

- **Chromium**：打开 `chrome://extensions`，开启开发者模式，「加载已解压的扩展程序」选 `dist/chromium`。点击工具栏图标打开侧边栏。
- **Firefox**：打开 `about:debugging#/runtime/this-firefox`，「临时载入附加组件」选 `dist/firefox/manifest.json`。点击工具栏图标切换侧边栏。

打开设置（右上角），给任一模型服务填入 API key，然后在输入框左下角选择模型，即可提问。页面工具第一次用在某个站点时，点输入框上方的「允许访问此站点」授权。

没有 API key 也可以先试：开发构建自带一个演示模型「Demo (scripted)」，它会真实调用 `page_snapshot` 读取当前标签页，再按脚本生成回答。开发构建还带全站权限，不需要逐站授权。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run build` | 正式构建两端（可用 `build:chromium` / `build:firefox` 只构建一端） |
| `npm run check` | TypeScript 类型检查 |
| `npm test` | 单元测试（Node 内存环境，faux 模型） |
| `npm run smoke:chromium` | 开发构建后在真实 Chromium 中冒烟测试 |
| `npm run smoke:firefox` | 开发构建后在真实 Firefox 中冒烟测试 |
| `node scripts/screenshots.mjs` | 截取面板各状态的浅色、深色截图（需先做 Chromium 开发构建） |
| `node scripts/icons.mjs` | 把 `static/icons/icon.svg` 渲染成各尺寸 PNG |

## 目录

```
src/
  contracts/   chord 契约：宿主地址、身份、Workspace / Chat / Browser / Page
  engine/      Engine：Harness、工具、面板服务、凭据、Code Mode
  broker/      Broker：标签页、脚本注入、alarms
  page/        内容脚本：页面工具的 DOM 实现
  panel/       侧边栏界面：对话渲染、Markdown、工具卡片、标签页与授权、界面文字
  entries/     各浏览器的后台入口（决定角色放在哪里）
  link/        基于 runtime.Port 的 chord Link
  platform/    WebExtension API 类型、构建目标
  tools/       页面工具规格（唯一来源）
  lib/chord.ts chord 的唯一引入点
static/        engine.html、panel.html、panel.css、图标
scripts/       构建、冒烟测试、截图、图标
test/          单元测试
docs/          架构、开发文档与截图
```

## 文档

- [架构](docs/architecture.md)：角色、连接、状态、生命周期、安全边界
- [开发](docs/development.md)：测试、调试、常见改动、发布前清单

## 许可

 [MIT LICENSE](LICENSE)
