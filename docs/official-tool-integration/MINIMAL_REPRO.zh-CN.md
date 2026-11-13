# 最小复现：自建工具的变量写入与正式保存

目标版本：ElecKoi `d4b6bb949771693cd357ddd535ead22f4e835774`，Desktop0.2.8；DSH0.2.0-rc.2。使用公开 API，不注册三个聊天回调，不直接操作产品数据库。

## 复现 A：生成中写入成功，正式保存随后失败

1. 用公开角色配置和 Conversation API创建一份初始变量为 `{score:1}`的聊天。
2. 通过公开 `preparePrompt`及原生 `sessionController.prompt`开始生成。
3. 在自建工具执行期间运行：

```js
const current = JSON.parse(ctx.eleckoiConversationsApi.authorState(id).currentVariableStateJson)
const saved = ctx.eleckoiConversationsApi.replaceVariableState(id, JSON.stringify({ ...current, score: 2 }))
const reread = JSON.parse(ctx.eleckoiConversationsApi.authorState(id).currentVariableStateJson)
// saved和reread都确认写入2。
```

4. 让根模型通过正常 Agent Loop产生正文，等待产品 `waitForGeneration(id, operationId)`。

**实际：** 正文存在于原生 Session，数据库读回2，但产品保存报“生成期间聊天变量已被其他操作修改，未覆盖当前变量。”。该工具写入没有自动回滚。

**期望：** 存在公开用法把工具计算后的变量放进本轮 working state，由正式保存统一进行校验、冲突检查和检查点记录；失败／取消不遗留本轮未提交的 current修改。若 `replaceVariableState`仅作为独立作者编辑，则它应该明确拒绝生成中操作，并另有适用于本轮工具的路径。

## 复现 B：保存后独立写入未进入已存在的历史楼层

1. 让一轮正常保存，score仍为1。
2. 保存 `before = await variableTimeline(id)`。
3. 公开替换当前值为9并重读，确认9。
4. 读取 `after = await variableTimeline(id)`；`before.floors`与`after.floors`一致，楼层值仍为1。
5. 调用公开 `deleteMessagesFrom(id, savedAssistantEventSeq, 'assistant')`。

**实际：** 当前值恢复1。独立写入9本身可持久化，但不属于此前楼层的检查点。

这可能是独立作者编辑接口的合理设计；问题是它无法用来实现“本轮工具状态随本轮一起提交”。不要求为了这个用例改变所有作者编辑语义。

## 可直接运行的完整复现

运行仓库 `scripts/verify-official-tool-team.mjs`，使用样例 README中的 `--host`和全新 `--data`。本地可控模型真实执行工具和原生保存，费用为0。输出中的 `during-generation-variable-write`与`after-save-variable-write`分别记录上述结果和楼层前后快照。

工具内部筛选、计算、冲突汇总和权限已经由插件完成；卡点是正式产品保存使用此前冻结的变量基值，而公开替换只改 current数据库对象。插件不能通过重新读 current或重复调用replace把这两个存储时机变成同一次正式提交；也不应直接写 Host内部快照文件或数据库表。

需要维护者确认的只有：现有正式公开能力是否已有“向当前 turn交付变量结果”的正确路径；如果没有，最小通用调整应是什么。不请求宿主实现团队业务。
