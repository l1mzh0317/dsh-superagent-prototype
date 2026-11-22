# Team Peppy Huly adapter (v1)

This optional Source connects one Huly workspace to the existing Superagent Engine. Enable `dsh-superagent-huly` in the profile and supply the deployment environment described in `src/sources/huly.ts`. Keep it disabled in ordinary GitHub installations.

For an installation without a GitHub identity, explicitly set `DSH_SUPERAGENT_HULY_ONLY=1`. Setup then resolves only machine and optional Feishu configuration. GitHub is unavailable rather than impersonated: no repository, CLI credential helper or account is fabricated. Existing GitHub deployments retain their usual startup checks.

## Native data flow

- Huly messages become stable Triggers, grouped by workspace, channel and original root message. Typed Person references grant addressed status; text resembling a mention does not. Edits remain context and do not become new authorizations.
- Source KV stores a timestamp / ID cursor in the existing Store. Activation skips old history. A typed mention invites the bot into that exact thread; subsequent human replies enter context even without a worker subscription. Source observation is confined to invited threads, so ordinary channel traffic is not a proactive input. Edits are context-only rather than fresh human authority. Two keyset queries handle equal timestamps without `$or`, which the deployed Huly v0.7.426 REST adapter does not support. Ingestion errors retain the cursor, allowing native Trigger deduplication on replay.
- Engine owns Policy, Eval, Ticket, Mandate and Assignment. Native Outbox owns reply receipts. Deterministic Huly document IDs reconcile a delivered reply whose HTTP receipt was lost.
- Dashboard is a query and interaction surface, not a second orchestrator. Task state is `ticketStage`, session IDs are `workerSessionId(ticket.id)`, and streamed history comes from SessionController.follow. No separate task, session or trace database is introduced.
- Human input uses Engine.receive and attach in one Store transaction, preserving Mandate validation and native resume behavior. A synthetic per-ticket Thread avoids fan-out into other tickets in the same physical conversation. Its Channel points back to the original Huly root. A request UUID, authenticated operator, workspace and ticket define idempotency.
- Channel feedback adds an idempotent bot-owned received reaction and one editable status reply. Explicit mentions are marked after native intake; unmentioned messages remain silent until a native accept, worker acknowledgement/answer, or actual Router reply shows adoption. Status is derived from native routing, assignment and report state. An unanswered explicit mention settled as discussion queues one durable native relay asking the Router for its substantive answer. Pending Outbox answers are not retried as new model questions.
- Replies carry a real task/worker-session link. `?task=<ticket>&session=1` selects the authorized task and opens its original side panel, waiting for allocation when queued. The shared Router transcript is not exposed through this link.

## Boundaries

`/team-peppy` serves the lightweight dashboard assets and authenticated API. In the deployed host Nginx places it beneath `/files/<workspace>/team-peppy/` to reuse Huly's workspace-scoped presentation cookie. Huly verifies the token signature and current account membership. Each task requires readable, enabled Huly channels; mixed-source tasks fail closed. Task creator, configured operators and workspace OWNER / ADMIN may write. Mutations require exact Origin and an application header. SSE rechecks membership and channel permissions every ten seconds.

Visible user / assistant text, tool names and high-level activity (analyzing, calling a tool, turn ended) are projected into the side panel. Reasoning deltas yield only a bounded activity indicator. System prompts, internal reasoning, raw tool arguments and results are omitted. The panel continues the original remote worker session; it does not yet embed Pepper's local Peppy renderer or create a desktop navigation entry.

Polling handles configured channels only; newly created channels and new member allowlists require explicit native Source / Policy configuration. This version does not implement attachments, fleet scheduling, identity wallets, or a dedicated trace store. DSH worker presets execute within their host user's environment; use a dedicated runtime/container boundary and do not describe Policy as an OS sandbox.

The paired `huly-selfhost/team-peppy` scripts provision and deploy the PT instance. Unit/HTTP tests cover normalization, replay, permissions, same-session binding and deduplication. The deployment smoke test additionally uses an actual private Huly thread, real DSH model/worker, Outbox and SSE.
