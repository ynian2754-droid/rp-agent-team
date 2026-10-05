# RP Agent Team 0.4.0

This release adds an isolated rehearsal desk for author-written multiround scenarios, two-configuration comparisons, seven types of author-defined use parameters, event and cooldown triggers, memory tools stored in permission-scoped state, and per-run request, reported-token and elapsed-time budgets.

The plugin still uses configuration schema version 2. The supported ElecKoi baseline is v0.2.4 at commit `088c2c25135fbcc1890df4d0941987d5e87e9f8f`; apply the included host patch and rebuild ElecKoi before importing the bundle.

## Assets

- `rp-team-dsh-roleplay-team-0.4.0.tgz`: import through the DSH plugin manager.
- Host source changes: reviewable in [`host-patch/`](../host-patch/README.md).

Read the [Chinese user manual](user-manual.zh-CN.md), [installation guide](install-guide.zh-CN.md), and [acceptance report](acceptance-0.4.0.md).

The package contains no user profiles, chat histories, model credentials, or database exports.
