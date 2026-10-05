# Compatibility

| Component | Supported version |
| --- | --- |
| ElecKoi | v0.2.4, commit `088c2c25135fbcc1890df4d0941987d5e87e9f8f` |
| DeepSeek Harness | `0.2.0-rc.2` |
| Plugin | 0.4.0 |
| Team configuration | schema 2 |
| ElecKoi product database | schema 10 |

This release depends on Host interfaces added by [`host-patch/`](host-patch/README.md). A later ElecKoi commit may change DSH lifecycle, state commit, or trajectory contracts. Do not assume compatibility from a matching application version label; check the commit and verify the patch applies.
