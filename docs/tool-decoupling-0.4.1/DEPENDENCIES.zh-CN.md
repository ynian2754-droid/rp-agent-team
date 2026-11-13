# 0.4.1 依赖变化与仍需宿主提供的能力

本次减少的是**成员对产品模型工具的依赖**，没有把完整插件改成干净 ElecKoi 0.2.8 的插件。正式运行仍固定 ElecKoi 0.2.4 / 088c2c25135fbcc1890df4d0941987d5e87e9f8f 及其累计补丁，DSH 0.2.0-rc.2。

## 统计口径

基准源码为改动前仓库 HEAD `ee6d43a90aaa534e6a635df97b0fd4dd3856db6b`，不是把 README 中出现过的名字全部当作实际依赖。

| 口径 | 0.4.0 | 0.4.1 |
| --- | ---: | ---: |
| 有实际产品实现、曾供成员执行的数据／RP 计划工具种类 | 10 | 0 |
| Runtime／native-policy 中独立产品工具名引用 | 20 | 10，全部用于拒绝或旧 capability 归类 |
| 没有实现的旧名称、桥名称或 probe 特例 | 10 | 0 |
| 新增 Team 资料工具 | 0 | 3 |
| 新增 Team 状态删除工具 | 0 | 1 |

10 个原产品工具为：设定 glob/grep/read/apply_patch 四种，变量 glob/grep/read/apply_patch 四种，read_uploaded_file 和 update_roleplay_plan。并非每轮都必须调用这十种；该统计表示此前交给原生产品工具完成的操作面。零依赖指成员不需要这些工具声明及执行来完成资料和状态操作，不表示它们的字符串从源码完全消失。

清理的十个名称：eleckoi_create_setting_file、update_setting_file、delete_setting_file、move_setting_file；eleckoi_web_search、native_web_search_bridge；eleckoi_list_toolsets、describe_toolset、call_capability；eleckoi_capability_probe。它们此前被分类或豁免，不是十项实际功能。

现在 HOST_PRODUCT_TOOLS 列出十个已知拒绝名称；执行 guard 另外拒绝全部 eleckoi_*。这不是用 deny list 隐藏依赖：原生夹具中未声明这些工具，仍实际完成读取、搜索、分页附件、世界变量写入、共享字段删除和正式正文提交。

## 代码路径改变

旧路径：成员原生产品工具 → 成员桥目录变量／设定文件 → `runtime.mjs:stageNativeBranchChanges` → StateStore 暂存 → Host 正式提交。

新路径：宿主准备成员输入 → `agent-context.mjs` Context/State 投影 → `context-tools.mjs:registerContextTools`／`team-tools.mjs:registerTeamTools` → StateStore 暂存 → **相同的** Host 正式提交。

`stageNativeBranchChanges`、activationBases、stageStateChange/Removal 及其 diffLeaves、canWriteNativeNamespace 死辅助函数已删除。宿主投影目录仅作为原生请求输入，writePaths 为空，不再从中提取成员修改。世界状态修改只有 Team State 一条链。

`native-policy.mjs:restrictMemberTools` 同时限制模型声明和真实执行，应用于调度成员、嵌套成员与恢复作用域。即使当前 schemas 为空也安装 guard。普通根会话不安装这项成员限制；隔离停用测试确认它仍能得到宿主变量工具。

## 仍然存在的 Host Service 依赖

| 能力／当前接口 | 调用点 | 为什么本次保留 |
| --- | --- | --- |
| 正式聊天准备与原生交付：eleckoiRuntimeExtensions.register、recordLocalDelivery | index.mjs、runtime.mjs、native-service.mjs | 冻结本轮资料、接入成员请求投影、交付唯一正式正文及恢复；本次没有替换正式 Runtime 链 |
| 产品状态与回执：eleckoiStoryState.snapshot/prepare/stageProductCommit/commitProductTurn/settleProductCommit/getProductCommitStatus、begin/endConversationWork | runtime.mjs、author-state.mjs、trial-worker.mjs | 世界状态校验、正式保存、锁定并发操作、幂等结算和检查点恢复，不能用独立数据库写入冒充与本轮共同提交 |
| 更新通知：eleckoiConversationChanges.publish | index.mjs | 作者状态修改后刷新产品视图 |
| 试演冻结和 seed：eleckoiTrialSnapshots.freeze/seed/getHostRoot/captureModelProviders/captureAgentPresets | trials.mjs、trial-worker.mjs | 独立环境准确复现资料、附件、模型与 preset；本次没有公开化整个快照协议 |
| 正常聊天入口：eleckoiConversationsApi.preparePrompt、归档／查询等 | trial-worker.mjs、官方样例及验证夹具 | 使用宿主正式聊天生命周期，不能手写 Session 日志 |
| 统一轨迹与导航：eleckoiTrajectory.registerSource/renderSnapshot、eleckoiConversations.openTrajectory | src/client/trajectory-source.js、entry.jsx 等客户端模块 | 成员原生 Session 关联、统一列表及试演轨迹组件；本次保持现有宿主扩展 |

DSH 的 agents、agentPresets、agentTeams、subagents、sessions、tools、llm、credentials、scope、attachments 继续使用。新增附件服务属于官方 DSH 能力，不是 ElecKoi 模型工具。模型凭据不通过新的资料工具暴露。官方右侧工作区、Typert Remote 和已有 Slots 也保留。

试演原先直接查询 eleckoiProductData.getProductCommitStatus 的调用改用已有 eleckoiStoryState 回执接口，减少一处产品内部服务耦合。没有改动产品数据库结构，数据库仍为版本 10。

## 干净官方宿主的验证边界

另一个明确独立的对象是 examples/official-tool-team（0.1.0 两成员样例），运行于干净官方 0.2.8 / d4b6bb949771693cd357ddd535ead22f4e835774。

它通过 agent/pre-step、Session 事件、agentTeams、Conversations.authorState/details/changes 做资料读取、成员工具、消息、候选汇总和插件私有状态。根 Agent 正常请求本地模型并发布；它没有注册 prepare、afterSave、prepareRestore。

该样例验证普通协作可不使用三个回调，并复现产品变量的具体缺口。它不证明完整 0.4.1 的机器强制交付、预算、试演、融合轨迹和产品状态崩溃恢复已经完成公开接口迁移。不会提前删掉正式提交桥。

## 安装形式的一处实测修正

目录链接与正常插件归档不是等价验收。官方样例从源码目录链接安装时，scopeOf 无法得到目标宿主作用域；`.tgz` 安装正常。正式试演把外层已安装目录再次链接到新 profile 时，也无法正确解析该 profile 的 DSH peer。

0.4.1 试演将**当前已加载插件代码**打成临时归档，再经官方插件管理器安装到每个独立空间；不重新构建源码，不使用另一个开发目录，不复制外层依赖或产品数据库。官方验证脚本要求显式 --bundle；避免把目录链接的偶然可用当作正常安装证据。
