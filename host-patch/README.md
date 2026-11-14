# Host supplements for RP Agent Team

The supplement extends the official product save path with turn-state staging and durable outcomes. It also supplies archive identity mapping, isolated desktop Host boot, scoped tool declarations and access to shared trajectory components.

## Windows source baselines

| ElecKoi | PC source commit | Supplement |
| --- | --- | --- |
| v0.3.0 | `b0f4a5dada412acb595d58678c7f468fec866eb0` | [eleckoi-v0.3.0-win-rp-team-v0.7.4.patch](eleckoi-v0.3.0-win-rp-team-v0.7.4.patch) |
| v0.2.21 | `924e30aa6d22b45cea67a4376843764e25b94657` | [eleckoi-v0.2.21-win-rp-team-v0.7.2.patch](eleckoi-v0.2.21-win-rp-team-v0.7.2.patch) |
| v0.2.20 | `7e1ee209c2b4cc0d14373a25c81fa024d0328597` | [eleckoi-v0.2.20-win-rp-team-v0.5.1.patch](eleckoi-v0.2.20-win-rp-team-v0.5.1.patch) |

All use DSH 0.2.2-rc.1. The v0.3.0 supplement shipped with 0.7.4 is used with the 0.7.19 plugin bundle.

Apply the patch from an untouched checkout of that ElecKoi commit:

```sh
git rev-parse HEAD
git apply --check /path/to/eleckoi-v0.3.0-win-rp-team-v0.7.4.patch
git apply /path/to/eleckoi-v0.3.0-win-rp-team-v0.7.4.patch
```

Build ElecKoi with its locked dependencies after applying the supplement. Use the [installation guide](../docs/install-guide.zh-CN.md) for the isolated profile and migration steps.

The v0.3.0 and v0.2.21 supplements migrate official schema 16 or 17 and the v0.2.20 team schema 17 to schema 18. The v0.3.0 supplement also opens the existing v0.2.21 team schema 18 directly. Migrate a stopped profile copy.

`eleckoi-fb6dcea-v050.patch` targets plugin 0.5.0 and the 0.2.8 Host. `eleckoi-v0.2.4.patch` targets plugin versions through 0.4.1. Convert those historical patched databases through their archive format into a fresh profile.

The diff contains ElecKoi-derived work under its applicable AGPL license. The plugin archive contains the RP Agent Team plugin.
