# Video System

Foundational backend for course videos. This document is the API contract and
provider setup guide. The frontend is not initialized yet, so no upload UI is
included; the contract below is what the frontend will consume later.

## Architecture

```text
Teacher browser
      │  1. POST /api/teacher/videos/:id/upload-authorization
      ▼
Node.js API ── signs short-lived upload instructions (no file bytes)
      │  2. returns upload URL + signed fields
      ▼
Teacher browser
      │  3. uploads the file DIRECTLY to the storage provider
      ▼
Video storage provider (raw bytes live here, never in MongoDB)
      │  4. POST /api/teacher/videos/:id/upload-complete
      ▼
Node.js API ── 5. asks the provider for authoritative asset state
      │
      ▼
MongoDB (metadata + provider reference + status only)
```

Guarantees:

- Raw video bytes are never stored in MongoDB.
- Uploads are never proxied through the Node.js process.
- Provider secrets never reach the browser (only the signed upload fields).
- The backend, not the client, controls `uploadStatus`, `processingStatus`,
  duration, dimensions, thumbnails and playback URLs.
- No playback URL is returned until the provider reports the asset ready and
  the requester is authorized.

## Provider abstraction

`backend/src/modules/videos/providers/video-provider.interface.ts` defines
`VideoProvider`:

| Method | Purpose |
| --- | --- |
| `createUploadAuthorization(request)` | Build short-lived direct-upload instructions |
| `getAsset(assetId)` | Fetch authoritative asset state/metadata from the provider |
| `buildPlaybackReference(asset)` | Build a playback reference for a ready asset |
| `deleteAsset(assetId)` | Provider asset cleanup (optional) |
| `isConfigured()` | Whether required credentials are present |

Adapters:

- `cloudinary.video-provider.ts` – signature-based direct uploads plus the
  Cloudinary Admin API for asset verification/deletion.
- `unconfigured.video-provider.ts` – fail-closed provider used when no provider
  is configured. Every operation returns HTTP `503` instead of faking success.

The active provider is selected by `VIDEO_PROVIDER`. Adding another provider
(e.g. Mux, S3, Vimeo) means adding an adapter that implements `VideoProvider`
and registering it in `providers/index.ts`; no service or route changes are
required.

## Configuration

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `VIDEO_PROVIDER` | no | `unconfigured` | `cloudinary` or `unconfigured` |
| `CLOUDINARY_CLOUD_NAME` | with Cloudinary | – | Public cloud name |
| `CLOUDINARY_API_KEY` | with Cloudinary | – | Sent to the browser (not secret) |
| `CLOUDINARY_API_SECRET` | with Cloudinary | – | Server-only; never returned |
| `VIDEO_UPLOAD_FOLDER` | no | `education-platform/videos` | Server-chosen asset id prefix |
| `VIDEO_UPLOAD_AUTHORIZATION_TTL_SECONDS` | no | `3600` | Lifetime of signed instructions (Cloudinary signatures are valid for at most 1 hour, so larger values are clamped) |

If `VIDEO_PROVIDER=cloudinary` but credentials are missing, the provider
resolves to the fail-closed adapter and upload authorization returns `503`.
This is intentional: misconfiguration is surfaced instead of silently producing
fake uploads.

### Cloudinary trade-offs

- Cloudinary was already referenced by the project configuration
  (`.env.example`), so it is the first adapter.
- It offers a free tier, but production usage/quotas are plan-dependent. No paid
  account is required by this code; the application runs with the fail-closed
  provider until credentials are supplied.
- Uploads are signed with the API secret using Cloudinary's documented
  algorithm (SHA-1 of sorted `key=value` pairs + secret). Only `api_key`,
  `timestamp`, `public_id` and the derived signature are returned.
- The adapter uses the Cloudinary Admin API (`fetch`) for `getAsset` and
  `deleteAsset`. No Cloudinary SDK dependency was added. `deleteAsset` uses the
  documented bulk endpoint (`DELETE /resources/video/upload` with a
  `public_ids[]` form field), which is the only Admin API path that deletes by
  public id. Admin API calls are bounded by a request timeout.
- Signed upload instructions are valid for at most one hour; the configured TTL
  is clamped to that limit so `expiresAt` never overstates the real window.

## API contract

All routes are under `/api`. Teacher routes require:

- a valid access-token cookie (or `Authorization: Bearer`),
- role `teacher` with `teacherStatus = approved` (admins bypass approval),
- a valid `X-CSRF-Token` header on state-changing requests, matching the
  `csrf_token` cookie.

Resource ownership is enforced on the server: a teacher may only access their
own videos. Admins may access any video.

### `POST /api/teacher/videos`

Create video metadata before uploading.

Request:

```json
{ "title": "Introduction", "description": "Optional" }
```

Response `201`:

```json
{
  "success": true,
  "data": {
    "video": {
      "id": "664f...",
      "ownerId": "664e...",
      "title": "Introduction",
      "description": "Optional",
      "provider": "cloudinary",
      "uploadStatus": "not_authorized",
      "processingStatus": "pending",
      "createdAt": "2026-10-17T00:00:00.000Z",
      "updatedAt": "2026-10-17T00:00:00.000Z"
    }
  }
}
```

### `GET /api/teacher/videos?page=1&limit=20`

List the authenticated teacher's videos. `limit` max is `100`.

```json
{
  "success": true,
  "data": [{ "id": "664f...", "title": "Introduction" }],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

### `GET /api/teacher/videos/:videoId`

Returns `{ "success": true, "data": { "video": { ... } } }`.

### `POST /api/teacher/videos/:videoId/upload-authorization`

Returns server-authorized direct-upload instructions. The server chooses the
asset id (reused on retries).

Response `200`:

```json
{
  "success": true,
  "data": {
    "upload": {
      "videoId": "664f...",
      "provider": "cloudinary",
      "assetId": "education-platform/videos/664f...",
      "uploadUrl": "https://api.cloudinary.com/v1_1/<cloud>/video/upload",
      "method": "POST",
      "fields": {
        "public_id": "education-platform/videos/664f...",
        "timestamp": "1700000000",
        "api_key": "<public key>",
        "signature": "<derived signature>"
      },
      "expiresAt": "2026-10-17T01:00:00.000Z"
    }
  }
}
```

The browser must send `uploadUrl` + `fields` as `multipart/form-data` with the
file in a `file` part. Do not add fields that are not in `fields`; the signature
covers them.

### `POST /api/teacher/videos/:videoId/upload-complete`

Called after the browser finishes the direct upload. The body is intentionally
empty; any client-supplied metadata is ignored/rejected by validation.

The backend calls the provider's `getAsset`:

- asset missing → `409 VIDEO_UPLOAD_NOT_FOUND`, video marked failed;
- asset processing → `200`, `processingStatus: "processing"` (call again to
  refresh);
- asset ready → `200`, metadata filled from the provider, `playbackUrl` set;
- provider failure → `502 VIDEO_PROVIDER_ERROR`.

The operation is idempotent once the video is ready.

### `GET /api/teacher/videos/:videoId/playback`

Returns a playback reference only when the provider reports the asset ready.

```json
{
  "success": true,
  "data": {
    "playback": {
      "provider": "cloudinary",
      "assetId": "education-platform/videos/664f...",
      "url": "https://res.cloudinary.com/..."
    }
  }
}
```

Not ready → `409 VIDEO_NOT_READY`.

### `DELETE /api/teacher/videos/:videoId`

Deletes the provider asset first, then the metadata record. If the provider
deletion fails, the request fails with `502 VIDEO_PROVIDER_ERROR` and the
metadata is retained so deletion can be retried; storage is never orphaned
silently. A provider asset that is already gone is treated as deleted.

## Error codes

| Code | Status | Meaning |
| --- | --- | --- |
| `VIDEO_NOT_FOUND` | 404 | Video does not exist |
| `VIDEO_FORBIDDEN` | 403 | Caller does not own the video |
| `VIDEO_UPLOAD_NOT_AUTHORIZED` | 409 | Completion attempted before authorization |
| `VIDEO_UPLOAD_NOT_FOUND` | 409 | Provider cannot find the uploaded asset |
| `VIDEO_UPLOAD_ALREADY_COMPLETE` | 409 | Re-authorization of an already-ready video |
| `VIDEO_NOT_READY` | 409 | Playback requested before the asset is ready |
| `VIDEO_PROVIDER_NOT_CONFIGURED` | 503 | No usable provider configuration |
| `VIDEO_PROVIDER_ERROR` | 502 | Provider request failed |
| `VALIDATION_ERROR` | 422 | Zod validation failed |

Standard envelopes are used (`success`, `data`/`error`, `meta` for lists).

## Data model

`backend/src/modules/videos/video.model.ts` stores metadata only:

- `ownerId` (teacher reference)
- `title`, `description`
- `provider`, `providerAssetId`
- `uploadStatus`: `not_authorized | authorized | completed | failed`
- `processingStatus`: `pending | processing | ready | failed`
- `durationSeconds`, `width`, `height`, `format`, `sizeBytes`
- `thumbnailUrl`, `playbackUrl`
- `uploadAuthorizationExpiresAt`, `uploadedAt`, `readyAt`, `failureReason`

`uploadStatus` and `processingStatus` are backend-controlled. No raw bytes or
client-provided status values are persisted.

## Provider setup requirements

To enable real uploads:

1. Create a Cloudinary account (free tier is sufficient to start).
2. Set `VIDEO_PROVIDER=cloudinary` plus `CLOUDINARY_CLOUD_NAME`,
   `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` in the backend environment.
3. Optionally adjust `VIDEO_UPLOAD_FOLDER` and
   `VIDEO_UPLOAD_AUTHORIZATION_TTL_SECONDS`.
4. Restart the backend. `POST .../upload-authorization` should stop returning
   `503`.
5. Upload a small video through the direct-upload flow and confirm
   `upload-complete` returns `processingStatus: "ready"`.

Nothing here creates an account or charges a plan; until credentials exist the
provider stays fail-closed.

## Frontend integration (deferred)

The frontend is not initialized yet. When it is, the upload flow is:

1. `POST /api/teacher/videos` to create metadata.
2. `POST /api/teacher/videos/:id/upload-authorization` with the CSRF header.
3. `FormData` upload directly to `uploadUrl` with the returned `fields` and the
   file. Do not send the file to the Node.js API.
4. `POST /api/teacher/videos/:id/upload-complete` and poll/refresh until
   `processingStatus` is `ready`.
5. `GET /api/teacher/videos/:id/playback` for the playable reference.

Upload progress, resumable uploads, retry UX and in-lesson preview remain on
the roadmap (Phase 6) and belong to that frontend step.
