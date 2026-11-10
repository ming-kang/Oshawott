# 开发

## 环境与构建

```sh
npm install
npm run build                        # 两端普通构建
npm run icons                        # 从 static/icons 的 SVG 重新生成 PNG 图标
node scripts/build.mjs chromium --dev
node scripts/build.mjs firefox --dev
```

## 验证

| 命令 | 用途 |
|:-:|:-:|
| `npm run check` | TypeScript 类型检查 |
| `npm test` | Node 单元测试 |
| `npm run smoke:chromium` | 构建并用 Puppeteer 验证真实 Chromium |
| `npm run smoke:firefox` | 构建并用 WebDriver BiDi 验证真实 Firefox |

界面改动后运行：

```sh
node scripts/build.mjs chromium --dev
node scripts/screenshots.mjs [目录]   # 默认 dist/screenshots；OSHAWOTT_LANG=en 可切换英文
```

开发构建除演示模型外还注册 `Demo account`：一个只能账号登录的内置服务，显示设备码 `DEMO-1234` 后要求输入授权码 `demo`。冒烟测试用它走完 Engine 的登录会话和 Panel 界面，不需要真实账号。

## 调试

Engine 全局对象 `oshawott` 在普通构建中也可用：

- `await oshawott.page(tabId, "page_snapshot", {})`：调用页面工具。
- `await oshawott.codemode("return 1 + 1")`：直接执行 Code Mode，不经过 Harness 或对话工具。
- `oshawott.engine.harness`：Durable Harness。
- `oshawott.files(chatId)`：该对话的低层文件环境。

Chromium 在 `chrome://extensions` 的“检查视图”中打开 `engine.html`；Firefox 在 `about:debugging` 中检查扩展。日志前缀为 `[oshawott engine]`、`[oshawott broker]`、`[oshawott page]`、`[oshawott panel]`。
