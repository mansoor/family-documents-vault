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

- Two-step sign-in. When an account has an authenticator, `POST /auth/password` answers `{ "mfa_required": true, "mfa_token": "…" }` instead of tokens; `POST /api/v1/auth/mfa` with `{ mfa_token, code }` completes it (`401 totp_invalid`, `401 mfa_expired` after five minutes). `POST /api/v1/auth/totp/enrol` (bearer) → `{ secret, otpauth_url }`; `POST /api/v1/auth/totp/confirm` `{ code }` → `204`; `POST /api/v1/auth/totp/disable` `{ code }` → `204` (owners: `403`). `GET /me` now carries `totp_enabled` and `totp_required`.

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
  - `POST /api/v1/documents/{id}/visibility` — `{ visibility }` → `204`. Rewraps every version's file key under the new scope and moves the OCR text into or out of the search index. Moving into or out of `private` is allowed only for the owning member. A `PATCH` carrying `visibility` does the same.
  - `DELETE /api/v1/documents/{id}` — soft delete; `POST /api/v1/documents/{id}/restore` brings it back.
  - `GET /api/v1/documents/{id}/versions` — `{ items: [{ id, version_no, filename, mime, byte_size, sha256, page_count, ocr_status, uploaded_at }] }`.
  - `POST /api/v1/documents/{id}/versions` — multipart, one `file`, **`Idempotency-Key` header (UUID) required**. The type is detected from the bytes; accepted: PDF, JPEG, PNG, HEIC, TIFF, WebP, DOCX, XLSX (`415 unsupported_type` otherwise; `413 too_large` over the limit). A retry with the same key returns the same version.
  - `POST /api/v1/capture` — multipart, same headers; creates a Needs-info document with its first version: `201 { document_id, version_id, job_id, state: "stored" }`.
  - `GET /api/v1/versions/{id}/content` — streams the decrypted file with `Content-Disposition`; supports `Range` (`206`, `Content-Range`; `416` outside the file). Every call is audited.

  - `GET /api/v1/search?q=&member_id=&category=&limit=` — full-text search over titles, identifiers, tags, notes and the text inside documents: `{ items: [{ document_id, title, type_key, category, owner_member_id, status, snippet, matched_in: "title" | "content", rank }], sealed_pending: { count } }`. `snippet` marks matches with `<em>`. `sealed_pending` counts the caller's private documents whose text is not searched server-side.
  - `GET /api/v1/versions/{id}/thumbnail` — a JPEG preview of the first page; `404 no_thumbnail` until the worker has produced one.
  - After an upload the worker counts pages, makes a thumbnail and runs OCR; `ocr_status` on the version moves from `pending` to `done`, `failed` or `skipped`.

  A document's `status` is `{ value, label }` with `value` one of `active`, `expiring_soon`, `expired`, `valid`, `needs_info`, `superseded`, `missing`. Treat unknown values as opaque.

- Reminders (bearer). Derived reminders are created from the document type's lead times whenever a document's expiry or type changes; manual ones are yours.
  - `GET /api/v1/reminders?state=due|upcoming|all` — `{ items: [{ id, document_id, document_title, kind, fire_at, lead_days, note, recurrence, status, snoozed_until, label }] }`. `label` is pre-rendered ("In 12 days · 2 Oct", "Due today", "Overdue by 3 days", "Later · 17 Oct").
  - `POST /api/v1/reminders` — `{ document_id, fire_at, note?, recurrence? }` (`monthly`, `quarterly`, `annual`, `every:Nm`) → `201`.
  - `POST /api/v1/reminders/{id}/snooze` — `{ until: "YYYY-MM-DD" | "expiry" }`.
  - `POST /api/v1/reminders/{id}/acknowledge` — Done. A recurring reminder answers with its next instance.
  - `DELETE /api/v1/reminders/{id}` — manual reminders only.
  - Uploading a second or later version of a document resolves its open reminders.
  - `PUT /api/v1/profile` accepts `timezone` (IANA name); reminders fire on the household's local calendar date and the daily digest goes out at 9 am local.

- Notifications.
  - `GET /api/v1/notifications/push-key` — **unauthenticated**; `{ public_key, enabled }`. The browser needs it before it can subscribe.
  - `GET/POST /api/v1/devices`, `DELETE /api/v1/devices` (body `{ endpoint }`) — Web Push subscriptions for the signed-in account. `POST` is idempotent on the endpoint and revives a subscription that had failed. `503 push_unavailable` when the server has no VAPID keys.
  - `GET/PUT /api/v1/notifications/preferences` — `{ daily_push, daily_email, weekly_email }` per account. Defaults: push on, daily email off, weekly email on.
  - `GET /api/v1/notifications/smtp/providers` — presets `[{ key, name, host, port, secure, hint }]`.
  - `GET/PUT /api/v1/notifications/smtp` — the household's own mail server (owner only). Saving always sets `status: "untested"`; the password is never returned.
  - `POST /api/v1/notifications/smtp/test` — sends a real message to the caller's address and answers `{ ok, message }` in plain words. Only a passing test sets `status: "ok"`, and nothing is sent through untested settings.

- Exports (bearer; adults). `POST /api/v1/exports` → `202 { id, state: "queued", … }`; `GET /api/v1/exports` and `GET /api/v1/exports/{id}` report `state` (`queued`, `running`, `done`, `failed`), `document_count`, `byte_size`, `expires_at`; `GET /api/v1/exports/{id}/content` streams the ZIP (`410 export_expired` after seven days). The ZIP holds every original the requester can see, in folders by category, plus `index.json`, `index.csv`, `index.html` and `README.txt`.

- Invitations (SHR-02). An invitation carries two secrets: a **link token**
  (32 random bytes, base64url) and an eight-character **code**. The server
  stores only their hashes, so both appear once, in the `201` that creates
  the invitation, and cannot be retrieved afterwards.

  - `POST /api/v1/invitations` — `{ member_id | display_name, email, role }`
    → `201 { invitation, link_token, code }`. `member_id` invites someone
    already in the household who has no sign-in; `display_name` adds them.
    Exactly one of the two. Requires an adult, and `role` of `adult` or
    `owner` requires an owner (`403 forbidden`). `409 email_in_use` when the
    address already signs in here; `409 already_signed_in` when the person
    does. Asks for step-up (`change_people`).
  - `POST /api/v1/members/{id}/invite` — the same thing for an existing
    person: `{ email, role }`.
  - `GET /api/v1/invitations` — `{ items: [{ id, member_id, display_name,
email, role, invited_by, created_at, expires_at, state, attempts_left }] }`,
    `state` one of `pending`, `accepted`, `revoked`, `expired`, `locked`.
    Adults only.
  - `DELETE /api/v1/invitations/{id}` — revokes a pending one, `204`.
  - `GET /api/v1/invitations/{link_token}` — **unauthenticated**. What the
    invitee is shown before deciding: `{ household_name, display_name,
email, role, role_label, invited_by, expires_at }`. Rate-limited.
  - `POST /api/v1/invitations/{link_token}/accept` — **unauthenticated**.
    `{ code, password }` → `201` with the same token set as a sign-in. The
    code is compared case- and punctuation-insensitively. A wrong code is
    `401 invitation_code_wrong` and says how many tries are left; after five
    the invitation is dead. Anything else wrong with the link — unknown,
    expired, revoked, already used, locked — is `404 invitation_not_valid`
    with one message, so a link cannot be probed for its state.

  Creating a second invitation for the same person revokes the first: nobody
  holds two live links.

- Passwords. A member's scope key is wrapped by a key derived from their
  password, so both routes below rewrap it: with the current password it is
  unwrapped with the old credential and rewrapped with the new one, and without
  it the key comes back through the master key and is given a fresh wrap.

  - `POST /api/v1/auth/password/change` (bearer) — `{ current_password?,
new_password }` → `204`. `current_password` may be omitted only by a
    session that has stepped up within the last five minutes
    (`403 step_up_required`, action `change_password`), which is how somebody
    who signs in with a passkey sets a first password. `401
invalid_credentials` for a wrong current password — note that this is _not_
    a dead session. Revokes every other session for the account.
  - `POST /api/v1/auth/password/forgot` — **unauthenticated**, `{ email }` →
    `202` with a fixed message, identical for a known and an unknown address.
    When the address is known, an `alert.send` job carries a one-time link to
    it, email only.
  - `GET /api/v1/password-resets/{token}` — **unauthenticated**:
    `{ household_name, email, issued_by_operator, expires_at }`.
  - `POST /api/v1/password-resets/{token}` — **unauthenticated**,
    `{ password }` → `200 { email }`. Deliberately returns **no session**: an
    account with two-step sign-in must still be asked for its code. Revokes
    every session for the account. A link lives one hour, is good once, and
    asking for another retires the first.

  Every dead link — unknown, spent or expired — is `404 reset_not_valid`.

  There is **no endpoint by which one member resets another's password**, and
  a test asserts the obvious spellings all 404. An owner who could do it could
  sign in as that person and read their private documents. A household with no
  mail server uses `cli.mjs reset-password <email>`, which is available to
  whoever holds the master key and therefore can read everything anyway.

- The household activity log (SHR-07). `GET /api/v1/audit?before=&limit=` →
  `{ items: [{ id, at, text, notable, document_id }], next }`, newest first.
  `text` is the whole sentence and is safe to show verbatim; `next` is the id
  to pass as `before` for the page after. Owners, adults and teens
  (`audit.read`); a viewer is refused.

  Lines about a private document are returned only to the member it belongs to,
  and adults-only documents only to adults — **left out, not redacted**, so
  there is no gap where one used to be. Actions that cannot be said in a
  sentence (step-ups, reminder housekeeping, dismissed suggestions) are not in
  this list; they remain in the hash-chained log, the nightly verification and
  the export. An event with no signed-in actor, such as a shared link being
  opened, is attributed to its label.

- **Changed:** `POST /api/v1/documents/{id}/visibility` answers `200
{ notice }` instead of `204`. `notice` is `{ title, body }` the first time a
  given member makes a given document private, and `null` every other time —
  the SEC-19 moment, said once and never repeated for that document.

- Share links (SHR-05). A link carries a 32-byte secret; the server stores only
  its SHA-256, so it is shown once at creation and can be replaced but never
  recovered. An optional PIN is four digits, hashed with Argon2 and guarded by a
  ten-attempt counter.

  - `POST /api/v1/documents/{id}/share` — `{ expires_in_days?, recipient_label?,
with_pin? }` → `201 { share, link_token, pin? }`. Adults only
    (`document.share`). `422 nothing_to_share` when the document has no file on
    it. Somebody else's private document is `404`, not `403`.
  - `GET /api/v1/shares` — every live and dead link the caller may know about,
    with `open_count`, `last_opened_at`, `state` (`active`, `expired`,
    `revoked`, `locked`) and a `summary` sentence. Links to a private document
    appear only for its owner.
  - `DELETE /api/v1/shares/{id}` — revokes it, `204`.
  - `GET /api/v1/shared/{link_token}` — **unauthenticated**:
    `{ household_name, needs_pin, expires_at, document_title, shared_by }`.
    `document_title` is `null` while a PIN is outstanding.
  - `POST /api/v1/shared/{link_token}/open` — **unauthenticated**, `{ pin? }` →
    the document's details. This is the call that counts as an open and writes
    `share.opened` to the audit log under an actor _label_ rather than an
    account. `401 pin_wrong` for a bad PIN.
  - `GET /api/v1/shared/{link_token}/content?pin=` — **unauthenticated**; the
    file, with `Cache-Control: private, no-store` and
    `X-Robots-Tag: noindex, nofollow`. Logged as `share.downloaded`, which does
    not count as a second open.

  Every dead end — unknown, expired, revoked, locked, or a document moved to
  the trash — is `404 link_not_valid` with one message.

- Co-owners (bearer; owner, and all of them ask for step-up).

  - `POST /api/v1/members/{id}/role` — `{ role }` → `{ applied, role, request?, message }`.
    `message` is written for a person and safe to show. Promoting and any
    change to a non-owner applies at once (`applied: true`). Taking the owner
    role off somebody else answers `applied: false` with a `request`: nothing
    has changed yet. `422` for your own role, `409 already_requested` when one
    is already waiting.
  - `POST /api/v1/me/step-down` — `{ role }`. Immediate, as long as another
    owner remains.
  - `DELETE /api/v1/members/{id}/sign-in` — `204`. The member row, their
    documents and their scope key stay; their sessions are revoked.
    `409 owner_notice_required` for an owner.
  - `GET /api/v1/owner-changes` — every member sees these, because one may be
    about them: `{ items: [{ id, target_member_id, target_name,
requested_by_name, action, requested_at, opens_at, lapses_at, state,
about_me, summary }] }`, `state` one of `waiting`, `ready`, `refused`,
    `completed`, `lapsed`. `summary` is a sentence.
  - `POST /api/v1/owner-changes/{id}/refuse` — only the person it is about;
    `403` otherwise.
  - `POST /api/v1/owner-changes/{id}/complete` — any owner, once `opens_at`
    has passed. `409 notice_period` before then, `409 request_lapsed` after
    thirty days.
  - `DELETE /api/v1/owner-changes/{id}` — any owner withdraws it.

  A role change takes effect on the next request, not on the next token: the
  `role` in an access token is advisory and the server reads the live one.

  A household always keeps at least one owner. That is a deferred constraint
  trigger, so the last owner cannot be demoted or removed by any route,
  including one that does both halves of a swap in a single transaction.

- New-device alerts (SEC-11). A sign-in from a user agent an account has not
  used before enqueues `alert.send`, delivered by push and by the household's
  mail server at once rather than in the daily digest. There is no preference
  to switch it off. The first device an account uses is never an alert.

- Roles. Every endpoint that refuses on the grounds of a role now answers
  `403 { "error": { "code": "forbidden", "message": … } }`, where `message`
  says who _can_ do it and is safe to show verbatim. The check runs before
  the body is validated, so a caller who is not allowed is told that rather
  than being told about their form. An adults-only document remains absent
  rather than refused (`404`) for teens and viewers, in listings, in search
  and by id — telling them it exists would be the leak.

- Privacy fixes (0.4.2). Each of these closed a route across the privacy wall;
  clients that relied on the old behaviour were relying on the leak.

  - `GET /api/v1/exports`, `GET /api/v1/exports/{id}` and
    `GET /api/v1/exports/{id}/content` answer only for the person who asked for
    the export. Anybody else, an owner included, gets `404` — an export holds
    its requester's _Only me_ documents. The list no longer shows other
    people's exports.
  - `GET /api/v1/shares` and `GET /api/v1/tags` apply the same visibility rule
    as every other list: teens and viewers no longer see links to, or tags on,
    adults-only documents, and nobody sees another member's private ones.
  - A member who has ever had a sign-in cannot be invited again:
    `POST /api/v1/invitations` (with `member_id`),
    `POST /api/v1/members/{id}/invite` and
    `POST /api/v1/invitations/{token}/accept` answer
    `409 { "error": { "code": "had_sign_in" } }`. Their private documents are
    locked to their own password, and an invitation would hand them to whoever
    holds its link and code.
  - **New:** `POST /api/v1/members/{id}/sign-in` (owner; step-up
    `change_people`) — `{ "role": "adult" | "teen" | "viewer" }` → `200
{ "message" }`. Gives a removed sign-in back to the same account, which
    signs in with its own password as before. `409 already_signed_in`, or
    `409 no_sign_in_to_restore` when there is no removed sign-in to give back.
  - `GET /api/v1/members` items gain `sign_in_removed: boolean` — true when the
    person's sign-in was taken away and can be given back.
  - `POST /api/v1/devices` ties the device to the session that registered it,
    and nothing is pushed to it once that session ends — signed out, revoked,
    or expired. A password change removes the account's devices on every
    other session; a reset removes them all.

## Deprecations in effect

None.
