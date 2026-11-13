# Changelog

## 0.7.3

- Each request hop adds one level of activation depth. Before, a hop was counted twice, so `maxDepth` 3 allowed only one hop and a chain such as A → B → C → D stopped before C. A requester resumed by a `resume` handoff runs again at its own depth instead of one level deeper.
- A rejected state write lists up to eight problems of the value at once, each with its path, instead of only the first. The error code is still `RP_TEAM_STATE_TYPE_MISMATCH`.
- A handoff target's `rp_team_submit_internal` is checked against the incoming handoff's `responseSchema` when it is submitted. A mismatch comes back as a tool error that lists every problem, so the target can fix it and submit again. Before, the check ran only after the target had ended, and a mismatch failed the handoff.
- Handoff request and response errors also list up to eight problems. A value outside an enum names the allowed values. Author-parameter and state-default errors in configurations use the same format.
- Members see the declared shape of each state path they may write, with required keys marked, so an empty default array no longer hides what each item needs.
- An activation started by a member's message or state write sits one level below that member, so chains of messages or state changes respect `maxDepth`. The message or write still succeeds when the triggered activation would be too deep; only that activation is blocked.
- Model-input trace events name the member whose Session made the request. Before, every scheduled member's requests were recorded under the output agent.
- Uses the same host supplements as 0.7.2.

## 0.7.2

- Support the ElecKoi v0.2.21 Windows host supplement. Team state reads and edits use the host's live variable paths when available and preserve variable origins across renames.
- Report context capacity for the local delivery route so an existing Session can switch to Team publication.

## 0.7.1

- Preserve the order of staged state writes when other operations intervene. A run can append two array elements and then update the first before committing.

## 0.7.0

Settings that toggle like preset entries:
- Choice, switch and number parameters can be bound with "Replace text marker". A choice inserts the text the author wrote for the chosen option (`options[].text`). A switch inserts `textOn` or `textOff`, and an empty or missing text inserts nothing. A number inserts its decimal value.
- Every option of a choice that inserts text must declare `text`, and a switch that inserts text must declare `textOn` or `textOff`. `textOn` and `textOff` are only valid on switches.
- Parameters can declare a `group`. The parameters page shows each group together and, for choices and switches that insert text, the text their current setting inserts.
- The author editor edits groups, option texts and switch texts, and offers "Replace text marker" for text, number, choice and switch parameters.
- Presets, portable presets and components that use groups or these insertions declare `minimumPluginVersion: 0.7.0`.

Runtime fixes since 0.5.1:
- Trigger cooldowns and between-turn `state_changed` triggers work again. Each turn snapshot carries the user inputs that are still on the Session surface. History and turn counting ignore events whose `surfaceOp` is not `append`.
- A stage call that the Host rejects before writing a turn row now fails the run locally. Before, the chat stayed blocked with `RP_TEAM_COMMIT_PENDING`.
- Startup recovery survives a run persisted as `publishing`, and one bad record no longer breaks the Team API. Runs interrupted before staging are failed, their state is released, and they can be retried.
- A retry no longer applies the state writes of members that run again, including the publisher, twice. Conditions and events do not restart members whose results the retry reuses.
- A late settlement of an older run no longer clears the newer run's Session mapping. Cancelling a finished run does nothing.
- The elapsed-time budget no longer discards a reply after the Host acknowledged it.
- Members read world settings as their editable source text, the same text a write replaces. A write to a setting without an editable entry fails immediately.
- A trial worker is not started after shutdown has begun.
- Writing a state key and then removing it in the same run no longer makes later reads, staging and commit fail with `RP_TEAM_STATE_PATH_UNDEFINED`. A path written again after a later write or removal of its parent keeps the newer value instead of losing it.
- Starting a turn no longer slows down as the chat grows:
  - committed runs are checked newest first, stopping at the first active one;
  - parsed run records are cached until their directory changes;
  - usage and model-input writes are batched every 250 ms;
  - only the newest runs of a chat stay in memory.

Team panel fixes since 0.5.1:
- The host reports why a retry is blocked (`retryBlockedReason`: team off, or configuration changed). Switching the team off and on keeps a retry valid.
- Members started by a condition or a retry show readable causes. Skipped members show the scheduler's recorded reason. A round that ended before scheduling no longer invents trigger reasons. A run whose details failed to load offers a reload instead of claiming "0/N took part".
- Removing a member drops triggers that only accepted that member, instead of opening them to every member.
- Adopting a trial result asks first when the draft has unsaved changes.
- The composer status opens the latest round instead of pinning one.
- The next-round forecast and the configuration check show triggers that are cooling down. The "check is out of date" hint re-reads the source version after each check and when the window regains focus.
- Author calls track several in-flight requests, so an older answer no longer overwrites a newer one. Late answers no longer revert edits made meanwhile.
- The enable switch retries once after a revision conflict and maps known errors to readable text.
- Trajectory filter bar, attempt and execution labels, and remaining client messages follow the app language.

## 0.4.0

- Added a separate DSH rehearsal space for author-written multi-turn scenarios and two-configuration comparisons.
- Added seven use-parameter types with stable member references and safe config-field or prompt bindings.
- Added interval, state-change, message and keyword event triggers with branch-aware cooldowns.
- Added permission-aware memory search and record tools on existing shared, private and world state.
- Added per-run request, provider-reported token and elapsed-time budgets, including nested calls and compaction.
- Preserved schema version 2 and added the ElecKoi 0.2.4 host integration patch.

See [the acceptance report](docs/acceptance-0.4.0.md) for verification scope and limits.
