# 文件

每个对话有独立的持久文件区，模型通过工具和 Code Mode 处理文件，用户从 Panel 下载结果

## 工具与路径

| 工具 | 用途 | 重放 |
|:-:|---|:-:|
| `read` | 文件预览，长文本按行分段；单行预览最多 50 KiB | safe |
| `read_text` | 程序专用完整文本分段读取，单次最多 1,000,000 个 UTF-16 码元 | safe |
| `write` | 写入文本并自动创建父目录 | unsafe |
| `edit` | 以唯一的精确匹配修改文本 | unsafe |
| `ls` | 递归列出目录与文件，最多 1000 项 | safe |
| `fetch` | 请求 HTTP(S)，返回预览或保存完整响应 | unsafe |

`src/engine/files.ts` 实现 pi-durable `ExecutionEnv`，默认目录为 `/workspace`；路径使用 POSIX 格式，每个对话有独立根目录

`read_text` 不直接暴露给模型，程序侧返回 `{text, offset, nextOffset, totalChars, eof}`，默认 UTF-8，可指定 TextDecoder 编码并去除 BOM

`/workspace` 中的文件显示在文件面板；Code Mode 临时输出放在 `/tmp`，Worker 退出不会删除文件。

## Fetch

- Engine 通过 `Browser.hasAccess` 检查 host 权限。页面工具与 fetch 共用 `sitePattern()`，按协议和主机授权，包含该主机的所有端口。
- 模型 API 域名已有静态权限，其他站点需用户授权；未授权请求在联网或写文件前失败。
- 支持 GET、POST、PUT、PATCH、DELETE、HEAD，以及显式请求头和文本请求体；使用 `no-store`、`no-referrer`，不自动携带 cookie 或登录态。
- 请求和响应读取限时 60 秒，响应最大 20 MiB。`saveTo` 只在完整读取后写入，不会用半截响应覆盖目标文件。
- 无 `saveTo` 时返回状态和文本预览，默认最多 20,000 字符；二进制响应只返回说明。HTTP 错误状态仍作为结果返回。
- 重定向一律拒绝，避免跳到未授权站点。所有 fetch 都标为 `unsafe`，授权后不会自动重跑失败请求。

## 面板与存储

文件面板列出当前对话 `/workspace` 下的路径、大小和修改时间，支持下载、手动刷新和二次确认删除。切换对话会关闭面板，过期请求不能覆盖新列表。`Chat.files`、`readFile`、`removeFile` 仅服务 Panel，并拒绝 `/workspace` 外的路径。

`src/engine/files-idb.ts` 使用数据库 `oshawatt-files`，元信息与字节分开，以 `[conversationId, path]` 为键。`MemoryFileBackend` 仅用于测试。`listFiles`、`ls` 与 Panel 列表共用 `ChatFiles.listTree` 的单事务元信息遍历，按路径段排序

- 单文件最大 20 MiB，总容量受浏览器配额限制。同一扩展 ID 下，Engine 重建或浏览器重启后文件仍保留。
- 重置对话上下文不清除文件；移除对话会清除文件，但 Durable 原始对话记录仍保留。
