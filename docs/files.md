# 文件与 Fetch

每个对话有独立的文件区，模型通过工具和 Code Mode 处理它，用户从面板下载结果。

文件保存在扩展私有的 IndexedDB 中，Chromium 与 Firefox 使用同一份实现。

## 模型的工具

| 工具 | 用途 | 重放 |
|:-:|---|---|
| `read` | 普通文件预览，长文本可按行分段；单行预览最多 50 KiB | safe |
| `read_text` | 仅供程序调用的完整文本分段读取，单次最多 1,000,000 个 UTF-16 码元 | safe |
| `write` | 写入文本文件，自动创建父目录，覆盖已有内容 | unsafe |
| `edit` | 以唯一的精确匹配修改文本，参数为 `path` 与 `edits` 数组 | unsafe |
| `ls` | 递归列出目录、文件和大小，最多 1000 项 | safe |
| `fetch` | HTTP(S) 请求，返回文本预览或保存完整响应字节 | unsafe |

前三个复用 pi-durable 的工具。`ChatFiles` 实现其 `ExecutionEnv` 接口，默认目录 `/workspace`；路径是 POSIX，每个对话有自己的根目录。没有 shell、符号链接、gitignore 或变更通知，`exec` 返回 `shell_unavailable`。

Code Mode 通过同一批工具访问文件。`read_text` 不直接提供给模型，而在程序侧返回 `{text, offset, nextOffset, totalChars, eof}`；默认 UTF-8，可指定 TextDecoder 的编码标签，去掉开头的 BOM。不要在分段读取期间并发改写同一文件。例如：

```js
const response = await tools.fetch({
  url: "https://example.com/data.json",
  saveTo: "data.json",
});
const parts = [];
for (let offset = 0; ; ) {
  const chunk = await tools.read_text({ path: "data.json", offset });
  parts.push(chunk.text);
  if (chunk.eof) break;
  offset = chunk.nextOffset;
}
const data = JSON.parse(parts.join(""));
await tools.write({
  path: "summary.md",
  content: `# Summary\n\n${data.items.length} items.\n`,
});
return { status: response.status, files: await tools.ls({}) };
```

Worker 结束不会删除这些文件。Code Mode 自己生成的临时输出在 `/tmp`，不显示在文件面板；希望用户下载的文件应写在 `/workspace`。`read` 对长文件返回有上限的预览，不应把截断的 JSON 当成完整数据解析；大单行也应改用 `read_text`，不必把整块数据塞回模型上下文。

## Fetch 的权限与限制

- Engine 先通过 Broker 的 `Browser.hasAccess` 检查 host 权限。与页面授权共用 `sitePattern()`：例如 `https://example.com:8443/path` 对应 `https://example.com/*`，覆盖该协议、主机的所有端口，不覆盖其他主机或协议。
- 清单内的模型 API 域名已有 host 权限，其他站点由用户授权。未授权调用在发送网络请求、写入文件前失败。
- 支持 GET、POST、PUT、PATCH、DELETE、HEAD，以及显式的请求头和文本请求体；不会自动带上浏览器 cookie 或登录态，使用 `no-store` 与 `no-referrer`。
- 请求和响应读取受 60 秒超时控制。响应最大 20 MiB，超过时取消读取；`saveTo` 只在完整响应读完后写入，不会把半截响应覆盖到目标文件。
- 有 `saveTo` 时保存完整字节，文本和二进制都可；否则返回状态和文本预览（默认 20,000 字符），二进制响应只显示说明。HTTP 错误状态也会返回给模型，不自动视为工具异常。
- **重定向被拒绝**，请直接提供最终 URL。浏览器的手动重定向可能是不透明响应，无法可靠地先取得目标再检查权限；自动跟随会绕过逐站授权，所以使用 `redirect: "error"`。
- 所有 fetch 都按 unsafe 处理：即使是 GET，也可能保存或覆盖文件；授权按钮不会自动重跑已经失败的请求，用户应再发消息让模型重试。

## 文件面板

当前对话打开后，右上角的文件按钮可打开文件面板：

- 列出 `/workspace` 下的文件，显示相对路径、大小、修改时间。
- 通过 `Chat.readFile` 读取字节，生成 `application/octet-stream` Blob 下载，不在扩展内渲染文件内容。
- 删除文件需二次确认，成功后刷新列表。
- 打开、手动刷新及任务结束时更新，不随每个流式片段轮询。切换对话会关闭面板；旧请求不能更新已关闭或较新的列表。
- fetch 未授权时，工具卡片直接显示「允许访问此站点」按钮。权限请求在点击事件里同步发起，兼容 Firefox 的用户手势要求。

`Chat.files`、`readFile`、`removeFile` 仅服务面板；读取和删除在规范化路径后拒绝 `/workspace/` 外的路径。

## 存储与恢复

`src/engine/files.ts` 定义文件环境和 `FileBackend` 事务接口；`files-idb.ts` 是真实后端，`MemoryFileBackend` 用于测试。数据库 `oshawatt-files` 把元信息和字节分开，以 `[conversationId, path]` 为键，列目录不用加载文件内容。

单文件最多 20 MiB，总容量受浏览器配额限制。同一浏览器配置、同一扩展 ID 下，Engine 重建或浏览器重启后文件仍在；清除扩展存储或卸载会丢失。重置对话上下文不会清除文件，移除对话会清除其文件；Durable 的对话记录仍保留，见 [已知限制](limitations.md)。

删除时先在 `WorkspaceDoc` 同一提交里移除对话并记录 `pendingFileDeletes`，再停止包括后台任务在内的工作、清文件、确认完成。中断或清理失败会保留意图，Engine 启动时重试；持续失败只报告错误，不丢掉意图，也不妨碍其他对话。面板调用和输入提交在当前工作区检查活动对话，提交时再次检查以挡住删除竞态；模型的文件环境在每次操作前也检查，旧引用和旧环境不能重新创建被删除的文件。

文件操作有自己的原子事务，但**不与 Durable 的对话提交原子绑定**：一次 unsafe 调用被中断时，文件可能已写入而工具结果还没提交。模型应先检查文件，不要假设副作用没有发生。

开发版演示模型收到网址后，会 fetch 保存下载、用 Code Mode 读取并写出 `.stats.json`，供两端冒烟测试使用。测试覆盖真实下载、文件隔离与删除、超过百万字符的单行分段读取、GET 302 / POST 307 不访问目标；Chromium 关闭 offscreen 后再次下载，Firefox 重开 IndexedDB 连接检查字节。原生权限弹窗的接受流程、真实模型 API、Firefox 事件页回收后的文件流程仍需额外验证。
