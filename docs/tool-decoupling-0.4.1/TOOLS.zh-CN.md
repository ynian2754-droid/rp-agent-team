# 0.4.1 团队数据工具合同与作者迁移说明

0.4.1 的成员不再调用 ElecKoi 产品工具。聊天资料由宿主准备一次，成员通过自己的 Context 选择和 State 权限取得数据。工具查询只发生在这个成员已获准的数据内，不回到完整角色卡、历史或世界状态中补字段。配置格式仍为 schemaVersion 2。

## 读取与搜索

### rp_team_read_context

输入：`{ source: string, path?: string }`。source 使用配置中的类别：current_input、recent_history、full_history、character_card、worldbook、long_memory、scene_state、agent_messages、drafts、hidden_state。

输出：存在时 `{ found: true, value: ... }`，路径不存在时 `{ found: false }`。没有授权的类别返回 `RP_TEAM_CONTEXT_FORBIDDEN`。

path 是**经过过滤后的结果**中的 JSON Pointer，空字符串读整个可见结果。不是完整资料的原路径。例如只选择 `/persona/name` 时，该类别的结果可能就是姓名字符串，应以空路径读取；同时选择多个字段时，结果保留授权字段的结构。工具不改变原有 selector 的投影规则。含 `/`、`~` 的字段名分别用 `~1`、`~0` 转义；非法转义返回 `RP_TEAM_INVALID_REQUEST`。不能使用 `../`、磁盘路径或其他类别绕过限制。

agent_messages 同时经过接收 ACL、收件人和来源成员筛选；drafts 同时经过草稿共享范围、接收 ACL 和来源选择。world/scene/memory 类状态先经过声明和 State ACL，之后才应用 Context selector。有读取权的成员能看到本轮暂存修改；未授权状态不会出现在查询结果中。

### rp_team_search_context

输入：`{ source, query, limit? }`。query 必须是非空文字；忽略大小写，进行字面匹配，不运行正则或代码。limit 默认 20，范围 1～100。

输出：`{ matches: [{ path, value }] }`，搜索已过滤结果中的字符串值。path 可以直接用于 read_context；不返回隐藏字段路径、隐藏匹配数或完整数据的命中总数。没有结果返回空数组。若需比较数字或状态条件，使用 read_state／声明式触发规则。

### rp_team_read_attachment

输入：`{ index: integer, offset?: integer }`。index 是**原始本轮输入**的零基附件编号，过滤之后不重新编号。offset 是字节偏移，默认 0，续读使用返回的 nextOffset。

输出：`{ index, offset, bytes, nextOffset, content }`。每页最多 50 KiB，UTF-8 多字节字符不会在正常分页处被拆坏；完成后 nextOffset 为 null。偏移超过文件末尾返回空内容。仅支持 UTF-8 文本文件，不把二进制强行当文字，NUL 或非法 UTF-8 返回 `RP_TEAM_INVALID_REQUEST`。传入取消信号后停止读取并释放流。

工具使用 DSH 的 `attachments.readFileStream(ref, signal)`。不接收磁盘路径、URL 或任意附件 ID。选择整个 current_input、整个 /attachments 或一个完整 /attachments/N 可以授予相应内容；只选择文件名等元数据不授予内容。图片仍通过授权后的原生模型输入提供，不能用这个文字工具读取。

## 状态修改

读取仍使用 `rp_team_read_state({ namespace, path })`；获取仅写路径的版本可用 `rp_team_state_version({ namespace, path })`；写入仍使用 `rp_team_write_state({ namespace, path, value, expectedVersion })`。

新增 `rp_team_remove_state({ namespace, path, expectedVersion })`，输出 `{ staged: true, baseVersion, expectedVersion }`，表示已暂存；后续版本用 state_version 查询。它复用 StateStore.remove：必须有 State 输出权、对应写权限和作者声明，并满足 CAS。删除对象字段可以用于变量和插件状态；不能删除整个 namespace、数组元素或世界设定文件。世界设定条目删除继续返回 `RP_TEAM_STATE_DELETE_UNSUPPORTED`。

世界变量路径形如 `namespace: "world", path: "/variables/对象/字段"`；设定内容形如 `namespace: "world", path: "/settings/条目文件名"`。它们仍经过产品 Host 的最终 schema 校验和正式保存；不是直接打开或修改产品 SQLite。

写入／删除本轮立即暂存。有读取权限的后续成员能读取；正式正文成功保存后提交，失败、取消、预算耗尽丢弃本轮修改，回退按现有检查点恢复。并行修改同一路径时，过期版本返回 `RP_TEAM_STATE_CONFLICT`，不会覆盖已有写入。读写权限错误使用 StateStore 现有错误码，如 `RP_TEAM_STATE_FORBIDDEN`；无状态输出权为 `RP_TEAM_OUTPUT_FORBIDDEN`。

所有工具先核对真实调用者：必须是当前被调度的成员 Session 且 run 仍活动。冒用另一成员、原生嵌套 Session 或调用已结束 run 的工具，返回 caller mismatch／terminal 错误。恢复成员重新建立同样边界。嵌套原生 Agent 不自动获得 Team 数据工具；它只能继承父成员已投影的资料和配置允许的通用 DSH 工具，若需要更多认知工作应使用团队请求／handoff 调度正式成员。

## 旧工具如何改用新工具

| 原操作 | 0.4.1 操作 |
| --- | --- |
| eleckoi_glob_setting_files / grep_setting_files / read_setting_files | 在获准 worldbook 或 hidden_state 结果中 read_context / search_context；不能枚举隐藏条目 |
| eleckoi_glob_variables / grep_variables / read_variables | read_state；需要浏览获准世界状态时 read_context / search_context |
| eleckoi_apply_variable_patch | 对声明的 world /variables 路径 write_state / remove_state，携带版本 |
| eleckoi_apply_setting_patch | 对声明的 world /settings 文件内容 write_state；条目删除仍不支持 |
| eleckoi_read_uploaded_file | read_attachment，按原始附件 index 分页 |
| update_roleplay_plan | 原生 RP 计划工具不再提供；用已有内部消息、声明状态和请求／handoff 表达团队工作，不新增产品计划替代协议 |

旧工具提示词**不会自动改写**。作者应更新自己的指令；运行时给每位成员增加明确的 Team 工具说明。成员挂载的原生 preset、独立模型和生成参数保持有效，但其旧产品工具指令不能赋予额外权限。

## 能力开关、信任与轨迹

旧“变量／设定／RP 计划” capability 字段继续读写、导出，避免保存时损坏旧配置；编辑器将这些旧产品工具开关置为不可编辑，并说明资料读取由 Context、修改由 State 权限控制。它们不再授予宿主工具。

成员模型请求不声明 `eleckoi_*` 和 update_roleplay_plan，执行 guard 也拒绝猜测名称。宽泛状态权限和 native:preset 信任都不例外；未来新出现的 eleckoi_* 名称同样拒绝。拒绝名单是约束，**不算功能依赖**。

网络、工作目录、工作流、协作、MCP 和原生 preset 的其他工具继续按既有能力选择和 trustedTools 配置使用。外部工具信任仍意味着作者允许这些工具的外部作用，本次不把任意 shell/MCP 变成数据沙箱。

真实工具参数和结果记录在成员原生 Session；简短 context.operation / state.operation 补充事件供协作详情使用。没有额外默认“上下文准备”行。关闭或卸载释放工具、guard 和作用域，普通根聊天保留宿主工具。
