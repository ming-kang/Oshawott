# 架构

Oshawatt 分为四个角色，通过 chord 对象通信。对话与运行状态由 Pi Durable 持久化，文件和凭据分别保存在独立 IndexedDB 中。

## 角色与连接

| 角色 | 职责 | Chromium | Firefox |
|:-:|---|---|---|
| **Engine** | Durable、模型、工具与持久状态 | offscreen `engine.html` | 事件页 `background.js` |
| **Broker** | 标签页、脚本注入与 alarms | Service Worker | 与 Engine 同一事件页 |
| **Panel** | 对话与文件界面 | side panel | sidebar |
| **Page** | 页面工具的 DOM 实现 | 按需注入 `page.js` | 同左 |

角色实现共用，浏览器差异集中在 `src/entries/`。Chromium 的 offscreen 文档提供 Worker 和长时间流式请求所需环境，但只有 `runtime` API，因此浏览器能力由 Broker 提供。

| 连接 | 建立方式 | 暴露对象 |
|---|---|---|
| Panel ↔ Engine | Panel 打开时连接 `oshawatt:panel`，断开后重连 | `Workspace`、`Chat({id})` |
| Broker ↔ Engine | 需要浏览器能力或 alarm 唤醒时连接 `oshawatt:broker` | `Browser` |
| Page ↔ Engine | Broker 按需注入后连接 `oshawatt:tab` | `Page({tabId})` |

契约集中在 `src/contracts/`。Engine 是唯一注册 `runtime.onConnect` 的上下文，并按 Port 名称、发送方和 frame 校验连接；`ensureEngine` 与 `wakeBroker` 两条一次性消息负责唤醒后台。

`src/link/port-link.ts` 处理 Chromium Port 的 JSON/base64 帧、监听器安装前的消息排队和关闭通知。chord 独占 Link 的 `onClose`，应用通过 `done` 判断重连。

## 状态

| 存储 | 内容 |
|---|---|
| IndexedDB `oshawatt` | Durable 对话与运行状态；`WorkspaceDoc` 保存对话列表、默认模型和待删除文件意图；`TargetDoc` 保存对话的目标标签页 |
| IndexedDB `oshawatt-files` | 每个对话独立的目录树，元信息与字节分开，键为 `[conversationId, path]` |
| IndexedDB `oshawatt-credentials` | 模型 API key，仅 Engine 读写 |
| Panel `localStorage` | 主题 |

Panel 通过 `self.follow` 直接观察 Durable state，不维护第二份对话副本。提供商列表及 key 是否配置是 Engine 内存状态，在 Panel 连接或修改 key 时刷新。

## 生命周期

1. Panel 请求 `ensureEngine`，随后连接 Engine。
2. Engine 获取 Web Lock `oshawatt:engine`，打开存储并执行 `Harness.open()`、`resume()`，再接入 Panel。
3. 页面工具需要标签页时，Engine 经 Broker 注入 Page，并等待其 Port 建立 route。

Durable 通过 `onWake` 请求后续运行，Broker 用 alarm `oshawatt:wake` 在后台回收后唤醒 Engine。运行中每 60 秒心跳，有定时任务时取更早时间，无任务时清除 alarm。

重启后从最后一次 Durable 提交继续。工具调用在执行前记录意图：只有 `replay: "safe"` 的调用会自动重跑，`unsafe` 调用中断后返回 `interrupted`，避免重复副作用。文件事务不与 Durable 提交原子绑定，详见[文件与 Fetch](files.md)。

## 边界与关键约束

- `Workspace`、`Chat` 只服务 Panel；`Browser`、`Page` 只服务 Engine。Panel 不能借 Engine route 访问浏览器或页面对象。
- 页面脚本运行在 isolated world，按需注入。元素 `ref` 只保存在 Page 内存的 `WeakRef` 表中。
- 页面工具规格只在 `src/tools/page-tools.ts` 声明；读操作标 `safe`，会修改页面的操作标 `unsafe`。
- Code Mode 在独立 Worker 的 QuickJS WASM 中运行，通过受控工具访问当前对话文件，没有 shell。
- 普通构建只静态声明模型 API 域名，其他站点由用户授权；开发构建额外声明 `<all_urls>` 供自动测试使用。
- fetch 在请求前检查 host 权限，不携带浏览器 cookie，不跟随重定向。
- API key 只进入 Engine。Panel 不插入模型或网页的原始 HTML，Markdown 由解析树创建 DOM，链接仅允许 `http(s):` 和 `mailto:`。
- Panel 文件操作只能访问当前对话的 `/workspace`；不同对话的文件互相隔离。
