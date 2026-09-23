# Changelog

All notable changes to Family Document Vault. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The household activity log, in Settings: _Sarah downloaded "Home insurance policy" — yesterday, 4:12pm._ Sentences and times, no ids and no jargon, and nothing in it that the reader could not already see — a private document's lines appear only to the person it belongs to, and are left out of everybody else's list rather than shown with the details removed. An open through a shared link appears as the link, because nobody signed in. Owners, adults and teens can read it; a viewer, who is an outsider, cannot.
- Marking a document _Only me_ now says what that means, at the moment it becomes true and once only: **Only you can open this. Nobody can open it after you, unless you leave a key.** Leaving a key with someone you trust is not built yet, and the message says so rather than implying otherwise. Changing who can see a document is also in the app for the first time, in the three plain choices — Everyone in the family, Adults only, Only me.
- Share one document with somebody outside the family: a read-only link that expires (seven days by default), optionally carries a four-digit PIN to be given some other way, and can be taken back at any moment. No account at the other end, and nothing else in the vault is reachable from it. Every open is counted and shown next to the link, and a link to a document that goes in the bin stops working without anybody having to remember it existed. A PIN withholds even the document's title until it is right; ten wrong PINs and the link is dead.
- Co-owners. Two people can hold the household equally, and the incapacity of one changes nothing. Making someone an owner is immediate and every other adult is told. **Taking an owner's role away is not**: it starts a seven-day notice, everybody is told at once, the person it is about can refuse at any point, and after the seven days an owner still has to come back and carry it out. A shared vault in a bad divorce is a real scenario and a one-tap lockout of a spouse would be a weapon. Stepping down yourself is immediate. At least one owner always remains, and that is a rule in the database rather than in the app, because a household with no owner cannot appoint one.
- Taking away a sign-in leaves the person. Their member record, their documents and their private scope key are untouched; only the way in is gone, their sessions end at once, and an invitation can bring them back.
- You are told when a device you have not used before signs in to your vault, by push and by email if the household has a mail server. It cannot be turned off, because it is about who can get into your vault. The first device an account ever uses is not an alert — there is nobody to tell.
- Invite the rest of the family. An adult makes an invitation and is handed two things: a link and an eight-character code, meant to travel separately — a message and a phone call, say, so that a forwarded message on its own is not a way in. The person who follows the link is told whose vault it is, who invited them and what they will be able to do, before they type anything. They choose their own password, which also unlocks their own private documents. Five wrong codes and the invitation is dead. The vault keeps neither secret, so both are shown exactly once and a lost invitation is replaced rather than recovered.
- The four roles — Owner, Adult, Teen, Viewer — are now one table that the server enforces and the app reads, so a button that would be refused is not shown at all. An owner can hand out any role; an adult can give a teen or a viewer a sign-in but cannot widen the circle of people who see the adults-only documents.
- Step-up: four things now ask you to confirm it is you, once, and then trust the session for five minutes — opening an Essential or an "only me" document, changing where your files are kept, changing who is in the family, and exporting everything. A passkey or your password will do. It defends against one specific thing: a session picked up from a device left unlocked.
- Passkeys. Sign in with a face, a fingerprint or a screen lock: nothing to remember, and nothing a convincing copy of the sign-in page could take, because the device checks the address itself. Add one per device in Settings, name them, remove them. The server keeps only a public key. A passkey also satisfies the rule that an owner cannot rely on a password alone, so an authenticator app is no longer the only way to meet it.

- HTTPS for the rest of the house: `docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d` puts Caddy in front of the vault, either with a certificate it issues itself for a name on your own network, or a real one from Let's Encrypt for a name you own. Browsers only treat `http://localhost` as secure, so until now a phone on the same wifi could not use passkeys, receive the day's reminders, or install the vault to its home screen. The README explains all three routes, including the one worth taking: Caddy plus a VPN, with nothing exposed to the internet.

### Fixed

- A change of role took up to fifteen minutes to take effect, because the role travelled in the sign-in token. It is now read from the household on every request, so somebody just made an owner is one immediately.
- A teen could move any family document to the trash, and restore it, although they could not edit one. The rule that a teen changes only their own documents now covers the trash as well.

### Changed

- Permission is now checked before the form is. Someone who is not allowed to change the mail server was told their form had a mistake in it; they are now told who can do it.
- `X-Forwarded-For` is no longer believed from anyone. The API trusted every caller's header, so a request straight to it could write any address into the audit log or dodge the rate limiter. It now trusts the container network and proxies on private addresses (`FDV_TRUST_PROXY=private`, the default); `all` and `none` are there for other arrangements.

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
