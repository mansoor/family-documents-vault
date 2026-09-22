# API changelog

The API lives under `/api/v1`. It is a hard contract: one official app must work
against self-hosted servers that are months or years behind.

**The rules**

1. Changes are additive by default. New fields, endpoints and enum values ship
   without a version bump; clients ignore what they do not recognise.
2. Nothing is removed without a deprecation window of **four minor server
   releases**, announced here and surfaced in the `deprecations` list of
   `GET /api/v1/capabilities`.
3. New enum values are additive. Treat an unrecognised `status` or `visibility`
   as an opaque string.
4. The client declares its minimum server version; the server declares its
   minimum client version. Either side refusing says so in plain words.

## Unreleased

- `GET /api/v1/capabilities` — the capability document. Fetch it first,
  unauthenticated. Shape:

  ```json
  {
    "product": "family-document-vault",
    "server_version": "0.0.1",
    "api_version": 1,
    "min_client_version": "0.0.1",
    "edition": "self_hosted",
    "protection_mode": "standard",
    "features": { "...": false },
    "limits": { "max_upload_bytes": 104857600, "max_members": null, "max_storage_bytes": null },
    "deprecations": [],
    "branding": { "display_name": "Our family vault" }
  }
  ```

  `null` in `limits` means unlimited. Every `features` flag starts `false` and
  is switched on by the release that ships it. `setup_required` is `true`
  until the first-run wizard has created the household.

- `POST /api/v1/setup` — first run only. Body: `household_name`, `display_name`,
  `email`, `password` (10+ characters). Creates the household, its first
  member and the owner account; answers `201` with tokens. `409 already_set_up`
  afterwards.

- `POST /api/v1/auth/password` — body `email`, `password`. Answers with tokens:

  ```json
  {
    "access_token": "…",
    "expires_in": 900,
    "refresh_token": "…",
    "refresh_expires_in": 2592000,
    "household_id": "…",
    "member_id": "…",
    "role": "owner",
    "scopes_unlocked": ["household", "adults", "member"]
  }
  ```

  Wrong email and wrong password both answer `401 invalid_credentials`,
  in the same time.

- `POST /api/v1/auth/refresh` — body `refresh_token`. Rotates it. Presenting
  a token that was already rotated revokes the whole session (`401 session_ended`).
- `POST /api/v1/auth/logout` — bearer; `204`.
- `GET /api/v1/auth/sessions` — bearer; `{ items: [{ id, current, user_agent, ip, created_at, last_used_at }] }`.
- `DELETE /api/v1/auth/sessions/{id}` — bearer; signs that device out; `204`.
- `GET /api/v1/me` — bearer; `{ account_id, household_id, member_id, role }`.

- Errors: `401 unauthenticated` (no or bad bearer), `401 session_ended`
  (revoked, expired or replayed), `422 validation_failed`, `429` with
  `Retry-After` on the auth endpoints (10 requests per minute per address).

- Vaults (where files are kept). All bearer; changes are owner-only.
  - `GET /api/v1/vaults` — `{ items: [{ id, kind, provider, label, endpoint, bucket, region, prefix, path_style, role, status, active, last_verified_at, last_error }] }`. Never includes keys.
  - `GET /api/v1/vaults/providers` — presets: `[{ key, name, endpoint, pathStyle, region?, hint }]`.
  - `POST /api/v1/vaults` — `{ provider, label?, endpoint?, region?, bucket, prefix?, path_style?, access_key_id, secret_access_key }` → `201` with the vault, `status: "untested"`.
  - `POST /api/v1/vaults/{id}/test` — writes, reads back and deletes a test object: `{ ok, message, code?, detail? }`. `message` is for the person.
  - `POST /api/v1/vaults/{id}/activate` — `204`; `409 vault_untested` unless the last test passed.
  - `DELETE /api/v1/vaults/{id}` — `204`; `409 vault_in_use` for the active vault.
  - Storage error codes: `not_found`, `unreachable`, `credentials_rejected`, `bucket_missing`, `permission_denied`, `verification_failed`.

- Household (bearer).
  - `GET /api/v1/profile` — `{ household_name, owns_home, rents_home, vehicle_count, has_pets, has_business, country, answered_at }`. `PUT` with any subset (adults only).
  - `GET /api/v1/members` — `{ items: [{ id, display_name, date_of_birth, relationship, is_deceased, colour, has_account, role, is_me, document_count }] }`.
  - `POST /api/v1/members` — `{ display_name, date_of_birth?, relationship? }` → `201`. A person without a sign-in; their private-scope key is created immediately.

- Documents (bearer). Viewers are read-only; teens may change only their own documents.
  - `GET /api/v1/document-types` — the built-in types: `{ items: [{ key, label, category, fields, expiry_driver, reminder_leads, usually_essential, default_visibility }] }`.
  - `GET /api/v1/documents` — filters `member_id`, `category`, `type_key`, `tag`, `visibility`, `essential`, `status`, `deleted=true` (the trash), `updated_since`; `sort=recent|expiring|alpha`; `limit`, `cursor`. Answers `{ items, next_cursor, has_more }`.
  - `GET /api/v1/documents/counts` — `{ by_member: [{ member_id, count }], by_category: [{ category, count }] }`.
  - `GET /api/v1/tags?q=` — `{ items: [{ tag, count }] }`.
  - `POST /api/v1/documents` — any subset of `type_key, title, owner_member_id, category, visibility, issued, expires, identifier, physical_location, is_essential, tags, notes, extra`. Dates are `{ date, precision }`. A body with `status` is refused (`422`). Answers `201` with the document and an `ETag`.
  - `GET /api/v1/documents/{id}` — with `ETag`. `PATCH` honours `If-Match` and answers `409 conflict` (the current copy is in `detail`) on a stale tag.
  - `DELETE /api/v1/documents/{id}` — soft delete; `POST /api/v1/documents/{id}/restore` brings it back.
  - `GET /api/v1/documents/{id}/versions` — `{ items: [{ id, version_no, filename, mime, byte_size, sha256, page_count, ocr_status, uploaded_at }] }`.
  - `POST /api/v1/documents/{id}/versions` — multipart, one `file`, **`Idempotency-Key` header (UUID) required**. The type is detected from the bytes; accepted: PDF, JPEG, PNG, HEIC, TIFF, WebP, DOCX, XLSX (`415 unsupported_type` otherwise; `413 too_large` over the limit). A retry with the same key returns the same version.
  - `POST /api/v1/capture` — multipart, same headers; creates a Needs-info document with its first version: `201 { document_id, version_id, job_id, state: "stored" }`.
  - `GET /api/v1/versions/{id}/content` — streams the decrypted file with `Content-Disposition`; supports `Range` (`206`, `Content-Range`; `416` outside the file). Every call is audited.

  - `GET /api/v1/search?q=&member_id=&category=&limit=` — full-text search over titles, identifiers, tags, notes and the text inside documents: `{ items: [{ document_id, title, type_key, category, owner_member_id, status, snippet, matched_in: "title" | "content", rank }], sealed_pending: { count } }`. `snippet` marks matches with `<em>`. `sealed_pending` counts the caller's private documents whose text is not searched server-side.
  - `GET /api/v1/versions/{id}/thumbnail` — a JPEG preview of the first page; `404 no_thumbnail` until the worker has produced one.
  - After an upload the worker counts pages, makes a thumbnail and runs OCR; `ocr_status` on the version moves from `pending` to `done`, `failed` or `skipped`.

  A document's `status` is `{ value, label }` with `value` one of `active`, `expiring_soon`, `expired`, `valid`, `needs_info`, `superseded`, `missing`. Treat unknown values as opaque.

## Deprecations in effect

None.
