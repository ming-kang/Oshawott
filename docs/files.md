# 文件与 Fetch

每个对话有一个独立的持久文件区。模型用工具和 Code Mode 处理文件，用户在 Panel 中下载结果。

## 工具

| 工具 | 用途 | 重放 |
|:-:|---|:-:|
| `read` | 预览文件，长文本按行分段，单行最多显示 50 KiB | safe |
| `read_text` | 只给 Code Mode 用：分段读取完整文本，每段最多 1,000,000 个 UTF-16 码元 | safe |
| `write` | 写入文本，自动创建父目录 | unsafe |
| `edit` | 替换唯一一处精确匹配的文本 | unsafe |
| `ls` | 递归列出文件和目录，最多 1000 项 | safe |
| `fetch` | 发送 HTTP(S) 请求，返回预览，或把完整响应存成文件 | unsafe |

- `src/engine/files.ts` 实现了 pi-durable 的 `ExecutionEnv`：路径用 POSIX 格式，工作目录是 `/workspace`。
- `read_text` 返回 `{text, offset, nextOffset, totalChars, eof}`，默认按 UTF-8 解码，可以指定其他 TextDecoder 编码，会去掉 BOM。
- 只有 `/workspace` 下的文件会显示在文件面板里。Code Mode 的临时文件放在 `/tmp`，Worker 退出后不会被删除。

## Fetch

- 请求前，Engine 先调用 `Browser.hasAccess` 检查权限。页面工具和 fetch 都用 `sitePattern()` 按协议和主机授权，该主机的所有端口都包括在内。未授权的请求在联网和写文件之前就会失败。
- 支持 GET、POST、PUT、PATCH、DELETE、HEAD，可以设置请求头和文本请求体。请求使用 `no-store` 和 `no-referrer`，不带 cookie。
- 不跟随任意重定向，避免被带到未授权的站点。GET / HEAD 被重定向时，只依次尝试同一地址的 https、`www` 和末尾斜杠形式：每个候选都重新检查权限，且只有成功的响应才被采用。
- 超时 60 秒，响应最大 20 MiB。设置了 `saveTo` 时，读完整个响应后才写入文件。
- 没有 `saveTo` 时返回状态码和文本预览（默认最多 20,000 字符）；二进制响应只返回说明。HTTP 错误状态码也作为正常结果返回。
- 所有 fetch 调用都是 `unsafe`，中断后不会自动重试。

## 面板与存储

- 文件面板列出当前对话 `/workspace` 下的文件，显示大小和修改时间，可以下载、刷新、删除（删除需要再点一次确认）。
- `Chat.files`、`readFile`、`removeFile` 只对 Panel 开放，拒绝访问 `/workspace` 以外的路径。
- `src/engine/files-idb.ts` 把元信息和文件内容分开存储，键为 `[conversationId, path]`。`ls`、`listFiles` 和文件面板共用 `ChatFiles.listTree`，在一个事务里遍历，按路径段排序。
- 单个文件最大 20 MiB，总容量取决于浏览器配额。只要扩展 ID 不变，文件在 Engine 重建和浏览器重启后都会保留。
- 重置对话上下文不会清除文件；移除对话会清除文件。
- 文件库和 Durable 无法在同一个事务里提交，所以删除分两步：先在 `WorkspaceDoc.pendingFileDeletes` 记录要删除的对话，再清理文件。Engine 启动时会继续处理没完成的删除。
