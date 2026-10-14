# Refresh-token security review

**Scope:** Phase 2 refresh-token rotation, replay detection, and failure safety
**Reviewed base:** `a033be0e30a03be8bcec5e0222563daf5274a688`
**Status:** Findings addressed on `fix/phase-2-refresh-token-replay`

## Findings and remediations

### 1. Replay counter used a check-then-update sequence

The service made its replay decision from a previously-read `reuseCount`, then
incremented the counter in a separate database operation. Concurrent replays
could all observe the same count and avoid the confirmed-reuse response.

**Remediation:** Increment the counter with atomic `findOneAndUpdate` and make
the decision from the returned counter value. Database lookup failures happen
before the counter changes and are not swallowed.

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

### 4. Replacement-state read raced the replay counter update

The replay handler read whether the replacement was consumed, then incremented
the parent token's replay counter. If the replacement rotated between those
operations, the handler could use stale active-state evidence and defer replay
containment.

**Remediation:** Use a conditional atomic update on the replacement token as the
state check. It matches only an active replacement and records
`lastReplayCheckAt`. Rotation uses an atomic claim on that same document, so the
two operations serialize: if the replay check wins, the replacement was active
at that point; if rotation wins, the check cannot match and the persisted
rotation reason / successor link is inspected. Database errors are surfaced.
A deterministic barrier test rotates the replacement immediately before this
conditional check and verifies replay containment.

## Failure handling and verification

Cleanup, transaction-abort, and reconciliation database failures are surfaced
instead of silently ignored. Tests cover save/claim failures, transaction-abort
handling, replay/logout distinctions, independent users, and barrier-controlled
replay-versus-rotation interleavings.

Backend verification on the reviewed branch:

- `npm test` — 28 tests passed.
- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm run build` — passed.

The integration suite uses a local MongoDB URI without replica-set configuration,
so successful transactions have not been exercised against a real replica set.
The transaction failure path is covered with a deterministic session test; the
standalone fallback and its concurrency behavior are exercised against MongoDB.
