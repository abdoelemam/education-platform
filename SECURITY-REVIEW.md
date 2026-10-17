# Refresh-token security review

**Scope:** Phase 2 refresh-token rotation, replay detection, and failure safety
**Reviewed base:** `a033be0e30a03be8bcec5e0222563daf5274a688`
**Status:** Findings addressed on `fix/phase-2-refresh-token-replay`

## Findings and remediations

### 1. Replay counter used a check-then-update sequence

The service made its replay decision from a previously-read `reuseCount`, then
incremented the counter in a separate database operation. Concurrent replays
could all observe the same count and avoid the confirmed-reuse response.

**Remediation:** Atomically increment `predecessorReuseCount` on the replacement
document and derive the replay decision from the authoritative post-update
document (count, rotation timestamp, and revocation state). The verdict is not
persisted as a separate flag, and database errors are surfaced.

### 2. Replacement revocation was treated as proof of rotation

The service inferred that a replacement token had been consumed from
`isRevoked` alone. A logout or another revocation could therefore be mistaken
for a successful rotation and unnecessarily revoke the user's other sessions.

**Remediation:** Persist a revocation reason (`rotation`, `logout`, or
`security_replay`). Only verified rotation-chain evidence counts as consumption;
logout revokes only an active token and does not overwrite an earlier rotation
cause.

### 3. Confirmed replay could race a standalone rotation

On standalone MongoDB deployments, a rotation could claim the old token before
its replacement was stored. A concurrent replay-wide revocation could miss that
replacement, after which the rotation could create an active session.

**Remediation:** Persist the private replacement candidate before atomically
claiming and linking the old token. Thus a replay either revokes the old token
before it can be claimed, or sees and revokes the replacement. Transactional
deployments keep candidate creation and claim/link in one transaction.

### 4. A persisted replay verdict could poison a later legitimate rotation

An earlier revision derived the replay decision from a persisted
`predecessorReplayConfirmed` boolean written as a side effect of the counting
update. That verdict was a superset of the final decision: it could be set on an
attempt that was ultimately rejected as a tolerated in-window sibling, and it was
consumed destructively by both the rotation claim filter and the replay handler.
A leftover verdict therefore blocked a later legitimate rotation of the
replacement and revoked valid sessions. The pipeline conditions also read the
predecessor document from before the atomic update.

**Remediation:** Remove the persisted verdict. The replay handler performs a
single atomic `$inc` of `predecessorReuseCount` on the replacement and derives
`outsideGracePeriod`, `repeatedAttempt`, and `replacementAlreadyConsumed` from
the returned document. Because this update and the rotation's conditional claim
write the same document, they serialize on one linearization point, and the
decision never depends on a pre-update read. Containment no longer relies on a
claim-time flag: the confirmed path revokes all active sessions, and rotation's
candidate-first ordering (see finding 3) plus the transaction write-conflict
abort/reconciliation guarantee that any concurrently issued replacement is swept
or its claim fails. Deterministic barrier tests cover both write orders, a
sibling retry followed by successive legitimate rotations, and a stale persisted
verdict that must be ignored.

The transaction-conflict test injects a transient write-conflict error and uses
a fake Mongoose session; it exercises abort/reconciliation logic but is not a
real replica-set integration test.

### 5. Transaction reconciliation could misread its own committed rotation

The transactional path reconciled a `TransientTransactionError` by treating any
`isRevoked` record as replay. When the transaction had in fact committed but the
driver surfaced a transient error, this classified the successful rotation as a
replay: the caller received a 401, the committed replacement became an
unreachable active token, and a client retry could inflate the replay counter and
revoke every session. The unclaimed-token branch also called `handleUnclaimedToken`
from inside the transaction `try`, so its expected 401 was caught as a fresh
transaction error and triggered a duplicate `endSession`.

**Remediation:** The transactional attempt is isolated in `runTransactionalRotation`,
which always closes its session exactly once and never performs replay evaluation
itself. Reconciliation now proves this request's own rotation committed by matching
the recorded successor hash against the current candidate hash
(`isOwnRotationCommitted`, shared with the standalone path). A token revoked by
another request defers to the replay policy; an unresolved state or a
reconciliation read failure fails closed; cleanup failures are surfaced as an
`AggregateError`. The unclaimed path runs after the session is closed, so its 401
is preserved and no duplicate cleanup occurs.

Tests 35-39 cover a committed-then-transient rotation, a rotation revoked by
another request, a reconciliation read failure, a preserved 401 with single
cleanup, and a surfaced cleanup failure. They use a fake transaction session and
a fake replica-set topology, so they exercise control flow but do **not** prove
behavior on a real replica set.

## Failure handling and verification

Cleanup, transaction-abort, and reconciliation database failures are surfaced
instead of silently ignored. Tests cover save/claim failures, transaction-abort
handling, replay/logout distinctions, independent users, barrier-controlled
replay-versus-rotation interleavings, and deterministic transaction
reconciliation scenarios.

Backend verification is rerun as part of each local security review. The
integration suite uses a local MongoDB URI without replica-set configuration,
so successful transactions have not been exercised against a real replica set.
