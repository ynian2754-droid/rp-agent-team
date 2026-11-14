# RP Agent Team 0.7.19 安装与数据导入

RP Agent Team 0.7.19 可用于电子爱 v0.3.0 Windows x64，搭配 DSH 0.2.2-rc.1、Cordis 4.1.0 和 Electron 44.7.0。宿主补丁扩展正式聊天保存、状态回执、归档、轨迹和隔离试演。插件配置沿用 schema 2。v0.2.20 和 v0.2.21 使用各自的宿主补丁。 [官方 v0.3.0 Windows 构建源码](https://github.com/eleckoi/ElecKoi/commit/b0f4a5dada412acb595d58678c7f468fec866eb0) · [版本与补丁](../host-patch/README.md)

## 构建和安装

工作区内用 `启动电子爱-v0.3.0.ps1` 打开新版的独立档案。`启动电子爱-v0.2.21.ps1` 和 `启动新版电子爱.ps1` 分别打开原来的 v0.2.21 和 v0.2.20 档案。准备新检出时，先核对交付的 `SHA256SUMS.txt`，再在确切源码提交上检查并应用对应补丁。

```powershell
git rev-parse HEAD
git apply --check $patchPath
git apply $patchPath
pnpm install --frozen-lockfile
pnpm prepare:desktop
pnpm --filter eleckoi-desktop build
pnpm check:electron-sqlite
```

`$patchPath` 为 v0.3.0 对应的 `eleckoi-v0.3.0-win-rp-team-v0.7.4.patch` 的绝对路径。宿主使用其锁定的 pnpm 10.32.1。启动构建后的 `apps/desktop` 时，为 Electron 传入独立的 `--user-data-dir`。在 DSH 插件管理器导入 `rp-team-dsh-roleplay-team-0.7.19.tgz`，按提示重启，然后打开角色聊天，点击输入区的「角色团队」。在「预设」中导入需要的 `.rp-team.json`，应用到指定的聊天后保存。 [插件安装包](https://github.com/ynian2754-droid/rp-agent-team/releases/tag/v0.7.19) · [预设下载](https://github.com/ynian2754-droid/rp-agent-team-presets)

### 可选：让宿主重发写坏的工具调用

模型偶尔会把工具参数写成不合法的 JSON，比如括号没配对。DSH 默认把这当作这一步失败，那名成员当场结束，团队这一轮也可能随之失败。DSH 的模型服务支持按错误类型重试。把 `MALFORMED_RESPONSE` 加进去以后，写坏的那一步会重新请求一次：失败那次的工具调用一个都不执行，模型也看不到它，只是多花一次请求。

在档案的 `dsh-runtime\home\profiles\desktop\cordis.patch.yml` 里，找到 `llm-pi-ai` 条目下要用的服务商，比如 `providers.config-xxxx`，加上：

```yaml
        retryPolicy:
          mode: normal
          maxRetries: 5
          retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, MALFORMED_RESPONSE]
```

- `retryableCodes` 会替换默认列表，所以默认的五类错误要一起写上。
- `maxRetries` 是同一步里各类错误共用的次数，这一步结束后清零。5 是默认值。
- 写错的 `retryPolicy` 会让这个条目下所有服务商在启动时不可用，所以改之前先关闭电子爱，改完核对一遍再启动。
- 电子爱保存模型设置时会保留这一项，只有清除或删除这个服务商才会丢失。
- 发生重试时，团队轨迹里会出现 `model.retry`。

自行生成插件包时，在插件仓库使用 Node.js 22+ 和 pnpm 11.22.0，执行 `pnpm install --frozen-lockfile`、`pnpm test` 和 `pnpm pack:dshbundle`。包写入 `DSHbundle/`。

## 从旧环境导入

### 现有 v0.2.21 团队档案

v0.3.0 团队宿主直接打开 v0.2.21 团队 schema 18。关掉两个版本，再复制停机档案到新目录。下例从工作区根目录运行，保留产品库、媒体、Session、插件数据和依赖清单，跳过依赖缓存。

```powershell
$oldProfile = Join-Path (Get-Location) 'output\profiles\eleckoi-v0.2.21'
$newProfile = Join-Path (Get-Location) 'output\profiles\eleckoi-v0.3.0-migrated'
if (Test-Path -LiteralPath $newProfile) { throw 'Choose an unused profile directory.' }
$dependencyCache = Join-Path $oldProfile 'dsh-runtime\home\profiles\desktop\node_modules'
robocopy $oldProfile $newProfile /E /XJ /XD $dependencyCache
if ($LASTEXITCODE -ge 8) { throw 'Profile copy failed.' }
$desktopProfile = Join-Path $newProfile 'dsh-runtime\home\profiles\desktop'
Push-Location -LiteralPath $desktopProfile
try {
    pnpm install --frozen-lockfile --ignore-scripts
    if ($LASTEXITCODE) { throw 'Profile dependency restore failed.' }
} finally { Pop-Location }
.\启动电子爱-v0.3.0.ps1 -UserDataDirectory $newProfile
```

若副本里的 `startup-profile.json` 指定了自定义 `userDataPath`，在启动前把该字段改为副本路径。恢复依赖时需保留旧锁文件所引用的本地包。启动后在副本的插件管理器导入 0.7.19 并重启，再核对聊天、队伍配置、变量历史和回执。

### 电子爱 v0.2.20、官方 v0.2.21 或官方 v0.3.0

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

首次启动会迁移数据库。在副本的 DSH 插件管理器导入 0.7.19，恢复插件依赖并按提示重启。验证聊天、队伍配置和变量历史后，从副本继续使用。直接运行启动脚本会进入预装插件的新档案。

### 更早的团队版

旧团队版的 schema 10 与同号官方库结构不同。先停机备份，再用匹配的旧宿主导出归档，导入新版独立档案。保留旧角色、媒体、预设、Session 和插件资料，以便核对和恢复。

- 旧 v0.4.1 停机副本的三个导出工具随 [0.5.0 历史交付说明](adaptation-0.5.0/install-guide.zh-CN.md) 使用，生成一份独立转换目录。已有转换目录时复制归档、产品和附件材料到新目录，以新导入记录绑定新资料目录。
- 在新宿主的源码根目录执行 `node scripts/import-v050-stopped-copy.mjs`。按 CLI 用法填写 `--conversion-dir` 和五个新目标路径，并将 `--preset-template` 指向 `apps/desktop/resources/dsh/agent-preset-template/agent.cordis.yml`，`--agent-patch` 指向同目录下的 `desktop-agent.patch.yml`。用匹配本地 SQLite 模块 ABI 的 Node 或 Electron Node 模式执行。
- 导入返回 `official-import-mapping.json`，包含聊天、Session、消息、状态操作和附件的身份映射。然后在插件仓库用 `node scripts/remap-plugin-data-v050.mjs --source <旧插件数据副本> --destination <空的新插件数据目录> --mapping <映射文件>` 重映射团队数据。
- 通过 `exportArchive` 生成的 0.5.0 原生归档也可由新 Host 的 `importArchiveWithMapping` 读取。导入前准备对应角色与资源。旧便携归档没有编码当前会话专属设定覆盖，含这类数据时应保留原停机副本。已归档的旧试演通过重新冻结继续使用。
- 在新资料目录内核对聊天历史、附件、队伍配置与轨迹。续聊、重生成和回退都从新环境执行。卸载使用电子爱的官方插件管理器。恢复旧环境时一同恢复匹配的宿主和数据副本。

实际范围和运行结果见随包的验收记录。
