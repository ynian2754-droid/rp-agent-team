# RP Agent Team 0.7.2 安装与数据导入

0.7.2 的适配目标是 ElecKoi v0.2.21 Windows x64 的源码提交 `924e30aa6d22b45cea67a4376843764e25b94657`，搭配 DSH 0.2.2-rc.1、Cordis 4.1.0、Electron 44.7.0。宿主补丁扩展正式聊天保存、状态回执、归档、轨迹和隔离试演，并沿用上游的变量身份迁移。插件配置沿用 schema 2。 [官方 Windows 构建源码](https://github.com/eleckoi/ElecKoi/commit/924e30aa6d22b45cea67a4376843764e25b94657)

## 构建和安装

工作区内用 `启动电子爱-v0.2.21.ps1` 打开新版的独立档案。原来的 `启动新版电子爱.ps1` 打开 v0.2.20 档案，该宿主使用 `eleckoi-v0.2.20-win-rp-team-v0.5.1.patch`，可安装同一份 0.7.2 插件。准备新检出时，先核对交付的 `SHA256SUMS.txt`，再在确切源码提交上检查并应用对应补丁。

```powershell
git rev-parse HEAD
git apply --check $patchPath
git apply $patchPath
pnpm install --frozen-lockfile
pnpm prepare:desktop
pnpm --filter eleckoi-desktop build
pnpm check:electron-sqlite
```

`$patchPath` 为 v0.2.21 交付中的 `eleckoi-v0.2.21-win-rp-team-v0.7.2.patch` 的绝对路径。宿主使用其锁定的 pnpm 10.32.1。启动构建后的 `apps/desktop` 时，为 Electron 传入独立的 `--user-data-dir`。在 DSH 插件管理器导入 `rp-team-dsh-roleplay-team-0.7.2.tgz`，按提示重启，然后打开角色聊天，点击输入区的「角色团队」。

自行生成插件包时，在插件仓库使用 Node.js 22+ 和 pnpm 11.22.0，执行 `pnpm install --frozen-lockfile`、`pnpm test` 和 `pnpm pack:dshbundle`。包写入 `DSHbundle/`。

## 从旧环境导入

### 电子爱 v0.2.20 或官方 v0.2.21

新版宿主将官方 schema 16、官方 schema 17 和本项目 v0.2.20 团队版 schema 17 升到 18。升级补齐变量来源，并保留旧团队版的提交回执和历史快照。新的会话归档使用 v3，仍可读 v1 和 v2。

要带上 v0.2.20 的聊天，先关闭两个版本，再将原档案复制到一个空目录。复制时跳过 DSH 的依赖缓存，保留插件数据、依赖清单和锁文件。下面从工作区根目录执行。

```powershell
$oldProfile = Join-Path (Get-Location) 'output\profiles\eleckoi-v0.2.20'
$newProfile = Join-Path (Get-Location) 'output\profiles\eleckoi-v0.2.21-migrated'
if (Test-Path -LiteralPath $newProfile) { throw 'Choose an unused profile directory.' }
$dependencyCache = Join-Path $oldProfile 'dsh-runtime\home\profiles\desktop\node_modules'
robocopy $oldProfile $newProfile /E /XJ /XD $dependencyCache
if ($LASTEXITCODE -ge 8) { throw 'Profile copy failed.' }
.\启动电子爱-v0.2.21.ps1 -UserDataDirectory $newProfile
```

首次启动会迁移数据库。在副本的 DSH 插件管理器导入 0.7.2，恢复插件依赖并按提示重启。验证聊天、队伍配置和变量历史后，从副本继续使用。直接运行启动脚本会进入预装插件的新档案。

### 更早的团队版

旧团队版的 schema 10 与同号官方库结构不同。先停机备份，再用匹配的旧宿主导出归档，导入新版独立档案。保留旧角色、媒体、预设、Session 和插件资料，以便核对和恢复。

- 旧 v0.4.1 停机副本的三个导出工具随 [0.5.0 历史交付说明](adaptation-0.5.0/install-guide.zh-CN.md) 使用，生成一份独立转换目录。已有转换目录时复制归档、产品和附件材料到新目录，以新导入记录绑定新资料目录。
- 在新宿主的源码根目录执行 `node scripts/import-v050-stopped-copy.mjs`。按 CLI 用法填写 `--conversion-dir` 和五个新目标路径，并将 `--preset-template` 指向 `apps/desktop/resources/dsh/agent-preset-template/agent.cordis.yml`，`--agent-patch` 指向同目录下的 `desktop-agent.patch.yml`。用匹配本地 SQLite 模块 ABI 的 Node 或 Electron Node 模式执行。
- 导入返回 `official-import-mapping.json`，包含聊天、Session、消息、状态操作和附件的身份映射。然后在插件仓库用 `node scripts/remap-plugin-data-v050.mjs --source <旧插件数据副本> --destination <空的新插件数据目录> --mapping <映射文件>` 重映射团队数据。
- 通过 `exportArchive` 生成的 0.5.0 原生归档也可由新 Host 的 `importArchiveWithMapping` 读取。导入前准备对应角色与资源。旧便携归档没有编码当前会话专属设定覆盖，含这类数据时应保留原停机副本。已归档的旧试演通过重新冻结继续使用。
- 在新资料目录内核对聊天历史、附件、队伍配置与轨迹。续聊、重生成和回退都从新环境执行。卸载使用电子爱的官方插件管理器。恢复旧环境时一同恢复匹配的宿主和数据副本。

实际范围和运行结果见随包的验收记录。
