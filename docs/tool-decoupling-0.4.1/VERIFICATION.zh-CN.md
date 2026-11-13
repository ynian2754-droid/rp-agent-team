# RP Agent Team 0.4.1 验收报告

验收日期：2026-10-10（本地日期）。本次由单 agent 实施；没有派子代理，没有调用付费模型，没有修改真实聊天、升级实际宿主或安装到实际 profile。此前未跟踪的文档和公开接口样例保留。

## 交付结论

**完整插件的产品工具功能依赖由 10 种降到 0。** 成员通过自建 context/read/search/attachment 以及已有 Team State 工具完成原来交给产品工具的数据操作。新增 remove_state，删除桥文件修改汇总链。schemaVersion 保持 2。

**无回调普通团队流程在干净官方 0.2.8 上复验通过，产品变量提交的缺口仍存在。** 正式 0.4.1 保留当前经过验证的提交／恢复、试演与轨迹桥。本次没有把样例通过说成整个插件已经无补丁运行。

完整工具合同见 [TOOLS.zh-CN.md](TOOLS.zh-CN.md)，统计口径和剩余依赖见 [DEPENDENCIES.zh-CN.md](DEPENDENCIES.zh-CN.md)，变量最小复现见 [MINIMAL_REPRO.zh-CN.md](MINIMAL_REPRO.zh-CN.md)。最终包与文件哈希由交付目录的 SHA256SUMS.txt、artifact-manifest.json 给出；不把归档自身哈希写入归档，避免循环。

## 两套对象分别验收

| 对象 | 基线 | 用途 |
| --- | --- | --- |
| 完整 0.4.1 | ElecKoi 0.2.4 / 088c2c25135fbcc1890df4d0941987d5e87e9f8f 加既有累计 host-patch；DSH 0.2.0-rc.2 | 完整 Runtime、提交恢复、交接、记忆、预算、轨迹及试演回归 |
| official-tool-team 0.1.0 | 干净 ElecKoi 0.2.8 / d4b6bb949771693cd357ddd535ead22f4e835774；对应锁文件的 DSH rc2 | 不注册 prepare/afterSave/prepareRestore 的普通团队可行性及产品变量反例 |

官方目录来自固定 commit 的下载归档，无 Git 工作树；7 个关键源码／锁文件 SHA-256 与此前核对的官方下载归档一致，详见 evidence/official-source-integrity.json。本次没有对它应用宿主补丁或修改业务代码。

完整插件使用实际打包的 `.tgz`，经 DSH 插件管理器安装到新建 profile；夹具新增 --plugin-source 和 --team-bundle，避免误读另一个仍为旧版本的开发目录。SQLite 使用宿主 Electron 44 内置 Node 运行，ABI 149；没有重建实际宿主正在使用的原生模块。浏览器复验使用隔离官方 DSH 页面，未连接真实窗口。

## 命令与结果

以下都是本次实际执行的结果，退出码均为 0。`PLUGIN` 指本仓库；`HOST` 指当前 patched ElecKoi；`OFFICIAL` 指上述干净官方目录；`PKG` 指 0.4.1 tgz。完整重现的路径和命令在交付目录 commands.json，验收过程中失败的尝试另列在文末，不混入通过计数。

| 验证 | 命令／参数 | 本次结果 |
| --- | --- | --- |
| 专项与邻近测试 | node --test tests/context-tools.test.mjs + test 中四个 trial 测试文件 | 15 项通过：8 项新工具专项、7 项试演邻近测试 |
| 插件完整测试 | node --test test/*.test.mjs tests/*.test.mjs | 213 项通过，0 失败、0 跳过 |
| 客户端及 Remote 构建 | node scripts/build.mjs | TypeScript Remote 类型检查、Typert 生成、共享 React 客户端构建通过 |
| 归档 | node scripts/pack.mjs | 生成 0.4.1，检查 package、Host/Client 产物、新模块和合同在包内 |
| 完整原生回归 | rp-team-v024-native-fixture.mjs --plugin-source PLUGIN --team-bundle PKG --skip-build --authoring --keep-installed --cold-profile-reopen | 114 次本地夹具请求；正式唯一正文、多轮、失败复用／重试、取消、停用／卸载、作者编辑与交接、恢复、冷 profile 再启用通过 |
| 专项原生数据操作 | 同夹具 --v040-nested-only | 10 个实际请求，预算也计 10；真实调用 read_context/search_context/read_attachment/remove_state；50 KiB+尾页文件、世界状态提交及私有状态隔离通过 |
| 事件／预算／记忆 | 同夹具 --v040-only --preinstall-native-team | 9 类场景通过：压缩、超时、并行请求上限、一次成功、缺失用量、token 阈值、触发去重、记忆提交、记忆回滚；使用宿主已有团队服务 |
| 双方案试演 | rp-team-trial-native-fixture.mjs --plugin-source PLUGIN --team-bundle PKG --skip-build --full | A/B 共 4 轮、12 次本地 HTTP 模型请求，独立进程与 profile；源聊天归档比较未变，两方案状态互不混入 |
| 试演失败后检查点重试 | 同试演夹具 --checkpoint-retry | 已提交第 1 轮保持原 run ID；恢复第 2 轮后共 2 轮、7 次请求，未重跑已提交轮 |
| 试演取消 | 同试演夹具 --cancel-retry | 保留已提交第 1 轮；取消在途请求，用量未知时阻止 token-budgeted 重试派发；4 次请求，源聊天未变 |
| 官方无回调样例 | verify-official-tool-team.mjs --host OFFICIAL --bundle official-tool-team.tgz --data NEW --uninstall | 9 类场景、72 次本地请求；两成员、通信、正文、私有状态、恢复成员、嵌套、失败、取消、删除／重生成、卸载再装通过；两项变量反例成功复现 |
| 独立进程重启 | 同官方脚本 --reopen | 不请求模型，私有状态按有效正文身份恢复；加载文件哈希与样例源码一致 |
| 官方 UI | 同官方脚本 --reopen --ui --native-ui | 浏览器实际打开团队 3 人名单（含根 Agent）、共享任务、成员会话与真实工具轨迹；截图／可访问性文本留档 |
| 夹具语法与 diff | node --check 两个 Host 夹具及官方脚本；git diff --check | 通过；没有业务 Host 源码改动 |

原生轨迹核对的选定会话集合有 26 个执行关联、26 个原生请求、88 个工具事件，其中包含 1 个嵌套执行。这是明确选定的核对集合，不把它误当成完整 114 次夹具请求的总量。原生工具参数、结果及各自 Session 保留，不复制或重写日志。

正式原生夹具证明：所有成员请求都不声明产品工具；嵌套成员猜测 eleckoi_read_variables 被拒绝；StateStore 写入、删除和 CAS 冲突按同一链工作；停用后普通根请求重新得到 eleckoi_read_variables 等宿主工具。设置全局／native preset 信任也无法解除产品工具的 execution guard，另有专项测试。

## 数据与权限细节

专项覆盖未授权类别／字段、消息来源及私有草稿、状态读权、重复 selector、数组 limit、转义路径、缺失字段、元数据与文件内容分离、原始编号、偏移分页、二进制／非法 UTF-8、跨页中文与表情、读取中取消并释放流、暂存状态、写／删 CAS、失败回滚、检查点恢复、输出权、错调用者、结束 run、空 schemas guard、嵌套作用域及旧 capability 配置往返。

没有新增调度协议或状态存储。StateStore 不变；新增工具复用其读写／删除、提交和恢复语义。状态写入／删除轨迹改为读取真实暂存版本，而非 expectedVersion + 1 的假设，因为其他路径的写入也会推进暂存版本。

试演曾把已安装目录再次链接到独立 profile，真实运行发现 DSH peer 无法正确解析；现改成打包当前已加载代码并通过官方管理器正常归档安装。不是在试演中编译开发目录，也不是复制外层数据库。试演回执查询也统一到已有 eleckoiStoryState 接口。

## 官方验证的具体边界

普通团队样例通过预步、Session、团队和公开产品资料接口运行，不注册三个生命周期回调。其私有状态是插件文件加有效输出身份的投影，不是与产品数据库共同事务；未知保存结果不自动重跑。根 Agent 仍请求模型完成正常正文，不声称机器强制原样交付已被公开接口替代。

两个变量写入场景不是“通过正式提交”：生成期间写入立即改数据库，但原生正式保存检测到基值冲突；保存后独立写入改 current，却不能补进该轮 floor，删除正文恢复旧值。完整插件不能因此删掉正式世界状态提交桥。

官方 UI 验证的是 DSH 自带团队组件；Node/web 启动时关闭了未具备桌面资源装载环境的 ElecKoi Client Shell。没有宣称干净 0.2.8 的完整 Electron 产品前端已经验收。完整 Runtime 通过 Electron 可执行文件的 Node 模式、真实 DSH／SQLite 运行；没有操控用户当前真实聊天窗口。

确定性本地模型证明真实请求、工具、取消和保存流程；它不证明真实大模型在任意旧 preset 提示词下永不尝试旧工具。作者指令不会自动改写，操作映射及显式 Team 提示已交付。完整思维链处理与原有轨迹行为均未因本次改造扩张。

## 开发中遇到并处理的失败

- 旧 injection 测试未包含新增 attachments，更新约定后通过。
- 源码目录链接的官方样例缺 DSH scope 身份；改用打包样例，并使脚本强制显式 --bundle。
- 试演跨 profile 链接无法导入原生 Team 服务；通过独立归档安装修正。
- 一次隔离 pnpm 安装在 package.json rename 阶段返回 Windows EPERM；同一隔离 profile 的最小安装命令成功，后续正常双方案、检查点和取消试演通过。没有加入产品自动重试或更改真实 SQLite。
- 一个夹具结果检查误读无 messages 的工具日志行，以及一次 cold-profile 参数缺 --keep-installed，修正夹具／命令后通过；它们不属于产品模型流程失败。

以上失败尝试的原始文件保留在 output/v041-*，未用于成功证据计数。最终成功命令、哈希和加载产物核对单独留档。

## 交付及停止点

交付 0.4.1 bundle、工具合同、作者操作映射、依赖变化、变量最小复现、可重跑夹具差异、验收报告和哈希证据。累计宿主业务补丁未修改，保留原包；夹具变化另存 test-fixtures.patch。

完成后停止：没有发布 Release、制作 EXE、重新迁移旧数据或自动更新真实 profile。后续安装需使用这个交付包，当前实际软件仍保持原安装。
