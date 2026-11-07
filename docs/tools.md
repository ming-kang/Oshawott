# 工具

模型可用的能力：页面工具读取和操作标签页，浏览器工具管理标签页，Code Mode 运行模型写的 JS，演示模型供没有 API key 时试用。新增页面工具的步骤见 [开发](development.md#常见改动)。

## 页面工具

- **页面工具只在 `src/tools/page-tools.ts` 声明一次**：描述、参数、返回值、`replay` 策略写在一起。`Page` 契约和 Durable 工具都从这里生成；读操作（快照、滚动）是 `safe`，有动作的（点击、输入）是 `unsafe`。
- 每个页面工具都多一个可选参数 `tabId`。目标标签页的确定顺序：调用时指定的 `tabId` → 对话的 `TargetDoc` → 当前活动标签页。
- 元素引用（`ref`）只存在内容脚本内存里的 `WeakRef` 表中，不写进页面 DOM，页面脚本读不到也伪造不了；下次快照或页面导航后失效。

## 浏览器工具

- `tabs_list`：列出标签页。
- `tab_open`：打开标签页并把它设为对话的目标标签页。

## Code Mode

`RemoteCodemodeSandbox` 留在 Engine 里管理工具和调用记录，QuickJS 在专用 Worker 里运行，每次执行新建 Worker，结束即 terminate。不需要 SharedArrayBuffer，所以两端都能用；扩展 CSP 只额外放开 `wasm-unsafe-eval`。

Code Mode 脚本通过 `tools.read`、`tools.write` 等工具访问当前对话的持久文件区。大单行文本可用程序专用的 `tools.read_text({path, offset})` 按字符分段读取，不受普通预览的 50 KiB 限制，见 [文件与 fetch](files.md)。

## 演示模型

仅开发构建（`src/engine/demo.ts`）：基于 pi-ai 的 faux provider。一般问题调用 `page_snapshot`；消息带网址时则 fetch 保存下载，用 Code Mode 读取并写出 `.stats.json`，再给出 Markdown 回答。用于没有 API key 时试用界面及完整链路测试，正式构建不包含它。
