# Changelog

## 0.7.19

- Author choice options can select the active team roster and replace full member prompts. The parameter editor shows the effective roster before saving, and the host freezes it for each turn.

## 0.7.18

- Enhanced draft review can run fact and presentation checks concurrently. The host merges exact-quote issues in draft order and uses the joined verdict for publication and ledger reconciliation.

## 0.7.17

- Draft reviewers can use independent pre-turn evidence to check factual claims made in dialogue. Current-turn reports of speech supply speech evidence.
- Event presentation anchors travel with the writer’s draft. The reviewer returns only `pass` and `issues`, and the host reconciles event status against the final published text.

## 0.7.16

- Simulators can select evidence from the current material pack through a native tool enum. The host resolves each choice to the original evidence reference and checks its actor scope.
- Opted-in draft review selects numbered prose passages for ledger presentation. The host binds unique exact matches, resolves the references back to original text, and verifies them against the publication.

## 0.7.15

- Opted-in adjudication can prepare independent outcomes at dispatch and submit only changed world fields after the clerk returns.
- Enhanced draft review links current adjudicated events with exact prose excerpts. Publication derives their presentation status from the final text within the existing turn transaction.

## 0.7.14

- Opted-in simulation submissions expose a typed tool contract, normalize empty departure fields, and repair the observed extra closing brace on an otherwise valid submission before the native parser.
- Focused adjudication forwards visible current scene cues alongside the existing midpoint facts, without turning an ongoing process into a completed event.
- Direct draft review checks the factual premises of character dialogue and may inspect directly linked, already presented evidence under the existing permissions.

## 0.7.13

- Opted-in adjudicators start a regular decision with the current handoff, scene evidence and objective state. They can retrieve their authorized originals on demand.
- Opted-in draft reviewers submit only `pass` and `issues`. The enhanced preset guides one complete pass with a focused follow-up on concrete doubts.

## 0.7.12

- Opted-in simulation members receive a per-character list of valid grounds, including qualified references to visible self records. Submission checks those references before a remote review or staged state write. A character's self-description does not count as a historical precedent.

## 0.7.11

- The 「经历」 turn tools register the user's stimulus and start the clerk in one call. World outcomes and their ordered event appends are validated with the final handoff and staged in one batch.
- The optional single-character clerk path dispatches the selected pack, runs configured simulation review and retry, and forwards the accepted result without repackaging. Rejected simulation writes never enter the journal.
- The enhanced preset recovers a complete narrator draft that stops without using the review tool. The host sends the original draft to the configured reviewer and preserves its existing revision and publication rules.

## 0.7.10

- Members may opt in to ordered tail appends. The host assigns each new record's index, even if other members update existing records in the same turn. Updates and archives still check collection versions.

## 0.7.9

- The 「经历」 provenance-aware chronicle accepts verified excerpts of published prose, keeps a typed batch contract, and rejects an exact event already present at the same story time.

## 0.7.8

- Scoped reviews receive only the current handoff and its authorized evidence, and submit a verdict through a single tool.
- The 「经历」 preset can prepare world facts before adjudication and reuse authorized material prepared before the clerk handoff.
- Chroniclers can submit event changes and summary updates as one atomic batch.

## 0.7.7

- 「经历」can opt into host-built material packs and one terminal simulation submission containing both the result and a batch of scoped state changes.
- A timed-out simulation is interrupted before retry. Its handoff timer starts when the native activation binds.
- Compact reviews preserve semantic checks and exact draft publication. The publisher can authorize publication of its original draft on approval.

## 0.7.6

- Await handoffs explicitly enabled for parallel execution can be sent together with `rp_team_request_many`. The caller uses one scheduler wait and receives an ordered result or error for each target.
- Independent context, state, message and memory reads can run in the host's parallel tool batches.
- A timed-out terminal reviewer with no state, draft, publication or external tool access releases its native turn so it cannot extend the wait for an available draft.

## 0.7.5

- Structured handoffs can declare `terminal: true`. A valid final result ends the target's model turn after the result is saved. Invalid results still return validation feedback to the target.
- `rp_team_publish` can publish the exact approved text from a completed terminal handoff by reference.
- Uses the same Windows host supplement as 0.7.4 on ElecKoi v0.3.0.

## 0.7.4

- A handoff can allow references with `references: true`. In data sent through it, and in the target's answer, a member may write `{"$ref": "ask-file#1"}` in place of a result it received or a request it sent earlier in the run. `pointer` takes one part of the data and `side: "request"` forwards the request instead of the result. The host substitutes the exact original before the selectors and schema run, so models no longer re-type long nested results. Each request is numbered `<handoffId>#<n>` per sender. Members that can write references receive each await result as `{ref, summary, data}`; other members still receive `{summary, data}`.
- A reference that names nothing, has no result yet or whose pointer finds nothing is rejected as `RP_TEAM_HANDOFF_REF_INVALID`. The tool error lists the references the member can use. Used references are traced as `handoff.refs_resolved`.
- When a handoff target fails, the requester no longer receives the target's raw model output. Upstream errors are cut before `Received arguments:`. Malformed tool arguments are reported as "Target X failed: its model produced malformed arguments for tool Y". Other messages are shortened to 400 characters. The request record, the trace and the member error keep the full text.
- DSH `llm/retry` events in member Sessions are traced as `model.retry` with the retry count and error code.
- The handoff editor has a "Forward verbatim" switch. Presets, portable presets and components that use references declare `minimumPluginVersion: 0.7.4`. Plugin 0.7.3 rejects them on import.
- Uses the same host supplements as 0.7.2.

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
