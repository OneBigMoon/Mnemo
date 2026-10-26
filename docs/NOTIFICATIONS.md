# Durable notification contract

This phase implements task-result notifications, not read receipts or exactly-once delivery guarantees. No real platform messages are authorized for automated development tests; use local/mock transports. Root owns shared types, Store transaction nesting, Queue, HTTP integration and final verification. Separate workers own outbox persistence, channel delivery, AstrBot integration and frontend. Do not create overlapping writers.

## Persisted identity and capacity

- Destination is `{platform,peer,botId?}`. Telegram requires the public numeric bot ID plus chat ID; bridge peers are exact trusted adapter UMO values after HMAC verification. Web is `{platform:'web',peer:'admin'}`. Destination comes from server context, never arbitrary task/request body.
- A task supports multiple watchers (max 8); subscription watchers propagate to automatically created tasks. Deleting a subscription atomically releases its own watchers while keeping inherited task notifications. Same URL/identity reuse also attaches the additional watcher.
- `generation` defaults to 1 for legacy tasks. Retry after failure/cancel increments it; pause/resume does not. Stable notification ID includes task ID, generation and destination, not updatedAt or a transport nonce.
- Reserve a `waiting` outbox entry when attaching a watcher or preparing a retry, before starting work. Limit live entries to 5000; prune old terminal delivery history to at most 500 while retaining watcher last-delivered event identity so pruning cannot recreate an old completed notification. Capacity failure backpressures admission/retry, never silently drops an already reserved terminal result.
- Outbox reservations, task/subscription association and task terminal update run in SQLite transactions. Store.transaction supports synchronous nested savepoints. A completed task with a waiting reservation after restart is reconciled into pending; interrupted sending becomes unknown. Paused/cancelled work never fabricates a completion or failure notice.
- Text is bounded, includes title, task ID and outcome; never download URL, local path, credentials or raw provider errors.

## Sending and acknowledgements

- Claim pending entries (max 10 per bridge poll; Telegram serial bounded batches), persist dispatching and a random claim token before transport handoff. Claim lifetime 120s; expired claims become unknown, never auto-pending. A late ack may reconcile the same current attempt after expiry, but a replaced/dismissed attempt cannot acknowledge a newer claim.
- Restarted dispatching -> unknown. Network errors/timeouts/cancellation after dispatch -> unknown. Explicit transport rejection -> rejected. Successful API/adapter response -> delivered, not proof the person read it.
- No automatic retry of unknown or rejected entries in this initial implementation. Administrator may retry unknown only with explicit confirmUnknown=true (potential duplicate warning); reject stale claim acks after retry. Dismiss is explicit and does not pretend delivery. Web read affects web notifications only.
- Telegram verifies configured bot identity and current chat allowlist before claim/send. It uses the same single owner lifecycle as polling; stopping does not start further sends and returns a Promise that must settle before SQLite closes. Invalid noncanonical peers are skipped without blocking valid destinations. Real credentials are never used in tests.

## Signed bridge transport

Existing message route/signature remains unchanged. Add:

- POST `/api/channels/bridge/:platform/notifications/poll`, JSON `{peer,nonce}`. Signature HMAC-SHA256 of `JSON.stringify(['notifications.poll',platform,timestamp,peer,nonce])`. Headers X-Mori-Timestamp (Unix seconds) and X-Mori-Signature (hex), existing ±5min window. Reply `{notifications:NotificationClaim[],serverTime:ISO}`. Exact destination filtering; no global notification list.
- POST `/api/channels/bridge/:platform/notifications/ack`, JSON `{peer,id,claimToken,outcome,receipt?}`. Signature HMAC-SHA256 of `JSON.stringify(['notifications.ack',platform,timestamp,peer,id,claimToken,outcome,receipt||''])`. Reply `{ok:true}`. Validate every field and destination/current attempt; duplicates of a delivered ack are idempotent.
- Nonce/transport signature is not durable notification identity. Duplicate poll cannot send an already dispatching entry again. Pending records are consumed only by a valid current claim; reading is never delivered.
- AstrBot keeps its own durable journal before Context.send_message. Permanently stale ACKs (404/409) are retained as obsolete without changing the send outcome, then excluded from ACK replay so they cannot starve newer claims. A successful journal entry only needs ack replay; a crash/timeout during send becomes unknown and is never sent again automatically. Poll only configured exact authorized UMOs. A new/reinstalled journal cannot redeliver expired/unknown server claims.

## App API and runtime

- GET `/api/notifications` -> `{notifications: public TaskNotification[]}` (no claim tokens). POST `/api/notifications/:id/action` with `{action:'read'|'retry'|'dismiss',confirmUnknown?:boolean}`. Administrator auth required; server validates state transitions.
- Requests action callbacks receive trusted owner as an optional final argument: addTask(input,owner), subscribe(query,media,startEpisode,owner). AgentDeps.forOwner binds direct URL task creation too. Both Web and channel-created tasks retain an in-app notification.
- Default phase scope is one administrator and trusted configured bridge adapters; HMAC does not create peer-level multi-tenant isolation from other holders of the same key. No external message is sent unless the user has configured and enabled that channel.
