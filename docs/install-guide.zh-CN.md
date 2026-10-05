# 安装与更新

RP Agent Team 0.4.0 需要固定版本的 ElecKoi v0.2.4（提交 `088c2c25135fbcc1890df4d0941987d5e87e9f8f`）和 DSH 0.2.0-rc.2。仓库同时提供独立插件源码、宿主适配补丁和可直接导入的 DSH 插件归档。

## 第一次安装

1. 关闭 ElecKoi，确保源码是上述 ElecKoi 提交，并完整备份 ElecKoi userData。
2. 在 ElecKoi 源码根目录执行：

   ```sh
   git rev-parse HEAD
   git apply --check path/to/eleckoi-v0.2.4.patch
   git apply path/to/eleckoi-v0.2.4.patch
   pnpm install
   pnpm build
   ```

   `git rev-parse HEAD` 必须输出上述固定提交。适配补丁包含产品 Host 对话、状态、DSH 工作区和轨迹接口的窄扩展；不能把它当作插件包内容直接导入。

3. 启动 ElecKoi，打开 DSH 插件管理器，导入 [v0.4.0 Release](https://github.com/ynian2754-droid/rp-agent-team/releases/tag/v0.4.0) 的 `rp-team-dsh-roleplay-team-0.4.0.tgz`，然后启用 **角色团队**。
4. 进入角色聊天，在输入框打开角色团队。旧的 schemaVersion 2 团队配置会保留原行为；新功能在你创建配置后才生效。

不使用 GitHub Release 时，也可以从源码仓库运行 `pnpm install --frozen-lockfile && pnpm pack:dshbundle`，再导入构建目录 `DSHbundle/` 中生成的 `.tgz`。

## 从 0.3.0 更新

更新前关闭 ElecKoi 并完整备份 userData。以固定 v0.2.4 宿主代码为基础，应用本仓库的宿主补丁并重新构建，然后通过 DSH 插件管理器安装新的 `.tgz`。产品数据库保持版本 10，不要重跑旧聊天迁移。0.3.0 的 V2 配置与插件数据会继续使用。

## 卸载和恢复

先在 DSH 插件管理器停用或卸载插件，再从 ElecKoi 源码目录回退补丁（仅适用于当前工作树中确实单独应用的补丁，且先确认没有其他工作依赖这些修改）。插件自己的场景和运行记录保存在 DSH 插件数据目录；按 Electron/DSH 的标准备份流程保存后再清理。

如果升级后需要整体恢复，关闭 ElecKoi 并还原升级前的**完整** userData，再切回匹配的 ElecKoi 源码版本。只恢复 SQLite 文件不足以恢复原生 Session、附件和插件状态。

遇到问题，请在 GitHub Issues 中提供 ElecKoi 提交、插件版本和不含凭据/聊天内容的错误摘要。不要上传 userData、原始轨迹、Token、API Key 或完整数据库。
