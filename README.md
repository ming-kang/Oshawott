# Oshawott

> 正在开发中

水水獭（Oshawott）是基于 [Pi Durable](https://github.com/earendil-works/pi) 的浏览器智能体扩展，支持 Chromium 和 Firefox。

- **可恢复**：对话、工具调用和运行状态存进 Durable，后台被回收或浏览器重启后能接着运行
- **页面工具**：读取当前标签页的快照，执行点击、输入、滚动；列出标签页和打开新标签页
- **文件与 Code Mode**：每个对话有自己的持久文件区；模型在 Worker 里的 QuickJS 中运行 JS 来处理文件
- **`fetch`**：请求用户授权过的站点，可以把响应存成文件
- **多模型**：由 `pi-ai` 接入 Anthropic、OpenAI、Google、OpenRouter、DeepSeek
- **侧边栏**：流式 Markdown，浅色/深色主题，中英文界面

| 空状态 | 对话 | 对话（深色） | 设置（深色） | 文件 |
|---|---|---|---|---|
| ![空状态](docs/screenshots/empty-light.png) | ![对话](docs/screenshots/chat-top-light.png) | ![对话（深色）](docs/screenshots/chat-top-dark.png) | ![设置（深色）](docs/screenshots/settings-dark.png) | ![文件](docs/screenshots/files-light.png) |

## 快速开始

```sh
npm install
npm run build                  # 输出到 dist/chromium 和 dist/firefox
node scripts/build.mjs --dev   # 开发构建：全站权限、source map 和测试钩子
```

- **Chromium**：打开 `chrome://extensions`，开启开发者模式，加载 `dist/chromium`
- **Firefox**：打开 `about:debugging#/runtime/this-firefox`，加载 `dist/firefox/manifest.json`

文档：[架构](docs/architecture.md) · [文件与 Fetch](docs/files.md) · [开发](docs/development.md) · [已知限制](docs/limitations.md)

## 许可

[MIT](LICENSE)
