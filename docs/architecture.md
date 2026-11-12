# 架构

Oshawott 把 Agent 核心、浏览器操作、用户界面和页面 DOM 拆成四个组件，组件之间通过 chord 远程对象通信。共享契约位于 `src/contracts/`。

| 组件 | 职责 | 运行位置 |
|:-:|:-:|:-:|
| **Engine** | 对话、模型、工具、文件和凭据 | Chromium offscreen 文档；Firefox 事件页 |
| **Broker** | 标签页、页面脚本注入和定时唤醒 | Chromium Service Worker；Firefox 事件页 |
| **Panel** | 侧边栏中的对话、设置和文件界面 | Chromium side panel；Firefox sidebar |
| **Page** | 页面工具的 DOM 实现 | 按需注入标签页 |

## 边界

`src/` 按运行位置、组件职责划分：
- `entries/` 启动并组合组件
- `contracts/` 定义跨组件的序列化契约
- 跨组件调用通过 `contracts/` 中定义的主机和引用进行

## 连接

箭头表示调用方向，连线上是 Port 名称。Firefox 中 Engine 与 Broker 同在事件页，直接在内存中连接。

```mermaid
flowchart LR
    Panel["Panel<br/>对话 · 设置 · 文件"]
    Engine["Engine<br/>Harness · 模型 · 工具"]
    Broker["Broker<br/>标签页 · 注入 · alarm"]
    DB[("IndexedDB<br/>对话 · 文件 · 凭据")]

    subgraph Tab["标签页"]
        Page["Page<br/>DOM 读写"]
    end

    Panel -- "oshawott:panel<br/>Workspace · Chat" --> Engine
    Engine -- "oshawott:broker<br/>Browser" --> Broker
    Engine -- "oshawott:tab<br/>Page" --> Page
    Broker -. "注入 page.js" .-> Tab
    Engine --- DB
```

## 一次页面工具调用

```mermaid
sequenceDiagram
    participant P as Panel
    participant E as Engine
    participant B as Broker
    participant T as Page

    P->>B: ensure-engine 消息
    B->>E: 按需启动（Chromium 创建 offscreen 文档）
    Note over E: 取得 Web Lock，打开存储，Harness resume()
    P->>E: 连接 oshawott:panel，发送提示词
    E->>B: attach(tabId)
    B->>T: 注入 page.js
    T->>E: 连接 oshawott:tab
    E->>T: page_snapshot / page_click …
    E-->>P: 对话状态随 Durable 更新
```

后台被回收时，Broker 用 alarm `oshawott:wake` 唤醒 Engine，Harness 从最后一次提交继续运行。
