# RP Agent Team for ElecKoi

**Build configurable character cognition teams for roleplay.** Give each agent its own knowledge, memory, model, tools, triggers and authority, then let the team produce one reply inside the normal ElecKoi chat.

Version **0.4.0** adds an isolated rehearsal desk, author-defined use parameters, event and cooldown triggers, permission-aware memory tools, and per-run request, token and time budgets.

> **Supported host:** ElecKoi `0.2.4` at [`088c2c2`](https://github.com/eleckoi/ElecKoi/tree/088c2c25135fbcc1890df4d0941987d5e87e9f8f), with the DSH `0.2.0-rc.2` runtime. Apply this repository's host patch and rebuild ElecKoi before installing the plugin. The plugin archive alone cannot add the required product-side interfaces.

## Install

1. Download `rp-team-dsh-roleplay-team-0.4.0.tgz` from the [v0.4.0 release](https://github.com/ynian2754-droid/rp-agent-team/releases/tag/v0.4.0).
2. Follow [Install and upgrade](docs/install-guide.zh-CN.md) to patch the supported ElecKoi source, build it and import the archive through the DSH plugin manager.
3. Open a roleplay chat and enable **角色团队** in the composer. Disable it any time to return to ordinary chat on the next turn.

Read the [creator manual in Chinese](docs/user-manual.zh-CN.md) or the [full authoring guide](docs/authoring-0.4.0.md) before building a preset. The `examples/` folder contains ready-to-import team and rehearsal examples.

## What it does

- Define any number of agents without fixed built-in job types.
- Control triggers, visible context, communication, state access, tools, execution and who may publish the reply.
- Rehearse author-written multi-turn inputs in a separate DSH profile and compare two configurations from the same frozen chat snapshot.
- Share presets and reusable components with stable parameter bindings.
- Let agents search and update memories stored in permission-checked team state.
- Limit each run by real model request count, provider-reported tokens and elapsed time.
- Inspect real model requests, tool calls and results in the host's trajectory view.

## Build from source

Requirements: Node.js 22 or later and pnpm 10.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm pack:dshbundle
```

The installable archive is written to `DSHbundle/`. Generated bundles and build output stay out of Git; release archives are attached to GitHub Releases.

See [Development and release](docs/development.md), [the exact host patch](host-patch/README.md), and [the changelog](CHANGELOG.md).

## License

RP Agent Team is distributed under [AGPL-3.0-or-later](LICENSE). ElecKoi-derived host changes in `host-patch/` retain the ElecKoi repository's applicable AGPL terms. See [NOTICE.md](NOTICE.md).
