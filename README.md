# RP Agent Team for ElecKoi

**Build configurable character cognition teams for roleplay.** Give each agent its own knowledge, memory, model, tools, triggers and authority, then let the team produce one reply inside the normal ElecKoi chat.

Version **0.7.3** supports the ElecKoi v0.2.21 Windows host and follows its live variable paths. It fixes request chains that stopped one hop short of `maxDepth`, checks a handoff result when the member submits it, and reports every problem of a rejected write or result at once. Members use permission-checked Team context, search, attachment and state tools. Rehearsal, prompt parameters, event triggers, memory, budgets and grouped native trajectories are available in the team workspace. [Runtime contract](docs/adaptation-0.5.0/CONTRACT.md) · [Installation guide](docs/install-guide.zh-CN.md)

The target is the Windows x64 build source of ElecKoi `0.2.21` at [`924e30a`](https://github.com/eleckoi/ElecKoi/commit/924e30aa6d22b45cea67a4376843764e25b94657), with DSH `0.2.2-rc.1`. Apply the matching host supplement for transactional turn state, durable receipts, archive identity mapping, headless rehearsal and public trajectory components.

## Install

1. Download the plugin archive and the matching Windows host supplement from [the releases page](https://github.com/ynian2754-droid/rp-agent-team/releases), or build the archive locally with `pnpm pack:dshbundle`. Plugin 0.7.3 uses the 0.7.2 host supplement.
2. Follow [Install and upgrade](docs/install-guide.zh-CN.md) to patch the supported ElecKoi source, build it and import the archive through the DSH plugin manager.
3. Open a roleplay chat and enable **角色团队** in the composer. Disable it any time to return to ordinary chat on the next turn.

### Download presets · 预设下载

Choose a `.rp-team.json` file from the [preset repository](https://github.com/ynian2754-droid/rp-agent-team-presets), or [download all presets and rehearsal scenarios as a ZIP](https://github.com/ynian2754-droid/rp-agent-team-presets/archive/refs/heads/main.zip). Import the preset in ElecKoi under **角色团队 → 预设**.

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

Requirements: Node.js 22 or later and pnpm 11.22.0.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm pack:dshbundle
```

The installable archive is written to `DSHbundle/`. Generated bundles and build output stay out of Git; release archives are attached to GitHub Releases.

## Team panel and UI preview

The Team panel beside the chat has five tabs: **本轮** (this turn's result, who took part and why, the published body, the next turn's forecast), **队伍** (members with six tabs each — prompt, model, when it runs, what it sees, collaboration, access — plus usage parameters and team settings), **预设** (export, import into the draft, examples, preset library, components), **试演** (a free configuration check without model calls, and real-model rehearsal) and **状态** (state values, memories and history). The “协作概览” link under a Team reply opens 本轮; member rows link into the host trajectory.

An offline UI preview with synthetic fixtures needs no model or host:

```sh
pnpm preview:build
pnpm preview:serve
```

Query parameters: `run=working|awaiting_commit|complete|failed|cancelled`, `page=run|team|presets|trial|state` (the old names `config|preview|library` still work), `c=2|3` (chat B, or chat C shaped like a four-member periodic/on-request team), `w=narrow|wide`, `theme=dark`, `lang=en`, `fail=enable` (the host refuses the team switch), `fail=retry` (the host withholds retry because the config changed). The preview is design evidence only; check native trajectories and request details in ElecKoi itself.

See [Development and release](docs/development.md), [the exact host patch](host-patch/README.md), and [the changelog](CHANGELOG.md).

## License

RP Agent Team is distributed under [AGPL-3.0-or-later](LICENSE). ElecKoi-derived host changes in `host-patch/` retain the ElecKoi repository's applicable AGPL terms. See [NOTICE.md](NOTICE.md).
