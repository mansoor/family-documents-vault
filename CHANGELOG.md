# Changelog

All notable changes to Family Document Vault. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Nothing yet.

## [0.3.0] - 2026-09-22

Phase 2 — **Alive.** The vault stops being a filing cabinet and starts telling you
things: what has expired, what is about to, what is missing, and what it could
not read.

### Added

- Notifications: the day's reminders arrive as one Web Push message on any device that opted in (no account or service needed — the install generates its own keys), and optionally by email through the household's own mail server, with provider presets and a Test that must pass before anything is sent. A summary every Sunday evening. Per-person preferences.
- Reminders: created automatically from each document type's lead times (a passport at 9 and 6 months before, a car registration at 45 and 7 days…), regenerated when dates change; manual reminders with a note and an optional repeat; Later (a week, a month, until expiry) and Done; renewing a document resolves its reminders. One digest per household per day at 9 am local, with a single catch-up summary after downtime, however long. Nightly status refresh. Household time zone.
- Search now reaches inside your own private documents. Their text is sealed under your key and has no index, so it cannot be searched on the server like everything else: the results you can share arrive first, and a second pass then opens your own sealed documents inside your session and adds what it finds under "Also in your private documents". Nobody else's sign-in can run that pass, including the household owner.
- Missing documents: the vault says what is _not_ there. Rules read the answers from the first-run wizard — you own your home, there are two cars, there is a child in the family — and draw an outline for the deed, the registrations and the birth certificate that are not on file yet, each with the reason it is being suggested. Tapping one opens Add with the type and the person already chosen. "Not for us" hides a suggestion and can be undone. A rule stays quiet when the question behind it went unanswered, and a private document belonging to someone else never silently satisfies one.
- A family member can be given a date of birth, in the wizard or when you add them later; the People screen can add someone without going through the wizard.

### Fixed

- Running the test suite against the development database reset the application role's password, locking a running stack out of its own database. Tests now log in as a separate role that inherits the application role.
- A server that was switched off all day and came back in the evening sent no reminder summary until the following morning. The digest now goes out at or after nine in the morning, local time, rather than only during the nine o'clock hour — still once a day, and still never before nine. The same applies to the Sunday summary.

## [0.2.0] - 2026-09-22

Phase 1 — **Vault.** Documents, encrypted per version, searchable, exportable,
and private when you say so.

### Added

- Key hierarchy: household, adults and per-member scope keys minted at setup, wrapped by the master key; member keys additionally wrapped by the member's password. Chunked AES-256-GCM file encryption with range decryption. `FDV_MASTER_KEY_FILE` and a `rotate-master-key` command.
- Storage: a local-disk vault (created and tested at setup) and any S3-compatible bucket, added from the Storage screen with provider presets and a Test that must pass before use. Every write is verified by SHA-256; bucket credentials are stored encrypted.
- Documents: 22 built-in document types; create, read, update (with ETags), soft-delete and restore; dates with day/month/year precision; status derived from the type's rules; list with filters, sorts and cursors; tags with counts. Versions: upload (type detected from the bytes, encrypted per version, idempotent on a client key, size-capped), download byte-identical with `Range` support, and `POST /capture` for a photo with no details yet.
- Search: one query across titles, identifiers, tags, notes and the text inside every document, with highlighted snippets. The worker counts pages, makes an encrypted thumbnail and OCRs each upload (Tesseract, offline); private documents' text is stored sealed and never indexed.
- Web app: the first-run wizard (account, a few quick questions, who is in the family, your starting list), Home with the needs-attention strip, people row, category tiles and recent documents; Add a document from a photo or file; the confirm card; document detail with preview, facts, history, download and new versions; search with filter chips; people; settings with storage and devices. Accessibility checks run in the test suite.
- Household profile and members endpoints.
- Visibility can be changed after upload: file keys are rewrapped under the new scope and the document's text moves in or out of the search index. Only the owning member can make a document private, and no other account — including the owner — can reach it afterwards.
- Two-step sign-in with an authenticator app, required for owners.
- Export everything: a ZIP with every original you can see plus `index.html`, `index.csv` and `index.json`, built in the background and kept for seven days.
- Nightly encrypted database backups (30 days kept) and a restore drill script; `backup-now` and `decrypt-backup` commands.

### Fixed

- A fresh install could deadlock on start (the API waited for the job-queue schema the worker was going to create, and the worker waited for the API). The API now installs it.

## [0.1.0] - 2026-09-22

Phase 0 — **Foundation.** The repository, the containers, the database with its
tenancy, and a household you can sign in to.

### Added

- Repository, pnpm workspace, shared type package, API package skeleton, CI.
- API service (Fastify) with `/healthz`, `/readyz` and `GET /api/v1/capabilities`; one error envelope on every failure.
- SQL migration runner; migrations apply automatically when the API starts. Two database roles so that row-level security is enforced on application queries.
- Background worker on pg-boss with a heartbeat job.
- Web app shell (React) showing the connection state and server version.
- `Dockerfile` with `api`, `worker` and `web` targets, `docker-compose.yml`, `docker-compose.dev.yml` (MinIO, Mailpit), and `scripts/gen-env.mjs`.
- CI runs integration tests against PostgreSQL and builds the three images; tagged releases push to GHCR.
- Households, members and accounts, with row-level security on every tenant table enforced in PostgreSQL.
- First-run setup (`POST /api/v1/setup`), password sign-in (Argon2id), short-lived access tokens with rotating refresh tokens and reuse detection, device list and per-device sign-out.
- Append-only, hash-chained audit log; the worker verifies every household's chain nightly.
- Web app: first-run wizard, sign-in, signed-in devices.
