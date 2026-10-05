# Development, build and release

This repository contains the removable ElecKoi DSH plugin source plus a separately maintained patch for its supported host baseline. Keep the plugin code and ElecKoi host changes as distinct deliverables.

## Requirements and commands

- Node.js 22+
- pnpm 11.22.0
- ElecKoi source at the fixed commit in [the compatibility note](../README.md#install)

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm pack:dshbundle
```

The package command writes the importable archive into `DSHbundle/`. That directory and `dist/` are generated artifacts and are intentionally ignored by Git. Do not commit local `.env` files, DSH profiles, userData, Session logs, SQLite databases, model credentials or fixture captures.

## Host patch

`host-patch/eleckoi-v0.2.4.patch` is generated against exactly ElecKoi commit `088c2c25135fbcc1890df4d0941987d5e87e9f8f`. Verify it on a clean checkout using `git apply --check`. Do not rebase this cumulative patch against a moving ElecKoi branch. When adapting another host version, make and review a separate patch against that exact version.

The source patch touches only the files recorded in the release's host patch proof. It adds shared conversation identity/state commit interfaces, the plugin-owned Team Remote and official trajectory integration needed by this runtime. It does not bundle an ElecKoi executable or a copy of the whole host repository.

## Releasing

Create a version tag such as `v0.4.0` after reviewing the source, host patch and docs. Attach the output `DSHbundle/rp-team-dsh-roleplay-team-0.4.0.tgz` to that GitHub Release. Keep compiled output and archives out of `main`; publish source as normal Git files and the host patch as a reviewable text diff.

The optional release workflow attaches the built archive when a `v*` tag is pushed. Maintainers should confirm that the tag's tree contains the matching version and fixed host baseline before publishing.

## Privacy and contribution

Use only synthetic chat and model fixtures in tests. Never add real userData, profile data, credentials, API responses, unredacted process output or private conversations. Before submitting a change, inspect both staged file names and file contents; attach test results without local usernames, access tokens or chat text.

Open an issue or pull request describing the behavior change, the smallest relevant tests and the exact ElecKoi baseline used. See [CONTRIBUTING.md](../CONTRIBUTING.md).
