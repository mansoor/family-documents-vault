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
        queued is `503 code_not_sent`, and nothing of it is kept.
      - `POST /api/v1/drop/unlock` `{ token, password?, code? }` →
        `DropSession` (with its `request_id`), and a session cookie named
        for the request, `fdv_drop_s_<request id without dashes>`
        (httpOnly, Secure, SameSite=Strict, path `/api/v1/drop`; 30 minutes
        idle, 4 hours at most, never past the request's end), so a browser
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
        been arriving for 15 minutes).
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
