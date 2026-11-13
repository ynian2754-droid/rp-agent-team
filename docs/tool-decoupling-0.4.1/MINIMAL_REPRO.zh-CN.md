# 产品变量如何加入正式 turn：0.4.1 实测最小复现

目标：干净官方 ElecKoi 0.2.8 / d4b6bb949771693cd357ddd535ead22f4e835774，不应用 host-patch；使用公开 Conversations API 和原生 Session。

建立合成角色与会话，变量初值 `score = 1`。成员通过私有工具读取授权资料，提交结构化结果 `score = 2`，普通根 Agent 负责唯一正文。正式产品流程和日志均交给宿主。

## 生成期间写入

1. Conversations.preparePrompt 后通过 sessionController.prompt 开始正常回合。
2. 根工具等待成员完成，通过 `Conversations.replaceVariableState(conversationId, ...)` 将 score 改为 2。
3. 数据库公开读取已能看到 2；让根 Agent 正常完成并等待产品 generation 保存。
4. 产品报错“生成期间聊天变量已被其他操作修改，未覆盖当前变量。”

实际：独立写入成功，但打破本轮原生保存的变量基值检查。期望：经过校验的工具状态能作为**本轮工作状态**在保存正文时共同形成变量检查点；并发的独立作者编辑仍应有冲突检测。

## 正文保存后写入

1. 正常完成并保存根正文，此时 current 和对应 floor 都是 score = 1。
2. 通过 replaceVariableState 将 score 改为 9。
3. 公开 authorState／变量历史读取：current = 9，已有 floor 仍 = 1。
4. 使用公开 deleteMessagesFrom 删除该正式正文，读取变量得到 1。

实际：保存后写入只更新 current，没有加入被删除正文对应的历史检查点。期望：归属于该 turn 的变量结果能被其重生成／回退／删除一起正确恢复；独立作者编辑应继续有自己的明确归属。

本次没有更改该 API 或通过手写数据库／日志绕过。examples/official-tool-team/runtime.mjs 中 productWriteTiming 的 during／after 两分支，以及 scripts/verify-official-tool-team.mjs 的对应场景，可用本地 LlmAdapter 重现。最新真实结果在 evidence/official-results.json，两条场景的 actual 和 productError／beforeHistory／afterHistory 给出数据证据。

该需求是一个产品 turn 状态交付／提交语义，不要求官方实现 RP Team 调度、记忆、预算或专有工具。完整 0.4.1 继续使用既有正式提交与恢复桥；普通协作无需三个回调的样例保持独立。
