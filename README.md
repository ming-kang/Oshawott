# Oshawatt

基于 [Pi Durable](https://github.com/earendil-works/pi) 的浏览器智能体扩展，同时支持 Chromium 和 Firefox。

- 对话、工具调用、运行状态全部记在 Durable 里，扩展的任何上下文被浏览器回收后都能从最后一次提交继续。
- 模型通过页面工具读取和操作当前标签页（快照、点击、输入、滚动），也能列出和打开标签页。
- Code Mode：模型写的 JS 在独立 Worker 中的 QuickJS 里运行，通过工具读写文件、处理数据。
- 每个对话有独立的持久文件区，支持 `read`、`write`、`edit`、`ls`；Engine 被回收或浏览器重启后仍保留，面板可以下载和删除文件。
- `fetch`：访问已授权的 HTTP(S) 站点，可把响应直接保存成文件；不带浏览器 cookie，不跟随重定向。
- 支持多种 LLM API，API key 只保存在 Engine 所在的文档里。
- 侧边栏界面：Markdown 回答流式显示，工具调用以紧凑的时间线呈现、可展开参数和结果，思考过程可折叠；输入框上方显示当前标签页，未授权的站点可一键授权；浅色和深色主题；中文和英文界面。

> 状态：0.1.0，框架和界面已在真实 Chromium 和 Firefox 中跑通（开发构建的演示模型）。
>
> 参见： [已知限制](docs/limitations.md)，[路线图](ROADMAP.md)。

| 空状态 | 对话 | 对话（深色） | 设置（深色） |
|---|---|---|---|
| ![空状态](docs/screenshots/empty-light.png) | ![对话](docs/screenshots/chat-top-light.png) | ![对话（深色）](docs/screenshots/chat-top-dark.png) | ![设置（深色）](docs/screenshots/settings-dark.png) |

## 快速开始

```sh
npm install
npm run build                       # 普通构建：dist/chromium 和 dist/firefox
node scripts/build.mjs --dev        # 开发构建：带全站权限、source map 和测试钩子
```

当前只从构建目录直接加载已解压扩展，不生成 zip、xpi 等安装包。

加载扩展：

- **Chromium**：打开 `chrome://extensions`，开启开发者模式，「加载已解压的扩展程序」选 `dist/chromium`。点击工具栏图标打开侧边栏。已解压版的扩展 ID 固定为 `nbemmciikpdicdifcdfapndnmmjcmdaa`。
- **Firefox**（桌面 128+）：打开 `about:debugging#/runtime/this-firefox`，「临时载入附加组件」选 `dist/firefox/manifest.json`。点击工具栏图标切换侧边栏。浏览器重启后需重新载入。

打开设置，给任一模型服务填入 API key，然后在输入框左下角选择模型，即可开始使用。

页面工具第一次用在某个站点时，点输入框上方的「允许访问此站点」授权。

### 文件与下载

| 文件（浅色） | 文件（深色） |
|---|---|
| ![文件面板（浅色）](docs/screenshots/files-light.png) | ![文件面板（深色）](docs/screenshots/files-dark.png) |

可以让模型“把这个网址的数据保存到 `data.json`，统计后写成 `summary.md`”。文件默认放在这个对话的 `/workspace` 中，右上角的文件按钮可以列出、下载或删除它们。每个对话互相隔离；移除对话会一起删除文件。单文件上限 20 MiB，总容量受浏览器存储配额限制。

fetch 因未授权失败时，卡片上会显示「允许访问此站点」。授权后再发一条消息重试，**不会自动重跑原请求**。请使用最终的下载网址：重定向会被拒绝，避免请求跳到未授权站点。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run build` | 普通构建两端（`build:chromium` / `build:firefox` 只构建一端） |
| `npm run check` | TypeScript 类型检查 |
| `npm test` | 单元测试（Node 内存环境，faux 模型） |
| `npm run smoke:chromium` / `smoke:firefox` | 开发构建后在真实浏览器中冒烟测试 |

截图与图标命令见 [开发](docs/development.md)。

## 目录

```
src/
  contracts/   chord 契约：宿主地址、身份、Workspace / Chat / Browser / Page
  engine/      Engine：Harness、工具、持久文件区、面板服务、凭据、Code Mode
  broker/      Broker：标签页、脚本注入、alarms
  page/        内容脚本：页面工具的 DOM 实现
  panel/       侧边栏界面：对话渲染、Markdown、工具卡片、文件面板、标签页与授权
  entries/     各浏览器的后台入口（决定角色放在哪里）
  link/        基于 runtime.Port 的 chord Link
  platform/    WebExtension API 类型、构建目标
  tools/       页面工具规格（唯一来源）
  lib/         chord 的唯一引入点与无平台依赖的小工具
static/        engine.html、panel.html、panel.css、图标
scripts/       构建、冒烟测试、截图、图标
test/          单元测试
docs/          架构、开发、文件与限制文档及截图
```

## 文档

- [架构](docs/architecture.md)：角色、契约、状态、生命周期与安全边界
- [开发](docs/development.md)：构建、测试、调试与修改入口
- [文件与 Fetch](docs/files.md)：工具、权限、存储与恢复
- [已知限制](docs/limitations.md)
- [路线图](ROADMAP.md)：当前开发重点与暂缓项

## 许可

[MIT LICENSE](LICENSE)
