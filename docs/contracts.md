# 契约与连接

角色之间只通过 chord 对象通信：每个对象有一份契约（`src/contracts/`），chord 按契约检查参数和返回值。拓扑和连接建立的时机见 [架构](architecture.md#连接)，本篇是 Port 之上的细节。

## Port 连接

**`onConnect` 按 Port 名分流，并校验发送方**：

- `oshawatt:tab`：必须来自标签页的顶层 frame（`frameId === 0`）。
- `oshawatt:panel`：必须来自本扩展的 `panel.html`。
- `oshawatt:broker`：必须来自本扩展，且不能来自标签页。
- 其他名字直接断开。

两条一次性消息（`MESSAGES`）用来唤醒后台：`ensureEngine`（面板请求 Broker 确保 Engine 文档存在）和 `wakeBroker`（Chromium 上 Engine 请求 SW 连回来）。

**Port 上的 Link**（`src/link/port-link.ts`）：

- Chromium 的 Port 消息按 JSON 序列化，所以每帧用 base64 字符串传输。
- Port 事件没有缓冲，所以 Port 一到达就包成 Link，监听器设置之前到的消息排队。
- chord 独占 Link 的 `onClose`，所以 Link 另外暴露 `done`，供应用判断何时重连。

## 契约

全部定义在 `src/contracts/`，chord 按契约检查参数和返回值。

| 对象 | 所在宿主 | 调用方 | 内容 |
|---|---|---|---|
| `Workspace` | Engine | 面板 | state：`chats`、`defaultModel`、`providers`；方法：`createChat`、`deleteChat`、`setApiKey`、`clearApiKey`、`setDefaultModel` |
| `Chat({id})` | Engine | 面板 | state：`view`（Durable 的 `ConversationView`）；方法：`send`、`abort`、`reset`、`configure`、`entries`、`files`、`readFile`、`removeFile` |
| `Browser` | Broker | Engine | `listTabs`、`activeTab`、`openTab`、`attach`、`hasAccess`、`armWake` |
| `Page({tabId})` | Tab | Engine | `page_snapshot`、`page_click`、`page_type`、`page_scroll` |

## 身份与授权

身份（`Principal`）由接收连接的一方在 `accept` / `connect` 时标记，调用方不能自报身份：

- `Workspace`、`Chat` 只服务 `panel`，其他身份收到 `forbidden`。
- `Browser`、`Page` 只服务 `engine`。
- Engine 到 `BrokerHost`、`TabHost` 的 route 只放行 Engine 自己发起的 hold，所以面板不能借 Engine 访问标签页或浏览器 API（有单元测试覆盖）。
