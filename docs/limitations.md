# 已知限制

## 尚未验证

- 第三方公网模型服务的兼容性；自动端到端测试使用本地 OpenAI 兼容服务，Anthropic Messages 与 OpenAI Responses 的发现路径有单元覆盖。
- 站点和自定义模型授权弹窗的完整人工流程（允许、拒绝、撤销授权）；自动测试覆盖权限请求及拒绝后的状态保护。
- Firefox 关闭侧边栏后的长时间任务、事件页被回收后的文件操作，以及 chord 心跳对 Chromium Service Worker 休眠的影响。

## 当前限制

- Panel 只显示 Durable view 窗口内的记录，不能加载更早的历史。
- fetch 不带登录态，也不跟随重定向。
- 移除对话后，Durable 中的原始对话记录仍会保留（pi-durable 1.5 没有删除接口）。
- 不会定期清理临时文件。
- Chromium 的 offscreen 文档空闲时不会自动关闭。
