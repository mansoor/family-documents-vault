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

## Deprecations in effect

None.
