# Contributing

Thanks for helping make RP Agent Team easier for roleplay creators to shape.

1. Open an issue before a large behavior change; small fixes can go directly into a pull request.
2. Keep the supported host commit explicit. Changes to ElecKoi itself belong in `host-patch/`; changes to the removable runtime and editor belong in the plugin source.
3. Keep examples synthetic. Do not commit userData, Session logs, real prompts from private chats, credentials or local profile files.
4. Explain the user-visible change and which behaviors or permissions it affects.
5. Run `pnpm build` and the relevant test(s); include the commands and results in the pull request.

Contributions are distributed under the repository's AGPL-3.0-or-later license. ElecKoi-derived host code remains identified in `NOTICE.md`.
