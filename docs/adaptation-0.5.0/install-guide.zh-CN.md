# 0.5.0 安装与转换

本版本针对 ElecKoi `fb6dcea1e4c4a901ebff4b4d0c7836d66410cb76`（0.2.8）及该提交锁定的 DSH `0.2.0-rc.2`。配置仍为 schemaVersion 2。0.2.4 专用 Runtime Extension、StoryState、TrialSnapshots、Trajectory 服务及 prepare/afterSave/prepareRestore 回调不再是安装前提。

完整插件仍需要本次固定新版的窄宿主补充。它提供正式回合状态暂存与持久保存结果、作者编辑 CAS、归档身份映射、隔离 Host 启动和可加载的通用轨迹组件。具体实物结果见本次验收记录，不能据此宣称任意干净 ElecKoi 版本都已兼容。

## 新环境

1. 使用单独目录检出固定提交，应用交付的 **0.5.0 新基线补充**。不要应用 `eleckoi-v0.2.4.patch`。
2. 按 ElecKoi 自身说明安装锁定依赖并构建 Host、renderer、桌面应用；确认数据库与原生模块使用正确的 Node/Electron ABI。
3. 使用独立 userData/profile 启动，导入 `rp-team-dsh-roleplay-team-0.5.0.tgz`，再启用角色团队。插件卸载继续使用官方插件管理器。
4. 在新聊天验证普通 RP、团队输出、状态和轨迹后，才安排真实环境切换。本次交付不自动切换实际软件或 profile。

从插件源码打包：`pnpm install --frozen-lockfile`，随后 `pnpm pack:dshbundle`。构建产物位于 `DSHbundle/`。核对交付哈希清单后再导入。

## 从补丁版 0.2.4 转换

旧补丁库和新官方库的迁移编号不是同一套编号。**不能让新版直接打开旧库，也不能修改 user_version 来假装兼容。**

转换输入必须是已停止旧宿主的完整副本，包含产品数据、媒体、DSH Session/profile 和插件目录。保留原软件与完整备份。产品侧工具按新 schema 初始化，再通过官方归档导入建立新数据，返回明确的 conversation、Session 和消息映射。插件侧 `scripts/remap-plugin-data-v050.mjs` 使用映射生成另一份插件目录：

产品侧工具位于应用补充后的新版 ElecKoi `scripts/`，依次使用：

1. `prepare-v050-legacy-archive.mjs`：读取停止副本的旧数据库、Session 和插件数据，建立归档及精确 Session 闭包。
2. `export-v041-stopped-copy-products.mjs`：把该副本的角色、产品预设及媒体导出至同一转换目录。必须通过 `--legacy-product-module` 指定停止旧环境中已构建的 ProductData 模块；工具不再引用开发者机器的固定路径。
3. `export-v041-stopped-copy-attachments.mjs`：按归档引用导出附件；输入为停止副本的官方附件仓库，不接受用实际运行中的仓库替代。
4. `import-v050-stopped-copy.mjs`：从转换目录启动独立官方 Host 并导入，指定新 runtime、profile、workspace、数据库和媒体目录；输出 `official-import-mapping.json`，包含导入核对和重复导入结果。

产品导入记录同时绑定导出材料的内容签名，以及数据库、runtime、profile、工作目录、媒体目录五个目标路径。只有来源签名与五个路径都一致才能复用；缺少这些字段的旧记录拒绝复用。变更来源或目标时使用新的转换目录和空目标，不修改既有导入记录来绕过检查。

产品导出示意：

```powershell
node scripts/export-v041-stopped-copy-products.mjs --source-db <停止副本的旧数据库> --media-root <停止副本的媒体目录> --output-dir <转换目录> --legacy-product-module <旧源码/packages/dsh-product-data/lib/index.js>
```

此处执行进程必须匹配所选旧 SDK 的原生 SQLite ABI；必要时使用旧版匹配的运行时，不能为了导出重建或修改真实安装目录。其余新 Host 脚本使用固定新版的 Node 与依赖。旧 SDK 只在临时数据库/媒体副本上加载。转换器不限制为测试样本的15个聊天或1个预设；仍要求支持的旧格式、集合结构及对象身份完整。旧聊天转换步骤需要至少一条可确认的官方 conversation；仅迁移角色或预设时可使用其正常产品导入功能。

这些工具属于宿主转换工具，须在已安装锁定依赖并构建的固定宿主检出中运行。它们的缺少参数错误会列出完整命令格式；先用小副本走通全链路，再处理完整副本。插件转换命令在插件仓库中运行：

```powershell
node scripts/remap-plugin-data-v050.mjs --source <旧插件目录副本> --destination <空的新插件目录> --mapping <转换工具生成的映射.json>
```

映射包含 `conversations`、`sessions`、`messages` 和 `operations` 的旧新身份对照；角色和产品 preset 重新导入时还包含 `characters`、`presets`，附件映射由产品导入器提供。原生 DSH preset 若有可靠的独立注册映射，则另用 `nativePresets`；这两个身份域不能混用。Team 预设 ID、成员 ID、作者参数、状态值和原生事件顺序保持原义；成员挂载的原生 `presetId` 仅按明确的 `nativePresets` 映射更新；没有映射的引用保留原 ID，并由成员编辑器提示缺失，不替换提示词或作者状态中偶然同名的字符串。工具不会从旧临时运行目录自动重启模型。未建立映射的聊天及全部原始插件材料保留在 `legacy-0.4.1-archive`，不能冒充当前已关联记录。只有映射和实际读取的源配置、状态、场景、trace 等内容签名均相同，重复执行才返回既有结果。来源修改、不同映射或旧标记缺少签名时，使用新的空目标目录；不会覆盖已转换的数据。

产品操作及历史编辑的身份使用 `operations:{旧操作ID:新操作ID}` 映射。导入器为新聊天重新分配操作 ID，并同时更新保存回执；插件转换器更新 authorEdits 的键及回执引用。操作 ID 不能直接复用，否则向已有数据的数据库导入可能发生主键冲突。作者状态和提示词中的普通字符串不参与这种映射。

核对正文、附件、历史、状态、轨迹后，还必须验证续聊、重生成和回退，才能切换真实 profile。只复制 SQLite 或只保留插件 tgz 不是完整备份。

旧试演的冻结快照与检查点使用已删除的宿主协议，保留在原始归档中；作者填写的场景会带入新版，需要重新冻结资料后开始试演。缺失可靠 Session 关联的历史尝试，以及缺失完整设定库的旧世界编辑，仅作为归档保留，不伪造可恢复检查点。

## 停用、卸载与恢复

停用会停止团队调度并排空在途执行，释放工具和客户端包装；普通 RP 继续使用官方工具。插件配置、状态和试演资料按官方管理器的数据保留策略处理。恢复旧版时同时恢复匹配的旧 Host 与完整数据副本，不能混用新旧数据库。

不要向外上传完整数据库、聊天记录、原始请求或凭据。报错时提供固定提交、插件版本、包哈希和脱敏错误即可。
