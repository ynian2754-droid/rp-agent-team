# 不使用三个聊天回调的两成员团队工具

这是对《以团队工具为中心的 ElecKoi 插件接入说明》的可运行验证样例，包名 `@rp-team/official-tool-team`，版本 `0.1.0`。它放在 RP Agent Team 仓库中，但**不是现有 0.4.0 插件的替换发布版**。

目的：先用真正的公开接口证明“专门工具 → 原生成员 → 有限资料读取 → 原生通信 → 汇总 → 普通聊天输出 → 插件结果保存”可以工作，再准确定位产品变量保存的问题。

## 已验证的基线

- ElecKoi Desktop 0.2.8，源码 `d4b6bb949771693cd357ddd535ead22f4e835774`。
- DSH `0.2.0-rc.2`，锁定源码 `c1b47e41fcd54d20a0f061df28683bfc29ee24e5`。
- 原始说明中的 ElecKoi SHA `080fc027c44d5ad2f720fa312513acee3efe63d5` 在核对时无法从官方仓库取得，不能把本次结果归给它。

使用官方干净源码，未应用 `host-patch`。安装仍需要宿主启用官方实验性 Agent Team profile，以提供 `agentTeams` 和官方团队面板；仅安装本样例不会凭空启用这些服务。

## 工具合同

根 Agent 看见 `rp_team_run {}`。输入不是模型自由指定的数据库路径或 conversation ID，而是由 Host 绑定配置，并由 `agent/pre-step` 捕获当前真实用户消息。

| 项目 | 本样例规则 |
| --- | --- |
| 身份 | conversation ID、root Session ID、用户消息 ID、原生 turn、插件 run ID、成员稳定 ID、真实 child Session ID分别记录 |
| 成员 | 正好两名，各自模型和提示词由配置决定；名称不是底层类型 |
| 请求 | 每名成员新建原生 Session，`context: fresh`，使用官方团队登记 |
| 工具 | 只有授权读取、发送消息、提交结果三个自建工具可执行 |
| 汇总 | 两名成员均完成并提交后，检查修改键冲突，返回指定成员的正文候选和结果 |
| 输出 | 由普通根 Agent 接收候选并走正式聊天输出；插件不拼写日志，不直接插入 assistant 正文 |
| 成功 | 工具完成与产品保存成功分别记录；私有修改只有产品成功通知且正式输出 ID 存在时生效 |
| 失败／取消 | 取消并排空成员，保留失败记录，私有修改不进入有效状态 |
| 恢复 | 用有效根 Session 的 assistant 消息 ID筛选已提交私有修改；删除／重生成淘汰的输出不再贡献状态 |
| 重启 | 已提交记录恢复；中断中的 `running/awaiting-publication` 标为 `unknown`，不自动重跑模型 |

它没有注册 `prepare`、`afterSave` 或 `prepareRestore`，也不注入 `eleckoiConversationLifecycle`。

调用公开的 `preparePrompt` 是正常产品生成准备，不等于注册 `prepare` 回调。宿主内部如何保存、恢复仍由宿主负责。

## 成员工具

- `rp_tool_read {}`：读取 `authorState` 和 `details`，返回当前输入、允许的角色字段、变量路径、设定条目和可选私有状态。角色和变量使用 JSON Pointer；设定按稳定条目 ID过滤。
- `rp_tool_send {to, body}`：检查配置的接收者，等待原生目标登记完成，再使用 `agentTeams.sendMessage`。真实消息进入目标 Session。
- `rp_tool_submit {summary, privateDelta?, productDelta?}`：限制可写键，暂存结果。提交不等于向用户发布。

成员的原生继承工具先限制可见范围，再通过 `tools.guard` 拒绝猜测调用。嵌套和恢复成员同样应用限制。实际模型请求会被测试，而不只是检查最初传入的 prompt。

## Host 绑定示例

安装后由另一个 Host 插件或调用方显式绑定，不提供新的产品页面或 Remote。调用方需要 `rpOfficialToolTeam` 服务。

```js
ctx.rpOfficialToolTeam.bind(conversationId, {
  publisherId: 'speaker',
  productWriteTiming: 'none',
  members: [
    {
      id: 'noticer', description: '有限观察',
      systemPrompt: '读取允许资料，向 speaker 发送简短观察，再提交结果。',
      model: { provider: 'YOUR_CONFIGURED_PROVIDER', model: 'YOUR_MODEL' },
      characterPaths: ['/assistant_name'], variablePaths: ['/attention'],
      settingIds: ['SETTING_ID'], sendTo: ['speaker'],
      writePrivateKeys: ['lastObservation'], writeVariableKeys: [],
    },
    {
      id: 'speaker', description: '角色表达',
      systemPrompt: '只依据允许资料和收到的观察提交短正文候选。',
      model: { provider: 'YOUR_CONFIGURED_PROVIDER', model: 'YOUR_MODEL' },
      characterPaths: ['/assistant_name'], variablePaths: [], settingIds: [],
      readPrivate: true, writePrivateKeys: ['lastExpression'],
    },
  ],
})
```

省略 `model` 时使用原生继承行为。示例中的 `observer/actor` 是测试配置的 ID，并非框架限定角色。

插件自有文件默认位于 `DSH_HOME/plugins/rp-team-official-tool/journal.json`。可通过 bundle 配置设置 `journalPath`。文件只保存插件记录，不读写产品 SQLite。配置绑定本身需要调用方在每次加载时恢复；本样例不新增配置库。

## 如何复验

准备上述精确提交的干净 ElecKoi 源码，安装锁文件依赖，构建 `build:workspace-runtime`；让 `better-sqlite3` 对当前 Node ABI 可用。使用与实际聊天完全不同的空目录作为 `--data`。

从 RP Agent Team 仓库根目录运行：

```powershell
node --test tests/official-tool-team.test.mjs
node scripts/verify-official-tool-team.mjs --host 'ABSOLUTE_CLEAN_HOST_PATH' --data 'ABSOLUTE_NEW_TEST_DATA_PATH' --bundle 'ABSOLUTE_SAMPLE_TGZ_PATH' --uninstall
node scripts/verify-official-tool-team.mjs --host 'ABSOLUTE_CLEAN_HOST_PATH' --data 'THE_SAME_TEST_DATA_PATH' --reopen
```

`--bundle` 可省略，届时通过官方插件管理器安装本目录。`--uninstall` 验证停用、卸载和再次安装，保留原生日志及私有记录。

夹具注册本地确定性模型适配器，真正执行 DSH Agent Loop、工具调用、团队通信、Session 持久化及产品 SQLite保存。没有外部模型请求，也没有付费消耗。`results.json` 保存真实请求输入和记录，`reopen-results.json` 验证独立进程重启；其中只有合成角色与测试资料。

可增加 `--ui --native-ui` 查看官方 DSH 面板；测试 profile 暂时关闭需要桌面资源协议的 ElecKoi Client Shell，不修改宿主源码。页面最多保持 180 秒，写入测试目录的 `ui.done` 可提前结束。这个检查不代表完整 Electron 桌面界面已经验收。

## 已复现的产品变量限制

`productWriteTiming: 'during-tool'` **仅用于复现，不用于正式聊天**：

1. 从公开接口读到 `score=1`。
2. 工具完整替换当前对象为 `score=2`，保留其他键。
3. 重新读取确实得到 2。
4. 正式保存发现基值发生变化并报错：`生成期间聊天变量已被其他操作修改，未覆盖当前变量。`
5. 数据库中的 2没有自动撤销，插件私有修改没有提交。

另一个测试在正文已保存后把当前变量替换为 9：读取及重启均能确认写入；原楼层快照没有变化，删除正文恢复为原来的 1。这是当前变量与本轮历史的一致性问题，**不能表述为没有变量写入接口**。

## 本样例的明确边界

- 当前普通工具路线由根模型决定是否调用团队工具、是否照用候选。它没有验证“任意选定 child 的文本必须原样成为唯一正文”的强制发布协议。
- 私有状态采用“成功通知 + 正式输出 ID”规则，不是与产品数据库的跨存储事务。通知到达前崩溃的结果保留为未知，不自动补提交。
- 当前输入和产品读取已验证；完整历史遍历、附件、任意 Agent preset、压缩、所有复杂 schema 校验没有在本样例中宣称通过。
- 不实现完整 V2 调度、事件、预算、记忆集合、统一跨成员轨迹或 A/B 试演；这些属于后续插件迁移工作。
- 正式产品变量跟随 turn提交与回退的语义仍有上述实际卡点。不能因为普通团队协作成功，就宣称现有 0.4.0 全部功能已经无补丁兼容。

接口证据、执行结果、最小复现和剩余问题见 `docs/official-tool-integration/VERIFICATION.zh-CN.md`。
