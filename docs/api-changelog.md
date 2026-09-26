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
    - `extra` on `POST /api/v1/documents` and `PATCH /api/v1/documents/{id}`
      is checked against the type the document will have, as the caller's
      household has it (hidden types included): only its fields' keys, each
      value of its field's `kind` — `text` a string of up to 500
      characters, `long_text` up to 10,000, `date` a `{ date, precision }`
      as every date is sent, `year` a whole year, `number` a number, `money`
      a number with no more than two decimal places, `choice` one of the
      field's `choices`, `yes_no` true or false — and the whole object up to
      16 KB as JSON. Text is kept trimmed, and blank text is no value.
      Anything else answers `422 invalid_extra`; `detail` is the key and
      `message` names it. A document with no type has no details to give.
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
      `detail`). A vault before 0.5.7 refuses the field, so send it only to
      a vault whose types have fields to fill in. A type the household has
      hidden or archived is still accepted, since a phone queues a scan
      against the list it had.
    - A required field with no value never stops a document being saved.
      It makes the document `needs_info`, in words that name the field:
      "Needs a passport number", "Needs an insurer and an expiry date",
      "Needs a passport number and 2 more details". An expiry that has
      passed or is close is still said first. The built-ins now require: a
      passport its number (`core.identifier`, labelled "Passport number")
      and expiry; a driving licence its expiry; an insurance policy its
      insurer and expiry; a vehicle registration its plate (the `plate`
      field, labelled "Registration plate"). Documents of those types that
      have none of them read Needs info from this release on. An older
      phone never sends `extra`, so its captures of such a type read Needs
      info; nothing is refused.
    - Search matches the details' words and numbers, weighted with the
      issuer and the tags, and shows them in the snippet — for documents
      the household or the adults can see. An Only me document's details
      are not in the index.
    - The export's `index.csv` gains a column for each detail, named as
      its type names it, guarded against spreadsheet formulas like every
      other cell (the names too); `index.json` carries each document's
      `extra` and a `details` list of `{ key, label }`; `index.html` lists
      them.
    - `@fdv/shared`: `checkExtra`, `checkDetail`, `missingFields`, and
      `CaptureMetadata.extra`, which `checkCaptureMetadata` checks offline;
      `deriveStatus` takes `missing`. `@fdv/client`: `DocumentInput.extra`.
      The fake keeps `extra` on captures, creates and edits (merged, as the
      vault does), answers `GET` and `PATCH /api/v1/documents/{id}`, and
      says the Needs info words.

## Deprecations in effect

None.
