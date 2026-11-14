# Compatibility

| ElecKoi Windows | PC source commit | Patched product database |
| --- | --- | --- |
| v0.3.0 | `b0f4a5dada412acb595d58678c7f468fec866eb0` | schema 18 |
| v0.2.21 | `924e30aa6d22b45cea67a4376843764e25b94657` | schema 18 |
| v0.2.20 | `7e1ee209c2b4cc0d14373a25c81fa024d0328597` | team schema 17 |

RP Agent Team 0.7.19 uses team configuration schema 2, DSH 0.2.2-rc.1 and Cordis 4.1.0. Each host requires its matching [supplement](host-patch/README.md). The v0.3.0 supplement shipped with 0.7.4 is used for this release. The v0.3.0 host opens v0.2.21 team schema 18 and upgrades official schema 16 or 17 and v0.2.20 team schema 17. See the [installation guide](docs/install-guide.zh-CN.md) for profile migration.
