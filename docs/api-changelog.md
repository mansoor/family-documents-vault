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

## 0.6.0

The Phase 5 release: the first on `main` since 0.4.5 (0.5.x were development
tags). This is the summary for client authors; each item is given in full
under "After 0.5.0 (Phase 5)" in [Unreleased](#unreleased). Nothing a 0.4.x
client calls is gone: `min_client_version` stays `0.0.1`, and the phone app
needs a vault of 0.4.10 or later.

- **New `features`**, each `true` from the release that shipped it:
  `custom_types`, `collections`, `reminder_dates`, `member_photos`,
  `share_options`, `collection_shares`, `share_second_factor`,
  `share_email_code` (only with the operator's mail server, `FDV_SMTP_URL`),
  `remove_for_good`, `member_edit`, `upload_requests`, `member_identity`,
  `member_admin`, `sign_out_everywhere`, `access_restrictions`, `guests` and
  `detail_suggestions`. New `limits`: `share_max_days`, `guest_max_days`.
- **Two callers without a sign-in.** A share link is looked at and opened
  with its token in a body (`POST /api/v1/shared/preview`, `/code`,
  `/unlock`); what it gives is fetched inside a session cookie scoped to
  `/api/v1/shared` (`GET /api/v1/shared/items`, `/items/{id}/content`,
  `/items/{id}/pages/{n}`). Somebody sending documents to a request does the
  same under `/api/v1/drop`. Neither cookie opens anything else, and a link
  made since 0.5.14 opens nothing on the old token-in-path routes.
- **New for the family:** kinds of document and their fields; collections,
  and links to them; reminders from any date a kind shows; a person's
  details, photo and identity record (sealed, masked, revealed with a
  passkey or a code); notes; removing a document for good; requests to send
  documents, and looking at what came in before it is filed; suggestions
  from a document's pages.
- **New for owners**, each with two-step sign-in or a passkey, asked again
  with one of those and never the password (`403 totp_required_for_owner`,
  `403 step_up_required`): the view of somebody's sign-in, locking it,
  starting a password reset, signing somebody out everywhere, limiting what
  a viewer sees, a guest's sign-in, who reads identity details, writing
  another person's identity details, and whether Only me documents can be
  shared outside the family.
- **New:** making a document Only me asks what becomes of the person's own
  links to it (`409 links_choice_needed`, `own_links`), and a household
  rule decides whether Only me documents go outside the family at all
  (`/api/v1/household/sharing`).
- **Changed for viewers** (a guest is a viewer, `kind: "guest"` on `/me`):
  no birthdays, household answers or household suggestions (5.3); a limited
  viewer is given only their grant (5.33); `physical_location` is `null`
  (5.41), and no status ever says a document needs it; no suggestions from
  pages (5.37).
- **Changed:** a restore pauses every link, every request to send
  documents and every sign-in but the owners', until an owner turns each
  back on (`GET /api/v1/after-restore`).
- **Changed (breaking, only for a client written against a 0.5.12–0.5.17
  development tag):** lists are collections, `/api/v1/collections`, with no
  alias (5.17b). 0.4.5 had neither.
- **Deprecated, removed in 0.9.0:** the token-in-path routes of share links,
  password resets and invitations; see
  [Deprecations in effect](#deprecations-in-effect).

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
  (revoked, expired or replayed), `422 validation_failed`, `429 rate_limited`
  with `Retry-After` on the auth endpoints (10 requests per minute per
  address) and everywhere else (300 per minute).

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
    is already waiting or ready. A lapsed one does not count: asking again
    after it opens a new request.
  - `POST /api/v1/me/step-down` — `{ role }`. Immediate, as long as another
    owner remains.
  - `DELETE /api/v1/members/{id}/sign-in` — `204`. The member row, their
    documents and their scope key stay; their sessions are revoked.
    `409 owner_notice_required` for an owner.
  - `GET /api/v1/owner-changes` — every member sees these, because one may be
    about them: `{ items: [{ id, target_member_id, target_name,
requested_by_name, action, requested_at, opens_at, lapses_at, state,
about_me, summary }] }`, `state` one of `waiting`, `ready`, `refused`,
    `withdrawn`, `completed`, `lapsed`. `summary` is a sentence.
  - `POST /api/v1/owner-changes/{id}/refuse` — only the person it is about;
    `403` otherwise, `409 already_settled` once refused, withdrawn or
    completed, `409 request_lapsed` once it has lapsed.
  - `POST /api/v1/owner-changes/{id}/complete` — any owner, once `opens_at`
    has passed. `409 notice_period` before then, `409 request_lapsed` after
    thirty days, `409 no_longer_owner` if the person is not an owner any
    more.
  - `DELETE /api/v1/owner-changes/{id}` — any owner withdraws it.
    `409 already_settled` once settled, `409 request_lapsed` once lapsed.

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
  - Share links (`/api/v1/shared/{token}`…) answer `404` once the person who
    made the link could no longer open the document themselves — made private
    by its owner, maker demoted, or maker's sign-in removed. Checked on every
    open.
  - Exports expire when their requester is demoted to teen or viewer or has
    their sign-in removed.
  - `PATCH /api/v1/documents/{id}` refuses to change `owner_member_id` of a
    private document (`422`) or of one that belongs to another member with a
    sign-in (`403`).
  - Step-up: a new action, `change_sign_in`, for
    `POST /api/v1/auth/passkeys/challenge`, `POST /api/v1/auth/passkeys` and
    `DELETE /api/v1/auth/passkeys/{id}`. `POST /api/v1/documents/{id}/share`
    asks `open_private_document` for a private or Essential document. Clients
    should treat `action` as opaque and show the server's message.
  - `POST /api/v1/auth/totp/enrol` answers `409 totp_already_on` while two-step
    sign-in is on.
  - A teen uploading a version to somebody else's document gets `403`.
  - `404`, not `403`, for another member's private document from
    `POST /documents/{id}/visibility`, `DELETE /reminders/{id}`,
    `DELETE /shares/{id}` and `GET /versions/{id}/content`.
  - `POST /api/v1/password-resets` completion also removes the account's
    passkeys. `POST /api/v1/auth/password/forgot` sends a link only through the
    operator's mail server (`FDV_SMTP_URL`), or through the household's to its
    only owner; its answer is unchanged either way.
  - `POST /api/v1/invitations/{token}/accept` takes an optional `email`: the
    address the new account signs in with, chosen by the person joining.
    `409 email_taken` if it is somebody's already. Creating an invitation for a
    person who already has a pending one answers `409 already_invited` unless
    the caller made it or is an owner. `409 had_sign_in` also covers a person
    with no sign-in who owns private documents.
  - `POST /api/v1/auth/totp/enrol` and `/confirm` ask for step-up
    `change_sign_in`. `GET /api/v1/exports/{id}/content` asks for
    `export_everything`.
  - Uploads: an `Idempotency-Key` already used on another document answers
    `422 idempotency_key_reused`; a replay on the same document still returns
    the original version. `POST /api/v1/capture` with a key it has seen returns
    the original `{ document_id, version_id }` and creates nothing. An upload
    that completes after the document's visibility or owner changed answers
    `409 document_changed` (`retriable: true`).
  - `POST /api/v1/devices` ties the device to the session that registered it,
    and nothing is pushed to it once that session ends — signed out, revoked,
    or expired. A password change removes the account's devices on every
    other session; a reset removes them all.

- Capabilities that tell the truth (0.4.4).

  - `server_version` is the release (for example `0.4.4`). Every earlier
    server answered `0.0.1`, whatever it was.
  - `features.push` is `true` exactly when the vault can send Web Push (its
    VAPID keys are configured) — the same fact as
    `GET /api/v1/notifications/push-key` `enabled`. `features.share_links`
    is `true`. Both were hard-coded `false` although both had shipped.
  - **New, additive:** `instance_id`, a random UUID made once per
    installation and never changed. A client that approved a vault at an
    address can tell whether the same vault still answers there. Absent from
    older servers; clients must treat it as optional.

- A lapsed owner change is over (0.4.6).

  - `POST /api/v1/members/{id}/role` on an owner whose earlier request
    lapsed opens a new request. Until 0.4.6 it answered `409
already_requested` for ever, about a request no client showed.
  - Refusing or withdrawing a lapsed request answers `409 request_lapsed`;
    until 0.4.6 either one settled it.
  - Two owners asking at the same moment: one gets the request, the other
    `409 already_requested` (it was a `500`).

- How an owner change ends (0.4.7).

  - **New, additive:** `state` `withdrawn`, for a request that ended without
    a refusal: an owner withdrew it, the person it was about stepped down,
    or a restore from a backup withdrew it. `summary` says which. Until
    0.4.7 a withdrawal answered `refused`. Treat a `state` you do not
    recognise as settled.
  - `POST /api/v1/me/step-down` closes the requests about the caller.
  - `POST /api/v1/owner-changes/{id}/complete` answers `409
no_longer_owner` when the person has stopped being an owner since.

- Uploads you can retry (0.4.8, `features.idempotent_capture`).

  - `POST /api/v1/capture` and `POST /api/v1/documents/{id}/versions` are
    reserve-then-commit on their `Idempotency-Key`: a retry with the same
    key never makes a second document or version, however the tries
    overlap, and a failed try leaves nothing behind (not even an empty
    Needs-info document), so the same key works again.
  - A retry of a finished upload answers `201` with what the first try made
    and the header `Idempotent-Replayed: true` — only to the account that
    made it, for the same request, while it can still see the document.
  - A try that overlaps one still running (for less than 15 minutes) answers
    `409 upload_in_progress`, `retriable: true`, `Retry-After: 5`. Wait, and
    retry with the same key. A try older than 15 minutes is taken over.
  - **Changed:** a key used for another request, another document or by
    another account answers `409 idempotency_key_reused` (it was `422`), and
    never says what the key made.
  - **Tightened:** the key must be a UUID written 8-4-4-4-12; any other
    form answers `422 validation_failed`.
  - **New, additive:** `GET /api/v1/uploads/{key}` — bearer; one of the
    caller's own keys: `{ state: "done", document_id, version_id }` or
    `{ state: "in_progress", since }`. A key never seen, someone else's, or a
    try that failed answers `404 not_found`.
  - **Fixed:** every `429`, from the general limit or an endpoint's own, is
    the error envelope with `code: "rate_limited"`, `retriable: true` and a
    `Retry-After` header. It answered `bad_request` with `retriable: false`.
    `503 storage_unreachable` now carries `Retry-After: 30`.
  - **Fixed:** a file cut off at the size limit on the way in answers `413
too_large` and is not kept. Until 0.4.8 the part that arrived was stored
    as a new version before the `413`.

- A capture that knows what it is (0.4.9, `features.capture_metadata`).

  - `POST /api/v1/capture` takes an optional `metadata` field, sent **before**
    the file: JSON with any of `type_key`, `title`, `owner_member_id`,
    `visibility`, `issued`, `expires`, `identifier`, `physical_location`,
    `is_essential`, `tags` and `notes`, as `POST /api/v1/documents` takes
    them. The document is made with them, and its file is wrapped for the
    people they say from the first byte: an Only me capture is never, even
    briefly, readable by anyone else. `category` and the type's other
    defaults follow from `type_key`. Without `metadata` the document is
    filed as Needs info, as before.
  - The details are checked before the upload is claimed, so a refusal
    stores nothing and the same key works again: `422 validation_failed`
    with the same messages `POST /documents` gives; `403 forbidden` for a
    teen filing a document for somebody else. Also refused: Only me for a
    document that is not the caller's (whatever the type's default), an
    expiry for a type that does not expire (or with no type), and a date
    whose precision it does not agree with — a month is sent as its last
    day and a year as 31 December, as `parseDateInput` makes them.
  - A teen never files a document as Adults only (they could not see it):
    asking for it answers `403 forbidden`, and a type whose default is
    Adults only is filed for everyone instead. `POST /api/v1/documents`
    keeps the same rule. A document filed Only me records that its owner
    was told what that means, as a visibility change does.
  - The details may also be sent as a file part (a Blob of JSON, up to
    64 KB) or as a field typed `application/json`. Anything else answers
    `422 validation_failed` and nothing is kept: a field or file after the
    file ("Send the details before the file."), a file part not named
    `file`, any field but one `metadata`, and details that are not JSON. A retry of a finished capture answers with what it
    made, whatever details it carries.
  - `@fdv/client`: `capture(token, { file, metadata? }, key)`; a body
    already built is still accepted. `@fdv/shared`: `checkCaptureMetadata`,
    `autoTitle`, `reminderSentence`, and `parseDateInput` now reads
    "14 Mar 2031", "March 2031", "March 14, 2031" and, given the reader's
    order, "14/03/2031".

- Who issued it (0.4.10, `features.issued_by`).

  - **New, additive:** `issued_by` (text, up to 200 characters) on document
    views, `POST`/`PATCH /api/v1/documents` and capture metadata. It is kept
    as typed, with spaces tidied; blank is `null`. A vault without
    `features.issued_by` refuses the field (`422`), so send it only to one
    that has it.
  - **New, additive:** `issued_by_label` on document types: the type's own
    word for it ("Institution", "Provider", "Insurer"…), `null` for "Issued
    by". The types' own fields that held it (institution, provider, lender,
    issuer, insurer, employer, vendor, vet, issuing country) are no longer
    in their `fields`; values stored under them in `extra` moved to
    `issued_by` (migration 0025, which leaves `updated_at` alone).
  - **Changed:** every document's ETag is new in 0.4.10, so a `PATCH` made
    with an `If-Match` from before the upgrade is refused (`412`) instead of
    putting an old `extra` back — fetch the document again. A client that
    syncs with `updated_since` should fetch everything once after upgrading:
    the move above does not change `updated_at`.
  - `GET /api/v1/documents?issued_by=` filters by it, regardless of case.
    Search matches it (weighted with the tags, below the title), takes
    `issued_by` as a filter too (the second, private pass keeps it), and
    each hit carries `issued_by` and `issued`.
  - **New:** `GET /api/v1/issuers?q=&type_key=&member_id=&category=` — the
    household's issuers the caller can see, one spelling each (the one used
    most), most used first; with `type_key`, only those who have issued
    that type: `{ items: [{ issued_by, count }] }`. An issuer seen only on a
    document the caller cannot see is not there.
  - **New:** `GET /api/v1/documents/{id}/issuer-suggestions` — who probably
    issued it, from its latest pages and the household's issuers:
    `{ state, items: [{ value, source }] }`, where `state` is `ready`,
    `pending` (the pages have not been read yet) or `unavailable`, and
    `source` is `known` or `page`. Offered, never filled in;
    `cache-control: no-store`. Needs the right to change the document.

- Sessions a phone can live with (0.4.11).

  - **New, additive:** the `X-FDV-Installation` request header — a UUID an
    app makes once and keeps — read on setup, password and MFA sign-in,
    passkey sign-in, invitation acceptance and refresh. A session records
    the installation that signed in. `@fdv/client` sends it when given
    `installationId`. Browsers send none.
  - **Changed:** new-device alerts key on the installation when there is
    one: an app update is not a new device; a second phone is. Browsers
    are recognised by their user agent, as before.
  - **New:** a refresh token that has just been replaced may be presented
    once more — within 30 s of its rotation, from the session's own
    installation — and gets a new rotation (audited as
    `auth.refresh_replayed`); the token it displaces becomes the previous
    one. Both the replayed token and the one it displaced are kept for the
    session's life: presented again, however many rotations later, either
    ends the session. Every other replay ends the session, as before. A
    browser never gets this.
  - **Changed:** sessions slide. Each refresh sets the session's end to 30
    days from now, but never past 180 days from the sign-in, and
    `refresh_expires_in` says what is really left. Sessions open before
    the upgrade get their 180 days from when they began.
  - **New, additive:** `401 session_ended` carries `error.reason`:
    `expired`, `revoked`, `reused`, `removed` or `malformed` — on refresh,
    and on any request with a token whose session has ended. `reused`
    means a spent token was presented and that ended the session; a
    refresh token the vault does not recognise at all is `revoked`.
    `detail` stays a free-text string.
  - **New, additive:** `GET /api/v1/auth/sessions` items carry `client`
    (`app`, `browser` or `other`) and `label` ("the app on a Google Pixel
    8a", "Firefox on a Mac").

- Pages the vault draws (0.4.12, `features.page_previews`).

  - **New:** `GET /api/v1/versions/{id}/pages/{n}` — page `n` (from 1) of a
    version, as a JPEG 1600 px on its long edge, with no metadata, sent
    `Cache-Control: private, no-store`. Checks run in this order: a version
    the caller may not see is `404 not_found`, exactly as one that does not
    exist; then an Essential or an "only me" document may answer `403
step_up_required`; then the page. A page not drawn yet is queued and
    answered `404 preview_pending` (`retriable: true`, `Retry-After: 3`);
    ask again. A file the vault cannot draw (Word, Excel…), a page past the
    last, or past the 30th, is `404 no_preview`: open the file itself. Every
    page served is audited as `document.viewed` (`detail: { version_id,
page }`); fetch a page when it is looked at, not ahead of time.
  - **New, additive:** `preview_pages` on versions: how many pages are drawn
    (at most 30); `null` until they are, or while a drawing is still being
    tried; `0` when there will be none — a file the vault cannot draw, or one
    it gave up on after three tries (a page then answers `no_preview`). An
    Essential given up on is tried again when the worker next starts, a day
    later at the soonest. `page_count` is the document's real length, which
    can be more than is drawn. Essentials are drawn as soon as they are
    processed or marked Essential; others the first time a page is asked for.
  - **New:** the step-up action `open_essential` ("to open an Essential
    document"), asked when opening an Essential's file or pages, or making a
    link to it. `open_private_document` stays for "only me" documents, and
    wins when a document is both. Treat actions as opaque: show the message.
  - **Changed:** the thumbnail of an Essential or an "only me" document is
    sent `Cache-Control: private, no-store`; others stay `private,
max-age=3600`.
  - **New:** the activity log says "looked at" for page views, one line per
    sitting (one person, one document, each view within ten minutes of the
    next).
  - `@fdv/client`: `page(token, versionId, n)`. The fake draws nothing: a
    version it made is `preview_pending` until a test sets
    `state.pages.set(versionId, count)`. `@fdv/shared`: `PREVIEW_MAX_PAGES`,
    `describeEvents()`.

- Essentials a phone may keep (0.4.13, `features.offline_essentials`).
  - **New:** `POST /api/v1/offline/grant` `{password, include_private?}` →
    `{granted_at, expires_at, include_private}`: this session may fill its
    phone until `expires_at` — 30 days at most, never past the session's
    own end. The password itself, not a code. Refusals: `422` from a
    session with no installation id (only an app keeps documents), `401
invalid_credentials` for a wrong password, `403` for viewers; 10 a
    minute. `DELETE /api/v1/offline/grant` ends it (`204`); so does
    anything that ends the session, and a password change (on this device
    or another). It never relaxes the step-up on
    `/content` or `/pages`.
  - **New:** `GET /api/v1/offline/essentials` → `{items: [{document,
version: {id, mime, page_count, preview_pages, preview_state},
private}], grant, max_offline_days, server_time, truncated}` — the
    complete set this person's phone may keep, at most 500: **what is not
    in it is to be removed from the phone.** With no grant in force (never
    given, ended, or lapsed) it is empty: keep nothing. Essentials the person can see,
    not in the bin, with a file; teens only their own; viewers none; the
    person's own Only me ones only under a grant with `include_private`.
    `mayKeepOffline()` in `@fdv/shared` is the same rule.
  - **New:** `GET /api/v1/offline/pages/{version_id}/{n}` — a page for the
    phone's copy. Visibility first (`404`, as a version that does not
    exist), then the current version of an Essential in the set (`404`),
    then the grant (`403 offline_grant_required`). Otherwise as
    `/versions/{id}/pages/{n}` (`preview_pending`, `no_preview`), without a
    step-up. Recorded once per session and version as
    `document.cached_offline`, not per page.
  - **New:** `POST /api/v1/offline/opens` `{events: [{id, version_id,
opened_at, mode: 'view'|'show', online}]}` (at most 200) → `{accepted,
duplicates, dropped}`. Each event id is recorded once, however often
    it is sent, as `document.opened_offline` on its document; an event
    about something the person cannot see is dropped and writes nothing.
    The record is dated when it arrived; the phone's `opened_at` is kept in
    `detail`, never later than now nor earlier than `max_offline_days` ago.
  - **New, additive:** `offline` on `GET /api/v1/auth/sessions` items: the
    device keeps Essentials. New activity lines: "Sarah's phone kept …
    for offline use", "Sarah opened … on their phone without a connection",
    and the Show and online variants.
  - **Not built:** the specification's general `GET /sync`. A phone keeps
    only the Essentials, so it asks for exactly those.
  - `@fdv/client`: `offlineGrant`, `endOfflineGrant`, `offlineEssentials`,
    `offlinePage`, `offlineOpens`; the fake answers them from
    `state.offlineEssentials`.

- UnifiedPush for the phone app (0.4.14, `features.unified_push`, the same
  fact as `features.push`).
  - `POST /api/v1/devices` takes `kind: 'web_push' | 'unified_push'`
    (default `web_push`). The push address must be `https://` (`422`
    otherwise) and must not point inside the vault's own network — by name
    or written out, an IPv4 address inside an IPv6 one included — unless
    the operator allows it (`422`). A device is bound to the session that
    registered it (and the app installation); the same address registered
    again moves it to the new session.
  - `GET /api/v1/devices` items gain `kind`, `this_session`, `failed_at`
    and `signed_out`: its session expired or was ended, so `working` is
    false and it hears nothing until that device signs in again.
  - **New:** `POST /api/v1/devices/{id}/test` (`202`) sends a test to one
    of your own devices; anybody else's is a `404`, a signed-out one a
    `409 signed_out`.
  - Signing out, `DELETE /api/v1/auth/sessions/{id}`, refresh-token reuse,
    a password change or reset and a removed sign-in now also remove that
    session's push devices. Once that has committed, each UnifiedPush
    device among them is sent `{"v":1,"type":"session_ended"}`, tried again
    for about four hours if its push service does not take it.
  - UnifiedPush messages carry no titles:
    `{"v":1,"type":"digest","count":3,"date":"2026-10-03"}`, `new_device`,
    `owner_change`, `session_ended` or `test`, encrypted per RFC 8291 with
    the vault's VAPID keys. Digests, tests and `session_ended` carry one
    Topic per type (a newer one replaces an older one still waiting);
    alerts carry none, so one never replaces another. The Sunday summary
    is email only.

- The Phase 4 release (0.5.0). Six changes:
  - A push address whose host is `localhost`, or ends in `.localhost`, is
    refused (`422`) by its name, as `127.0.0.1` is — whatever DNS answers
    for it.
  - Every answer carries `Cache-Control: no-store` unless its route says
    otherwise (`private, no-store` for files and pages). That includes
    `GET /api/v1/capabilities`, which was `public, max-age=300`: it says
    which vault this is and what it runs, so read it fresh every time. Do
    not keep API answers in an HTTP cache; `@fdv/client` sends
    `Cache-Control: no-cache, no-store` (and `cache: 'no-store'`) with every
    request, and its `fresh` request option is gone.
  - Every thumbnail is `private, no-store`. An everyday document's was
    `private, max-age=3600`.
  - **New:** every answer carries `X-FDV-Server-Version`, the same version
    as the capability document's `server_version`. An app that sees a
    different one knows the vault was upgraded (or rolled back) and reads
    the capability document again; `@fdv/client`'s `createHttp` takes
    `onServerVersion` to hear it. A vault before 0.5.0 sends none.
  - `GET /api/v1/shares` answers an empty list to anybody who may not share
    (teens and viewers); it used to list every link to a document they
    could see.
  - `POST /api/v1/auth/logout` answers with `Clear-Site-Data: "cache"`, so
    a browser forgets what it kept of the vault. Browsers act on it over
    https and on `localhost` only; apps ignore it.

- After 0.5.0 (Phase 5):
  - `VersionView.uploaded_by_name` — who added the version, by the name the
    household knows them by, in `GET /api/v1/documents/{id}/versions` only.
    Null for a viewer (the activity log's rule: `audit.read`) and when that
    person has left the household; still the name when only their sign-in
    was taken away. Absent from older vaults.
  - `@fdv/client`: `restoreDocument(token, id)`, for the existing
    `POST /api/v1/documents/{id}/restore`.
  - The activity sentences for `document.deleted` and `document.restored`
    say "moved … to the Trash" and "took … out of the Trash".
  - **Changed (5.3), for viewers only** — they are given documents, not the
    family: `GET /api/v1/members` answers `date_of_birth: null` for
    everyone but themselves; `GET /api/v1/profile` answers every household
    answer as null (the name and time zone stay); `GET /api/v1/suggestions`
    answers no items and `profile_answered: null` (the type is now
    `boolean | null`). The fields stay, so older clients read them as
    unknown. New capability `family.details` (owners, adults, teens).
  - **Changed (5.3):** `GET /api/v1/notifications/smtp` answers `provider`,
    `host`, `port`, `username`, `from_name`, `from_email` and `last_error`
    as null to anybody without `notifications.manage` (everyone but owners);
    `configured`, `secure`, `status` and `last_verified_at` stay.
  - **Changed (5.3):** `GET /api/v1/invitations/{token}` shows `email`
    masked ("j•••@example.com"); accepting without an `email` keeps the one
    it was sent to, as before.
  - **Changed (5.4):** taking a check away asks for it (SEC-17).
    `PATCH /api/v1/documents/{id}` with `is_essential: false` on a document
    that is Essential answers `403 step_up_required` with
    `action: "open_essential"` unless a credential was presented in the
    last five minutes; `POST /api/v1/documents/{id}/visibility`, or a
    `PATCH` carrying `visibility`, that takes a document out of `private`
    answers the same with `action: "open_private_document"`. Nothing is
    changed until then. Turning Essential on, making a document private
    and every other edit ask nothing, and a role that may not make the
    change, or a document the caller cannot see, is answered as before
    (`403 forbidden`, `404`). Send these through the confirm-it-is-you flow
    (`POST /api/v1/auth/step-up`) and try again, as a download of the same
    document already is.
  - Document types belong to the household (5.7). A household has types of
    its own, and its own changes to the built-in ones; nothing in the API
    makes either yet (5.11 will), so every list is as it was until then.
    - `GET /api/v1/document-types` items gain `builtin`, `hidden`, `core`,
      `short_label` and `issuer_noun`, and each of `fields` gains
      `required`. `core` is the fixed fields (`identifier`, `issued_by`,
      `issued`, `expires`, `physical_location`, `tags`, `notes`), each
      `{ shown, required, label }`; a null `label` is the app's own word,
      and `issued_by`'s is `issued_by_label`. A field's `kind` may now also
      be `long_text`, `number`, `money`, `choice` (with `choices`) or
      `yes_no`. All absent from older vaults.
    - `GET /api/v1/document-types?all=true` lists every type, hidden and
      archived ones included.
    - **New:** `GET /api/v1/document-attributes` — the fields a type can
      ask for, the vault's and the household's:
      `{ items: [{ key, label, kind, choices, builtin }] }`.
    - A household's own type keys are `h_` and ten base32 characters, and
      never change.
    - **Changed:** a type the household has hidden or archived leaves the
      default list, so it is no longer offered — unless a document the
      caller can see still uses it. That one stays, marked `hidden: true`,
      so a client that looks a document's type up in this list (app 0.2.0
      does, offline, for an Essential's expiry) still finds it.
    - A capture or an edit naming a type the household does not have —
      another household's own included — is refused as an unknown type
      always was: `422 validation_failed`, "That kind of document is not
      on the list."
    - `@fdv/client`: `documentTypes(token, { all })` and
      `documentAttributes(token)`; the fake answers both, the in-use rule
      included.
  - **Changed:** text containing a NUL character (U+0000), in any field of
    any request, is refused with `422 validation_failed`, "That text
    contains a character the vault cannot keep." It was a `500`.
  - A type's details are kept, searched and exported (5.8). A document's
    `extra` holds its type's own fields, by key.
    - **Changed:** `extra` on `POST /api/v1/documents` and
      `PATCH /api/v1/documents/{id}` was taken as it came; it is now
      checked against the type the document will have, as the caller's
      household has it (hidden types included): only its fields' keys, each
      value of its field's `kind` — `text` a string of up to 500
      characters, `long_text` up to 10,000, `date` a `{ date, precision }`
      as every date is sent, `year` a whole year, `number` a number, `money`
      a number with no more than two decimal places, `choice` one of the
      field's `choices`, `yes_no` true or false — and the whole object up to
      16 KB as JSON. Text is kept trimmed, and blank text is no value.
      Anything else — text with a NUL or half a surrogate pair included —
      answers `422 invalid_extra`; `detail` is the key and `message` names
      it. A document with no type has no details to give. Two edits at once
      are measured one after the other, so together they cannot pass the
      16 KB either.
    - **Changed:** `PATCH /api/v1/documents/{id}` merges `extra` into what
      the document holds, and `null` takes a key away — a key the type no
      longer asks for included. Before, `extra` replaced the whole object,
      so a client that showed some of the details wiped the rest, and two
      people editing different details lost one of the edits. A client that
      sends the whole object gets the same result, except that leaving a
      key out no longer deletes it (send `null`). A value sent back exactly
      as the document holds it is left as it is and never refused, so an
      edit never fails on what it did not change.
    - `POST /api/v1/capture`'s `metadata` takes `extra`, checked the same
      way before anything is kept (`422 invalid_extra`, the key in
      `detail`). A vault before 0.5.7 refuses the field, and replaces a
      document's details whole on an edit: send `extra` on a capture, or a
      partial set on an edit, only when the capability document's
      `server_version` is 0.5.7 or later (every vault's types have had
      fields since 0.1, so they cannot tell you). A type the household has
      hidden or archived is still accepted, since a phone queues a scan
      against the list it had.
    - **Changed:** a required field with no value never stops a document being saved.
      It makes the document `needs_info`, in words that name the field:
      "Needs a passport number", "Needs an insurer and an expiry date",
      "Needs a passport number and 2 more details". An expiry that has
      passed or is close is still said first. The built-ins now require: a
      passport its number (`core.identifier`, labelled "Passport number")
      and expiry; a driving licence its expiry; an insurance policy its
      insurer and expiry. Existing documents of those types that lack any
      of them read Needs info from this release on, so `?status=active` and
      `?status=valid` list fewer of them and `?status=needs_info` more. (A
      vehicle registration's `plate`, now labelled "Registration plate", is
      required from the release whose card can ask for it.) An older
      phone never sends `extra`, so its captures of such a type read Needs
      info; nothing is refused. App 0.2.0 works an Essential's status out
      offline without the details, so a passport with a future expiry and
      no number reads Valid on the phone and Needs info on the vault until
      the app is updated.
    - Search matches the details' words and numbers, and a date detail's
      date (not its precision), weighted with the issuer and the tags, and
      shows them in the snippet — for documents the household or the adults
      can see. An Only me document's details are not in the index.
    - The export's `index.csv` gains a column for each detail, named as
      its type names it, guarded against spreadsheet formulas like every
      other cell (the names too); `index.json` carries each document's
      `extra` and a `details` list of `{ key, label }`; `index.html` lists
      them.
    - `@fdv/shared`: `checkExtra`, `checkDetail`, `missingFields`, and
      `CaptureMetadata.extra`, which `checkCaptureMetadata` checks offline;
      `deriveStatus` takes `missing`. `@fdv/client`: `DocumentInput.extra`.
      The fake keeps `extra` on captures, creates and edits (merged, as the
      vault does), answers `GET` and `PATCH /api/v1/documents/{id}` — with
      an `etag`, `409 conflict` for a stale `If-Match`, and `501` for a
      field it does not keep, rather than dropping it — and says the Needs
      info words.
  - Only me notes and details are sealed (5.9). An Only me document's
    `notes` and its type's details (`extra`) are sealed under its owner's own
    key, as its pages' text always has been: from this release on they are
    in no plain column, no search index and no new backup. Those written
    before are sealed when the worker first starts, and by a restore.
    - `GET /api/v1/documents/{id}` gives them to the document's owner as
      before, and so do the answers to creating, editing and restoring it.
    - **Changed:** `GET /api/v1/documents`, and each `document` of
      `GET /api/v1/offline/essentials`, answer an Only me document with
      `notes: null` and `extra: {}`. The reason: a list would have to open
      every Only me document's notes and details to show them, in every
      list, and no client shows them there; they are opened only when their
      owner asks for the document itself. A new field, `has_notes`, says
      whether a document has notes, on every document. A client that reads
      notes from `GET /api/v1/documents/{id}`, as the web and the app do,
      sees no change. Absent from older vaults.
    - An Only me document's `status` still names what it needs ("Needs a
      box number"), in a list too: which details it has is written down,
      unopened, whenever its owner writes them.
    - Search: an Only me document's notes, like its details (5.8), are no
      longer in the index. The second pass (`GET /api/v1/search/sealed`)
      opens them, with its pages, for its owner alone, and a match there is
      `matched_in: "title"`, as the first pass says of a document's own
      words. `sealed_pending.count` counts the caller's Only me documents
      with pages, notes or details to open.
    - The export opens the requester's own Only me documents' notes and
      details, and nobody else's are in it (as before). It is now kept
      under the requester's own key rather than the household's.
    - `@fdv/shared`: `DocumentView.has_notes`, `withSealed`. `@fdv/crypto`:
      `sealPrivate`, `openPrivate`. The fake keeps `notes`, answers
      `has_notes`, and seals an Only me document's notes and details in a
      list; a contract scenario holds the vault and the fake to it.
  - The card asks for a type's details (5.10). No endpoint changes.
    - **Changed:** a vehicle registration's `plate` ("Registration plate")
      is required (`fields[].required: true` in `GET /api/v1/document-types`),
      as 5.8 said it would be once the web's card could ask for it. Nothing
      is refused for want of it: a car without one reads "Needs a
      registration plate", so `?status=needs_info` lists existing cars that
      have none and `?status=active` fewer. An Only me car whose plate is
      sealed counts it as given. A household that has changed the type's
      own fields keeps its own list.
  - Kinds of document, managed (5.11). Owners and adults (`types.manage`)
    add the household's own kinds, change them and the built-ins, and hide,
    archive or delete them. Teens and viewers are refused every one of
    these with `403 forbidden`, "Only an adult can change the kinds of
    document the family keeps.", before the body is read.
    - **New:** `POST /api/v1/document-types` — `{ label, category,
short_label?, issuer_noun?, core?, fields?, reminder_leads?,
default_visibility?, usually_essential? }` → `201` with the kind, as
      `GET /document-types` lists it, and an `ETag`. Its key is `h_` and ten
      base32 characters and never changes, whatever its name becomes.
      `category` is one of the twelve (`identity`, `legal`, `property`,
      `financial`, `tax`, `insurance`, `medical`, `education`, `bills`,
      `work`, `pets`, `other`; `other` if left out). `core` changes the
      fixed fields key by key, each `{ shown?, required?, label? }`:
      `expires.shown` is whether the kind expires at all (one that does and
      names no lead times is reminded 30 days before), and a field is
      required only where it is shown (`422` otherwise, the field in
      `detail`). `expires.required` is always whether the kind expires: a
      document of a kind that expires has always read "Needs an expiry
      date" without one, whatever the rule said, so every kind — a built-in
      whose rule said otherwise, such as a visa, included — now says so, and
      asking for anything else is refused rather than kept and ignored:
      `422 validation_failed`, `detail: "expires"`, "A kind of document that
      expires always needs its expiry date. Switch Expires off instead." (or,
      for one that does not expire, "A field has to be shown to be
      required."). `fields` is the kind's own fields, the whole list in
      order, each `{ key, label?, required? }` naming a field of the
      library by key — its kind and answers are the library's, its label
      the library's unless given (`422`, the key in `detail`, for one the
      library does not have). Names are trimmed and 80 characters at most.
    - **New:** `PATCH /api/v1/document-types/{key}` — any of the same, and
      `hidden` for a built-in; what is left out stays as it is. Send the
      kind's `etag` as `If-Match`: a kind changed since answers
      `409 conflict`, "Someone else changed this kind of document. Reload
      and try again.", with the kind as it now is in `detail`. A built-in
      keeps its name and category (`label`, `category`, `short_label` and
      `issuer_noun` are `422`); the household's change to it is kept beside
      it, and a release's changes to the built-in still reach it. A kind of
      the household's own is archived, not hidden (`hidden` is `422`, on
      `POST` too). Expires switched on for a kind with no lead times is
      reminded 30 days before, as a new kind that expires is, unless the
      change names its own. When its lead times change, or Expires is
      switched on or off, every document of the kind — whoever can see it —
      has its reminders made again by the worker (`types.regenerate`): only
      those whose day is still ahead are made, so a lead added, or Expires
      switched off and on again, never makes a reminder due for a document
      long expired or whose lead day has passed, nor brings back one the
      family already dealt with; a reminder that stays as it was keeps its
      state (done, snoozed or settled). A document's own edit still makes a
      lead whose day has passed due, as filing it does.
    - **Letting more people see a kind by default is an owner's decision**:
      Only me or Adults only to Everyone, or Only me to Adults only. Anybody
      else is refused `403 forbidden`, "Only an owner can let more people
      see a kind of document from now on." An owner who has not confirmed
      it is them in the last five minutes is answered
      `403 step_up_required` with `action: "widen_type_visibility"`, and
      nothing changes until they do. Narrowing asks nothing more than
      `types.manage`.
    - **New:** `POST /api/v1/document-types/{key}/archive` and `/restore` —
      no longer offered for a new document, or offered again; a built-in
      is hidden rather than archived. They answer with the kind. Its
      documents keep it, and it stays in the default list, marked
      `hidden: true`, while a document the caller can see uses it; a
      phone's scan queued against it is still taken.
    - **New:** `DELETE /api/v1/document-types/{key}` — a kind of the
      household's own. The answer depends only on the documents the caller
      can see: while one of them uses it, in the Trash included, it is
      `409 type_in_use`, "This kind of document is still in use, so it can't
      be deleted. Archive it instead: every document filed under it stays
      as it is."; otherwise `204`, and "… deleted …" in the log, whether or
      not documents the caller cannot see (another member's Only me) use
      it — a refusal would say that they exist. A kind no document uses is
      gone. One that only such documents use is deleted for everybody all
      the same: left out of `GET /document-types`, `?all=true` included, for
      anybody who can see none of them; `404` to every change, archive,
      restore, impact and delete, for everybody; refused as not on the list
      by `POST /api/v1/documents`. It still names the documents filed under
      it — their owner finds it in the list, `hidden: true`, and may edit
      them — and is gone for good once none uses it, when the last is filed
      under another kind (nothing purges a document from the Trash yet). A
      built-in is `422`.
    - **New:** `GET /api/v1/document-types/{key}/impact` — what a change
      would touch, for the editor's warnings ("12 passports have no number
      yet"): `{ key, documents, in_trash, core: { <field>: { with_value,
without_value } }, fields: [{ key, label, with_value, without_value }],
reminders, unseen }`. Only the documents the caller can see are
      counted; `unseen` is always "Documents you can't see may also be
      affected.", with no number, so nothing says that somebody's Only me
      documents are of the kind.
    - **New:** `POST /api/v1/document-attributes` — `{ label, kind,
choices? }` → `201` with the field, for the library; a `choice` has at
      least one answer, and nothing else has any.
    - `GET /api/v1/document-types` items gain `etag`. Absent from older
      vaults.
    - **Changed:** somebody who files no documents (a viewer) is given the
      built-in kinds and, of the household's own, only those of documents
      they can see — with `?all=true` too — and of
      `GET /api/v1/document-attributes` the built-in fields and, of the
      household's own, only those a document they can see has a value for,
      so that a detail its kind no longer asks for still has its name. A
      kind's name ("Divorce proceedings") says what the family keeps; a
      viewer is given documents, not the family. Everybody who files
      documents is offered every kind and field, as before.
    - **Changed:** a kind whose default is Only me never files somebody
      else's document, or nobody's, as Only me. `POST /api/v1/documents`
      now refuses it as `POST /api/v1/capture` did: `422 validation_failed`,
      "This kind of document is kept private to the person it belongs to.
      Choose who can see this one." (`detail: "visibility"`). Before, it
      filed the document as the other person's Only me, out of reach of
      whoever filed it, or failed with a `500` when nobody was named. A teen's
      document is theirs from the start, so a teen may now ask for Only me
      without naming themselves, as a capture always could.
    - **Changed:** `POST /api/v1/capture` no longer refuses an expiry date on
      a kind that does not expire, nor one with no kind yet: a scan queued
      while the household's kind still expired, sent after its Expires was
      switched off, was refused for good, while `POST /api/v1/documents`
      kept the same date. Both keep it now; it counts — status and
      reminders — only while the kind expires. `checkCaptureMetadata` no
      longer refuses it offline either.
    - **Changed:** `POST /api/v1/capture` naming a kind the household does
      not have — deleted since the phone queued the scan offline, or never
      its own — files the document with no kind (`type_key: null`) instead
      of refusing it `422` for good. Everything else is kept as sent; its
      details are kept where the field library has the key, read as that
      field's kind, and any other is left out; and, the kind's default
      gone with it, a document sent with no `visibility` is filed for as
      few people as its filer may choose: Only me when it is theirs (a
      teen's always is), else Adults only. Another household's key is not
      seen, and is filed exactly as a key nobody has. Typed in, with
      somebody there to choose, a kind not on the list is still refused by
      `POST /api/v1/documents`.
    - The activity log says, to everyone who reads it: "Sam added a kind of
      document, “Allotment tenancy”", "Sam changed “Allotment tenancy”",
      "Sam archived …" (a built-in: "stopped offering …", and back:
      "offered … again" / "brought back …"), "Sam deleted …", "Sam added
      “Plot size” to the fields a kind of document can ask for", and, marked
      notable when it lets more people see them, "Sam made new “Will /
      trust / power of attorney” documents visible to everyone in the
      family".
    - Suggestions ("No vehicle registration yet") leave out a built-in the
      household has hidden.
    - `@fdv/shared`: capabilities `types.manage` and
      `types.widen_visibility`; `DocumentTypeInput`,
      `DocumentAttributeInput`, `DocumentTypeImpact`, `widensVisibility`,
      `TYPE_IN_USE`, `EXPIRY_ALWAYS_REQUIRED`, `UNSEEN_DOCUMENTS`,
      `PRIVATE_BY_DEFAULT`. `@fdv/client`: `createDocumentType`,
      `updateDocumentType(token, key, body, etag)`, `archiveDocumentType`,
      `restoreDocumentType`, `deleteDocumentType`, `documentTypeImpact`,
      `createDocumentAttribute`; the fake answers all of them as the vault
      does — the kind as it now is in a stale edit's `detail`, `hidden`
      refused on a new kind, names 80 characters at most, a document's
      `issued`, `physical_location` and `tags` kept and counted by impact,
      and a capture naming a kind it does not have filed with none — and
      contract scenarios hold the two to it.
    - The worker's daily digest holds the reminders it sends until it has
      recorded them, so one deleted meanwhile (a document edited, or a
      kind's reminders made again) no longer rolls the digest back to be
      sent a second time; and one household whose digest fails no longer
      stops the others'.
  - Kinds of document: the editor (5.12). The web's Settings → Kinds of
    document uses the endpoints of 5.11; on the wire, one flag and one
    more count.
    - **New:** `features.custom_types: true` in `GET /api/v1/capabilities`:
      the household keeps kinds of document of its own, each under one of
      the twelve categories, and changes the built-ins. A client that
      groups kinds by category, or files a document into one with no
      details, needs nothing new; a document whose kind requires a field
      it has no value for is Needs info, naming it. Absent from older
      vaults.
    - `GET /api/v1/document-types/{key}/impact`'s `fields` lists, after
      the kind's own, every other field one of the documents it counts
      keeps a value for — one the kind dropped, kept under Other details
      — with `label: null`. So an editor that shows it again as required
      says how many would need it, as Needs info will; a field not listed,
      none of them has. The fake counts the same, and the contract holds
      both to it (the 5.12 review).
    - `@fdv/shared`: `CapabilityFeatures.custom_types`, `leadWords` (the
      reminder sentence's words for a lead time). The fake answers
      `features.custom_types`, and `GET /api/v1/documents/{id}/versions`
      with each version's `uploaded_by_name` — null for a viewer, as the
      vault answers (its `state.role` says who is signed in) — and a
      contract scenario holds the vault and the fake to both.
  - Lists of documents (5.14, `features.lists`). A list is a name, a few
    words, who it is for, and the documents on it in the order they were
    put there. It never widens who may see a document.
    - **New:** `GET /api/v1/lists` → `{ items: [ListView] }`, by name.
      `ListView` is `{ id, name, description, audience, owner_member_id,
mine, item_count, created_at, updated_at, etag }`. `item_count` is how
      many of its documents the caller can see, out of the Trash: never how
      many they cannot, and nothing else says so either.
    - **New:** `POST /api/v1/lists` `{ name, audience, description? }` →
      `201` with the list (`ListDetail`: the view, the first page of its
      `items`, `next_cursor` and `has_more`) and its `ETag`. `audience` is
      `everyone` (owners, adults and teens), `teens` (the same, for now),
      `adults` (owners and adults) or `only_me` (its maker alone). The
      name is tidied, 1–80 characters (`422
validation_failed`, `detail: "name"`); what it is for, 1000 at most;
      with no audience, `422` (`detail: "audience"`). Owners, adults and
      teens (`list.manage`): a viewer is `403 forbidden`, "Viewers can open
      and download documents, but not make lists of them." A list is for an
      audience its maker is in: a teen's for the adults is `403`, "Only an
      adult can make a list for the adults."
    - **New:** `GET /api/v1/lists/{id}` → `ListDetail`, with `ETag`.
      `items` is `[{ document, added_at, hint }]`: the documents on it the
      caller can see, out of the Trash, in the order they were put there,
      each as the document list gives it (an Only me one's notes and details
      sealed). `hint` is for the list's maker only — "Teens in this list’s
      audience can’t see this one.", "Only you can see this one. It is
      private." — and null for everybody else.
    - `items` come a page at a time, as `GET /api/v1/documents` gives
      documents: `?limit` (1–200; 50 unasked) and `?cursor`, the last
      page's `next_cursor`, which is null, with `has_more: false`, on the
      last page. `item_count` is all of them the caller can see, on every
      page. A cursor names the last document the caller was given and
      nothing else; one naming anything else — a document taken off the
      list since, or out of the caller's sight — is `422
validation_failed`, "That page cursor is not valid.", whatever it
      names: start again from the first page.
    - **New:** `PATCH /api/v1/lists/{id}` `{ name?, description?,
audience? }`, made to the list as the caller saw it: a stale
      `If-Match` is `409 conflict`, with the list as it now is in `detail`.
      `DELETE /api/v1/lists/{id}` → `204`: gone for everybody; its
      documents are untouched. A change answers with the list as `GET`
      gives its first page, read once the change is made.
    - **New:** `POST /api/v1/lists/{id}/items` `{ document_ids }` (1–200) →
      the list: put on at the end, in the order given, each once; one
      already on it stays where it is. Each must be one the caller can see,
      out of the Trash: if any is not, none is put on, and the answer is
      `404 not_found`, "That document is not in the vault.", as for one that
      does not exist. `DELETE /api/v1/lists/{id}/items/{documentId}` →
      `204`; one not on it is `404`.
    - **New:** `GET /api/v1/documents/{id}/lists` → `{ items: [ListView] }`:
      the lists it is on, of those the caller may see. One in the Trash is on
      none until it is brought back; one the caller cannot see is `404`.
    - Only a list's maker changes it: anybody else in its audience is
      `403 forbidden`, "Only the person who made this list can change it.";
      anybody outside it, `404`, exactly as for a list that does not exist. A
      viewer sees no list at all, not even one for everyone, until a later
      release lets one be granted to them: `GET /api/v1/lists` answers
      `{ items: [] }`.
    - A list's maker keeps it, whatever their role now. Made a teen or a
      viewer, they still see it (`mine: true`, in `GET /api/v1/lists`, by
      id and among a document's lists), with the documents on it their
      role now may see, counted so, and they may `DELETE` it, a viewer
      too; its lines in the activity log are theirs as well (a viewer reads
      no log). Once they are outside its audience they may no longer
      change it: `PATCH` and its items are `403 forbidden`, "This list is
      for people you are no longer one of. You can still delete it, but not
      change it." (a viewer is told what a viewer is told of any change).
    - When nobody may change a list any more — its maker is outside its
      audience now, or has no sign-in in the household — an owner who can
      see it may `DELETE` it: `204`, and "Owner deleted the list “…”" in
      the log, as for its maker. They never change it (`403`, "Only the
      person who made this list can change it.") and are given no more of
      it than they see anyway; anybody else is `403` as before. An Only me
      list whose maker has no sign-in stays invisible to everybody, an
      owner too: it is kept as it is, and is its maker's again with their
      sign-in.
    - A document taken to the Trash, or made somebody else's Only me, is
      gone from every list at once for whoever can no longer see it; brought
      back, it is where it was. A list's `updated_at` and ETag move with its
      name, words and audience, never with what is on it.
    - The activity log: "Sam made the list “Holiday”", "Sam renamed a list,
      now “…”", "Sam changed the list “…”" (its words or audience) and "Sam
      deleted the list “…”", to the list's audience as it is now; "Sam added
      “Passport” to the list “Holiday”" and "Sam took “…” off the list “…”",
      one line per document, to whoever may see both the document and the
      list. The log keeps a list's id, never its name.
    - `features.lists: true` in `GET /api/v1/capabilities`. Absent from
      older vaults.
    - A copy of everything (`POST /api/v1/exports`) is unchanged: it holds
      documents, not lists.
    - `@fdv/shared`: capability `list.manage`; `LIST_AUDIENCES`,
      `canSeeList` (a list's maker always), `inListAudience`,
      `listItemHint`, `LIST_HINT_TEENS`, `LIST_HINT_PRIVATE`,
      `LIST_HINT_SOME`, `LIST_NAME_MAX`, `LIST_DESCRIPTION_MAX`,
      `LIST_ITEMS_PAGE`, `LIST_ITEMS_PAGE_MAX`, `ListView`, `ListDetail`
      (with `next_cursor` and `has_more`), `ListItemView`, `ListInput`,
      `CapabilityFeatures.lists`. `@fdv/client`: `lists`, `createList`,
      `getList(token, id, { limit?, cursor? })`,
      `updateList(token, id, body, etag)`, `deleteList`, `addToList`,
      `removeFromList`, `documentLists`. The fake keeps lists and what is
      on them as the vault does, for each role (`state.lists`), pages them,
      and lets a maker, and an owner, delete as the vault does; a contract
      scenario holds the vault and the fake to it.
  - Links whose secrets stay out of URLs (5.16). A new link is
    `{origin}/s#{link_token}`: the token is in the fragment, which no
    server is sent, and the page takes it out of the address bar and
    that tab's history. The browser's own history of visited pages may
    still hold the link, which no page can change; a PIN is the lock for
    anything sensitive. The page previews, opens nothing until the person
    presses Open, and sends the token and the PIN in POST bodies. Open
    gives a session cookie, inside which the document is fetched. The
    cookie is `Secure`, so Open needs a secure page: over plain http
    anywhere but localhost the page turns Open off, and nothing is
    counted.
    - **New:** `POST /api/v1/shared/preview` `{ token }` →
      `ShareLinkPreview` `{ household_name, shared_by, protection,
expires_at, document_title }`. `protection` is what Open asks for:
      `["pin"]`, or `[]`. `document_title` is null while a protection is
      on. Nothing is counted and nothing is written to the activity log.
      Unauthenticated; 20 a minute per address.
    - **New:** `POST /api/v1/shared/unlock` `{ token, secret? }` →
      `SharedSession` `{ household_name, shared_by, expires_at,
session_expires_at, items: [{ id, title, type_label, filename,
content_type, byte_size }] }`, with `Set-Cookie: fdv_share=…;
Path=/api/v1/shared; HttpOnly; Secure; SameSite=Strict; Max-Age=…`.
      The cookie is 32 random bytes the vault keeps only as a SHA-256. The
      session lasts 30 minutes from its last use and ends at the earlier
      of 4 hours and the link's `expires_at` (`session_expires_at`). This
      is the call that counts an open and writes `share.opened`. A wrong
      PIN is `401 pin_wrong`; each uses one of the link's ten tries,
      reserved before the PIN is checked, so tries made at once never get
      past ten, and a right PIN gives its try back. The tenth locks the
      link: `share.locked` is written once, its sessions end, and the
      sharer is sent an alert (no title, no recipient). Every dead end —
      unknown, expired, revoked, paused, locked, the sharer no longer able
      to see the document, the document in the Trash — is `404
link_not_valid`, as before. 20 a minute per address.
    - **New:** `GET /api/v1/shared/items` (the cookie) → `SharedSession`,
      and `GET /api/v1/shared/items/{document_id}/content` → the file
      (`share.downloaded`; not a second open). Each request checks the
      session (`401 share_session_ended` once it is over, idle, or never
      was) and the link again, as Open did (`404 link_not_valid`, and the
      session is ended). A document the link was not made for is `404
not_found`, as one that does not exist. 120 a minute per address.
    - Every answer under `/api/v1/shared/` carries `Referrer-Policy:
no-referrer`, `X-Content-Type-Options: nosniff`, `X-Robots-Tag:
noindex, nofollow` and `Content-Security-Policy: default-src 'none';
frame-ancestors 'none'; sandbox`.
    - **New, additive:** `CreatedShare.link_url` — the link to send, on the
      vault's public-only site when the operator set `FDV_PUBLIC_URL`
      (`https://share.example.com/s#…`), else null: put the app's own
      origin before `/s#{link_token}`. `FDV_PUBLIC_URL` must be an
      `https://` address alone — no path, query, fragment or user name
      (`http://` only for localhost) — and is kept as its origin.
      `Share` gains `flow` (`legacy` or
      `v2`), `paused_at` and `paused_reason`, and `state` gains `paused`.
      All absent from older vaults.
    - **Changed:** the legacy routes — `GET /api/v1/shared/{token}`,
      `POST /api/v1/shared/{token}/open` and
      `GET /api/v1/shared/{token}/content` — answer only the links made
      before 0.5.14 (`flow: "legacy"`): a new link's token is `404
link_not_valid` on each, whatever its options, and a legacy link's is
      the same on the new routes. No new legacy link is made, so the last
      lapses within 90 days. The three are listed in `deprecations`
      (`removed_in: "0.9.0"`). Their PIN tries are reserved the same way.
    - **Changed:** a restore pauses every live link (`state: "paused"`,
      `paused_reason: "restored"`), since one revoked after the backup was
      made would otherwise work again, and ends every link session. A
      paused link is `404 link_not_valid` on every route until it is
      turned back on.
    - **New:** `GET /api/v1/after-restore` → `{ links: [Share] }`: the
      paused links the caller may decide about — an owner, every one to a
      document they can see, to turn back on or take back; anybody else
      with `document.share`, the links they made, only to take back.
      `POST /api/v1/shares/{id}/resume` → the `Share`, active again
      (`share.resumed`); it asks what making the link asks (step-up for an
      Essential or Only me document). Only an owner (`restore.review`)
      may: for anybody else it is `403 forbidden`, whoever made the link
      and whatever its document, since the backup brought back whatever
      an owner took back since. So a link to a non-owner's own Only me
      document, which no owner can see, stays paused: its maker takes it
      back and makes a new one. For an owner, a link that is not paused
      is `404`. Taking a paused link back (`DELETE /api/v1/shares/{id}`)
      is unchanged. 5.21 and 5.28 add upload requests and sign-ins to
      `after-restore`.
    - An outsider's address is kept cut to its /24 (IPv4) or /48 (IPv6),
      in the activity log's share lines and in the session.
    - The activity log says "A link to “Lease” stopped working: its PIN was
      typed wrong ten times" and "Sam turned a link to “Lease” back on after
      a restore".
    - `@fdv/shared`: capability `restore.review` (owners); `ShareProtection`,
      `ShareLinkPreview`, `SharedItem`, `SharedSession`; `Share.flow`,
      `paused_at`, `paused_reason`; `CreatedShare.link_url`.
      `@fdv/client`: `previewLink`, `unlockLink(token, secret?)`,
      `linkItems`, `linkItemContentUrl`, `afterRestore`, `resumeShare`. A
      pasted `/s#…` link gives the phone its vault's origin, the fragment
      dropped, as other pasted links do.
  - Reminders from any date: the server (5.16a). A kind reminds from one
    date it shows: Expires (Review by on the Will), or one of its own
    `date` fields — a bill's Due date, a car's MOT. Issued and years are
    never offered. Nothing repeats: a bill's next due date is a new date.
    Built-ins keep reminding from Expires, and a document's status is
    still about Expires only.
    - **Added:** `features.reminder_dates` in the capability document. It
      is present and `false` in 0.5.15, and turned on with the web's editor
      (5.16b). A client offers what follows only when it is `true`.
    - **Added:** `due_date` ("Due date", a `date`) in every household's
      library (`GET /api/v1/document-attributes`, `builtin: true`). A
      household's own field of that name keeps its key and its data.
    - **Added:** `DocumentTypeView.remind_from` — `'expires'`, a date
      field's key, or `null` for no reminders — and `remind_leads`, that
      date's lead times (while nothing reminds, the times Expires kept).
      `DocumentTypeInput` takes both, on `POST` and `PATCH
/document-types`. `remind_from` must be a date the kind shows: a
      `date` field it asks for, or `'expires'` while Expires is shown. With
      no `remind_leads`, a date chosen starts with its default: 7 days for
      `due_date`, 30 for any other, and Expires takes back the times it
      kept while switched off. A kind's ETag moves with `remind_from` and
      `remind_leads` only while a date field reminds, so every existing
      kind kept its ETag at the upgrade.
    - **Added:** `DocumentTypeImpact.reminders_by_source` — the reminders
      not dealt with yet, on documents the caller can see, by the date each
      is about: `{ "expires": 3, "due_date": 2 }`. `reminders` is their
      total, as before.
    - **Added:** `ReminderView.source` (`'expires'`, a field's key, or null
      for a manual reminder) and `about`, the date it is about in the
      kind's words and how far off it is: "Due date: 10 Oct, in 7 days".
      `label` is unchanged.
    - **Changed:** `reminder_leads` is Expires's alone: `[]` while a date
      field reminds, so an older phone never says "before it expires" of a
      bill's due date, and its offline status agrees with the vault's. It
      is `[]` too while nothing reminds and Expires is shown, as after
      `remind_from: null` (it always was after `reminder_leads: []`).
    - **Changed:** `reminder_leads` in a body sets the lead times of the
      date the kind reminds from, whichever it is; `[]` is still "no
      reminders". Left out with `remind_from`, the rule every vault has
      kept: a kind that reminds nobody starts reminding from Expires when
      Expires is switched on, when it is made showing Expires, or when lead
      times are sent while it shows Expires — the times sent, else those
      kept, else `[30]`. A kind reminding from another date keeps it.
    - **Changed:** new `422 validation_failed` refusals, each with its
      sentence: a `remind_from` the kind does not ask for (`detail:
"remind_from"`); reminders on with no lead times, or lead times with
      `remind_from: null` (`detail: "remind_leads"`); `remind_leads` and
      `reminder_leads` together; the reminding field made optional
      (`detail`: its key) — the reminding field is kept `required: true`,
      which is how an older phone asks for it; and `POST
/document-attributes` with a `label` the library has already, a
      built-in's included, in any case (`detail: "label"`), which only the
      web checked before.
    - **Changed:** hiding the date reminders come from — Expires switched
      off, or the field taken off the kind — switches them off, audited
      with `remind_from` in the line's `fields`. Expires keeps its lead
      times for when it is switched on again; a field's are cleared.
    - **Changed:** a document's reminders are made again when an edit sets
      or takes away the detail its kind reminds from, as for `expires` and
      `type_key`; any other detail leaves them as they are.
    - **Changed:** a due date (any date field) that has already passed
      makes no reminders when a document is filed or edited, and takes
      none away: an edit after the due day never deletes a reminder nobody
      has dealt with. Taking the date away takes its reminders, as for
      Expires. An expiry that has passed still makes one.
    - **Changed:** of the reminders whose day has already passed when a
      document is filed or edited, only the one nearest the date is made
      `due`, and none if a nearer one is held: a passport filed with two
      months left is one line, not two. This is so for Expires too.
    - **Changed:** snoozing a derived reminder `until: "expiry"` waits for
      the date it is about (its expiry, or its due date). A snooze of a
      reminder about a date field never goes past that date while it is
      ahead: a later day is cut back to it, so an older phone's "A month"
      on a bill due in 9 days waits 9 days.
    - **Changed:** in the digest (email, web push), a derived reminder
      "has lapsed" only once the date it is about has passed, not when the
      reminder itself is late; its line says `about` where there is one.
      An Only me item's email says neither its title nor its date: "One of
      your private documents — Due today".
    - **Changed:** an Only me document's reminding date is readable to the
      vault, as its expiry date always was: its owner's own writes, and the
      vault's `types.regenerate` job, open that one sealed date (never in
      the Trash, never logged or kept) to make its reminders. Everything
      else in its details stays sealed. Its only plain trace is the
      reminder rows, as an Only me expiry date's already is.
    - `@fdv/shared`: `remind_from`, `remind_leads`, `reminders_by_source`,
      `source`, `about`, `reminder_dates`; `reminderOf`, `reminderChoices`,
      `reminderWord`, `defaultLeads`, `nextReminder` (the rules above, which
      the fake keeps too), `leadTimes`, `DUE_DATE`, the sentences
      (`REMIND_FROM_NOT_ASKED`, `REMIND_NEEDS_LEADS`, `REMIND_OFF_NO_LEADS`,
      `REMINDING_DATE_REQUIRED`, `ONE_SET_OF_LEADS`, `libraryHasName`);
      `dateReminderSentence`, `REMIND_ONCE` (`reminderSentence` is
      unchanged, word for word); `reminderAbout`, `aboutDate`, `lapsed`.
  - Reminders from any date: the web (5.16b). **Changed:**
    `features.reminder_dates` is `true` from 0.5.16, with the web's editor
    for them; nothing else on the wire changes. `@fdv/shared`'s `Profile`
    has `timezone`, which `GET /api/v1/profile` already answers to every
    role: the web's snooze buttons count days on the household's calendar,
    as the vault does.
  - Invitation and reset links the same way (5.17). A new link is
    `{origin}/join#{link_token}` or `{origin}/reset#{token}`: the token is
    in the fragment, which no server is sent — not the vault, not a proxy
    on the way — and the page reads it, takes it out of the address bar
    and that tab's history, and posts it in a body. The browser's own
    history of visited pages may still hold the link, which no page can
    change; what protects it there is that it works once and expires — an
    hour for a reset, the invitation's own days for an invitation, which
    also needs its code. The reset email and `cli.mjs reset-password` give
    `/reset#…`; the web's invitation hand-over, and its Copy, `/join#…`.
    A link made before 0.5.17 (`/reset/{token}`, `/join/{token}`) still
    opens the page, which takes the token out of the address the same way
    and posts it in the same bodies.
    - **Added:** `POST /api/v1/password-resets/lookup` `{ token }` →
      `ResetPreview`, as `GET /api/v1/password-resets/{token}` answers; and
      `POST /api/v1/password-resets/complete` `{ token, password }` →
      `200 { email }`, as `POST /api/v1/password-resets/{token}` does — no
      session, every session ended, the link spent. The same refusals:
      `404 reset_not_valid` for every dead link, `422 validation_failed`
      for a token under 16 characters, a missing one, or (for `lookup`) a
      field beside it. Unauthenticated; 10 a minute per address, each, as
      the path forms.
    - **Added:** `POST /api/v1/invitations/lookup` `{ token }` →
      `InvitationPreview`, as `GET /api/v1/invitations/{token}` answers;
      and `POST /api/v1/invitations/accept` `{ token, code, password,
email? }` → `201` with tokens, as
      `POST /api/v1/invitations/{token}/accept` does, a wrong code using
      one of the same five tries. The same refusals: `404
invitation_not_valid`, `401 invitation_code_wrong`, `422
validation_failed`. Unauthenticated; 10 a minute per address, each.
    - **Changed:** an invitation's code tries are reserved before the code
      is checked, as a share link's PIN tries are (5.16): tries made at
      once, by either way in, never get past five — the rest are `404
invitation_not_valid` — where each used to read the count and all were
      tried. A right code uses no try, as before, even when it is then
      refused for something else (`409 email_taken`).
    - The request log names the four routes, and keeps no token, code or
      password from them, as for every other route; a body that is not
      JSON is `400 bad_request`, and its line keeps nothing of it either.
    - **Deprecated:** the path forms — `GET /api/v1/password-resets/{token}`,
      `POST /api/v1/password-resets/{token}`,
      `GET /api/v1/invitations/{token}` and
      `POST /api/v1/invitations/{token}/accept` — listed in `deprecations`
      (`removed_in: "0.9.0"`). They keep working, for any link, until then:
      a page loaded before an upgrade asks them, and the links made before
      0.5.17 last an hour, or the invitation's days.
    - `@fdv/client`: `lookupReset`, `completeReset(token, password)`,
      `lookupInvitation`, `acceptInvitationLink(token, body)`, which a vault
      older than 0.5.17 refuses (`404`; `422` for the reset ones, whose
      names it reads as a path form's token); `resetPreview`,
      `resetPassword`, `invitationPreview` and `acceptInvitation` are the
      path forms, kept for those vaults. A pasted `/join#…` or `/reset#…` link gives the
      phone its vault's origin, the fragment dropped, as every other pasted
      link does; an older phone does the same.
  - Lists are called collections (5.17b). **Changed (breaking,
    deliberately):** lists of documents are collections now, on the wire as
    on the screens. The owner chose the word (A70): "list" reads as a list
    of names, or a to-do list, and a document can be in several
    collections. The routes, the feature flag, the capability and the wire
    names change with **no aliases**. This is the one deliberate exception
    to rule 2's window of four minor releases, for the owner's reason:
    nobody but the owner uses the vault yet, and no released phone reads
    lists (the phone gains them later, as collections). The earlier entries
    about lists stay as they are, since they say what shipped then.
    Everything else is as it was: the same shapes, answers and refusals,
    with each sentence saying "collection".
    - `GET`/`POST /api/v1/lists` → `/api/v1/collections`;
      `GET`/`PATCH`/`DELETE /api/v1/lists/{id}` → `/api/v1/collections/{id}`;
      `POST /api/v1/lists/{id}/items` and
      `DELETE /api/v1/lists/{id}/items/{documentId}` →
      `/api/v1/collections/{id}/items…`; and
      `GET /api/v1/documents/{id}/lists` →
      `GET /api/v1/documents/{id}/collections`. The old paths are gone:
      `404 not_found`, as for any path that does not exist.
    - `features.lists` → `features.collections` in
      `GET /api/v1/capabilities`. Absent from older vaults, which say
      `features.lists`.
    - The capability `list.manage` → `collection.manage`. Its refusal is
      "Viewers can open and download documents, but not make collections
      of them.", and every other refusal says "collection" too: "That
      collection does not exist.", "Only the person who made this
      collection can change it.", "This collection is for people you are no
      longer one of. You can still delete it, but not change it.", "That
      document is not in this collection.", "Only an adult can make a
      collection for the adults." and the rest.
    - The activity log writes `collection.created`, `collection.renamed`,
      `collection.updated`, `collection.deleted`, `collection.item_added`
      and `collection.item_removed`, with `object_type: "collection"` (a
      document's line keeps `detail.collection_id`). Its sentences say
      "collection": "Sam made the collection “Holiday”", "Sam added
      “Passport” to the collection “Holiday”", "Sam took “Passport” out of
      the collection “Holiday”". Lines already written about a list are
      never rewritten, since the log is hash-chained and still verifies;
      with no rule left for `list.*`, they are shown to nobody.
    - A collection's `ETag` is seeded with its new name, so one read before
      the upgrade is stale once: a change made with it is `409 conflict`,
      with the collection as it now is in `detail`.
    - `@fdv/shared`: `CollectionView`, `CollectionItemView`,
      `CollectionDetail`, `CollectionInput`, `CollectionAudience`,
      `COLLECTION_AUDIENCES`, `COLLECTION_NAME_MAX`,
      `COLLECTION_DESCRIPTION_MAX`, `COLLECTION_ITEMS_PAGE`,
      `COLLECTION_ITEMS_PAGE_MAX`, `canSeeCollection`,
      `inCollectionAudience`, `collectionItemHint`,
      `COLLECTION_HINT_TEENS`, `COLLECTION_HINT_PRIVATE`,
      `COLLECTION_HINT_SOME` and `CapabilityFeatures.collections`.
      `@fdv/client`: `collections`, `createCollection`, `getCollection`,
      `updateCollection`, `deleteCollection`, `addToCollection`,
      `removeFromCollection` and `documentCollections`; the fake keeps
      `state.collections`. The old names are gone, with no deprecated
      aliases.
    - The database: 0039 renames `doc_list`, `doc_list_item` and `list_id`
      to `doc_collection`, `doc_collection_item` and `collection_id`, with
      their rules, trigger, functions, keys and indexes, in place. Every row
      keeps its id and every item its place, and a backup made before 0039
      restores and is brought up to date.
  - A person's profile, and their photo (5.17c). The family sees
    everyone's photo; a viewer sees only their own, and initials for
    everybody else (A65). Owners set anyone's; adults their own and those
    of people without a sign-in; teens their own; viewers none; anybody may
    remove a photo of themselves (A66).
    - **Added:** `features.member_photos` in the capability document, `true`.
    - **Added:** `Member.photo` — `{ id }` once a photo is ready, else null;
      null for everybody but themselves to a viewer. `Member.photo_status` —
      `'processing'` while one is being made, `'failed'` when the vault
      could not use it, else null; told only to whoever may change their
      photo. `Member.can_change_photo`. All absent from older vaults.
    - **Added:** `PUT /api/v1/members/{id}/photo`, multipart: an optional
      `crop` field (JSON `{ x, y, w, h }`, fractions of the upright picture,
      each 0–1, inside it, at least 0.05 a side; none for the middle; up to
      0.001 over an edge, as rounding leaves it, is taken as the edge), then
      the picture as `file`, and nothing else. `202` with the person
      (`photo_status: "processing"`); the worker makes a 512-pixel square
      JPEG, from a picture of up to 16,000 pixels a side: a JPEG of up to 128
      megapixels, a HEIC, WebP or PNG of up to about 50 (an iPhone's "HEIF
      Max" is 48), turned upright by its EXIF orientation (a WebP's too), and
      GET /members says `photo` when it is ready. Refused, in this
      order: a person the caller cannot see, `404`; `403 forbidden` (a
      viewer, in the matrix's words; anybody else not allowed, "Only an
      owner or the person themselves can change this photo. For someone
      without a sign-in, any adult can."); a crop that is not one, `422
validation_failed` (`detail: "crop"`); a crop after the file, a
      second file or any other part, `422` "Send the crop first, then the
      photo."; anything but JPEG, PNG, WebP or HEIC/HEIF by its bytes,
      whatever it is called or declared, `415 unsupported_type`; over 20 MB
      (or the vault's `max_upload_bytes`, if smaller), `413 too_large`.
      Nothing of a refused photo is kept. No step-up and no idempotency
      key: the newest photo sent wins, and one still being made is dropped.
    - **Added:** `DELETE /api/v1/members/{id}/photo` → `204`, also when
      there was none; by whoever may change it, or the person themselves.
    - **Added:** `GET /api/v1/members/{id}/photo/{photo_id}` → the JPEG,
      `cache-control: private, no-store`, `x-content-type-options:
nosniff`, with a sign-in. Not allowed, no photo, an old id, anything
      else: `404 no_photo`, the same every time.
    - The three take the ids in any case, as every uuid in the API is
      taken: a photo is filed, sealed and answered by the person's own id,
      so the `202` is the person as `GET /members` gives them, and a photo
      opens however its address is spelled.
    - **Changed:** `Member.relationship` follows the family's details, as
      `date_of_birth` has since 0.5.3: a viewer gets null, except their own.
    - **Changed:** a teen's own document of a kind that is Adults only by
      default — a social security card, a medical record — is their Only me
      (`visibility: "private"`), where it was for Everyone, viewers
      included (the owner's decision). This is only the default: what a
      document made or captured is when it says nothing about who sees it,
      and where the web's card starts; a teen who sends `visibility` as
      `household` gets Everyone, as before. A teen's documents are always
      their own, so it is always theirs. Nobody else can open it, and only
      they can change who sees it afterwards (next).
      `effectiveVisibility` in `@fdv/shared` says the same; a phone that
      sends the visibility its own copy preselected keeps sending Everyone
      until it is updated.
    - **Changed:** a teen can change who sees their own documents that they
      filed, between Only me and Everyone (A72).
      `POST /api/v1/documents/{id}/visibility`, and
      `PATCH /api/v1/documents/{id}` with `visibility`, take `private` or
      `household` from a teen, for a document whose `owner_member_id` is
      theirs and that they filed, and answer as they do anybody: out of
      Only me asks what opening it asks (`step_up_required`,
      `open_private_document`), and the activity log says it as any change
      of who can see a document. Adults only is refused, `403 forbidden`:
      "Adults only would hide it from you too. You can make the documents
      you filed Only me or Everyone." Anybody else's document, and one an
      owner or adult filed for them (which, made Only me, the family would
      lose with no trace), is refused as before, `403` "Only an adult can
      change who is able to see a document."; one they cannot see is
      `404`, as it is for everybody (it was a `403` before the vault
      looked). Owners, adults and viewers are unchanged; so is the role
      matrix, whose `document.visibility` is still an owner's and an
      adult's.
    - **Added:** `DocumentView.filed_by_me`: whether the one asking filed
      the document, so a screen offers a teen the change only where it is
      theirs to make. Only ever about the caller, never who else did.
      Absent from older vaults (read it as false).
    - `@fdv/shared`: `visibilityRefusal`, `visibilityChoices` (both take
      `{ role, mine, filedByMe }`), `VisibilityAsker`,
      `mayChangeVisibilityAtAll`, `PRIVATE_OWNER_ONLY`,
      `TEEN_NOT_ADULTS_ONLY`.
    - The activity log says "Mansoor added a photo of Aisha", "Sara changed
      their photo", "Mansoor removed Aisha’s photo" (owners, adults, teens).
    - Nothing of a photo is in the capability document, an invitation's
      page, a link's preview, an email, a push or the digest.
    - `@fdv/shared`: capability `member.photo`, `canChangePerson`,
      `canChangePhoto`, `canRemovePhoto`, `PHOTO_REFUSAL`; `initialsFor`
      and `shortName` (people.ts); `PHOTO_MAX_BYTES`, `PHOTO_EDGE`,
      `PHOTO_TYPES`, `PhotoCrop`; `ActivityEvent.actor_member_id`.
      `@fdv/client`: `setMemberPhoto` (the crop sent first),
      `removeMemberPhoto`, `memberPhoto`, `memberPhotoUrl`, `photoUpload`;
      the fake makes a photo by the next GET /members.
    - `initialsFor` keeps going until two people's letters differ: after
      the first letter, the second, and the last name's, the letter where
      their first names part ("Sr" and "Sm" for Sara and Sam Khan), then a
      middle name's ("MA" and "MU"); letters are whole graphemes, never
      two people's in different cases, and shared only by the same name.
      `graphemesOf` splits a word as a reader sees its letters.
  - An id that is not one, for every route (5.17c review). **Fixed:** a
    path given something that is not a uuid where one belongs —
    `GET /api/v1/documents/abc`, a `PATCH` of it, `POST .../visibility` —
    reached the database and could answer `500 internal_error`. It is now
    `404 not_found`, "Nothing in the vault has that id.", as for any id
    that names nothing. A valid id is answered as before.
  - The activity log's chain, for every route (5.17c review). **Fixed:** an
    id sent in capitals — a `DELETE` of `/api/v1/auth/sessions/{ID}`, a
    `PATCH` of `/documents/{ID}`, any route — was hashed as sent, while the
    table kept it in lower case, so the row never verified and the chain
    read as tampered with from then on. Every row is now hashed as the
    table keeps it (ids as the database's `uuid` gives them back, the
    detail as `jsonb` does). Rows already written are unchanged, and so is
    the rule that checks them; a chain broken this way before stays broken
    at that row.
  - Until a date and time, view or download, so many opens (5.18,
    `features.share_options`). A new link can end at a time, be for viewing
    only, and be opened so many times. One use is one Open that worked:
    reloading the page it opened, turning its pages and downloading again
    inside that session are free.
    - **Added:** `features.share_options` in the capability document,
      `true` from this release and absent before it. Send what follows
      only when it is `true`.
    - **Added:** `POST /api/v1/documents/{id}/share` takes `expires_at` (ISO
      8601 with an offset; at least 5 minutes ahead and at most
      `FDV_SHARE_MAX_DAYS` days, 90 unless the operator shortens it),
      `permission` (`view` or `download`, the default), `max_opens` and
      `max_downloads` (1 to 1000, or null for no limit). Refusals:
      `422 expiry_out_of_range` ("Choose a time at least 5 minutes from
      now.", "A link can last 90 days at most."); `422 view_not_possible`
      for a file the vault cannot draw (Word, Excel: "Word and Excel files
      can only be shared to download…"); `422 validation_failed` for both
      `expires_at` and `expires_in_days`, or `max_downloads` on a link to
      view. **Kept:** `expires_in_days` (1 to 90) for older clients; with
      neither, a week, as before. Neither of those is refused for being
      past `FDV_SHARE_MAX_DAYS`, which an older client cannot know: they
      are cut to it, and the answer's `expires_at` says when the link ends.
    - **Added:** `limits.share_max_days` in the capability document: the
      longest a link may last (`FDV_SHARE_MAX_DAYS`). A client offers only
      ends within it. Absent from older vaults, which take 90.
    - **Added:** `Share` gains `permission`, `max_opens`, `max_downloads`,
      `downloads_used` and `pages` (`{ state: 'drawing' | 'ready' |
'failed', shown, total }` for a link to view, else null), and `state`
      gains `used_up`: opened as often as it allows (a page opened with it
      lasts to its own end). Its `summary` reads "Shared with the letting
      agent, opened 2 of 5 times; 3 downloads. Stops working on 2 October
      at 17:00.", the time on the household's clock.
    - **Added:** `ShareLinkPreview` gains `permission` and `opens_left`
      (null for no limit); `SharedSession` gains `permission` and
      `downloads_left`; `SharedItem` gains `pages` and `downloaded` (this
      session has had the file, and may again, free, once the link's
      downloads are used up). All absent from older vaults, where every
      link downloads and has no limits.
    - A view-only link's pages still to be drawn are asked of the worker
      whenever the link is looked at — the preview, Open, `GET
/shared/items`, a page, and the family's `GET /shares` — once for each
      link and version however often it is asked, so a newer version, a
      lost job or a worker that started after the API never leaves a link
      "being drawn" for ever. Pages the worker could not draw, on its last
      try, are `pages.state: "failed"` for that version for an hour; after
      that, somebody looking at the link asks for them again (a newer
      version, or an owner turning the link back on, does so at once). A
      version whose own previews failed, or a kind of file the vault cannot
      draw, is `failed` for good.
    - An `expires_at` up to 5 minutes past the longest is taken, for a
      client whose clock is ahead.
    - **Added:** `GET /api/v1/shared/items/{document_id}/pages/{n}` (the
      cookie) → a JPEG: page `n` of a view-only link's document, drawn by
      the worker from the vault's page previews with the link's
      recipient label and the day it was made written across the whole
      page in a slanted grid, and once more below it, in any script. The
      first 30 pages; past them `404 no_preview` ("Pages after 30 were not
      shared."); not drawn yet `404 preview_pending` (retriable,
      `Retry-After: 3`), and the worker is asked to draw them. On a link
      to download, `404 no_preview`. 120 a minute per address, as the
      session's other routes.
    - **Changed:** a view-only link never gives the file: `GET
/api/v1/shared/items/{id}/content` is `403 view_only`, and the legacy
      routes answer only legacy links, which are always to download (the
      database holds every 5.18 option to `flow = 'v2'`).
    - **Changed:** Open (`POST /api/v1/shared/unlock`) counts within
      `max_opens` in one guarded statement, however many press it at once;
      past it, Open and the preview answer `410 link_used_up` ("This link
      has been opened as many times as it allows…"), and no PIN is tried.
      A download is counted against `max_downloads` once per document per
      session; past it, the file is `403 downloads_used_up`.
    - **Changed:** on the new routes, `share.downloaded` is written once
      per document per session, not on every fetch; **new** `share.viewed`, once per
      document per session, the first time a view-only link's pages are
      fetched. `share.created`'s detail gains `permission`, `max_opens`
      and `max_downloads`. The activity log says "Sam made a view-only link
      to “Lease” for the GP" and "Shared link (the GP) looked at the pages
      of “Lease”".
    - **Added:** `FDV_SHARE_MAX_DAYS` (1 to 90, default 90): the longest a
      link may last.
    - The worker: `share.pages` draws a view-only link's pages. It is queued
      when the link is made, when an owner turns it back on after a
      restore, and whenever a live link's pages are still to be drawn and
      somebody looks at it (the preview, Open, `GET /shared/items`, a page,
      `GET /shares`), once for each link and version. The last try failing
      is recorded on the link, and somebody looking at the link an hour or
      more later asks for its pages again. A drawing that fails part-way
      removes what it wrote (even with the database out of reach) and no
      page names; one whose link ended meanwhile keeps nothing.
      `share.pages.prune` removes a link's pages when it is taken back, and
      nightly for links that have ended or been used up and a version a
      newer one replaced.
    - `@fdv/shared`: `SharePermission`, `SharePages`, `ShareInput`,
      `SHARE_MIN_MINUTES`, `SHARE_MAX_DAYS`, `SHARE_LIMIT_MAX`,
      `SHARE_END_GRACE_MINUTES`, `canShareToView`, `sharePagesNote`,
      `pagesNotSharedNote`, `shareUses`, `zonedParts`, `zonedTime`,
      `shareQuickPicks(timezone, now, maxDays)` (only the picks within the
      vault's longest), `latestShareEnd`, `defaultShareEnd` (a week, or an
      hour safely inside a shorter longest), `shareEndWords`,
      `shareEndProblem` (with `maxDays` and `graceMinutes`);
      `CapabilityFeatures.share_options`, `CapabilityLimits.share_max_days`,
      `SharedItem.downloaded`.
      `@fdv/client`: `share` takes a `ShareInput`; `linkItemPageUrl`. The
      fake says `share_options: true`.
    - A multi-page TIFF (a document scanner's) is a page a frame: its
      `page_count` counts them (from the frames' headers, up to 1000), and
      its previews, and so a view-only link, draw up to 30.
    - The database: 0041 adds `share_link.permission`, `max_opens`,
      `max_downloads`, `downloads_used`, `pages_failed_version` and
      `pages_failed_at`, each 5.18 option checked to a
      v2 link (`flow = 'v2' or …`), the counts held within their limits,
      and a link's own writes to the counts alone; `share_session_use`
      (what each session has had) and `share_page` (a view-only link's
      pages), each with a rule for every kind of caller.
  - Share a collection (5.19, `features.collection_shares`). A collection
    can be shared outside the family by a link, as its sharer ticked it:
    exactly those documents, each checked again on every request. One the
    sharer can no longer see, taken out of the collection, in the Trash or
    with no file is simply not given, and nothing says it was there.
    - **Added:** `features.collection_shares` in the capability document,
      `true` from this release and absent before it.
    - **Added:** `GET /api/v1/collections/{id}/share-preview` (bearer) →
      `CollectionSharePreview { collection_id, collection_name, audience,
items: [{ document_id, title, type_label, ticked, lock, reason,
viewable }] }`: the documents in the collection the caller can see,
      out of the Trash, in the collection's order — none they cannot, and
      no count of them. `ticked` when everybody the collection is for may
      see it; otherwise `lock` says why: `adults` ("Adults only — include
      anyway?"), `private` ("Only you can see this. It is private.", never
      ticked for you) or `no_file` (it cannot go). Refusals: `403
forbidden` without `document.share` ("Only an adult can share a
      document outside the family.": a teen never shares a collection,
      A18); `404 not_found` for a collection the caller is not given;
      `422 collection_only_me` for an Only me collection ("An Only me
      collection is yours alone, so it cannot be shared outside the
      family. Change who it is for first.").
    - **Added:** `POST /api/v1/collections/{id}/shares` (bearer) → `201
CreatedShare`. Body: `document_ids` (the ticked ones, at most 200; at
      least one unless following), `follow_collection` (optional),
      `left_out_ids` (optional, at most 10000 — a household's worth,
      NFR-05: what the share sheet offered and was left unticked, below),
      and
      every 5.18 option (`expires_at` or `expires_in_days`,
      `recipient_label`, `with_pin`, `permission`, `max_opens`,
      `max_downloads`). **Every one asks to confirm it's you**, whatever is
      in it: `403 step_up_required` with `action: "share_collection"` ("…to
      share a collection outside the family"), asked after who may and
      after the collection is found, so a collection that is not there for
      the caller is `404`, never a question first. A document that is not
      in the collection now, or that the caller cannot see, is `404
not_found` ("That document is not in this collection."); one with no
      file `422 nothing_to_share`; a Word or Excel file on a link to view
      `422 view_not_possible`, naming it. With `follow_collection`, what an
      owner or an adult puts in the collection later goes too — decided
      once, as it is put in: only what everybody the collection is for now,
      and was for as the link was made, may see (which a private document
      never is), and never a document in the collection as the link was
      made that was left unticked, however it is taken out and put back —
      nor one in `left_out_ids`, what the sheet offered and was left
      unticked, though it left the collection before the link was made, or
      was made one the caller cannot see meanwhile (every one of the
      household's documents named is kept so; ids of nothing, or of another
      household's, are dropped, never an error: a left-out document only
      ever narrows the link); a teen's never follows; one
      that followed and is taken out is decided again, and logged again,
      if it is put back — and
      the link lasts 30 days at most: a later `expires_at` is `422
expiry_out_of_range` ("A link that keeps up with its collection lasts
      30 days at most…"), and older `expires_in_days` are cut to 30 (30
      days is counted on the database's clock: an end chosen within
      `SHARE_END_GRACE_MINUTES` past it, as every link's end is let through,
      is cut to it; the answer's `expires_at` says). When
      somebody other than the collection's maker shares it, the maker is
      told by `alert.send` (email): who shared one of their collections,
      and nothing of which, with whom, or what.
    - A collection's link gives, on every request, the documents that were
      ticked, or that followed (decided as each was put in, above), and
      that are in the collection now, out of the Trash, with a file, and
      that its sharer can still see; one that followed, only while it is
      still for the whole of the audience of the collection now and of
      the one the link was made for. Nothing that changes later sends out
      anything more — narrowing a collection, or widening a document's
      visibility, only takes away. It stops
      altogether when the collection is deleted or made Only me (its links
      are taken back for good: widening it again does not bring them
      back; a link being made as the collection is made Only me is not
      made, or is taken back with the rest), or when its sharer can no
      longer see the collection or is no longer an owner or an adult.
    - **Changed:** `Share` (in `GET /shares`, `GET /after-restore` and a
      `CreatedShare`): `document_id` is `null` for a link to a collection,
      which carries **new** `collection_id`, `collection_name` (its name
      now) and `follow_collection`; `document_title` is null for it, and
      `pages` too. A client that finds a document's links by `document_id`
      finds none of these. `GET /shares` lists a collection's link only to
      a reader who may share and can see the collection and every document
      it was made with or has followed (or made it), and never says how
      many went; the summary adds "Keeps up with the collection." for a
      live following link. **Changed (every link):** a link taken back says
      by whom — "You took this link back." to the one who did, "Sam took
      this link back." to anybody else — and a collection's link that ended
      with its collection says so ("It stopped when the collection was made
      Only me." / "…was deleted.").
    - **Changed:** `DELETE /shares/{id}` takes back a collection's link for
      its sharer, an owner who can see the collection, or anybody who may
      share and can see the collection and every document it was made with;
      anybody else is `404`, as for a link that does not exist. `POST
/shares/{id}/resume` turns one back on for an owner, and always asks
      to confirm it's you (`share_collection`). A restore pauses
      collections' links as it does every link.
    - **Added:** `ShareLinkPreview` and `SharedSession` gain `kind`
      (`document` or `collection`; absent from older vaults: a document)
      and `collection_name` (withheld behind a PIN, as a title is). A
      collection's session's `items` are what it gives now, in the
      collection's order; `content` and `pages/{n}` answer only those,
      anything else `404`. A download counts once per document per session,
      as before.
    - **Added:** `CollectionView.shared_outside`: `{ with, following }`
      while a link outside still works for the collection — `with` the
      recipient labels of the links `GET /shares` gives the reader (a
      reader who may share, and made the link or can see every document it
      was made with or has followed; empty for anybody else) — or null.
      Absent from older vaults. `sharedOutsideWords(shared, role)` tells a
      teen that what they put in stays in the family.
    - The activity log: `share.created`, `share.opened`, `share.revoked`,
      `share.locked` and `share.resumed` of a collection's link are about
      the collection (`object_type: "collection"`), shown to whoever in
      the collection's audience `GET /shares` gives the link to (above),
      with its name now and never a count ("Sam made a link to the
      collection “For the lawyer” for Jane Smith, which keeps up with it";
      "A link to the collection “Holiday” stopped working: Sam deleted the
      collection"); `share.created`'s detail keeps the ids that went
      (`document_ids`) and `follow_collection`. `share.downloaded` and
      `share.viewed` stay about each document, and are shown, for a
      collection's link, only to whoever may see the document and is given
      the link, too — in the collection's audience now: made Only me, its
      links' lines are its maker's alone; deleted, they stay, as the
      collection's own lines do. **New** `share.followed`:
      a document put in a collection whose link keeps up with it, and
      decided then to follow, one line per link, shown to whoever may see
      the document and the collection and is given the link.
    - **Changed (every line):** an activity line's `at` is the database's
      clock, to the millisecond, taken as the log is held — no longer the
      API's.
    - **Changed (the database, 5.6 review):** a share link reaches only
      what its page needs, in every table. Besides its documents, their
      newest files, its share and snapshot, its collection and its
      sessions, it reads its household, its sharer's member and membership,
      and the scope key and vault its files are under — and nothing else of
      the household's tables or of the sign-ins (accounts, credentials,
      reset links, passkey challenges), which gain a rule for it. Of its
      snapshot, only the rows of what it gives now. It writes
      only its own counts and sessions and its own lines in the activity
      log, which it no longer reads: `appendAudit` chains through a new
      `audit_chain_head()` and no longer reads its insert back. Each line
      it writes is one of `app_link_audit_actions()`, held to its own name
      (`shared link (label)`, by `app_link_label()`), about a document it
      gives or its own collection (`app_link_may_name()`), chained to the
      log's head, and dated now; that it locked, only once it has
      (`app_link_locked()`: its tenth wrong PIN). And as each goes in
      (`audit_event_link_line`, a trigger): on the head as it is then, so
      one statement cannot write two lines on one head; saying only the
      keys `app_link_line_keys(action)` gives (today `share_id` and
      `user_agent`), each a string or null; and hashed as `appendAudit`
      hashes, which the trigger works out again — the chain verifies after
      anything a link writes. A later release adds an action, or a key,
      by redefining those two functions alone.
    - `@fdv/shared`: `CollectionSharePreview`, `CollectionShareItem`,
      `CollectionShareInput`, `CollectionShareLock`, `CollectionSharedOutside`,
      `COLLECTION_SHARE_REASONS`, `FOLLOW_MAX_DAYS`,
      `withinCollectionAudience`, `collectionShareItem`,
      `sharedOutsideWords`; `CapabilityFeatures.collection_shares`.
      `@fdv/client`: `collectionSharePreview` and `shareCollection`. The
      fake says `collection_shares: true`, and its collections
      `shared_outside: null`.
    - The worker: `share.pages` draws a collection's link to view for each
      document it gives (the job's `version_id` names one), asking the
      database as the link itself which those are. One document failing
      leaves the others drawn, and cleans up after itself as a document's
      link does (a first drawing removes all it wrote; a redraw, only what
      no page names). It holds the link FOR NO KEY UPDATE as it keeps them,
      and a collection's addition holds each following link FOR KEY SHARE
      before its documents, so the two never deadlock. Likewise, deleting a
      collection or making it Only me holds its links before the activity
      log, as every other writer of a link does, and a collection's link
      holds the documents it names in id order, as an addition does.
    - **Changed (every link, sessions):** ending a link — taking it back,
      its tenth wrong PIN, its collection deleted or made Only me — ends
      its sessions without waiting for one in use at that moment. A
      session request (`GET /shared/items`, `…/content`, `…/pages/{n}`)
      whose link ends while it is being answered — its session removed as
      it waited, anything it asks failing or coming back empty, or its link
      found gone as it finishes — is answered `404 link_not_valid`, with
      all it did undone (a first download is not counted, a first look at
      pages is not written down) and its session removed; a first download
      that waited on the link as it was taken back, locked or paused is
      refused at its count. Its session goes with that answer, so a later
      request of it is `401 share_session_ended`, as after any
      `link_not_valid` (5.16). A session whose request finished just before
      its link ended is refused `404 link_not_valid` at its next request,
      and removed. A request whose link still works keeps its own answer.
    - **Changed (pages that could not be drawn):** 5.18's rules now hold a
      version at a time, for a document's link and each document of a
      collection's alike. The worker's last failed try is kept for the
      link, the version and when (`share_page_failure`); that document's
      `pages.state` is `failed`, and an hour on (`PAGES_RETRY_MS`) whoever
      looks at a live link has it asked for again. The version's own
      previews failing, or a file the vault cannot draw, stays failed; a
      link that is not live says failed. Drawing a document's pages clears
      its failures; an owner turning a link back on clears all of the
      link's. Nothing on the wire changes.
    - The database: 0042 lets `share_link.document_id` be null and adds
      `collection_id`, `follow_collection` (30 days at most, held by a
      check), `follow_audience` (the collection's audience as a following
      link was made) and `revoked_why` (`collection_only_me` or
      `collection_deleted`), exactly one of a document and a collection,
      each a v2 link's alone; `share_link_target_fixed` keeps what a link
      is to, and the audience it follows for; `share_link_item`, the
      snapshot, a row for each document `ticked`, `followed` or `left_out`
      (`kind`), and `share_page_failure`, what a
      view-only link could not draw — 0041's `pages_failed_version` and
      `pages_failed_at` move into it, and go — each with a rule for every
      kind of caller; `app_live_share()`, `app_link_documents()`,
      `app_link_versions()`, `app_link_collection()`, `app_link_sharer()`,
      `app_link_label()`, `app_link_may_name()`, `app_link_locked()`,
      `app_link_audit_actions()`, `app_link_line_keys()` and
      `collection_audience_sees()` for the link's rules;
      `audit_chain_head()`; and the `audit_event_link_line` trigger. The
      restore check knows each, and a backup from before 0042 is brought up
      to date with its failures kept.
  - A second factor for someone with no account (5.20,
    `features.share_second_factor`, `features.share_email_code`). A link —
    to a document or to a collection — can ask for more than itself, in any
    combination: a PIN or a password, a code emailed to an address its
    sharer typed, and to open in one browser only.
    - **Added:** `features.share_second_factor` in the capability document,
      `true` from this release; `features.share_email_code`, `true` only
      when whoever runs the vault has set `FDV_SMTP_URL` (A21). Both absent
      from older vaults.
    - **Added (making a link):** `POST /documents/{id}/share` and `POST
/collections/{id}/shares` take `with_password` (the vault makes one
      up: three groups of four letters and digits, returned once as
      `CreatedShare.password`; checked without regard to capitals, dashes
      or spaces, since it is read out and typed unseen), `password` (typed:
      8 to 64 characters, never returned, checked as typed), `code_email`
      (the address a code goes to: `isShareAddress`, the same rule the
      share sheet checks, else `422 validation_failed` whose `detail`
      starts `code_email:`) and `this_device_only`. One secret at most: a
      PIN, a made-up password or a typed one, else `422 validation_failed`.
      `code_email` without the operator's mail server is `422
email_code_unavailable`, with the reason (the household's own mail
      settings are never used for it).
    - **Added (the page):** `POST /api/v1/shared/code` `{ token }` → `200 {
sent_to, expires_at }`: a six-digit code, good for 10 minutes and 5
      tries and used once, sent to the address the sharer typed — the page
      never says one, and `sent_to` is masked (`j•••@e•••.com`) — through
      the operator's mail server alone, as a plain-text email with no link
      and no title. A newer code ends the ones before it: only the newest
      works, and the page and the email say so. At most 3 a link in 15
      minutes and 10 a day: `429 code_limit` with `Retry-After`. `409
no_code_needed` for a link that asks for none; `403 other_device` from
      another browser than a bound link's; `503 email_code_unavailable`
      when the vault can no longer send one (worded for the person the link
      is for: ask whoever sent it for a new link); `503 code_not_sent`
      (retriable, `Retry-After: 60`) when its email could not be queued —
      then nothing was kept: no code, no line in the activity log, no place
      in the count of sends, and the code before it still works; the error
      is logged, with no address or code. Rate-limited as the other share
      routes are.
    - **Changed:** `POST /api/v1/shared/unlock` takes `code` beside
      `secret` (the PIN, or now the password). **One counter of ten**
      (A23): every failed PIN, password or code uses up one of the link's
      ten, reserved before anything is checked, however many arrive at once.
      With a password and a code, the code is tried only once the password
      is right, and a wrong one of either gets the same answer, word for
      word: `401 secret_wrong`. A PIN alone still answers `401 pin_wrong`.
      The tenth locks the link (`share.locked`, the sharer told), as
      before. A link for one device binds the browser of the first Open
      that works with a cookie, `fdv_share_device_<kid>` (httpOnly,
      Secure, SameSite=Strict, `/api/v1/shared`, kept only as a hash with
      the link's id), whose name carries a short id of the key it was made
      under, so that after the master key is rotated the browser keeps its
      earlier cookie beside the next and every link bound before still
      finds its own: a binding is matched against every
      `fdv_share_device*` cookie the browser brings. Only the vault makes
      one — random bytes and their HMAC under a key derived from the master
      key — and a new binding keeps the browser's cookie only when it is
      the current key's own; any other is replaced, so a cookie planted
      before the first open is never bound. A link bound already keeps the
      cookie it matched, whatever key made it. From any
      other browser Open is `403 other_device` ("…opened in another
      browser already…") before anything is tried or counted, and a
      session cookie taken to another browser is refused there (`items`,
      `content`, `pages`).
    - **Added:** `ShareLinkPreview.protection` may say `password` and
      `code`; **new** `code_to` (masked), `this_device_only` and
      `other_device` (this browser is not the one it opens in: title and
      collection name withheld). `Share` gains `protection`, `code_to`
      (masked; null once the link has ended) and `this_device_only`;
      `has_pin` stays true for a PIN only. The summary says "Asks for a
      password and a code emailed to j•••@e•••.com. Opens in one browser
      only." where it does.
    - The activity log: **new** `share.code_sent` ("A code to open a link
      to “Lease” was emailed to j•••@e•••.com"), written as the link, with
      the address masked; `share.created`'s detail says `with_password`,
      `code_to` (masked) and `this_device_only`. `share.locked` reads "its
      PIN, password or code was wrong ten times".
    - The address is cleared when the link ends: taken back, locked, or
      opened as often as it allows, in the statement that ends it; a link
      whose end has passed, by the worker's nightly prune.
    - The worker: **new** job `mail.to_address` — one email to one address,
      through `FDV_SMTP_URL` only; its address and text are sealed on the
      queue under a key derived from the master key. The nightly
      `share.pages.prune` also clears ended links' addresses and codes past
      their day. Neither logs an address.
    - The database: 0043 adds `share_link.secret_kind` (`pin`, `password`
      — typed — or `generated` — made up, hashed lowercase without dashes
      or spaces; the argon2 hash stays in `pin_hash`), `code_email`,
      `this_device_only` and `device_hash`, each a v2 link's alone;
      `share_link_factors_fixed` keeps a link's protection as it was made,
      binds a device once, and clears the address only when the link has
      ended; `share_code` (`code_hash` an HMAC-SHA256 under a key derived
      from the master key, never a plain hash; 10 minutes; 5 tries; used
      once), with a rule for each kind of caller — its own link and the
      vault, and nobody else, the family included — and
      `share_code_writes`. `share_session.verified_by` may say `password`,
      `code`, `pin+code` or `password+code`. A link may write
      `share.code_sent`, with `to` (masked) beside `share_id` and
      `user_agent`: 0043 redefines 0042's `app_link_audit_actions()` and
      `app_link_line_keys(action)` (as 0042 has them: stable, parallel
      safe, its search_path, the application's to call) and nothing else,
      so the line is held by 0042's own rule and trigger — its own label,
      its own document or collection, the chain's head, the database's
      clock (15 minutes behind to 1 ahead). `to` on any other line is
      refused. A restore deletes every code.
    - `@fdv/shared`: `ShareSecretKind`, `ShareCodeSent`, `maskEmail`,
      `readShareCode`, `SHARE_PASSWORD_MIN`/`MAX`, `SHARE_CODE_*`,
      `SHARE_CODE_TRUTH`, `SHARE_CODE_UNAVAILABLE`, `SHARE_CODE_CANNOT_SEND`,
      `SHARE_NEWEST_CODE_ONLY`, `isShareAddress`; `ShareProtection` gains
      `password` and `code`. `@fdv/client`: `sendLinkCode`, and
      `unlockLink(token, secret?, code?)`. The fake says
      `share_second_factor: true, share_email_code: false`.
  - Ask someone to send documents: the server (5.21). An owner or an
    adult asks somebody outside the family — the accountant, the solicitor
    — to send documents in, through a write-only link. What comes in waits,
    encrypted and apart from the documents, for review (5.23 files it; the
    web's pages are 5.22's). `features.upload_requests` arrives with 5.23;
    until then these routes are for the web and tests.
    - **Added:** `POST /api/v1/upload-requests` (owners and adults) with
      `title` (1–120), `message` (up to 2,000), `items` (up to 10 named
      things to send, each up to 80: "W-2", "1099"), `recipient_label`,
      `recipient_email`, `expires_at` (ISO 8601 with an offset; at least 5
      minutes ahead and at most `FDV_SHARE_MAX_DAYS`, 90 unless shortened:
      `422 expiry_out_of_range` "A request can last 90 days at most."; there
      is no "no end"), `with_password` (the vault makes one up, shown once)
      or `password` (8 to 64 characters), `email_code`, `this_device_only`,
      `max_visits` (1–1000, or null), `max_files` (1–10, 10 unless said),
      `max_total_bytes` (up to 200 MB, 200 MB unless said), `accept_types`
      (`standard`: PDFs and photos; `office`: Word and Excel too),
      `review_by` (`me`, the default, or `adults`), `suggested_member_id`
      and `suggested_type_key` (hints for the reviewer, never shown to the
      sender) and `close_after_submit`. `201` `CreatedUploadRequest`:
      `{ request, link_token, link_url, password? }`; `link_url` is
      `{FDV_PUBLIC_URL}/drop#{link_token}` when the vault has a public-only
      site, else null. `email_code` without operator mail (`FDV_SMTP_URL`)
      is `422 email_code_unavailable`; without `recipient_email`, `422`.
    - **Added:** `GET /api/v1/upload-requests` answers
      `{ items, email_code_available }`, each item an `UploadRequestView`:
      the requests the reader reviews — their own, and those any adult
      reviews. Another adult's review-by-me request is not listed, not even
      to an owner.
      `DELETE /api/v1/upload-requests/{id}` → `204`: taken back, its link
      opens nothing, its sessions and codes end, and its address is
      cleared; files already sent stay for review.
      `POST /api/v1/upload-requests/{id}/resume` → the request, turned back
      on after a restore: owners only (`403 forbidden` for an adult).
    - A teen or a viewer is answered `404 not_found` on every one of these,
      as if there were no such thing; the role matrix's
      `upload_request.create` (owners and adults) is new.
    - **Changed:** `GET /api/v1/after-restore` gains `upload_requests`: the
      paused requests the reader may decide about. An adult's review-by-me
      request is theirs alone, so it stays paused until they take it back.
    - **Added**, the sender's routes (no sign-in; on the public-only site):
      - `POST /api/v1/drop/preview` `{ token }` → `DropPreview`: the
        household's name, who asked, what Open asks for (`protection`:
        `password`, `email_code`, `this_device`) and the end. Never the
        title, the message, the items or the hints. Nothing is counted.
      - `POST /api/v1/drop/code` `{ token }` → `{ sent_to, expires_at }`: a
        6-digit code to the address the requester gave, masked
        (`j•••@e•••.com`), by operator mail only (5.20's `mail.to_address`);
        10 minutes, 5 tries, once, and only the newest works: sending one
        ends the ones before it. 3 a quarter of an hour and 10 a day
        (`429 too_many_codes`). Kept as an HMAC under a server key; the
        email has no link and no title. A request that ends as the code is
        asked for sends none (`404 link_not_valid`); one that cannot be
        queued is `503 code_not_sent`, and nothing of it is kept. A
        this-device-only request already bound to a browser sends a code
        only for that browser (its device cookie); any other is
        `403 other_device`, before anything is sent or counted. A code
        asked for while the request is being opened waits for the Open.
      - `POST /api/v1/drop/unlock` `{ token, password?, code? }` →
        `DropSession` (with its `request_id`), and a session cookie named
        for the request, `fdv_drop_s_<request id without dashes>`
        (httpOnly, Secure, SameSite=Strict, path `/api/v1/drop`; 30 minutes
        idle — a file still arriving is use of it — 4 hours at most, never
        past the request's end), so a browser
        can have two requests open. Opens pressed at once wait for each
        other. A wrong password or code, in either, is `401 secret_wrong`,
        the same answer, and uses up one of the request's ten tries for its
        life; the tenth locks it (the requester is told). The code a
        request was just opened with, pressed again, is `409 code_used` and
        uses up no try. Past `max_visits`, `410 request_used_up`, however
        many press Open at once. This device only (5.20's device cookies):
        one `fdv_drop_device_<key id>` cookie per browser, made by the vault
        alone — one it did not make, planted before the first Open, is
        replaced, never bound — and set again with its full 90 days by every
        Open that uses it; each request is bound to it by the first Open
        that works, and every other Open, at once or later, from another
        browser is `403 other_device`. A binding made under a master key
        since turned still opens, with its own cookie, which is kept. A
        first Open whose request ends as it binds is `404 link_not_valid`.
      - Inside an opened request, a call says which request it is about
        with `X-FDV-Drop-Request: <request_id>`; with only one session
        cookie in the browser it need not. With two and no header, it is
        `401 drop_session_ended`.
      - `GET /api/v1/drop/session` → `DropSession`: the household, who
        asked, the title, the message, the items, what it takes
        (`accept_types`, `accepted`), `files_left`, `bytes_left`,
        `max_file_bytes` and the files this browser has sent. Never another
        session's, and never the hints.
      - `POST /api/v1/drop/files`, multipart: an optional `item_id` field,
        then `file`, and nothing else; 20 a minute per address. `201`
        `DropFile`. Its room is reserved before a byte is read: its
        `Content-Length`, or the most it could be, within the file's own
        limit (`max_upload_bytes`), what is left of the request's bytes and
        files, and the household's room for files waiting for review
        (2 GB), each counting the files still arriving as well as those in.
        No room: `413 too_large` (or `409 files_used_up`) at once, before
        its body has arrived. Refused, and nothing of it kept:
        `415 unsupported_type` for anything but a PDF or a photo by its bytes —
        stopped as soon as its first bytes say so — and, with `office`, a
        Word or Excel file only as its package's own main part declares it
        (read as XML: character references decoded, comments ignored, a
        document type refused), a package of more than 500 parts not at
        all; `415 macros_refused` for a Word or Excel file with anything
        that runs or reaches outside — a VBA project by its content type,
        relationship or name, a macro-enabled document or template main
        part (.docm, .dotm, .xlsm, .xltm), a macro sheet, ActiveX, an
        embedded OLE object, or a template, frame or object fetched from
        elsewhere. A plain template (.dotx, .xltx), or any package whose
        main part is not exactly a Word document or an Excel workbook, is
        `415 unsupported_type`. `413 too_large` when more arrives than the
        room reserved, and at the commit when the household's room is
        taken meanwhile (a reservation stops counting once its file has
        been arriving for 15 minutes, or its session has ended).
      - `DELETE /api/v1/drop/files/{id}` → `204`: a file this session sent,
        before Finish. `POST /api/v1/drop/finish` `{ note? }` (up to 1,000
        characters) → `{ files, closed }`; `422 nothing_to_send` with no
        file. With `close_after_submit`, the request closes.
      - The preview, a code and Open answer a request that has been taken
        back, closed, paused, locked, run out of time, or whose requester
        is no longer an owner or an adult as `404 link_not_valid`, and one
        opened as many times as it allows as `410 request_used_up`. The
        routes inside a session answer `401 drop_session_ended` once the
        request has stopped, because its sessions end with it; they answer
        `404 link_not_valid` only for a session that outlives a stop the
        database alone knows of (a requester's role changed by hand). A
        used-up request's sessions keep working to their own end. A request
        taken back while one of its sessions is in use does not wait for it:
        that call is answered `404 link_not_valid`, all it did undone, and
        its session ends. 20 a
        minute per address for the preview, a code, Open and a file; 120
        for the rest inside a session. Every answer carries the public
        pages' headers (no referrer, nosniff, noindex, a strict sandboxing
        policy).
    - **Changed:** a requester made a teen or a viewer, or whose sign-in is
      taken away, loses their requests: each is closed, its sessions and
      codes end, and its address is cleared (A39).
    - A file is encrypted from its first byte under the key of whoever
      reviews it — the requester's own member key, or the adults key — and
      is never a document, never searched, listed, reminded or counted,
      until it is reviewed (5.23). Nothing of the vault is ever given to a
      sender, and nothing a sender sends is decoded: 5.23 draws review
      previews under the existing ImageMagick limits.
    - The activity log says "Sam asked Jane, accountant to send documents",
      "Upload link (Jane, accountant) opened a request to send documents",
      "Upload link (Jane, accountant) sent 2 files", and a request's code
      sent, lock, taking back, closing and turning back on — to whoever
      reviews the request only. Never its title or a file's name, which the
      log does not keep.
    - The request log keeps no token, password, code, file name or cookie:
      `/api/v1/drop/*` paths other than the routes' own names, and anything
      after `/drop/`, are cut, and the headers @fastify/multipart logs at
      trace level are redacted (they carried a bearer token too).
    - After a restore, every live request is paused for an owner to turn
      back on (A55), and no sender's session or code survives.
    - A request's address is cleared by whatever ends it: the tenth wrong
      try, its last visit, taking it back, closing it; one that runs out of
      time, by the nightly prune.
    - **Added:** `503 busy` (retriable, `Retry-After: 1`), on any route,
      for two requests that got in each other's way in the database (a
      deadlock or a serialization failure): nothing was done.
    - The worker: the nightly `uploads.prune` also takes away files whose sending died,
      with their objects, ended senders' sessions and codes, and the
      address of a request that has ended.
    - `@fdv/shared`: capability `upload_request.create`;
      `UPLOAD_REQUEST_MAX_FILES`, `UPLOAD_REQUEST_MAX_BYTES`,
      `INCOMING_HOUSEHOLD_MAX_BYTES`, `SENDER_NOTE_MAX`,
      `UPLOAD_PASSWORD_MIN`, `uploadRequestTypes`,
      `uploadRequestTypesWords`, and the types
      `UploadRequestInput`, `UploadRequestView`, `CreatedUploadRequest`,
      `DropPreview`, `DropCodeSent`, `DropSession`, `DropFile`,
      `DropFinished`. `@fdv/client`: `createUploadRequest`,
      `uploadRequests`, `revokeUploadRequest`, `resumeUploadRequest`,
      `dropPreview`, `dropCode`, `dropUnlock`, `dropSession(requestId)`,
      `dropFilesUrl`, `dropRemoveFile(requestId, id)`,
      `dropFinish(requestId, note?)`, `dropHeaders(requestId)`; the fake
      keeps requests (`state.uploadRequests`).
    - The database: 0044 adds `upload_request`, `upload_request_item`,
      `upload_session`, `upload_code` and `incoming_file`, each with a rule
      for every kind of caller: an upload link reaches its own request
      while it can be used and its own session's files alone; a
      review-by-me request and its files are its requester's alone. And,
      as 0042 does for a share link (A74), each of the household's other
      tables and the sign-ins gets a rule of its own for an upload link: it
      reads its household, its requester's member row, the one key its
      files are encrypted under and the vaults they are kept in, and
      nothing else; writes none of them; and of the activity log reads
      nothing and writes only its own lines, under its own name, about its
      own request, on the log's head, hashed as every line is.
  - Removing a document for good (5.24, `features.remove_for_good`). Nothing
    empties the Trash by itself; an owner may remove a document in it for
    good — at once one they filed, or one that is theirs when nobody is
    named as filing it or whoever did no longer signs in here; anybody
    else's only `PURGE_NOTICE_HOURS` (24) after whoever filed it was told.
    - **Added:** `features.remove_for_good` in the capability document,
      `true` from this release and absent before it.
    - **Added:** `POST /api/v1/documents/{id}/purge` (bearer, owners only).
      **Every call asks to confirm it's you**: `403 step_up_required` with
      `action: "remove_for_good"` ("…to remove a document for good"), asked
      after who may and after the document is found, so a refusal is never
      a question first. A document the caller filed (`created_by`), or
      that is theirs (`owner_member_id`) when nobody is named as filing it
      or whoever did no longer signs in to the household, is removed at
      once: `204`. One handed to the caller is not theirs to remove at
      once: whoever filed it is asked about first. Anybody else's is asked
      about instead: `202` with the document, now carrying
      `purge_requested_at` and `purge_allowed_from`; whoever filed it, while
      they are in the household, and the other owners are told by
      `alert.send` (email, and web push) — who asked, and when it may go,
      never which document. A call from `purge_allowed_from` on removes it
      (`204`); before then `409 purge_not_yet` ("Whoever filed it has been
      told, and can bring it back until then: it can be removed for good
      from Saturday 3 October at 14:05.", the household's clock; `detail`
      is `purge_allowed_from`). The day counts from the asking, on the
      database's clock — never from the Trash, so a document trashed before
      this release cannot be removed by another owner the moment it lands.
      Refusals: `403 forbidden` for anybody but an owner ("Only an owner
      can remove a document for good."); `404 not_found` for a document the
      caller cannot see (another member's Only me document, too) or that is
      not there; `409 not_in_trash` out of the Trash; `409 file_found`
      when a version a restore marked removed for good has its file where
      it is kept after all — the mark is cleared and nothing is removed, so
      the owner can look at it first.
    - What goes: every version's file, its thumbnail, its page previews,
      the pages any link to view drew of it, the file of an upload to it
      that never finished. In one transaction each is written down
      (`purge_leftover`), then the document goes, every row that names it
      going with it (its versions, text, reminders, links and their
      sessions, collection items, collection links' snapshot rows), then the
      line in the log. The objects are deleted after it, a missing one being
      fine; one storage could not delete is left for the worker's new
      `purge.leftovers` job (queued then, one a household, and every night),
      never a document half removed. A place that fails once is not tried
      again for the rest, there or in the job's run, so the owner is answered
      in the time one try takes. A kind deleted while it still used it goes with
      it if it was the last. An export made before the removal keeps its
      copy until it expires (seven days); a phone keeping it offline drops
      its copy when it next connects.
    - **Changed:** `POST /api/v1/documents/{id}/restore` (Bring it back)
      clears an owner's request; asked again, the day starts again. A
      document removed for good meanwhile is `404`, never a fault.
    - **Added:** `DocumentView.purge_requested_at` and `purge_allowed_from`
      (null when nobody has asked; in the Trash only), `purge_at_once`
      (whether the caller, an owner, may remove it at once: what a client
      offers, as the vault decides it), and `file_removed`;
      `VersionView.file_removed`. All absent from older vaults. `GET
/api/v1/documents` takes `purge_requested=true|false`.
    - **Added (restore):** a backup holds only the database, so restoring
      one made before a removal brings back the record, not the file. Given
      where the files are kept (`restore-backup` does), the restore looks
      for every version's file; each one missing is marked, listed in the
      report (`filesRemoved`, by document), and answers `410 file_removed`
      ("The file was removed for good.") from `GET /versions/{id}/content`,
      `/pages/{n}` and `/thumbnail`, and through a link, with no download
      written down. Its `file_removed` says so, and it leaves a phone's
      offline set. Only where the place files are kept clearly holds files:
      a folder that is not there, a place that cannot be opened or reached,
      or one holding none of the files it should marks nothing — counted in
      `filesUnchecked`, with why in `filesUncheckedWhy`. The new worker
      command `recheck-files` unmarks every version whose file is back, and
      a removal for good looks first (`409 file_found`, above). A restore
      clears every request to remove for good (`purgeRequestsCleared`):
      asked again, the day starts again.
    - **Changed (shares):** `POST /api/v1/documents/{id}/share` of a
      document whose newest file was removed for good is `422 file_removed`
      ("The file was removed for good, so there is nothing to send."). A
      collection's `GET /share-preview` leaves it unticked with `lock:
"no_file"` and that reason, and `POST /collections/{id}/shares` naming
      it is `422 file_removed`. A collection's link gives it no longer — not
      listed by `GET /shared/items`, not opened — until `recheck-files`
      finds its file back (0045 redefines 0042's `app_link_documents()` to
      say so too).
    - **Changed (storage):** an S3-compatible place gives up connecting
      after 10 seconds, and a stat or a delete after 20, retries and all, as
      out of reach (`unreachable`); reading and writing a file are not cut
      short.
    - **Changed (exports):** `index.csv` gains a last column, `file_note`,
      and `index.html` the same note: a version whose file was removed for
      good, or was not where it is kept, is listed there without its file,
      and the export is made.
    - The activity log: **new** `document.purge_requested` ("Sam asked to
      remove “Payslip” for good", notable) and `document.purged` ("Sam
      removed a document for good", notable, no title, nowhere to go), each
      a line about the document. `document.restored` of one an owner had
      asked about says "…out of the Trash, so it will not be removed for
      good". Once a document is removed, its lines — old and new — are
      shown to whoever could see it, by its tombstone, and to nobody else;
      a line about a document with neither a row nor a tombstone is shown
      to nobody. A collection's link made with a document since removed
      stays unknown to a reader who could not see that document — in `GET
/shares`, a collection's `shared_outside`, taking it back, and the
      log.
    - `@fdv/shared`: `PURGE_NOTICE_HOURS`, `FILE_REMOVED`,
      `COLLECTION_SHARE_FILE_REMOVED`,
      `CapabilityFeatures.remove_for_good`, capability `document.purge`
      (owners). `@fdv/client`: `purgeDocument(token, id)` → `{ removed:
true }` or `{ removed: false, document }`, and `PurgeResult`. The fake
      keeps a Trash (`DELETE`, `restore`, `?deleted=true`), removes for good
      as the vault does, says `purge_at_once`, and a document a test marks
      `filedBySomeoneElse` is asked about first, whoever it belongs to.
    - The database: 0045 adds `document.purge_requested_at` and
      `purge_requested_by` (only in the Trash; both or neither; set only by
      an owner, as themselves, at the database's now —
      `document_purge_request_owner`), `document_version.file_removed_at`,
      and `document_tombstone (id, household_id, visibility,
owner_member_id, link_ids, removed_at)`: read by the family and the
      vault, written only by an owner of a document in the Trash saying
      what its row says, never changed or removed; and `purge_leftover
(household_id, vault_id, object_key, removed_document, tries,
last_error)`, the objects still to be deleted, read and written only by
      an owner and the vault. The restore check knows each.
  - Change a person's details; the owner's view of a sign-in (5.25,
    `features.member_edit`).
    - **Added:** `features.member_edit` in the capability document, `true`.
      Absent from older vaults, which change nobody's details.
    - **Added:** `Member.version` — moved on by one with every change to the
      person's name, date of birth, relationship or passing (never by a
      photo); null to whoever is not given their details (a viewer, but for
      their own). `Member.can_edit` — whether the caller may change their
      name, date of birth and relationship. Both absent from older vaults.
    - **Added:** `PATCH /api/v1/members/{id}` with `{ display_name?,
date_of_birth?, relationship?, is_deceased? }`, strict: what is sent is
      changed, and nothing else; a blank relationship is none; a date of
      birth is a real day, not after tomorrow. Send `If-Match: "<version>"`
      (also `W/"<version>"`, a bare number, or `*`), as with the other
      PATCHes: an older version is `409 conflict`, with the person as they
      are now (as `GET /members` gives them to the caller) in `detail`, and
      nothing is changed. `200` with the person and `ETag: "<version>"`.
      Nothing different sent: no new version, nothing logged. Who may
      change whom is A66, as with photos: an owner, anybody; an adult,
      themselves and anybody with no sign-in; a teen, themselves; a viewer,
      nobody, not even themselves. Refused, in this order: a person the
      caller cannot see, `404`; a viewer, `403 forbidden` in the matrix's
      words (`member.edit`: "Viewers can open and download documents, but
      not change anybody's details."); anybody else not allowed, `403
forbidden` ("Only an owner or the person themselves can change these
      details. For someone without a sign-in, any adult can."); `is_deceased`
      changed by anybody but an owner, `403 forbidden` ("Only an owner can
      record that someone has passed away."); a stale If-Match, `409
conflict`; `is_deceased: true` for somebody who can still sign in, `409
signed_in` ("… Take their sign-in away first, then record that they
      have passed away."); and a change to `is_deceased`, either way, asks
      for a step-up, `403 step_up_required` with `action: "change_people"`
      (any credential, as `change_people` always has). Recording a passing
      takes back, in the same change, every invitation still waiting for
      them (an `invitation.revoked` line each, as one taken back by hand).
    - **Changed:** nobody recorded as passed away is given a sign-in. `POST
/members/{id}/invite` (and `POST /invitations` with their `member_id`),
      accepting an invitation for them (`POST /invitations/accept` and the
      path form), and `POST /members/{id}/sign-in` answer `409 passed_away`
      ("Grandad is recorded as having passed away, so they can't be given a
      sign-in."), and nothing is made. An invitation made or accepted, a
      sign-in given back and a passing recorded each hold the person first:
      one sent again at the moment a passing is recorded is refused, or
      taken back with it, and never left waiting.
    - **Changed:** `POST /api/v1/members` checks `date_of_birth` as the
      PATCH does: a real day, not after tomorrow; otherwise `422
validation_failed`. It took any `YYYY-MM-DD` before.
    - **Added:** `GET /api/v1/members/{id}/account` — an owner's view of
      somebody's sign-in, read-only: `{ member_id, role, email, two_step,
passkeys, last_signed_in_at, devices: [{ label, client, last_used_at,
offline }] }` — `two_step` is two-step sign-in with an authenticator app,
      `passkeys` how many, `last_signed_in_at` their most recent sign-in
      here (null for never), and `devices` where they are signed in now (not
      signed out, not expired), most recently used first, each in words
      ("Safari on a Mac", "the app on a Google Pixel 8a"), `app`, `browser`
      or `other`, and whether it keeps Essentials offline. No address a
      device signed in from, no user agent, no session, credential or
      account id, and nothing secret. Anybody but an owner: `404 not_found`
      ("That page does not exist."), whoever's card they ask for, their own
      included. A person with no sign-in: `404 not_found` ("They have no
      sign-in to show."). Each card given is a line in the activity log
      (below); a refusal writes none.
    - **Changed (A54): new owner powers refuse an owner without two-step
      sign-in.** A power added from this release on — today only `GET
/api/v1/members/{id}/account`; later the locks, owner-started resets and
      signing out everywhere of 5.28–5.30, the restrictions of 5.33, guest
      invitations (5.34) and identity (5.26) — answers an owner who has
      neither two-step sign-in nor a passkey `403 totp_required_for_owner`
      ("Turn on two-step sign-in to manage other people's sign-ins."), and
      asks any other for a step-up whose credential is a passkey or a code
      from an authenticator app, never the password: `403
step_up_required` with **new** `action: "manage_sign_ins"` ("Please
      confirm it is you to manage other people's sign-ins."). `POST
/auth/step-up` with a password still answers `200`, and still opens
      everything it opened before, but not these; one with a `passkey` or a
      `code` opens them for five minutes. A sign-in with a passkey, or with
      a password and a code, is fresh for them at once; one with a password
      alone is not. Every power from before this release is as it was: the
      password still confirms each, and a password-only owner keeps them.
    - The activity log: **new** `member.updated` ("Mansoor changed Aisha's
      date of birth and relationship"; "Sara changed their name") with
      `detail.fields` — which details, never what they were or are — and
      `member.deceased` ("Mansoor recorded that Grandad has passed away",
      or "took back the record that…"), notable, with `detail.deceased`.
      Both are the family's, as a member's lines are: owners, adults and
      teens. And `member.account_viewed` ("Mansoor looked at Sara's
      sign-in"), notable, with no detail at all, for the owners and for the
      person looked at, nobody else (a viewer reads no log).
    - The database: 0046 adds `member.version`, `updated_at` and
      `updated_by` (an account; null for the vault itself), which the
      trigger `member_versioned` keeps — nobody sets them — and which
      refuses anybody signed in but an owner who would change
      `is_deceased`; `member_change_actor`, a restrictive rule for updates
      that holds A66 for every kind of caller (the vault itself; an owner;
      an adult, themselves and anybody with no sign-in; a teen, themselves;
      nobody else); and `session.factor_verified_at`, when the session last
      saw a passkey or a code. `member_versioned` also refuses to record the
      passing of somebody who has a sign-in, and the trigger
      `account_household_not_deceased` refuses a sign-in to somebody
      recorded as passed away, whoever asks, holding the person's row while
      it looks. The restore check knows both triggers and the rule.
    - `@fdv/shared`: `MemberEdit`, `MemberAccount`, `MemberAccountDevice`,
      `FACTOR_STEP_UPS`, `canChangeDetails`, `DETAILS_REFUSAL`,
      `DECEASED_REFUSAL`, `DECEASED_SIGNED_IN`, and the capability
      `member.edit` (owners, adults, teens). `@fdv/client`: `updateMember`
      (the version as If-Match) and `memberAccount`; the fake keeps each
      person's version and answers the account card only for an owner with
      `ownerTwoStep`.
  - Incoming: look before it is filed (5.23). What somebody outside the
    family sends through a request waits for whoever reviews it to look at
    it, then file it or refuse it. `features.upload_requests` is **on** from
    here: the requests (5.21), the sender's routes, and these.
    - **Added:** `GET /api/v1/incoming` → `{ items: IncomingFileView[] }`,
      newest first: the files sent (Finish pressed) and waiting for the
      reader — the requester alone for a request they review alone (A43),
      the owners and adults for one any adult reviews, the owners alone
      once moved to them (below). Each: `id`, `request_id`,
      `request_title`, `recipient_label`, `item_label`, `name` (as sent,
      made safe to show), `content_type` (what its bytes are), `byte_size`,
      `sender_note`, `sent_at`, `removed_at` (30 days after it arrived),
      `scan_state` (`pending` while it is being got ready, then `unscanned`:
      this vault scans for nothing, A42 — never `clean` without a scanner),
      `preview_state` (`pending`, `ready`, `unsupported`, `failed`),
      `preview_pages`, the request's hints `suggested_member_id` and
      `suggested_type_key`, `review_by`, and `moved_to_owners`.
    - **Added:** `GET /api/v1/incoming/{id}/pages/{n}` → a JPEG the worker
      drew for review (1600 px on its long edge, as a version's), `nosniff`,
      never kept by the browser. `404 preview_pending` (retriable,
      `Retry-After: 3`) while it is drawn; `404 no_preview` for a kind the
      vault does not draw (Word, Excel) or a page past those drawn; `409
already_decided` once somebody has filed or refused it.
    - **Added:** `GET /api/v1/incoming/{id}/content` → the file, always
      `Content-Disposition: attachment`, under its own name with the ending
      its bytes say, never the sender's ("invoice.html" that is a PDF is
      "invoice.pdf"); `X-Content-Type-Options: nosniff`, a sandboxing
      `Content-Security-Policy`, `Cache-Control: private, no-store`; and,
      when it was not scanned for viruses (every file, here),
      `X-FDV-Scan: unscanned` and `Warning: 199 - "Not scanned for viruses"`.
      Each copy is a line in the activity log. `409 incoming_not_ready`
      (retriable) while it is still being got ready; `409 already_decided`
      once somebody has filed or refused it.
    - **Added:** `POST /api/v1/incoming/{id}/accept`
      `{ owner_member_id?, type_key?, title?, visibility? }` → `201
IncomingAccepted` `{ document_id, version_id }`: a new document, its
      details checked as a capture's are (the person in the family, Only me
      for one's own only), and a kind the household does not have refused,
      `422 validation_failed` with `detail: "type_key"` — not filed with no
      kind, as a phone's queued capture is: this is chosen now, from the
      list as it is; or
      `{ into_document_id }`, a new version of a document the reviewer may
      see and change, as adding a version asks (the teen's rule included):
      any other is `404 not_found`, and both at once is `422`. It goes
      through the commit every upload goes through; the file is never
      encrypted again — its key is rewrapped for the document, as a
      visibility change rewraps a version's — and its bytes are copied to
      where versions are kept, then its own object and every page of it
      removed, whatever was drawn. A filing whose answer is lost (the
      connection gone as it commits) keeps its copy unless the filing
      certainly did not happen; the daily sweep then removes the file's own
      object only once the version's copy is there — made again from it
      when it is not. The new document's `created_by` is the reviewer,
      never null. Its OCR, page count and previews are queued only now
      (`version.process`).
      `409 already_decided` once somebody has filed or refused it; `409
incoming_not_ready` (retriable) while it is still being got ready.
    - **Added:** `POST /api/v1/incoming/{id}/reject` → `204`: refused, its
      bytes and every page removed, and with them its name, the sender's
      note and its hash. What stays is its row, decided: that a file of that
      kind and size came through the request, and who refused it when. `409
already_decided` once decided.
    - A file sent but not finished (its sender never pressed Finish) is not
      waiting: not listed, and `404 not_found` on every one of these.
    - A teen or a viewer is answered `404 not_found` on every one of these;
      so is another adult, and an owner, for a file of a request somebody
      reviews alone. A decision waits for the reviewer's own role being
      changed, and the change for it: one demoted as they file is answered
      `404` and files nothing. `503 busy` (retriable) for a role that
      changed while the call was on its way.
    - Nothing waiting is searched, listed, reminded or counted: it is not a
      document until it is filed.
    - Removing a document for good (5.24) takes the file it was filed from
      in the same statement: its row, with the sender's name for it and
      their note, and — if they are still there — its bytes and pages,
      written down to be deleted with the rest (`purge_leftover`).
    - **Changed:** `VersionView` gains `sent_through`: "Sent through a
      request link (Jane, accountant)" on a version that came in through a
      request — to whoever may review that request; to anybody else, as on
      an older vault, `null`, and `uploaded_by_name` names whoever filed it.
    - The activity log: "Sam filed a document sent by Jane, accountant",
      "Sam refused a file sent by Jane, accountant", "Sam saved a copy of a
      file sent by Jane, accountant, to look at it", "2 files sent by Jane,
      accountant were removed: nobody filed them within 30 days", and "2
      files sent by Jane, accountant were given to the owners to look at:
      whoever asked for them can no longer" — to the request's reviewers
      only, as its own lines are; never a file's name. The sender's own
      lines read "Upload link (Jane, accountant) …", as since 5.21.
    - The push: **new** `PushMessage` `{ v: 1, type: 'incoming', count }`
      — how many files are waiting for this person, and nothing else; a
      browser is told "3 files sent to your vault are waiting for you to
      look at.", and a tap opens `/incoming` (the push's `url`, where the
      email's link goes). Never a teen, a viewer, or anybody whose sign-in
      was taken away. A phone older than 5.31 shows a push of a type it does not
      know as nothing. The email, through the household's mail server, says
      the same count and where to look, and nothing else.
    - The worker: **new** `incoming.scan` (sent when a sender presses
      Finish): `scan_state` `unscanned` (no `FDV_CLAMD_URL`: scanning is
      built only if asked for, A42), the review pages drawn under the same
      ImageMagick limits as a version's, encrypted under the file's own key
      beside its object; then its reviewers told, once, of every file ready
      and not yet told of (`told_at`) — so a job that stopped between the
      two is made good by the next, or by the sweep. **New** `incoming.move`
      (sent after a role change or a sign-in taken away): what was sent for
      somebody alone to review, once they can no longer review it, is moved
      to the owners — each waiting file's key rewrapped from their own key
      to the adults key, the request's reviewers made `adults` and both
      marked the owners' alone, the request closed — with a line in the
      activity log, and the owners told. **New** daily `incoming.sweep`: a
      file not filed within 30 days of arriving is removed, its bytes, every
      page and its row; a decided file's bytes left behind are removed (a
      filed one's only once its version's copy is there); a request
      past its end with nothing waiting and nothing ever filed from it is
      removed, with its items, sessions, codes and refused files' rows (one
      something was filed from stays: a document's history says it came
      through it); and what a lost job missed is done.
    - Restore: a file waiting in the backup whose bytes have gone since
      (filed, refused or removed after the backup was made) is dropped, and
      the report says how many (`incomingDropped`); a decided file's bytes
      found gone are written down as gone. Only where the files are kept
      clearly holds files, as for versions (5.24): a folder not there, or a
      place holding none of these files and none of its documents', drops
      nothing, and the log says why.
    - `@fdv/shared`: `IncomingFileView`, `IncomingAcceptInput`,
      `IncomingAccepted`, `IncomingScanState`, `IncomingPreviewState`,
      `INCOMING_KEEP_DAYS`, `NOT_SCANNED`, `incomingFileName`,
      `sentThroughWords`, `incomingWords`; `PushMessage` gains `incoming`;
      `CapabilityFeatures.upload_requests`. `@fdv/client`: `incoming`,
      `incomingPage`, `incomingContent`, `acceptIncoming`,
      `rejectIncoming`; the fake keeps files sent in (`state.incoming`) and
      says `upload_requests: true`; the contract gains a scenario (and its
      context `sendFiles`).
    - The database: 0047 adds `incoming_file.preview_state` (`none`,
      `drawing` — one job at a time, taken over after an hour — `ready`,
      `unsupported`, `failed`), `preview_requested_at`, `preview_pages`,
      `object_removed_at`, `owners_only` and `told_at`, a version filed from
      at most one file (`incoming_file_version_key`), and `upload_request
.moved_to_owners_at`. A refused file's `original_name` and `sha256`
      may be null (`incoming_file_named`; `incoming_file_received_whole`
      asks the hash of every other). `document_id` and `version_id` go with
      what they name (`on delete cascade`, where 0044 let go of them), and
      `incoming_file_leaves_bytes` writes a decided file's bytes and pages,
      not yet known gone, into `purge_leftover` as its row goes. Rules of its
      own beside 0044's, which it does not change: a moved request and its
      files are the owners' alone (`upload_request_moved`,
      `incoming_file_moved`); a reviewer never removes a file
      (`incoming_file_account_delete`); and `incoming_file_account_writes`
      lets somebody signed in only file a waiting file — once, as
      themselves, as the version that very transaction made of it, which
      they uploaded, in its own document — or refuse it, naming nothing and
      letting go of its name, note and hash; say once that a decided file's
      object is gone; and nothing else, ever: where a filed file went is
      never changed afterwards, and a sender's session is let go of only by
      the database as it ends. The restore check holds both triggers and
      the owners' rules to being there.
  - Making a request, and the sender's page (5.22). The web's pages for
    5.21's requests, and the changes to the sender's routes that they
    needed.
    - **Changed:** a password the vault makes up for a request
      (`with_password`) is checked as a share link's is (5.20): without
      regard to capitals, dashes or spaces, since it is read out and typed
      unseen — `ABCD EFGH JKMN` opens `abcd-efgh-jkmn`. A password the
      requester typed (`password`) is still checked exactly as typed, and
      so is one a request was made with before this release.
    - **Changed:** `GET /api/v1/drop/session` no longer lists the files
      Finish has sent (`DropSession.files`): they are the reviewer's, and
      Remove could not reach them. A session's next file is listed, and
      sent, on its own.
    - **Added:** `DropPreview` gains `request_id` (which request it is: a
      page with a session for it in this browser already — another tab, or
      the link followed again — carries on in that one with `GET
/drop/session` rather than pressing Open, which would start another
      session under the same cookie name and leave the first one's files
      where nothing can send them), `code_to` (where an emailed code goes,
      masked as `j•••@e•••.com`, as 5.20's link preview says it; null when
      the request asks for none, and in another browser) and
      `other_device` (a this-device-only request already opened in another
      browser: Open would be refused, so the page says so first). The
      preview reads the browser's `fdv_drop_device*` cookies for it, and
      still counts and writes down nothing. All three are absent from
      older vaults.
    - **Changed:** a call inside a session is answered only for the request
      it names — `X-FDV-Drop-Request`, or, with no header and one session
      cookie, the request that cookie's name carries. A cookie under one
      request's name that holds another request's session is `401
drop_session_ended` on every route under `/api/v1/drop` that works
      inside a session, `files` included: neither request is opened by it.
    - **Changed:** the preview of a request opened as many times as it
      allows answers, with its `request_id`, to a browser that presents a
      live session of that request (its own cookie, not past its end and
      not idle for 30 minutes), so that browser can carry on in it: it
      opened the request already. Every other browser is still `410
request_used_up`, and nothing is counted.
    - **Added:** `DropSession.file_limit_bytes`, the vault's own limit for
      one file (`FDV_MAX_UPLOAD_BYTES`), beside `max_file_bytes` (that
      limit, or what is left of the request if less), so a page that gives
      room back when a file is removed caps one file by the vault's limit
      too, and never offers more.
    - The database: 0048 adds `upload_request.secret_kind` (`generated`,
      made up by the vault, hashed and checked lower case without dashes
      or spaces; `password`, typed, checked as typed; null for no password,
      or one from before 0048, checked as typed), only where there is a
      password (`upload_request_secret_kind_hashed`). 0044's rules stand as
      they are: an upload link can change no column but its counters.
    - `@fdv/shared`: `DropPreview.request_id`, `code_to` and
      `other_device`; `DropSession.file_limit_bytes`; and `dropFileName`,
      the rule the vault keeps a sent file's name by (NFC, no control or
      direction characters, runs of space as one, trimmed, 200 characters
      at most), which the API now uses and a page compares names with.
      `@fdv/client` is unchanged: its methods return the new fields as
      they are.
  - Identity records, sealed (5.26, `features.member_identity`).
    - **Added:** `features.member_identity` in the capability document,
      `true`. Absent from older vaults, which keep no identity details.
    - **The honest limit.** Every identity value is sealed, and no owner can
      open another person's Only me part through the vault, by any route.
      But whoever runs the server holds the master key, which wraps every
      key that seals them, and could. A client says exactly that where Only
      me is offered (5.27).
    - **Added:** each person's identity details, in two parts. `shared` is
      read by the person, by the owners, and as the household's audience
      says (below) by all adults or the whole family; viewers never read
      anybody's but their own. `only_me` is the person's alone (A33): no
      owner, nobody else signed in, reads, writes or is told anything of it.
      The fields (A35): `title`, `given_name`, `middle_name`, `family_name`,
      `other_names`, `place_of_birth`, `country_of_birth` (ISO 3166-1
      alpha-2), `sex` (`F`, `M` or `X`, as on documents), `nationalities`
      (alpha-2 each, at most 10), `username`, `company`, `job_title`,
      `notes`, and lists whose entries each carry an `id` the client chooses
      (`[A-Za-z0-9_-]{1,40}`, unique in its list): `emails` and `phones`
      (`{ id, label?, value }`, at most 20 each), `addresses` (`{ id, label?,
line1?, line2?, line3?, city?, region?, postal_code?, country? }`, at most
      10), `ids` — government IDs, `{ id, kind, label?, number?, issuer?,
issued_on?, expires_on?, document_id? }`, `kind` one of `passport`,
      `national_id`, `driving_licence`, `residence_permit`, `tax_id`,
      `social_security`, `health_insurance`, `other`, at most 30 — and
      `custom` (`{ id, label, value?, hidden? }`, at most 50). No blood type
      and no allergies. Every ID's `number`, and every hidden custom field's
      `value`, is masked.
    - **Added:** `GET /api/v1/members/{id}/identity` → `{ member_id,
audience, can_edit: { shared, only_me }, versions: { shared, only_me },
shared, only_me }`, each part `{ fields, masked, filled, version,
updated_at }`: a masked value is left out of `fields` — no `number` in
      that ID, no `value` in that hidden custom field — and named in `masked`
      (`ids.<id>`, `custom.<id>`), so that a part sent back as it was shown
      keeps every value it was never shown; `filled` names what has a value, by key
      (`given_name`, `nationalities`, `ids.<id>`…), never a value. A part
      never written is `{}`, version 0. To anybody but the person, `only_me`
      and `versions.only_me` are null. An ID's `document_id` is left out for
      a reader who may not see that document. Anybody not given the record —
      another adult before the audience is `adults`, a viewer, a person in
      another household, an id that is nobody — is `404 not_found` ("That
      page does not exist."), the same in each case. A look at somebody
      else's record is a line in the activity log, once a sitting (ten
      minutes); one's own is none.
    - **Added:** `PUT /api/v1/members/{id}/identity` with `{ part, version,
fields }`, strict: the whole part, made from the `version` it was read at
      (0 for a part never written). Who writes: the person, both parts of
      their own (an owner, an adult or a teen; a viewer writes nothing, `403
forbidden`); an owner, the shared part of anybody's, people with no
      sign-in included. Another person's Only me part is `404` for everybody,
      at any version: nothing anybody else sends reaches it. A version moved
      on is `409 conflict` with `detail` `{"part", "version"}`, and nothing
      changes; two writes of a part at once, one is made and the other is
      `409`. What the writer was shown masked, or may not see, is kept: an
      entry's `number` (or a hidden custom field's `value`) left out keeps
      what it had, and null or blank clears it; an ID's `document_id` that
      the writer may not see stays, whatever is sent, and one they may see
      is kept when left out and cleared by null. A hidden custom field whose
      `value` is left out stays hidden, whatever `hidden` says: unhiding one
      takes its value, which only a reveal gives. A document linked anew must
      be one the writer may see (`422 validation_failed`). A part whose JSON
      would be more than 128 KiB (131,072 bytes) is `422 validation_failed`
      ("These details are too long to keep. Shorten some of them."), and
      nothing is written. Nothing different is no change: no new version, no
      line. `200` with the record as the writer is shown it. Each part has
      its own version: a change to Only me moves nothing anybody else is
      shown.
    - **Added:** `POST /api/v1/members/{id}/identity/reveal` with `{ part?,
keys }` (`part` defaults to `shared`; 1 to 100 keys) → `{ part, values }`:
      the masked values asked for, by key; a key naming nothing masked is
      left out. Another person's Only me part, and any record not given, is
      `404`, before anybody is asked who they are. Then it asks. Another
      person's numbers, whoever asks — an owner, or an adult or a teen the
      household's audience lets read them: **new** `403 step_up_required`
      with `action: "open_identity"`, a passkey or a code from an
      authenticator app, never the password; somebody with neither is
      refused outright, an owner `403 totp_required_for_owner` and anybody
      else **new** `403 two_step_required`, each "Turn on two-step sign-in to
      see another person's identity numbers." One's own numbers, owners
      included: **new** `action: "reveal_identity"`, any credential. Each
      reveal is a line naming the keys shown, never a value.
    - **Added:** `GET /api/v1/household/identity-audience` → `{ audience,
pending, can_change }`, for anybody signed in: `audience` is who reads
      other people's shared parts now — `owners_and_self` (the default),
      `adults` or `family` — and `pending` a wider one waiting for its
      notice, `{ to, requested_at, notice_until }`, or null. A client shows
      a widening waiting to everybody it is for; this is how every adult is
      told in the app (A34).
    - **Added:** `PUT /api/v1/household/identity-audience` with `{ audience
}`, owners only (anybody else `403 forbidden`, "Only an owner can change
      who sees identity details.", the capability `identity.audience`); an
      owner power (A54): `403 totp_required_for_owner` ("Turn on two-step
      sign-in to change who can see identity details.") for an owner with
      neither two-step sign-in nor a passkey, and **new** `action:
"identity_audience"`, a passkey or a code, never the password.
      Narrowing takes effect at once, withdraws a widening waiting, and
      expires the exports of everybody who no longer reads other people's
      details. Widening waits **72 hours**: `pending` is set, and from
      `notice_until` the wider audience reads — every request counts it from
      then, without anybody having to ask again; everything that reads the
      audience reads that one. Everybody with a sign-in but the owner asking
      — owners, adults, teens and viewers, whose details all gain readers —
      is told: in the app (`pending`), and by the operator's mail server
      where there is one (`FDV_SMTP_URL`), never by push, with nothing of
      anybody's details and the moment it applies on the household's clock,
      its zone named ("From Monday 5 October at 07:00 (America/Los_Angeles),
      …"). The mail is queued last, in the request's transaction: if it
      cannot be, nothing was asked, and asking again asks. Each may mark fields Only me meanwhile.
      Asking again
      for the same does not start the clock again; asking for another
      withdraws the one waiting, and the new one waits its own 72 hours;
      asking for the audience as it is withdraws one waiting. Refused, `409
member_cannot_be_told` ("Tariq cannot sign in just now, so could not be
      told, or mark anything Only me first. …"), while anybody with a
      sign-in, of any role, cannot sign in to be told (today: their account
      switched off, which no mail reaches either; from 5.28, a sign-in locked
      or paused after a restore). `200` with the audience as `GET` gives it.
    - **Changed (A54):** `FACTOR_STEP_UPS` adds `open_identity` and
      `identity_audience`: a client asking for either offers no password
      field. `reveal_identity` takes any credential. **Changed:** the message
      of `403 totp_required_for_owner` names what was asked for ("Turn on
      two-step sign-in to …"); for the account card it is as it was.
    - The activity log: **new** `identity.viewed` ("Mansoor looked at Sara's
      identity details"), `identity.revealed` ("Mansoor showed one of Sara's
      identity numbers", notable when it is somebody else's) with
      `detail.part` and `detail.keys`, `identity.updated` ("Sara changed
      their own identity details") with `detail.part` and `detail.keys` —
      which fields, never a value — each shown to the owners, the person it is
      about and whoever did it, nobody else, and a line about an Only me part
      to the person alone; the person sees a line whenever somebody else
      shows their numbers (A38). And `identity.audience_changed` ("Mansoor
      asked to let all adults see identity details from 5 October at 07:00",
      the moment on the household's clock; "…made identity details visible to
      the owners and each person only"; "…withdrew letting everyone in the
      family see identity details"), notable, with `detail.from`,
      `detail.to`, and `detail.notice_until` or `detail.withdrawn`, shown to
      everybody who reads the log: everybody it tells.
    - Restore: every notice still waiting is withdrawn, so a widening
      withdrawn since the backup cannot come back, and every household's
      audience goes back to `owners_and_self`. The report says how many
      notices were withdrawn (`noticesWithdrawn`) and, for each household,
      what its audience was (`identityAudiences`); the command line says it
      in words. Widening it again goes through the notice.
    - The database: 0049 adds the scope kind `identity` — the household's
      identity key, minted on the first write of a shared part, rewrapped by
      every master-key rotation as every scope key is. 0050 adds
      `household.identity_audience`; `member_identity (household_id,
member_id, part, sealed, dek_wrapped, wrapped_by_scope, filled, version,
updated_at, updated_by)`, each part AES-256-GCM under a fresh data key
      bound to `identity:<household>:<person>:<part>`, the data key wrapped
      under the identity key (shared) or the person's member key (Only me);
      and `notice_request (kind, subject, requested_by, requested_at,
notice_until, completed_at, withdrawn_at)`, a primitive for anything done
      only after the people it touches were told. Their rules: Only me rows
      are the person's alone, whoever asks (an owner's query with no WHERE
      clause finds none of anybody else's); each kind of caller is named —
      somebody signed in reads their own and the shared parts the audience
      in effect gives their role (`identity_audience_now()`,
      `identity_audience_sees()`), the vault itself everything, a share link,
      an upload link, a signed-out page and a caller who says nothing
      nothing; the person writes both parts of their own and an owner the
      shared part of anybody's. Neither table's rows are ever removed but
      with their person or household. Triggers keep each part's version,
      under the key of its part; keep a notice as it was asked, 72 hours at
      least, ending once; and refuse an audience wider than the one in
      effect — nobody widens before the notice runs out, the vault itself
      included. The restore check knows the triggers, asks for the rules that
      say who writes by name and command, and tries them in a transaction it
      rolls back: a viewer changes no identity details of their own, a teen
      with the whole family the audience nobody else's, and nobody signed in
      but an owner asks for a notice.
    - `@fdv/shared`: the field catalogue (`IDENTITY_FIELDS`, `IdentityFields`
      and its entries, `IDENTITY_ID_KINDS`), `IDENTITY_MAX_BYTES`,
      `identityTooLong`, `IDENTITY_TOO_LONG`, `maskIdentity`,
      `identityFilled`, `revealIdentity`, `mergeIdentityWrite`,
      `identityChanges`, `IDENTITY_AUDIENCES`, `IDENTITY_NOTICE_HOURS`,
      `IdentityView`, `IdentityWrite`, `IdentityReveal`,
      `IdentityAudienceView`, `canSeeIdentity` and `canEditIdentity` beside
      `canSee`, `identityAudienceSees`, and the capability
      `identity.audience` (owners). `@fdv/client`: `identity`,
      `updateIdentity`, `revealIdentity`, `identityAudience` and
      `setIdentityAudience`; the fake keeps each part and its version, and
      the audience with its 72 hours.
  - Identity on the web, and in the export (5.27). No route changes; the
    export's contents do.
    - The export holds the people the requester may have (A68):
      `people/<name>.jpg`, each photo they may see (owners, adults and
      teens everybody's; a viewer their own), and `identity/<name>.json`,
      each identity record they may read when it is built — the person's
      own, and others' as `canSeeIdentity` gives them under the audience in
      effect then. `index.json` gains `people`, `{ id, name, photo,
identity }` for everybody, the paths null where the export has none,
      and `index.html` a section for each. A record is `{ person,
member_id, shared, only_me? }`, each part `{ fields, masked? }`.
    - The requester's own record is whole: both parts, every number.
      Anybody else's is their shared part as `GET …/identity` shows it, with
      every ID number and hidden field left out and named in `masked` — the
      vault shows those only to whoever confirms it is them with a passkey
      or a code (A54), each a line the person sees (A38), and an export is
      asked for with any credential. Another person's Only me part is in no
      export. An ID's `document_id` is kept only where the requester may see
      that document.
    - The command line's restore summary says who can see identity details
      went back to the owners and each person, and what it was.
    - **Changed:** a person who takes a field out of their own shared part
      — into Only me, or away — ends every export anybody else asked for
      (`expires_at` now), as making a document Only me does: those were
      built while they could read it. An owner's change to somebody else's
      shared part ends none.
    - **Changed:** a role change that takes away sight of other people's
      identity details under the audience in effect ends that person's
      exports, beside the rule for the adults' documents: an owner who steps
      down to adult, or is made an adult by an owner change carried out,
      while the audience is the owners and each person.
    - **Changed:** a restore ends every export still to be downloaded, as it
      ends every session: one made under a wider audience would otherwise be
      served again. The report counts them (`exportsExpired`), and the
      command line says so.
  - Lock a sign-in (5.28, `features.member_admin`).
    - **Added:** `features.member_admin` in the capability document, `true`.
      Absent from older vaults, which lock nobody.
    - **Added:** `POST /api/v1/members/{id}/lock` with `{ until?, end_links?,
note? }`, strict: `until` an ISO moment with its offset, in the future and
      within a year (`LOCK_MAX_DAYS`, 365), or left out or null for "until an
      owner unlocks it"; `end_links` true to take their links and requests
      back for good rather than pause them; `note` (trimmed; blank is none;
      500 characters at most, `LOCK_NOTE_MAX`) for the owners, never shown
      to the person. `200` with `{ member_id, suspension: { reason: "locked",
since, until, note, by } }`, `by` the locking owner's name. Owners only
      (A52; the capability `member.suspend`). Refused, in this order: what
      was sent, `422 validation_failed`; anybody but an owner, `403
forbidden` ("Only an owner can lock or unlock someone's sign-in."); an
      owner power (A54), as the account card is — `403
totp_required_for_owner` for an owner with neither two-step sign-in nor a
      passkey, otherwise `403 step_up_required` with `action:
"manage_sign_ins"`, a passkey or a code, never the password; a person with
      no sign-in, or nobody, `404 not_found` ("They have no sign-in to
      lock."); oneself, `422 validation_failed` ("You cannot lock your own
      sign-in."); an owner, `409 owner_notice_required` (A50: "… one owner's
      sign-in is never locked by another. Ask for their role to be changed
      first — that takes seven days, and they are told about it."); somebody
      locked already, `409 already_locked`; an end gone by, or more than a
      year off, `422 validation_failed`. Somebody paused after a restore may
      be locked: the lock takes the pause's place. What a lock does, in one
      transaction (A51): every session of theirs ends, with the reason
      `suspended`, and every device with it (their phones are pushed
      `session_ended` once it commits); the invitations they sent are taken
      back and their reset links used up; their exports stop being
      downloadable; their share links, collection links and requests to send
      documents stop answering — `404 link_not_valid` to whoever holds one,
      as any link that has stopped, and a page open with one stops at its
      next request — and answer again, as they were, once the lock ends;
      with `end_links` those still live are taken back instead (a
      `share.revoked` or `upload_request.revoked` line each), and stay so —
      one that has run out, or locked itself after ten wrong tries, is left
      as it ended, with no line; a wider audience for
      identity details still waiting is withdrawn (5.26: an
      `identity.audience_changed` line with `detail.withdrawn`). Once it
      commits, what was sent for them alone to review moves to the owners
      (`incoming.move`, 5.23), and its request closes — a lock alone does
      that: a pause after a restore takes nobody's right to review away, and
      what was sent for them waits, untold, until they are turned back on.
      The person is emailed, with nothing secret and not the note; the other
      owners are told.
    - **Added:** `DELETE /api/v1/members/{id}/lock` — the lock ends now:
      `204`. Asked and refused as a lock is; somebody not locked (never,
      past its end, or paused after a restore) is `409 not_locked`. Their
      links and requests that were not taken back answer again, and they
      sign in as before; the person is emailed, the other owners told.
    - **Added:** a lock with `until` ends by itself: from that moment every
      read takes it as over — signing in, their links and requests, the
      account card, who can be told of a widening — with nothing written and
      nothing to run. The next lock writes over it.
    - **Added:** `GET /api/v1/members/{id}/account` gains `suspension` — `{
reason, since, until, note, by }` while their sign-in is locked
      (`reason: "locked"`) or paused after a restore (`reason: "restored"`,
      `by` null), null otherwise — and `max_offline_days`, how many days a
      phone may go on showing the Essentials it keeps without reaching the
      vault (FDV_OFFLINE_MAX_DAYS, the `max_offline_days` a phone is given):
      what a phone that never reconnects keeps after a lock. Both absent from
      older vaults.
    - **Added:** `403 membership_suspended`, with `error.reason` `locked` or
      `restored`, for a sign-in refused while it is locked or paused — said
      only once the password, the code (with two-step sign-in, at `POST
/auth/mfa`; the password step still answers `mfa_required`) or the
      passkey is proven, so it tells nobody else which accounts there are.
      A wrong password is still `401 invalid_credentials`. Its message says
      until when, on the household's clock ("An owner has locked your
      sign-in until Monday 5 October at 07:00 (Europe/London). …"). Treat a
      reason never heard of as paused.
    - **Added:** `401 session_ended` gains the reason `suspended`: a session
      ended by a lock, and any request or refresh of a session whose person
      is locked or paused after a restore. A client says the person's sign-in
      is paused, not that something went wrong; older apps wipe as for every
      reason but `expired`.
    - **Changed:** a switched-off account's passkey sign-in is refused (`401
passkey_rejected`), as its password always was; it went straight on.
    - **Changed:** `PUT /household/identity-audience` refuses a widening, `409
member_cannot_be_told`, while anybody with a sign-in — of any role — is
      locked or paused after a restore, as for a switched-off account.
    - **Changed:** `POST /members/{id}/role` making a locked or paused person
      an owner is `409 locked`: unlock them, or turn them back on, first.
    - **Changed:** a link or a request whose maker's sign-in is locked or
      paused after a restore has `state: "paused"`: it works again by itself
      once they can sign in, and no owner turns it on — `GET /after-restore`
      lists only a restore's own pauses, and `POST /shares/{id}/resume` on
      one is `404`. Why is said to an owner and to its maker alone:
      `ShareView.paused_reason` and `UploadRequestView.paused_reason` gain
      `locked` (their sign-in is locked) and `sign_in_paused` (it waits after
      a restore), with `paused_at` when that began. Anybody else is given
      `paused_reason: null` and `paused_at: null`, and a link's `summary`
      says only that it is paused: a lock is the owners' and the person's to
      know (A51). A link or request turned back on after a restore whose
      maker still waits answers `state: "paused"`, `sign_in_paused`; one
      whose maker's lock the restore kept answers `locked`. Say what it
      still waits for from the answer, not that it works again, and offer
      turning one on only for `paused_reason: "restored"`. Treat a reason
      never heard of as paused.
    - **Changed: a restore pauses every sign-in but the owners'** (A55). A
      backup cannot know of a lock made after it, nor of a sign-in taken away
      since; so after a restore each person but the owners waits, `reason:
"restored"`, for an owner to turn their sign-in back on. A lock in force
      the backup holds, on somebody who is no owner, stays a lock, and loses
      any end of its own (it may have been made longer since); one past its
      end is over — paused like the rest, or, on somebody since made an owner,
      cleared away — and an owner's is left as it is. A backup from
      before 0051 is brought up to date, then paused. The report says how
      many wait (`signInsPaused`) and how many locks it kept (`locksKept`),
      and the command line says why. The restore fails, closed, if any
      sign-in but an owner's is left open, or a household is left with no
      owner who can sign in.
    - **Added:** `GET /api/v1/after-restore` gains `sign_ins`: `[{ member_id,
display_name, role, paused_at }]`, every sign-in a restore paused, for an
      owner (anybody else, `[]`); its role is shown to confirm, and 5.33 adds
      a viewer's restriction beside it. Absent from older vaults. **Added:**
      `POST /api/v1/members/{id}/resume` turns one back on: `204`. Owners
      only (`restore.review`, "Only an owner can turn things back on after a
      restore."), asked as a lock is (`manage_sign_ins`); somebody not paused
      by a restore is `409 not_paused` (a lock is unlocked, not resumed).
    - Alerts, reminders and digests go to nobody whose sign-in is locked or
      paused, as to nobody switched off; only what is about their own sign-in
      — the lock, and its end — reaches them.
    - Somebody made an owner whose lock ran out by itself has what was left
      of it cleared, whoever makes them one: an owner is never unlocked, and
      a restore would otherwise have found it.
    - The activity log: **new** `member.locked` ("Mansoor locked Sara’s
      sign-in until 5 October at 07:00, and ended their links for good") with
      `detail.until`, `detail.end_links` and how many sessions, invitations,
      links, requests and exports it ended (`detail.widening_withdrawn` when a
      widening was), never the note; and `member.unlocked` ("Mansoor unlocked
      Sara’s sign-in"; with `detail.reason: "restored"`, "… turned Sara’s
      sign-in back on after the restore"). Both notable, for the owners and
      the person they are about, nobody else.
    - The database: 0051 adds to `account_household` `suspended_at`,
      `suspended_by`, `suspended_until`, `suspend_reason` (`locked` or
      `restored`) and `suspend_note` (500 characters at most), and
      `suspension_in_effect(at, until)`, which every read of one asks. The
      owner floor (`assert_owner_remains`, now 0051's) asks for an owner who
      can sign in — not locked, not paused — however the change is made: the
      API, the vault itself, a restore, a statement by hand. The trigger
      `account_household_suspension` lets only an owner signed in change a
      suspension, never their own, never another owner's (A50), and lets
      nobody signed in make a locked person an owner. `app_shared_document()`,
      `app_live_share()` and `app_live_upload_request()` (now 0051's) give a
      link or a request nothing while its maker's sign-in is suspended; and
      `upload_requests_end_for_lock()` takes back a locked person's requests,
      with the owner's rights, for a lock with `end_links`. The restore check
      knows the new trigger.
    - `@fdv/shared`: `MemberSuspension`, `SuspendReason`, `MemberLock`,
      `PausedSignIn`, `LOCK_MAX_DAYS`, `LOCK_NOTE_MAX`, `suspensionInEffect`,
      `MemberAccount.suspension` and `max_offline_days`, the capability
      `member.suspend` (owners), and `features.member_admin`. `@fdv/client`:
      `lockMember`, `unlockMember`, `resumeMember`, and `afterRestore`'s
      `sign_ins`; the fake locks and unlocks, ends a locked person's sessions
      with `suspended`, refuses their right password with `403
membership_suspended`, takes a lock past its end as over, and pauses
      sign-ins as a restore does (`pauseSignIns()`).
  - A password reset the owner starts (5.29, D5, A48–A50).
    - **Added:** `POST /api/v1/members/{id}/password-reset` with `{
stop_now? }`, strict. Owners only (the capability `member.reset_password`:
      "Only an owner can start a reset of someone's password."), and an owner
      power (A54) asked as a lock is — `403 totp_required_for_owner` for an
      owner with neither two-step sign-in nor a passkey, otherwise `403
step_up_required` with `action: "manage_sign_ins"`, a passkey or a code,
      never the password. Refused, in this order: what was sent, `422
validation_failed`; anybody but an owner, `403 forbidden`; the owner
      power; a person with no sign-in, or nobody, `404 not_found` ("They have
      no sign-in to reset."); oneself, `422 validation_failed`; an owner, `409
owner_notice_required` (A50); somebody locked, or paused after a restore,
      `409 locked`; `stop_now` where no link can reach them (`operator`, below),
      `409 stop_now_unavailable`, with nothing done. `200` with `{ member_id, path, stop_now, link?,
expires_at?, command? }`, where `path` is the way it went:
      - `mail` — whoever runs the server set `FDV_SMTP_URL`: a link that
        works once, for an hour (`expires_at`), goes to the person's own
        sign-in address by that mail server alone, never the household's,
        by email alone. The answer and the activity log carry no link.
      - `handover` — no operator mail, and the person keeps nothing private:
        no Only me document (in the Trash too, or removed for good), note or
        detail; no Only me identity part, whatever it holds (a label alone
        too); no request to send documents that they alone review, in any
        state — taken back, closed, run out — until the worker removes it,
        nor any file sent through one that is still kept while the request is
        still theirs to review (one moved to the owners is not); no export that has
        not run out; no Only me collection, deleted too. The answer's `link`
        (`/reset#…`) is shown this once, and works once, for an hour. It
        stops working — `404 reset_not_valid`, as any dead link, saying
        nothing of why — if the person keeps anything private, or has been
        made an owner, by the time it is spent: asked again as it is.
      - `operator` — anybody else: no link is made. `command` is what
        whoever runs the server types: `docker compose exec api node
apps/api/dist/cli.mjs reset-password '<their address>'`, the address
        quoted for a POSIX shell (each `'` written `'\''`), so it is passed
        whole and as it is.

      The answer says only which way, never what was found. A teen follows
      the same rule (A49). With `stop_now`, on `mail` and `handover` only,
      their password stops working at once and every session of theirs ends
      (`401 session_ended`, reason `revoked`; their phones are pushed
      `session_ended`): nobody is given a password (A48), and they choose one
      through the link. A passkey of theirs still signs them in until the link
      is spent; a lock is what keeps somebody out. Spending any link signs
      them out everywhere, removes their passkeys and leaves two-step sign-in
      to be asked for, as before. The person is told — by the link's own
      mail, or by a mail with no link — and the other owners are told
      (`owner_change`). Once a `handover` link is spent, the person's mail says
      an owner was given it, and to set a password of their own.

    - **Added:** `GET /api/v1/members/{id}/account` gains `reset_path`:
      `mail`, `handover` or `operator`, which way a reset would go now; null
      for an owner, or somebody locked or paused. Absent from older vaults,
      which have no such reset. Treat a value never heard of as `operator`.
    - **Added:** `GET /api/v1/me` gains `reset_notice` — `{ by, at, spent_at,
passkeys_since, two_step_since, links_since }`: the owner who was given a
      link to hand over for this sign-in (`by` null once their sign-in is
      gone) and when; when such a link was last spent (null while none has
      been); and what was added to the sign-in since — each passkey `{ label,
added_at }`, when two-step sign-in was turned on (null if it was not), and
      each share link made as them that still works `{ title, made_at }` — until the
      person says they saw it with **`DELETE /api/v1/me/reset-notice`** (`204`,
      also when there is nothing to see). Null otherwise; absent from older
      vaults. And `handover_since`: when such a link was last spent, null if
      never.
    - **Changed: after a hand-over link is spent, every change of the
      password, and every reset, removes each passkey and two-step sign-in
      added to the sign-in since, and ends each share link made as them since**
      (document and collection links still working, each with a
      `share.revoked` line) — whoever spent the link chose the password and
      could have added them. Not only the first change: an owner could change
      it first, add a passkey, and then hand the person a password. The
      person's own added since go too (a client says so before the change,
      from `handover_since`); `auth.password_changed`'s
      `detail.passkeys_removed`, `detail.two_step_removed` and
      `detail.links_removed` say what went. A reset keeps two-step sign-in
      turned on after the last change of the password, which may be the
      person's own: a reset leaves two-step sign-in to be asked for.
    - **Changed:** a change of the password holds the person's sign-in while
      it is made, as a reset and a lock do: a passkey added, two-step sign-in
      turned on, or another change, from a session it ends, waits for it and
      is then refused, `401 session_ended`.
    - **Added:** `POST /api/v1/password-resets/lookup` (and its path form)
      gains `issued_by`: `self`, `operator` or `owner`; `issued_by_operator`
      is true for an owner's link too. Absent from older vaults.
    - **Changed:** every reset link spent — the person's own, an owner's, the
      command line's — now also ends the person's exports
      (`auth.password_reset`'s `detail.exports` says how many).
    - **Changed:** `401 session_ended`, with the reason the session ended
      for (`revoked`, or `suspended` for a lock), also answers a request that
      waited for a reset, a stopped password or a lock to end the session it
      came from: one that would have made something private for its person, a
      password change, a passkey added, two-step sign-in turned on. None of
      them is made.
    - **Changed:** a sign-in whose password or passkey was proven just before
      a reset, or a stopped password, commits opens no session: `401
invalid_credentials` (a password) or `401 passkey_rejected` (a passkey),
      as for a wrong one. Checked again where the session opens.
    - The activity log: **new** `member.reset_started` ("Mansoor made a
      one-time link to reset Sara’s password, and stopped their password
      now"; "… sent Sara’s sign-in address a password reset"; "… asked for
      Sara’s password to be reset by whoever runs the vault") with
      `detail.path`, `detail.stop_now` and how many sessions it ended, never
      a link. Notable, for the owners and the person it is about, nobody
      else.
    - The database: 0052 lets `password_reset.issued_by` be `owner`, and adds
      `household_id`, `issued_by_account`, `handover` and `told_at`; a rule
      for somebody signed in (`password_reset_account`) reaches their own
      reset links, and an owner those of their household's people, no other;
      and an owner's reset is read by no caller in another household
      (`password_reset_household`); `account.handover_spent_at` says when a
      hand-over link was last spent, and `account.password_changed_at` when the
      password was last changed (not reset); `handover_links_end(account)` ends
      the share links made as them since, with the owner's rights, for the
      account itself or the reset of it spent this very transaction. `member_holds_private(account)` answers
      yes or no, with the owner's
      rights, to an owner or to the reset being spent for that account, and
      refuses anybody else; `password_reset_expire_exports(account)` ends the
      exports of the account whose reset this very transaction spent. Writing
      anything private for somebody (`member_private_gained`, on documents,
      collections, identity parts, requests, incoming files and exports)
      waits for a reset being spent for them, and is refused for a session
      that ended meanwhile, with the vault's own SQLSTATE `FDV01` (no other
      error is answered as a session's end). The restore check knows the new
      triggers and the rule; a restore ends owners' links with every other.
    - `@fdv/shared`: `ResetPath`, `OwnerResetInput`, `OwnerResetResult`,
      `ResetNotice`, `RESET_LINK_MINUTES`, `resetCommand`, `shellQuoted`,
      `MemberAccount.reset_path`, `Me.reset_notice`, `Me.handover_since`,
      `ResetPreview.issued_by`
      and the capability `member.reset_password` (owners). `@fdv/client`:
      `startPasswordReset` and `dismissResetNotice`; the fake starts a reset
      by the way its `operatorMail` and `keepsPrivate` say, stops a password
      with `stop_now` (refusing it on `operator`), and keeps the notice until
      it is dismissed.
  - Role changes reach every device; sign out everywhere (5.30,
    `features.sign_out_everywhere`).
    - **Added:** `features.sign_out_everywhere` in the capability document,
      `true`. Absent from older vaults.
    - **Added:** `DELETE /api/v1/members/{id}/sessions` signs somebody out
      everywhere (A53): `200` with `{ member_id, sessions_ended }`. Every
      session of theirs ends — `401 session_ended`, reason `revoked`, to its
      access and refresh tokens alike — with its offline grant, and every
      device of theirs here; their phones are pushed `session_ended` once it
      commits. Their sign-in is as it was: they sign in again with their own
      password. A co-owner too, who is emailed; anybody else it is about is
      emailed as well (no push: their devices went with their sessions).
      Oneself: every session but the one asking, as a password change does.
      Owners only (the capability `member.sign_out`): anybody else `403
forbidden` ("Only an owner can sign someone out everywhere."), oneself
      included. An owner power (A54), asked as a lock is: `403
totp_required_for_owner` for an owner with neither two-step sign-in nor a
      passkey, otherwise `403 step_up_required` with `action:
"manage_sign_ins"`, a passkey or a code, never the password. Nobody with a
      sign-in: `404 not_found` ("They have no sign-in to sign out.").
    - **Added:** `RoleChangeResult.effects` — what a role change did besides
      the role, each `{ effect, count }`, only what happened (`[]` for
      nothing, and for a change that did not happen or waits its seven
      days): `offline_ended` (the sessions whose offline grant ended),
      `requests_closed`, `exports_ended`. On `POST /members/{id}/role`, `POST
/me/step-down` and `POST /owner-changes/{id}/complete`. Its `message`
      says them too ("Wes is now a teen. Their phone removes the Essentials it
      keeps at its next sync."). Absent from older vaults; treat an effect
      never heard of as something it did. `@fdv/shared`'s
      `roleChangeEffects(from, to)` says which a change may do, before it is
      made.
    - **Changed:** a role change that takes sight away — an owner or an adult
      made a teen or a viewer, anybody made a viewer (`reducesSight`) — ends
      the offline grant of every session of theirs: `GET
/offline/essentials` answers `items: []` and `grant: null` at the phone's
      next sync, so it removes what it keeps (older phones already take no
      grant as an empty set, 4.9). Keeping Essentials again asks for the
      password, as ever. And a viewer is given no grant whatever their
      session holds.
    - **Changed:** a role change that takes away `upload_request.create`
      closed their requests already (A39); it now says how many, and a line
      says so. Only live ones are counted, and have an `upload_request.closed`
      line: one that had run out, or locked itself after ten wrong tries, is
      closed too, with no line, as for any change that takes asking away
      (0053 narrows what `upload_requests_close_lost()` returns).
    - **Changed: token families.** Every refresh token names its session:
      `household.session.secret`, the secret 16 random bytes and 16 of an
      HMAC under a key derived from the master key. Any token the vault made
      for a live session, presented once it has been replaced, ends the
      session as `reused` — not only the token just replaced: a thief who
      spends a stolen token and then its successor before the owner does
      loses the session when the owner's token comes in, whichever is
      presented second. The 30-second grace for an answer that never
      arrived is unchanged. A token that names a session but whose tag is
      not the vault's ends nothing (`revoked`). Treat refresh tokens as
      opaque, as ever: a token from before (`household.secret`) still
      refreshes, and is answered with one of a family; the vault keeps it
      with the tokens a grace touched, so it too ends the session if it is
      ever presented again. A spent token of a session that has ended says
      why it ended, as the token just replaced always did.
    - **Changed: trusted proxies.** `FDV_TRUST_PROXY` gains `network`, the
      new default: `X-Forwarded-For` is believed only from the networks the
      API's own container is on (nginx and Caddy in the compose setup),
      never from a device on the LAN, and only the one address that peer
      wrote last: a proxy of one's own must overwrite the header, not add to
      it. `private` (the old default, every
      private address), `all` and `none` stay. nginx passes on the address a
      request came from and nothing the caller wrote; the TLS overlay's
      Caddy sends `/api/*`, `/healthz` and `/readyz` to the API itself, and
      binds `:8080` to `127.0.0.1`; there Caddy bounds a request's headers (10
      seconds), its whole body (30 minutes) and an idle connection (2
      minutes), as nginx did. An `X-Forwarded-For` entry that is not an
      address is not believed — the address recorded is the last good one —
      where it was a `500`.
    - **Changed:** an upload over the size limit (`POST /documents/{id}/versions`,
      `POST /capture`) is answered `413 too_large` as before, and if the
      client is still sending five seconds later the connection is closed;
      until now the rest was read to nowhere for as long as it came.
    - The activity log: **new** `member.signed_out_everywhere` ("Mansoor
      signed Sara out everywhere"; oneself, "… signed out of every other
      device") with `detail.sessions` (and `detail.self`), notable;
      `member.offline_ended` ("Mansoor changed Wes’s role, so their phone
      stops keeping Essentials") with `detail.sessions`; and
      `member.requests_closed` ("… so their request to send documents
      closed") with `detail.requests`. Each for the owners, the person it is
      about and whoever did it, nobody else. The role change's own line keeps
      its audience.
    - `@fdv/shared`: `SignedOutEverywhere`, `RoleChangeEffect`,
      `RoleChangeEffectDone`, `RoleChangeResult.effects`, `reducesSight`,
      `roleChangeEffects`, the capability `member.sign_out` (owners), and
      `features.sign_out_everywhere`. `@fdv/client`: `signOutEverywhere`;
      the fake signs people out everywhere, and ends a session when any token
      it has spent is presented again.
  - The restriction, enforced by the database (5.32, D6, A56–A59). No route
    changes yet: 5.33 adds `PUT`/`DELETE /members/{id}/access` and the
    screens. Older phones simply see fewer documents.
    - **Added:** `GET /api/v1/after-restore`'s `sign_ins[]` gain
      `restriction`: `{ summary }`, a restricted viewer's restriction in a
      sentence ("Restricted: sees 1 person's documents of 2 kinds and 1
      collection. Adults-only documents included."), shown to confirm beside
      the role (A55); `null` for somebody with none. It counts only
      collections that grant something (for Everyone, not deleted), and says
      so when every kind, or every person, it named has been deleted since
      ("… so it gives no documents by person or kind"). Absent from older
      vaults.
    - **Changed:** a restricted viewer is given, by every route, only what
      their restriction grants — the database narrows each table, so a list,
      a count, a search, a page, a file, a reminder, a link or a digest that
      does not ask still cannot reach outside it. Within the ceiling (the
      household's documents; Adults only ones when an owner allows it, D6;
      their own Only me ones; never somebody else's Only me): their own
      documents, those of the people named and the kinds named together
      (A56), and those in a granted collection while it is for Everyone and
      not deleted; a document of nobody's only with the checkbox (A57).
      Deleting a person or a kind that is named only narrows: once every one
      named is gone, that part gives nothing. Nothing at all once the
      restriction's end date has passed. People: themselves, those named,
      and the owners of what they can see, and what hangs off a person
      follows them (sign-ins, their accounts, invitations, keys, dismissed
      suggestions); sessions, devices, known devices and notification
      settings only their own; no collection but those granted and their
      own; identity details, their own only; none of the household's
      answers; kinds of document, the built-ins and those granted or in use
      on what they can see; exports, their own; a link's sessions as the
      link is given; lines of the activity log about a document, a reminder,
      a person, a kind or a collection as that is given, and any other only
      their own.
    - **Changed:** who may see Adults only documents is worked out once for
      each sign-in (`seesAdults`): the role's `document.see_adults`, or a
      viewer whose restriction an owner lets include them. Every copy of the
      visibility rule — the document list, search, tags, issuers, reminders,
      collections, suggestions, counts, links, the digest and the export —
      reads it. An unrestricted viewer sees no Adults only document, as
      before.
    - **Changed:** a restriction stands only beside a viewer's role (A58).
      Changing a restricted person's role to anything else, giving their
      sign-in back as anything else, or inviting them as anything else is
      refused with **new** `409 restricted` ("… access is limited to some
      documents. Remove their limits first."), and accepting such an
      invitation is refused the same way.
    - **Changed:** a link lends no more than its maker may see now. A link
      made by somebody restricted since gives only what their restriction
      gives (a document outside it, or a collection, gives nothing: `404` as
      for any link that has stopped). To an owner and to its maker,
      `GET /shares` lists it as `paused` with **new** `paused_reason:
"limited"` ("Paused: the access of whoever made it is limited, and it
      gives nothing outside what they may see now."); anybody else is told
      it is paused. Treat a reason never heard of as paused, as before.
    - The database: 0054 adds `access_restriction`, keyed on the person (not
      on their sign-in: taking it away and giving it back keeps it, and asks
      the owners to confirm it again, `reconfirm_since`), with
      `include_adults_only`, `include_no_person_docs`, `limits_people`,
      `limits_types`, `expires_at`, `created_by`, `updated_at` and
      `private_confirmed_at`; and `access_restriction_member`, `_type` and
      `_collection`. Owners read and write them, the person reads their own;
      a new one is for a viewer only, one for somebody who keeps Only me
      documents needs `private_confirmed_at` (A59), and nobody restricted is
      given another role (`account_household_restricted_role`, SQLSTATE
      `FDV02`). `app_restricted()`, `app_grant()` (the caller's grant, read
      once a statement), `app_granted_documents()`, `app_granted_people()`,
      `app_granted_collections()` and `app_granted_types()` answer with the
      owner's rights; `doc_in_grant()` is the rule itself, a pure function
      of a grant and a document, with no rights of its own. A restrictive
      rule on every table a document's rows hang from, and on the family's
      own, asks them. `app_grant_of()` and `maker_lends()` read anybody's
      grant and are granted to nobody; `share_link_lends()` answers whether a
      link's maker still lends what it was made for, and
      `app_shared_document()`, `app_live_share()` and `app_link_documents()`
      (now 0054's) ask `maker_lends()`. The restore check knows the new rules
      and triggers, fails if any is missing or if the application role can
      run `app_grant_of()`, and asks each restricted person's documents as
      them.
    - `@fdv/shared`: `seesAdults`, `restrictionMayWiden`, `mayBeRestricted`,
      `AdultsGrant`, `canSee`'s `seesAdults`, `restrictionSummary`,
      `RestrictionCounts`, `RestrictionSummary`, `PausedSignIn.restriction`
      and `ShareView.paused_reason`'s `limited`.
  - Limit what a viewer can see (5.33, `features.access_restrictions`; D6,
    A17, A27, A29, A56–A59). Older phones simply see fewer documents.
    - **Added:** `PUT /api/v1/members/{id}/access` with `{ people[],
types[], collections[], include_adults_only, include_no_person_docs,
expires_at, limits_people?, limits_types?, confirm_private? }` (each
      optional; a list left out is none, a checkbox false, the end none)
      limits a viewer to that grant, or changes their limits, and answers
      `MemberAccess`: the grant, `limits_people` and `limits_types`,
      `summary` (the sentence `restrictionSummary` makes), `reconfirm_since`,
      `private_confirmed` and `updated_at`. `limits_people` and
      `limits_types` say whether it names people, or kinds, at all: true
      whenever one is named, and still true once every one it named has been
      deleted — then it gives nothing by person or kind (R532-01). Send them
      back as `MemberAccess` gave them. An empty list never clears one by
      itself: left out, it stays as it is; only `false` lets an empty list
      mean anybody's, or any kind. `DELETE` takes the limits off (`204`, also
      when there were none); the viewer then sees every family document but
      the Adults only ones. Both are owners only and an owner power (A54),
      with **new** step-up action `limit_access`. A PUT is refused in this
      order: anybody but an owner `403 forbidden`; a body of the wrong shape
      `422`; an owner with neither two-step sign-in nor a passkey `403
totp_required_for_owner` ("Turn on two-step sign-in to limit what a
      viewer can see."), and any other without a passkey or a code within five
      minutes `403 step_up_required` (`limit_access`; `FACTOR_STEP_UPS` lists
      it), never the password; nobody of the family `404`; anybody but a
      viewer (or somebody with no sign-in) `409 not_a_viewer`; what the grant
      names `422` (people, kinds and collections of the family, a collection
      for Everyone, an end in the future); somebody who keeps Only me
      documents `409 confirm_private` until it is sent again with
      `confirm_private: true` — they are then told by email (A59), once, or,
      with no sign-in then, when their sign-in is given back. Putting the
      same grant again after their sign-in was given back confirms it
      (`reconfirm_since` becomes null) — its end too, even one that has
      passed, which stays ended; a new end in the past is refused. Taking the
      limits off clears it too. A change applies from the viewer's next
      request. A change that lets a flag go, as any widening, is logged as
      `access.changed`, never as a confirmation.
    - **Added:** only a collection for Everyone may be granted (A17): any
      other is `422 validation_failed` with a sentence ("“Teen papers” is for
      Teens and up, so it cannot be given to a viewer. Only a collection for
      Everyone in the family can be."; `onlyEveryone` in `@fdv/shared`). A
      collection whose audience changes away from Everyone, or that is
      deleted, leaves every grant in the same transaction, and is not given
      again by itself should it be made Everyone, or brought back. A deleted
      collection sent in a grant is left out, not refused; `MemberAccess`
      names only collections that still grant.
    - **Added:** `GET /api/v1/members/{id}/access/preview` counts a grant not
      yet saved — `?people=a,b&types=x,y&collections=c&include_adults_only=true&include_no_person_docs=false&expires_at=…`
      (lists comma-separated; `limits_people` and `limits_types` too) — by
      the rule itself, as a PUT would write it, and answers `{ documents,
keeps_private? }`: what they would then see out of the Trash, but for
      their own Only me documents, whose number is told to nobody else.
      `keeps_private` says there are some, and is there only for an owner
      whose session gave a passkey or a code within five minutes. Only
      somebody who could be limited is counted: anybody else `409
not_a_viewer`. `GET /api/v1/access/preview` counts for somebody not yet
      in the family, who owns nothing. An owner's, or an adult's (who may
      invite a viewer) without Adults only documents (`403`); anybody else
      `403`.
    - **Added:** `GET /me` gains `restriction`: for a restricted viewer, `{
summary, people[{ id, display_name }], types[{ key, label }],
collections[{ id, name }], include_adults_only, include_no_person_docs,
expires_at }`, in their own words ("You can see: Tax return documents for
      Ahmed, the collection “For the accountant” and your own."), naming
      only what the vault gives them now; `null` for anybody else.
    - **Added:** `GET /members` gains `restriction: { summary } | null` on
      each person, for owners alone; absent for anybody else. `GET
/members/{id}/account` gains `access`: a viewer's `MemberAccess`, or
      `null`.
    - **Added:** an invitation (`POST /invitations`, `POST
/members/{id}/invite`) takes `restriction`, a grant as above, for a
      viewer only (`422` otherwise), checked as the inviter sees the family.
      Accepting it applies it in the same transaction that makes the
      sign-in, so the viewer is never unrestricted for a moment; what it
      names that was deleted since (or a collection no longer for Everyone)
      is left out, and what it named still narrows. Its `limits_people` and
      `limits_types` follow the rule a PUT does: left out with an empty list,
      they keep what the person's limits say now. An owner's replaces
      limits set on that person before the invitation was made; limits set
      after it, or any already there for an adult's, stay, and the owners
      are asked to confirm them. The invitation list's items gain `limited`.
    - **Changed:** an adult inviting a viewer must give `restriction` — an
      unrestricted viewer invitation from an adult is refused `403
forbidden` ("Only an owner can invite a viewer who sees every family
      document. Choose what they can see.") — and may not include Adults
      only documents (`403 forbidden`, A27). Owners may still invite an
      unrestricted viewer.
    - **Changed:** a restricted viewer's `GET /collections` and `GET
/collections/{id}` (and `GET /documents/{id}/collections`) give the
      collections for Everyone granted to them, with the documents in them
      they are given (A17, U515-11); until now a viewer was given only
      collections they had made. A viewer with no limits is given none, as
      before.
    - **Changed:** a sign-in given back to somebody whose limits were set
      while it was away says so in its email: "An owner has limited what you
      can see in the vault: only the documents they have given you, and your
      own." — nothing of what is given.
    - **Added:** `POST /collections/{id}/items` answers `warnings`: one
      sentence for each viewer given the collection who will now see what
      was put in ("Jane (viewer) will be able to see this.", "… these.", "…
      2 of these."); absent when there is nobody.
    - The activity log: **new** `access.restricted` ("Mansoor limited what
      Val can see", with an end and Adults only said; "…, as they accepted
      their invitation" for an invitation's, as its inviter),
      `access.changed` ("… changed what Val can see"; "… confirmed what Val
      can see" when the same limits were put again after a sign-in was given
      back) and `access.removed` ("… took the limits off what Val can
      see"), notable, each for the owners, the person and whoever did it.
      They say how many people, kinds and collections, never which.
    - **Added: push** `{ v: 1, type: "notice" }` (5.26's notice, a follow-up
      from 5.31): everybody told of a widening of who sees identity details
      is pushed the word and nothing else — not whose details, who asked or
      from when — on each of their devices whose sign-in has not ended,
      beside the notice in the app and the operator's mail, whether or not
      there is a mail server: pushed once the notice has committed, as best
      effort, so a notice that is not asked pushes nothing, and a push that
      cannot be queued leaves the notice and its mail standing. A browser is
      told "Something about your
      details is changing. Open the vault to see what." Phones since app
      0.2.2 show it; an older one shows nothing. TTL a day, Topic
      `fdv-notice`.
    - The database: 0055 adds `invitation.restriction` (jsonb, a viewer's
      invitation's alone); `access_restriction_collection_everyone` (a
      collection named in a grant is for Everyone and not deleted, held FOR
      SHARE while it is named) and `doc_collection_leaves_grants` (made for
      fewer, or deleted, it leaves every grant), both known to the restore
      check; it also removes any grant naming a collection deleted, or not
      for Everyone, before it; and
      `collection_viewers_given(collection, documents[])`, which says to
      somebody signed in, not restricted, which viewers given a collection
      would see which of these documents.
    - `@fdv/shared`: `AccessGrant` (with `limits_people`, `limits_types`),
      `namedAllGone`, `ACCESS_GRANT_MAX`, `MemberAccess`,
      `AccessPreview`, `MyRestriction`, `NamedGrant`, `youCanSee`,
      `onlyEveryone`, `NOTICE_WORDS`, `Me.restriction`,
      `Member.restriction`, `MemberAccount.access`, `Invitation.limited`,
      `CollectionDetail.warnings`, `PushMessage`'s `notice` and
      `features.access_restrictions`. `@fdv/client`: `setMemberAccess`,
      `removeMemberAccess`, `previewAccess`, and `invite`'s `restriction`;
      the fake keeps limits, counts them by the vault's rule, and tells a
      restricted viewer on `/me`.
  - Someone outside the family (5.34, `features.guests`; D4, A27, A28,
    A34, A54). A guest is an attorney or an accountant with a sign-in of
    their own: on the wire a **viewer** (`role: "viewer"`) with `kind:
"guest"`, so an older phone treats them as one; always limited; their
    sign-in ends on a day within a year, which an owner renews; never shown
    among the family.
    - **Added:** an invitation takes `kind` (`family`, the default, or
      `guest`), `access_expires_at` and `relationship` (somebody new's
      relationship to the family; for a guest what they are to it,
      "attorney", 60 characters at most). A guest's invitation is a viewer's
      (`422` otherwise), always with `restriction` (`422`, "A guest is
      always limited to what they are given. Choose what they can see."),
      and with `access_expires_at` in the future and within
      `limits.guest_max_days` (366) days (`422`); nobody else's has an end
      (`422`). An existing person invited as a guest must be one (`409
not_a_guest`), and a guest invited as one of the family is `409
guest`. An adult may invite a guest limited to what the adult sees,
      never with Adults only documents (A27, `403 forbidden`). Accepting
      gives the sign-in its end, and its limits in the same transaction.
      Accepting one whose end has passed is `409 access_ended`. The
      invitation list's items and the invitation preview (`POST
/invitations/lookup`) gain `kind` and `access_expires_at`; the preview
      also gains `timezone`, the household's, which a guest's end is said
      on (the review's second round).
    - **Changed (the 5.34 review):** a guest who has had a sign-in here — a
      sign-in now, one taken away, or an invitation accepted once — is
      never invited again as themselves: `409 had_sign_in` ("Jane Smith has
      had a sign-in here. An owner can give it back, with a new end, from
      People outside the family; or invite them by their name as somebody
      new."). An owner gives it back with `POST /members/{id}/sign-in`. An
      adult's invitation of somebody an owner gave Adults only documents is
      `403 forbidden` ("An owner gave them Adults only documents, so only an
      owner can invite them."). Both are checked again as the invitation is
      accepted, under its locks, and nothing is made: a guest who has had a
      sign-in here meanwhile is `409 had_sign_in`; an adult's invitation of
      somebody an owner has given Adults only documents since is `409
owner_needed` ("This invitation cannot be accepted as it is. Ask an
      owner of the family to invite you."). An invitation whose guest an
      owner removed meanwhile is `404 invitation_not_valid`, its preview
      too.
    - **Changed (stricter owner invitations):** an owner's invitation that
      decides what a viewer sees — **any guest**, a viewer who sees every
      family document (no `restriction`), Adults only documents for a
      viewer (`include_adults_only`), or limits that would replace limits
      already set on that person (the 5.33 review, S533-02) — is an owner
      power (A54), asked as `PUT /members/{id}/access` is: an owner with
      neither two-step sign-in nor a passkey `403 totp_required_for_owner`
      ("Turn on two-step sign-in to limit what a viewer can see."), any
      other without a passkey or a code within five minutes `403
step_up_required` (`limit_access`), never the password. It is asked
      after the body's shape and the guest's and adult's refusals, and
      **before** the ordinary step-up (`change_people`): a passkey or a code
      counts for that too, so one confirmation is enough. A family viewer
      limited to what the owner sees, with no Adults only documents, asks
      only the ordinary step-up, as an adult's invitation does.
    - **Added:** `GET /me` gains `kind` and `access_expires_at` (a guest's
      end; null for the family). A guest's `restriction` is never null.
    - **Changed:** `GET /members` lists the family: a guest is never among
      them, to anybody, but for a guest themselves, to themselves. Each
      person gains `kind` and `access_expires_at` (a guest's end, to an
      owner and to the guest). `GET /members?kind=guest` lists the people
      outside the family, with their `restriction` and end, for owners
      alone (anybody else `403 forbidden`). `GET /members/{id}/account`
      gains `kind` and `access_expires_at`, and a guest's `access`.
    - **Added:** `POST /api/v1/members/{id}/renew` with `{ access_expires_at
}` renews a guest's sign-in, sooner or later, within a year, and
      answers `{ member_id, access_expires_at }`. Refused in this order:
      anybody but an owner `403 forbidden`; a body of the wrong shape `422`;
      an owner power with **new** step-up action `renew_guest` (`403
totp_required_for_owner`, "Turn on two-step sign-in to renew a guest's
      sign-in."; `403 step_up_required`; `FACTOR_STEP_UPS` lists it); an end
      not in the future, or more than a year away, `422`; nobody with a
      sign-in `404`; somebody of the family `409 not_a_guest`. Logged as
      `member.access_renewed` ("Mansoor renewed the sign-in of Guest — Jane
      Smith, attorney until 4 January 2027 at 23:59"), notable, for the
      owners, the guest and whoever did it.
    - **Added:** a guest's sign-in past its end stops: every session of
      theirs answers `401 session_ended` with the **new** reason
      `access_ended` (a refresh too), so every client, an older one too,
      goes back to its sign-in; signing in again is refused, once the
      password (and code) are right, `403 access_ended`, with the day it
      ended on the household's clock, and its year ("Your access to this
      family vault ended Monday 5 October 2026 at 09:00 (Europe/London). Ask
      whoever invited you to renew it."). The database gives an ended guest
      nothing either, and the worker sends them no digest and no alert.
    - **Added:** `POST /members/{id}/sign-in` (giving a sign-in back) takes
      `access_expires_at`: a guest's comes back as a viewer's only (`409
guest`), always with a new end (`422` without one), asked as renewing
      is (`renew_guest`); nobody else's takes one (`422`). Their limits stay,
      and the owners are asked to confirm them again (5.32). For a guest, or
      with an end, the passkey or code is asked **before** the ordinary
      step-up (`change_people`), which it counts for too: one confirmation
      (the review's second round). The body's shape is checked before
      either.
    - **Added (the 5.34 review):** `DELETE /api/v1/members/{id}` removes a
      guest who never signed in, with their invitations and limits: `204`.
      Owners only (`403 forbidden`), asked as taking a sign-in away is
      (`change_people`); nobody there `404`; somebody of the family `409
not_a_guest`; anybody who has had a sign-in — one now, one taken away,
      an invitation accepted — `409 had_sign_in` (take it away instead).
      Logged as `member.removed` ("Mansoor removed Rex, a guest who never
      signed in"), notable. A removed guest invited again is somebody new.
    - **Changed (hardening, the 5.34 review):** a limited caller — a guest,
      or a viewer an owner limited — is told nothing of where files are
      kept or of the mail server: `GET /vaults` and `GET
/notifications/smtp` answer them `403 forbidden`, and the database
      gives them neither (a limited caller reads a storage row only for a
      file they open).
    - **Changed:** what a collection says of who will see what is put in it
      names a guest as one: "Jane Smith (guest) will be able to see this.".
    - **Changed:** a guest is a viewer and nothing else: `POST
/members/{id}/role` for a guest is `409 guest` ("Jane Smith is from
      outside the family: a guest is always a viewer, limited to what they
      are given."). `DELETE /members/{id}/access` for a guest is `409
guest_always_limited`. A guest owns no document, by any path — made,
      changed or handed over (`POST`/`PATCH /documents`), captured, a file
      sent in filed as theirs: `422 validation_failed` ("A guest owns no
      documents. Choose someone in the family.", `detail:
"owner_member_id"`). A guest is nobody's way in to a viewer's limits
      (`422`, "Choose people from the family."), has no identity record (`GET
/members/{id}/identity` `404`, their own too; never told of a widening,
      A34) and no member key, is given no suggestions, and never holds a
      widening of who sees identity details back.
    - **Changed (hardening, R532-04's remainder):** somebody signed in reads
      their own account and those of the household's sign-ins, never
      another household's; an owner also those of its people whose sign-in
      was taken away (the 5.34 review), nobody else. No route answers
      differently.
    - With no member key, a guest's sign-in, refresh, password change (with
      the current password, or after a passkey or a code) and a reset by
      either path an owner starts all work; their reset's path is
      `handover` unless the vault has a mail server (5.29: only an unexpired
      export of theirs could stand in the way, and a viewer makes none).
      `POST /exports` is `403` (adults only, as for every viewer) and `POST
/offline/grant` is `403` ("People outside the family can't keep
      documents on a phone."), as for every viewer.
    - The activity log names a guest as one: "Guest — Jane Smith, attorney"
      (their name, and their relationship to the family when there is one),
      whether they did it or it is about them. `invitation.created` for a
      guest says "… invited jane@example.com to sign in as a guest until 4
      November 2026"; `member.added` "… added Jane Smith as a guest from
      outside the family".
    - The database: 0056 adds `member.kind` (`family` or `guest`, fixed once
      made), `account_household.access_expires_at` (a guest's alone, always
      set, within a year) and `invitation.kind` and
      `.access_expires_at`; guards that a guest owns no document (SQLSTATE
      `FDV04`), is a viewer (`FDV03`), never signs in without a restriction
      nor loses it while signed in (both as the transaction commits), and
      has no identity details and no member key; `app_restricted()` is true
      for every guest, so a guest whose restriction row is missing sees
      nothing; a guest's grant gives nothing past their end; and the
      `account_reach` rule above; since the review, rules that only an
      owner removes a person (a guest who never signed in) and that a
      limited caller reads no mail server and only the storage rows of
      files, and `member_given_adults_only()`. A guest's end is within 366
      days of being set, counted as the vault counts it (366 × 24 hours).
      The restore check knows each, and fails a backup in which a guest
      owns a document, signs in unrestricted or without an end, ends more
      than a year after the restore, or has a member key or identity
      details.
    - `@fdv/shared`: `MemberKind`, `GUEST_MAX_DAYS`, `GUEST_DEFAULT_DAYS`,
      `GUEST_DESCRIPTION_MAX`, `guestLabel`, `guestEndProblem`,
      `guestAccessEnded`, `guestEndWords`, `guestAccessEndedWords`,
      `shareEndWords`'s `year`, `GUEST_ONLY_VIEWER`,
      `GUEST_ALWAYS_LIMITED`, `GUEST_OWNS_NOTHING`, `GuestRenewal`, `kind`
      and `access_expires_at` on `Me`, `Member`, `MemberAccount`,
      `Invitation` and `InvitationPreview`, `features.guests` and
      `limits.guest_max_days`. `@fdv/client`: `guests`, `renewGuest`,
      `removeGuest`, `restoreSignIn`'s end, and `invite`'s `kind`,
      `access_expires_at` and `relationship`; the fake keeps guests and
      invitations, refuses as the vault does (an owner's guest invitation
      asked for a passkey or a code first, `access_ended`'s `reason`, a
      re-invited guest, removal), and ends a guest's sign-in at its end.
  - Notes you can write (5.35; A30, A31, A32). One note a document, in a
    small Markdown that each client draws as its own elements — never as
    HTML. Plain text, as every note was until now, is already valid, so an
    older phone showing notes as plain text shows the same words. No
    feature flag: a vault before 5.35 is told by the fields below being
    absent.
    - **Added:** every document view (`GET /documents/{id}`, the lists,
      what `POST`/`PATCH /documents` answer, a collection's documents)
      gains `notes_updated_at`, when the note's words last changed —
      written, changed or taken away, by any route: `POST`/`PATCH
/documents`, a capture's metadata, a file sent in and filed. Only the
      words move it: an edit of anything else, the same words saved again
      (once trimmed), a move to or from Only me leave it as it was. Null
      until somebody writes a note on 5.35 or later (nothing is filled in
      for older notes). And `notes_updated_by_name`, who changed them, as
      the household knows them, on the activity log's terms like a
      version's `uploaded_by_name`: null to a viewer (a guest among them),
      and when that person has left the household.
    - **Unchanged:** `notes` is a string of 10,000 characters at most
      (`422` beyond), written through `PATCH /documents/{id}` by whoever may
      change the document (a viewer or a guest `403`; a teen their own
      only), with `If-Match` as ever (`409 conflict`, the document as it is
      now in `detail`). An Only me document's note stays sealed under its
      owner's key (0.5.8, A31).
    - **Added:** the activity line `document.notes_changed`, with
      `detail.change` `added`, `changed` or `removed` and never the note's
      words ("Sarah changed the note on “Water bill”"), for whoever may see
      the document. **Changed:** an edit of the note alone is no longer also
      `document.updated`, and `document.updated`'s `fields` never name
      `notes`.
    - **Changed:** a search's snippet shows a note as plain text ("Blue bins
      go out on Mondays", not "\*\*Blue\*\* bins…"), in both passes; the
      index still holds a note's words as written.
    - The Markdown (`@fdv/shared`, `parseNotes`): paragraphs and line
      breaks; bold (`**`) and italic (`*` or `_`); bulleted (`- `, `* `,
      `+ `), numbered (`1. `) and checklist (`- [ ] `, `- [x] `) items, one
      level deep; level-3 headings (`### `); links, `[words](address)` or an
      address written out, to `https:`, `http:` or `mailto:` only, drawn
      with their address as the browser will reach it (a host in another
      script as punycode). Anything else — HTML, images, tables, other
      headings, a `javascript:` or `data:` link, and a link whose address
      could show as somewhere it does not go: one with a control, format
      (Unicode Cf: bidi overrides, zero-width characters, the soft hyphen)
      or line-separator character in it, or a name before its host
      (`https://bank.example@evil.example`) — is text, exactly as written.
      The parser is linear in a note's length, a note of many lines too.
    - The database: 0057 adds `document.notes_updated_at` and
      `.notes_updated_by` (a sign-in; its name comes off if the sign-in is
      removed, the moment stays), and a guard that somebody signed in
      stamps a note only as themselves and now. The restore check knows it.
    - `@fdv/shared`: `NOTES_MAX`, `parseNotes`, `notesPlainText`,
      `noteTreeText`, `noteLinkAllowed`, the `NoteTree` types,
      `DocumentView`'s `notes_updated_at` and `notes_updated_by_name`, and
      `whenExactly`'s time zone. `@fdv/client`: the fake keeps a note's stamp
      as the vault does, refuses a viewer's edit and a teen's of somebody
      else's document, and, as the vault does, takes back an invitation still
      waiting when the same person is invited again — by its maker or an
      owner only (`409 already_invited`).

  - The vault reads what it can, and suggests (5.37,
    `features.detail_suggestions`; A44, A46).
    - **Added:** `GET /api/v1/documents/{id}/suggestions` — what the
      words on a document's newest version propose for the fields it has no
      value for: `{ "state": "ready" | "pending" | "unavailable",
"version_id": "…" | null, "proposal": { … } }`. `version_id` is the
      version whose pages were read (null unless `ready`): a client offers
      the proposal only while that is still the document's newest version,
      and asks again when one is added. `proposal` has at most `type_key`,
      `owner_member_id`, `issued`, `expires` (each a `DateValue`),
      `identifier` and `issued_by`, each `{ "value", "confidence", "cue" }`:
      a confidence from 0 to 1, never below `PROPOSAL_THRESHOLDS` for its
      field (anything below is left out), and a cue from a fixed list
      (`PROPOSAL_CUES`: `kind_words`, `machine_lines`, `name_labelled`,
      `issue_label`, `expiry_label`, `due_label`, `period_end`,
      `number_label`, `known_issuer`, `letterhead`, `issuing_body`,
      `issuing_country`, …) —
      a reason, never the page's words. A field the document has a value
      for is never proposed. `pending` while the worker is still reading
      the pages; `unavailable` with no file, or a kind of file it does not
      read — and when the proposal could not be made in time: it is made
      on a thread of the API's own, one page at a time, and a page that
      takes more than a second, finds eight waiting, or finds that the
      thread cannot be started (it is tried again ten seconds later), is
      answered `unavailable`, never an error, while every other request is
      answered as usual. `proposal` is `{}` unless `ready`, and often then. Offered,
      never filled in: nothing is written, and neither the words nor the
      proposal is kept or logged (`Cache-Control: no-store`). An Only me
      document's words are opened only in its owner's own request (404 to
      anybody else, as for a document that does not exist). Refused as any
      edit is: `403` to a viewer, limited or not, and a guest, whatever the
      id; a teen is answered for their own documents only.
    - The rules (`@fdv/shared`, `proposeDetails`): no cue, no answer; no
      date and no number without a confident kind — the document's own, or
      one the page proposes at the 2.6 spike's bar (a score of 5, 2 ahead
      of the next); only the dates that kind keeps; whose it is, by the
      family's names: a first name with the person's own surname beside it
      or on the form's surname line — for somebody known by a first name
      only, the household's surname ("The Thompsons"), never another
      member's — never a first name alone, never a first name that is also
      a word ("Bill To:", "May 2025") without its surname, never a name
      with a doctor, a parent or a signature before it on its line, or in
      a transaction (what is right of a name, in a column of its own, is
      not about it: "Our ref"), never a surname past a comma ("Sarah
      Ahmed, Lucy Thompson"), never a guest, and nobody when two of the
      family are named together, or when a name is said too often to look
      at every time; a passport's machine-readable lines
      believed only with their check digits right, its holder only with
      the family's surname, and its expiry's century the one that fits its
      issue; a kind whose issuer is a country (a passport's "Issuing
      country") offered a country, never an office; a pet's vaccination
      record never a person's medical record; "issued" a label only in a
      label's form — its date right after it ("Issued: 14 March"), or
      alone on its line with the date below — never in a sentence, wrapped
      or not;
      a number read whole, never a phone number or a postcode;
      a date in numbers whose order the document does not show read in the
      household's (`profile.country`, the US month first), and not at all
      without one. English only (A46). Read from the text's first 60,000
      characters, each line's first 2,000, and no run of white space
      longer than 40; each pattern linear, and each stopping after so many
      matches, so the same text always gets the same answer.
    - **Unchanged:** `GET /documents/{id}/issuer-suggestions` stays, for
      older phones.
    - **Changed (the worker):** a PDF's text is read from the PDF itself
      (poppler's `pdftotext -layout`, so a table's label stays beside its
      value); a page is drawn and OCR'd only when it is a scan — no text of
      its own, or a line or so (under 200 letters) with a picture covering a
      tenth of it or more (poppler's `pdfimages`) — and then keeps both
      texts, so nothing searched before is lost. A page with more text of
      its own is read by it alone: a text PDF, an illustrated one and a
      searchable scan with its own text layer never reach Tesseract. A Word file's words
      are read from its XML (its headers, body and footers), the XML turned
      into text on a thread of its own that is stopped at its deadline; so
      it is searched, and suggested from, as a PDF is; `ocr_status` is
      `done` for it. An Excel workbook is still not read. The text kept of
      one version is at most 500,000 characters. `FDV_OCR_MAX_PAGES` (20)
      is now the pages of a PDF read, by its own text or by OCR.
    - `@fdv/shared`: `proposeDetails`, `ProposalContext`, `DetailProposal`,
      `Proposed`, `PROPOSAL_FIELDS`, `PROPOSAL_CUES`, `CUE_WORDS`,
      `PROPOSAL_THRESHOLDS`, `KIND_MIN_SCORE`, `KIND_MIN_LEAD`,
      `scoredIssuers`, `DetailSuggestions` and
      `features.detail_suggestions`. `@fdv/client`: `detailSuggestions`;
      the fake answers what a test gives it, `unavailable` otherwise, and
      refuses a viewer as the vault does.
  - The Phase 5 exit (5.41).
    - **Changed, for viewers only:** where a document's paper original is
      kept is the household's. `physical_location` is `null` for a viewer,
      limited or not, and so for a guest, in every answer that carries a
      document (`DocumentView`): `GET /api/v1/documents/{id}`,
      `GET /api/v1/documents`, `GET /api/v1/collections/{id}`'s items, and
      the rest. Owners, adults and teens are answered as before; nobody
      else could write it, and still cannot. Neither pass of a search (`GET /api/v1/search`,
      `GET /api/v1/search/sealed`) finds, ranks or leaves out a document by
      its location's words for a viewer: they are matched against the index
      without them (migration 0058 gives the location a weight of its own,
      `D`, which also ranks a location's words a little lower for everybody
      else). Nothing a share link, the drop page, the activity log, a
      digest, an email or a push carries names a location, as before. The
      field stays, so older clients read it as unknown. New capability
      `document.see_location` (owners, adults, teens); `@fdv/shared`:
      `seesLocation(role)`. `@fdv/client`'s fake answers the same.
    - **Fixed:** `POST /api/v1/auth/passkey/verify`, and
      `POST /api/v1/auth/step-up` with a `passkey`, given a response that
      names no credential (`{ "response": {} }`), answered `500`. Now
      `401 passkey_rejected`, as any passkey not accepted.
    - **Changed (the queue, not the API):** a password reset's link in an
      `alert.send` job is sealed under a key derived from the master key
      (`sealed_url`, `ALERT_LINK_KEY_PURPOSE`), as 5.20's `mail.to_address`
      jobs are: the queue's table, which the application role reads, and
      every backup of it, hold no working link. The worker opens it as it
      sends; a job queued by an older API, its `url` in words, is still
      sent.
    - **Changed (A54):** writing another person's identity details
      (`PUT /api/v1/members/{id}/identity`, an owner writing their shared
      part) is an owner power: `403 totp_required_for_owner` to an owner with
      neither two-step sign-in nor a passkey, `403 step_up_required` with
      `action: "change_identity"` (a passkey or a code, never the password)
      to one who has not given one in five minutes. Reading them is as
      before, masked, and so is writing one's own. `FACTOR_STEP_UPS` adds
      `change_identity`.
    - **Changed:** a lock, or a restore's pause, outlives a sign-in taken away
      (migration 0059). `DELETE /api/v1/members/{id}/sign-in` keeps it with
      the person, and `POST /api/v1/members/{id}/sign-in` gives the sign-in
      back still locked or paused — its message says so, the person is not
      told they can sign in, and the other owners are told — so only an
      owner power ends it. A restore pauses a sign-in that was taken away
      when the backup was made, for whenever it is given back. The database
      refuses to delete a locked or paused sign-in that has not been kept so
      (`409 sign_in_suspended`).
    - **Changed:** `POST /api/v1/devices` with a push address another sign-in
      registered answers `409 device_taken` and leaves that device as it was;
      it used to move it to the caller (and answered a limited viewer or a
      guest `500`). An address of one's own is updated as before. An address
      whose sign-in has ended (signed out of nowhere: revoked, as a restore
      does, or run out) is anybody's to take over (migration 0060): only a
      live one of somebody else's is `409 device_taken`. A client given
      `device_taken` may give the address up and post a new one; the web app
      does so.
    - **Changed:** somebody whose sign-in is given back still locked or
      paused is emailed so, when an owner limited what they see while it was
      away, with the words of a limited sign-in given back (L533-03); the
      emails as a lock ends (`DELETE /api/v1/members/{id}/lock`) and as a
      restore's pause ends (`POST /api/v1/members/{id}/resume`) carry those
      words too, for anybody limited.
    - **Added (the owner's decision of 6 Oct 2026):** `GET` and
      `PUT /api/v1/household/sharing` — whether this household's Only me
      documents can be shared outside the family (`OnlyMeSharing`:
      `only_me_shareable`, on unless an owner turned it off, and
      `can_change`). Read by owners and adults (`403` to anybody else);
      changed by an owner (`sharing.only_me_rule`; `403 forbidden` to an
      adult), an owner power (A54): `403 totp_required_for_owner`, `403
step_up_required` with `action: "only_me_sharing"`. Turned off, every
      live link that sends an Only me document — a document's link to it, or
      a collection's link that ticked it — is paused, `paused_reason:
"only_me_not_shared"` on the link (to an owner and its maker; anybody
      else sees it paused), and each maker is emailed how many of theirs;
      turned back on, those links work again, unless something else stops
      them. Neither the answer nor the activity log counts them: how many
      links other people had to their Only me documents is theirs to know.
      While it is
      off no link serves an Only me document at all, whatever its row says:
      `POST /api/v1/documents/{id}/share` to one, and `POST
/api/v1/collections/{id}/shares` ticking one, answer `409
only_me_not_shared`. The activity log says it, notable, to owners and
      adults: "Olivia turned off sharing Only me documents outside the
      family". Migration 0061; a vault restored from an older
      backup has it on, and a link it had paused waits for an owner after a
      restore, as every link does (A55).
    - **Changed:** a visibility change into Only me (`POST
/api/v1/documents/{id}/visibility`, or `PATCH /api/v1/documents/{id}`
      with `visibility: "private"`) takes `own_links: "end" | "keep"`. With
      links of the caller's own that could send the document — a link to it,
      or a collection's link that ticked it, whether live or paused (by the
      household's rule or a restore), and the collection's even while the
      document is out of the collection — and no `own_links`, it answers
      `409 links_choice_needed` and changes nothing;
      its `detail` is JSON (`LinksChoiceNeeded`): each link's `id`, `kind`,
      `recipient_label`, `collection_name`, `expires_at` and `protection` —
      never a token — `keep_allowed`, and `others`, how many links somebody
      else made stop with it. A link a restore paused, for anybody but an
      owner, is marked `will_end: true`: no owner can turn it back on while
      the document is Only me, so it ends whichever is chosen, and `keep`
      keeps, and the notice counts, only links that can send. `end` ends a
      document's link as Take it back does, and leaves the document out of a
      collection's link; `keep`
      leaves them; while the household does not share Only me documents
      outside the family, `keep` is `409 only_me_not_shared`. Links others
      made stop, as before. The answer (`VisibilityChange`) adds `links`
      (`yours`, `yours_now`: `ended` | `kept` | null, `others`), and the
      notice says what is true now: "Only you can open this. Your 2 links to
      it have ended.", "Only you, and the people your 1 link is for, can open
      this." The activity log's line counts them (`links_ended`,
      `links_kept`, `links_others_stopped`). A client that sends no
      `own_links` gets the `409` only when there are such links.
    - **Changed:** a document's `status`, to a viewer or a guest, never asks
      for where the original is kept: a kind that requires it is worked out
      without it for them (the document, a list, a search).

- After 0.6.0 (Phase 6):
  - Documents as a table (R2, `features.document_table`). **Added:**
    `GET /api/v1/documents` sorts by a column — `sort=title`, `kind`,
    `person`, `issued`, `expires`, `status`, `visibility`, `collections` or
    `location` — with `direction=asc|desc` (ascending unless said; a blank
    goes last either way; a tie by the document's id). With one of those:
    `member_id=none` (nobody's), `collection_id=<id>|none` (in that
    collection, which the caller may see, or in none they may),
    `location=<text>` (kept there, whatever the case); `status` gives full
    pages and is counted, not filtered after the page; each page has
    `total`, how many the filters give the caller; each document has
    `collections` (`[{ id, name }]`, those the caller may see, by name;
    none in the Trash). `next_cursor` holds the sort and direction it came
    with, and is refused (`422 validation_failed`) with any other. A sort
    or filter by location is refused (`422 validation_failed`) to a viewer,
    limited or not, and so to a guest. `limit` is still 200 at most. A
    status is worked out as the document's own view says it to the caller
    — to a viewer or a guest, never asking for where the original is kept
    (5.41), in the order or a `status` filter either — so a sort by
    status (most pressing first: expired, expiring soon, needs details, in
    date, nothing to renew; then the sooner expiry) reads every document
    the other filters give. **Unchanged:** `sort=recent|expiring|alpha`,
    or none, answer as before — no `total`, no `collections`, `status`
    filtered after the page — and refuse `direction`, `collection_id`,
    `location` and `member_id=none` (`422`) rather than leave them out.
    `GET /api/v1/tags` is in `@fdv/client` (`tags`). `@fdv/shared`:
    `DOCUMENT_SORTS`, `DocumentSort`, `SortDirection`, `isDocumentSort`,
    `STATUS_ORDER`, `statusRank`, `DOCUMENT_PAGE_MAX`, `maySortByLocation`,
    `DocumentListParams`, `DocumentPage`. The client fake answers the same.
  - Many documents at once (I1, `features.batches`). **Added**, for whoever
    may add documents (an owner, an adult, a teen; a viewer or a guest is
    `403 forbidden`): `POST /api/v1/batches` (`{ name?, defaults? }`) makes
    a batch of the caller's own, with defaults that fill only what an
    accept does not say — `owner_member_id`, `type_key`, `visibility`
    (null: as each kind says, and never wider than the batch chose),
    `physical_location`, `collection_id` (one the caller may add to),
    `tags`, `is_essential` — and an end (`ends_at`) 30 days after it was
    made, when what is undecided in it is removed with it. `GET
/api/v1/batches` lists the caller's own, newest first, each with
    `counts` (`items`, `waiting`, `accepted`, `duplicates`); `GET`, `PATCH`
    (name and defaults) and `DELETE /api/v1/batches/{id}` (what is
    undecided removed, its bytes too; accepted items stay documents).
    `POST /api/v1/batches/{id}/items`: one file a request, multipart as
    `file`, the size limit and the kinds a single add takes (`413
too_large`, `415 unsupported_type`), at most `BATCH_MAX_FILES` (200)
    in a batch (`422 batch_full`), before its end (`409 batch_ended`);
    each item says its `name`, `byte_size` and `sha256` (a resumed upload
    sends only what is not there), `state` (`waiting` | `accepted`),
    `reading` (`waiting` until I2 reads it), its pages (`preview_state`,
    `preview_pages`, drawn by the worker one item at a time a household,
    at `GET …/items/{itemId}/pages/{n}`), and `duplicate` — of a document
    the caller can see (`{ of: 'document', document_id, title }`), never
    one they cannot, or of another of their own items waiting (`{ of:
'item', batch_id, batch_name, batch_created_at, item_id, same_batch }`).
    `DELETE …/items/{itemId}` removes one, as a refused file sent in is.
    `POST …/items/{itemId}/accept` files it as a new document with every
    detail a capture takes and `collection_id`, in one transaction; a
    detail not sent takes the batch's default; answers `{ document_id,
version_id, warnings? }`; `409 already_decided` once decided. Somebody
    else's batch, an owner's included, is `404`: a batch and its items are
    their uploader's alone, and nothing — the activity log, a count, the
    files sent in, a search — says they exist until an item is accepted,
    when it is a document's lines as any new document's are. `@fdv/shared`:
    `BATCH_MAX_FILES`, `BATCH_NAME_MAX`, `BatchDefaults`, `BatchInput`,
    `BatchView`, `BatchDetail`, `BatchItemView`, `BatchDuplicate`,
    `BatchAcceptInput`, `BatchAccepted`, `batchVisibility`,
    `duplicateWords`. `@fdv/client`: `createBatch`, `batches`, `batch`,
    `updateBatch`, `removeBatch`, `addBatchItem`, `batchItemsUrl`,
    `removeBatchItem`, `acceptBatchItem`, `batchItemPage`. The client fake
    answers the same. A batch made Only me (`visibility: 'private'`) is its
    uploader's own: `owner_member_id` is the uploader where none is sent,
    somebody else is `422` (as a capture's), and an accept naming somebody
    else without a `visibility` is refused, never widened. `DELETE
/api/v1/batches/{id}` ends the batch first, so a file sent while it is
    removed is `409 batch_ended`. `POST …/items` takes an optional
    `Idempotency-Key` (a UUID): a file sent again with the key of one that
    arrived is answered `201` with that item and `idempotent-replayed:
true`; one still on its way is `409 upload_in_progress`; one removed
    since, `409 already_decided` (`addBatchItem`'s fourth argument). An
    accepted item's `preview_state` is `none`: its pages went with its
    bytes. **Unchanged:** `GET /api/v1/incoming` lists files sent through a
    request alone, and a batch's item is never decided there.
  - The vault reads each item and suggests (I2, `features.batch_proposals`).
    **Added**, to each item of `GET /api/v1/batches/{id}` (and the item `POST
…/items` answers), for its uploader alone: `reading` goes `waiting` →
    `reading` → `read`, or `failed` with `read_failure` (`blank` |
    `password` | `unreadable` | `too_slow` | `not_read`; null otherwise);
    `level` (`ready` | `check` | `unrecognised` | `problem`; null while it is
    not read, unless it is a duplicate, and once it is accepted); `tags`
    (`[{ code, kind: 'problem' | 'check' | 'info', words, detail?, field? }]`:
    `duplicate_document`, `duplicate_in_batch`, `duplicate_item`, `unread`,
    `not_read`, `clash_kind`, `clash_person`, `kind_unsure`,
    `person_unsure`, `expiry_unsure`, `missing`, `person_missing`,
    `not_theirs` (a teen's pages naming someone else), `narrowed`); `proposals` (what the card starts from: `type_key`,
    `owner_member_id`, `issued`, `expires`, `identifier`, `issued_by`, each
    `{ value, from: 'pages' | 'batch' | 'both', confidence, cue }`, and
    `visibility: { value, from: 'batch' | 'kind' | 'narrowed' }`; null once
    accepted); and `clashes` (`[{ field, pages: { value, confidence, cue },
batch }]`, where the pages disagree with a default at `CLASH_CONFIDENCE`,
    0.8, or more). Worked out as they are asked, from what the worker sealed,
    the batch's defaults now and the kinds now: a default or a kind changed
    re-levels every item. **Unchanged:** an accept takes what it is sent and
    the batch's defaults, never a proposal; nobody else — an owner included
    — is given a batch or its items. Absent from an older vault's items.
    `@fdv/shared`: `levelItem`, `levelSummary`, `storedProposal`,
    `BatchLevel`, `LEVEL_WORDS`, `BatchReadFailure`, `READ_FAILURES`,
    `READ_FAILURE_WORDS`, `BatchTag`, `BatchTagCode`, `ItemSuggestion`,
    `ItemVisibility`, `ItemProposals`, `BatchClash`, `ITEM_SURE`,
    `CLASH_CONFIDENCE`, `householdDateOrder`. The client fake levels its
    items the same way, read as a test says (`FakeBatchItem.reading`,
    `read_failure`, `proposal`).

## Deprecations in effect

- `GET /api/v1/shared/{token}`, `POST /api/v1/shared/{token}/open` and
  `GET /api/v1/shared/{token}/content` (since 0.5.14; removed in 0.9.0).
  They answer only links made before 0.5.14, the last of which lapses
  within 90 days of that release. Use `POST /api/v1/shared/preview`,
  `POST /api/v1/shared/unlock` and `GET /api/v1/shared/items` instead.
- `GET /api/v1/password-resets/{token}`, `POST /api/v1/password-resets/{token}`,
  `GET /api/v1/invitations/{token}` and
  `POST /api/v1/invitations/{token}/accept` (since 0.5.17; removed in
  0.9.0). Use `POST /api/v1/password-resets/lookup` and `/complete`, and
  `POST /api/v1/invitations/lookup` and `/accept`, with the token in the
  body.
