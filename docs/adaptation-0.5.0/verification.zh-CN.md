# 0.5.0 验收记录

目标固定为 ElecKoi `fb6dcea1e4c4a901ebff4b4d0c7836d66410cb76`（0.2.8）和 DSH `0.2.0-rc.2`，配置 schema 保持 2。实际软件、真实聊天与 profile 没有切换。模型验收全部使用本地可控 provider；token 数是夹具向原生请求报告的用量，不是付费服务账单。

## 接入结果

正式 Runtime 使用 DSH Agent 事件、原生 Team/子 Session 和本地正文交付。没有注册旧 prepare/afterSave/prepareRestore，不再依赖 0.2.4 专用 Runtime Extension、StoryState、TrialSnapshots 或 Trajectory Service。native-service.mjs 仍由 cordis.patch.yml 加载，用来引导官方 Team 服务，并非可以单独删除的死文件。

完整插件仍需要新版宿主补充：turn 状态暂存与回执、作者编辑 CAS、归档身份映射、隔离 Host 启动和通用轨迹组件导出。移除旧中介不代表任意干净新版可以直接安装。

## 确定性检查

| 范围 | 命令与结果 |
|---|---|
| 候选16完整插件 | `node --test test/*.test.mjs tests/*.test.mjs`；246/246，exit 0 |
| 候选18完整插件 | `pnpm test`；254/254，exit 0，含正式回执恢复、有效分支和并发重试目标用例 |
| 最后代码候选19 | `pnpm test`；259/259，exit 0；试演回执目标集27/27，exit 0 |
| 最后界面与转换目标集 | request-context-v050、client-bundle-v050、trajectory-v050、conversion-v050；15/15，exit 0 |
| 独立 Runtime 复核 | Runtime/事件预算/worker/checkpoint 73/73，作者状态与工具18/18；exit 0 |
| 最后宿主目标集 | `pnpm exec vitest run tests/conversation-archive-public-api.test.ts tests/conversation-archive.test.ts tests/dsh-conversation-generation-save.test.js tests/v050-legacy-archive.test.mjs tests/trajectory-platform-bootstrap.test.ts`；18/18，exit 0 |
| 转换工具最终目标集 | `node --test tests/import-v050-stopped-copy.test.mjs tests/export-v041-stopped-copy-products.test.mjs`；5/5，exit 0；四个脚本语法检查 exit 0 |
| 类型、构建与文档 | workspace-runtime、桌面、renderer、client 类型、page/preload 检查已通过；最后 Node/Web 类型、架构和生成插件文档检查再次 exit 0 |

pre-ack publishing、pending/unknown 阻止新 run、stage/dispose 并发和终态回滚由 Runtime fixture 覆盖。这些 fixture 重建 Runtime/StateStore，不是操作系统硬杀。不能把插件测试数量代表宿主全量测试。

## 正式 Host / DSH / SQLite

候选16 SHA256：`5F3F54263C1B8B41F67D3F86A7045CB6D55A29382449632195F37EA1F0238E83`。

`scripts/verify-v050.mjs` 在 runtime-smoke-16 exit 0，九个场景通过：稳定 Session 多轮、新 run、真实成员模型/参数、隐藏资料/工具隔离、通信和唯一正文、世界/插件状态提交、重生成/回退、预算耗尽、取消排空、Team 关闭后普通模型/原生工具恢复，以及公开管理器停用/卸载/重装。

`scripts/verify-v050-cold.mjs` 独立进程 exit 0，读回已提交回执、状态、配置、成员 Session 和根正文，没有自动生成。`scripts/verify-v050-presets.mjs` 的运行和冷启动 exit 0；请求含实际挂载指令，压缩 start/summary/end 存在，计入三次请求名额，派生原生 preset 冷恢复成功。加载哈希与候选产物一致。

含试演回执恢复修正的候选18，SHA256 `84B74F698C324FC088C95D126069E4876415277CF5273CD757851FAF8753CB94`，再次运行 `verify-v050` 与独立 `verify-v050-cold`，分别九个运行场景与两个冷启动场景通过，均 exit 0。证据为 runtime-smoke-18/results.json 和 cold-results.json，不能用旧包结果代替。

实物验收修正了：请求过早读取输入、Agent 自有工具过滤遗漏、空设定库 CAS 不稳定、嵌套助手 ID 读取错误、迟到通知使 turn 错标 blocked、产品 preset/原生 preset 身份混用、fork worker 依赖解析及试演步骤/原生 turn 混用。

## 试演

候选16 trial-ee2ad206-ca59-4cf2-80d8-795317e7ecf8：A/B各两轮完成，累计十次请求。A 的 generation0/checkpoint/run IDs 保持；B 的 generation0中503和未暂存失败保留，显式重试在 generation1独立 profile完成。

这次 smoke 进程 **exit 1**：试演完成后，fixture 误断言公开 DTO 存在 conversationId/nativeConversationId。修正 fixture 后没有重跑模型掩盖退出码。对已保存结果的 trial-worker-v050-cold-read 独立冷读 **exit 0**，分别核对公开 Session ID 与存储的私有 conversation ID。冻结 snapshot SHA256 `0ca03ab9f52b750369f382457adcb98d7b49d56567f73c0958fa0cefa5917561`，冷读前后不变。

收尾发现并修正真实缺口：worker 在正式提交后、写 durable checkpoint 前硬终止，旧实现不能主动查同 generation 回执。恢复现以官方聊天详情确认正式 Session，严格核对 run、输入 ID/序号、有效分支、正文 ID/序号；恢复冻结的原生成员预设，按 trial 合并并发恢复查询。已确认失败/取消才允许重试，未知仍不重跑。

真实故障样本 trial-758883ec-9dcc-44be-9dd3-1a6e2685f7a2：在已验证 committed 回执且尚无 trial checkpoint 的一次性内部测试暂停点，仅硬终止该 trial marker 对应的 worker。该暂停点只由内部 fixture 注入，不是 Remote 参数。第一轮原run `ce4f0ea3-7f31-4f28-87ef-79df04ecf291`、Session `11d90ced-aa50-42e5-82bd-fc62da47542d`、输入和正文ID在候选19冷恢复后完全保留，generation仍为0。本地服务器监听原冻结端口，恢复阶段0请求；主代理独立读取已保存检查点与实际安装 worker 哈希复核了身份。

随后 candidate19-resume-step2.mjs 通过官方 Host 启动后加载实际安装的 dist，显式 retry只续第二轮，exit 0。最终两轮complete，第二轮新run `b721c161-e9b1-4747-8f01-5392a4cc38ac` 属于generation1，checkpoint为[1,2]；本地fixture新增恰好2请求，首轮没有重跑。证据在 trial-receipt-hardkill-18/candidate19-recovery-resume-evidence.json。该代码候选SHA256 `BABB75482D00D6B67A9150ACDC11792A4D9A289022CA628A136A2003E14B3EB5`，实际安装worker SHA256 `A1AF554D967D000812C0622F56528500D1C486EC5F8DE663884BB9ADA93B1430`。

故障注入原脚本及若干前置核验曾因错误读取公开DTO的私有字段、或在官方Host加载前直接导入缺peer解析环境的模块而exit 1；这些不改写为通过。恢复仍针对同一样本，没有重做首轮/硬杀来掩盖脚本错误。恢复0请求来自先前同样本冷恢复中已通过的本地监听断言；最终exit0 continuation验证的是接续第二轮，并通过私有持久对象核对完整回执。主代理还在正式runtime-smoke-18 profile公开升级候选19并独立冷读，exit 0。

## 真实 Electron 界面

候选17 SHA256 `00A5E058CE1732ED61332B9EEFA07644A4A6D518F54A9DAAC4613A86570CB784`，独立 electron-profile-04，原生 dsh-app://app/。

修正三个实物界面错误：公共组件加载早于共享 React 绑定；owner props 覆盖 Slot 替换；原生请求来源对象被当文字渲染造成 React #31。

已核对请求的实际 provider/model/参数/用量/输入、工具参数与结果、成员/类别筛选、搜索、右侧工作区、六个页面、草稿关闭重开保留、800×760窄窗口、放弃草稿、停用后普通轨迹恢复，以及重启用后的团队注册。没有触发生成；GUI 中的夹具 provider 未挂载，界面明确提示缺失而非替换模型。

修复后无 React 崩溃。存在既有开发 CSP 警告，另观察到一次 plugins/events 的 net::ERR_FAILED 资源错误；未复现对应渲染失败，随后重新启用恢复注册。没有将其写成控制台完全无错误。

## 停止副本转换

合成旧环境含15聊天、83原生Session、25 Team traces和5 handoff sidecars。官方导入核对309条逐聊天消息映射（全局去重296 ID）、2310事件、28历史状态操作/重分配映射、15重复导入，附件5直接引用/2内容对象。

插件 final05 转换及重复执行 exit0，绑定 mapping hash 和来源签名。宿主 importer 的数据库/runtime/profile/workspace/媒体五目标路径校验已纳入补丁和目标测试；旧缺字段marker拒绝复用。

交付检查还去掉了 importer 的15聊天/15角色/1预设样本计数限制，并让旧 ProductData 模块路径成为明确的必填参数，去掉开发者个人路径。目标测试覆盖1聊天、2预设的有效集合，错误schema和集合形状仍拒绝；旧模块缺参在临时目录/数据库复制前拒绝。该 CLI参数改造没有重新加载实际旧SDK导出，既有15聊天实物导出仍使用同一个旧模块，执行时须选择匹配其原生ABI的运行时。

一个导入旧聊天续聊、重生成、回退后保留188根事件和19用户/助手ID，实物运行是候选14。后续 converted-continuation-04-cold16.log 记录候选16升级冷读exit0；原候选14 results JSON不能改称候选16。其他聊天核对导入完整性，未逐一请求模型。这不是实际用户 profile 全量转换证明。

## 边界和最终产物

Host大Remote用例在通过归档映射断言后，仍有 CreatorStudio 删除目录清理断言失败。没有修改无关清理代码，不声明 Host 全量测试全绿。

Session日志与SQLite为两个存储，硬中断可留下没有产品引用的Session文件，不承诺跨存储事务。缺失可靠关联的旧轨迹/世界编辑保留归档，不伪造检查点。旧试演需重新冻结。

正式 pre-ack unknown 硬杀、真实 nested 权限以及永久不结束的Host stage Promise没有完整实机故障注入证据；目标测试与实机结果须分开理解。未验证其他Host SHA、远端provider或实际数据切换。

新版patch为416297字节，SHA256 `1B2C032AC400A5588E5ADD1E65525132DF629DAB96A445B9BEC20CCC27E18700`，已通过修改工作树reverse check及干净固定基线apply check。最终交付仅在候选19插件代码上更新验收文档和脚本记录，核心模块字节与已验证候选保持一致；最终包哈希及包内全部dist/lib加载比对单独列在交付evidence/final-artifacts.json、final-loaded-hashes.json和SHA256SUMS.txt，避免在包内记录其自身哈希造成循环变化。一个构建产生的声明source-map未纳入manifest文件清单，明确排除，不当作缺失运行模块。

本次完成打包后停止，没有安装到真实profile，没有切换真实源码目录，没有发布Release或制作EXE。原实际ElecKoi的Electron SQLite模块哈希保持 `7CEC2A4426B25AAD6A430404C3E18696207E672BE24B6FCA6A181175E0CBFD5F`；隔离宿主恢复Node ABI，所有本次Host/worker/本地模型server已关闭。
