# Family Document Vault

**Every important paper in the household, in one place — telling you its own status and warning you before it expires.**

Passports, birth certificates, licences, insurance policies, tax returns, bills. Scan or upload once; the vault files it, works out whether it is current, expiring or expired, and reminds you months ahead — not the week after. Files are encrypted by the server before they are written anywhere, and they live on **your** disk or **your** S3-compatible bucket.

Built for people whose whole skill floor is _scan, upload, download_. You should never have to see the words bucket, key, schema or encryption unless you go looking.

> **Status: early development.** The repository is being built in small, tested iterations. The stack starts and runs, but there is nothing to put documents into yet. This README grows with every release; the [changelog](CHANGELOG.md) says what actually works.

---

## What it does

- **Filing is done for you.** The app proposes the type, the person and the key dates; you confirm with one tap. A document saved with nothing but a photo is still a valid document.
- **Status is derived, never typed.** Nobody sets a document to "expired". Dates plus the rules for that document type produce the status, so a vault left alone for a year is still correct.
- **Reminders that lead.** A passport reminds you nine and six months before it expires; a car registration 45 and 7 days before. Renewing a document — uploading the new one — resolves its reminder automatically.
- **Browse by person and by category**, with counts and status roll-ups, and full-text search across titles, tags, notes and the text inside the document.
- **A household, not a user.** Members with or without their own sign-in (children, elderly parents), four simple roles, and three plain visibility levels per document: _Everyone in the family_, _Adults only_, _Only me_.
- **"Only me" is cryptographic.** Private documents are encrypted so that no other account — including the household owner — can open them.
- **Your storage.** Local disk by default; any S3-compatible bucket (AWS, MinIO, Backblaze B2, Wasabi, Cloudflare R2, DigitalOcean Spaces, Ceph, Storj …). Change later with a verified background migration; add a second location as a mirror.
- **Always exportable.** One button produces a ZIP of the originals plus a readable index. Deletion is reversible for 30 days.
- **The household survives its administrator.** Trusted contacts, a printable recovery sheet, and an offline recovery tool that decrypts your bucket without this software running.

## What it will run on

One `docker compose up`. Four containers: the API, a background worker (OCR, thumbnails, reminders), the web app, and PostgreSQL. No Redis, no message broker, no Kubernetes.

|           | Minimum                                                                   |
| --------- | ------------------------------------------------------------------------- |
| Host      | Anything that runs Docker: a NAS, a Raspberry Pi 5, a small VPS, a laptop |
| CPU / RAM | 2 vCPU, 2 GB                                                              |
| Database  | PostgreSQL 16 (included in the Compose file)                              |
| Storage   | A local directory, or an S3-compatible bucket                             |
| Browsers  | Last two versions of Chrome, Safari, Firefox, Edge                        |

## Quick start

You need Docker (with Compose v2) and Node 22 for the one-off setup script.

```bash
git clone https://github.com/mansoor/family-documents-vault.git
cd family-documents-vault
node scripts/gen-env.mjs   # writes .env with a random master key and database passwords
docker compose up -d
```

The first start builds the images (a few minutes), applies database migrations, and starts the four containers. Then open `http://localhost:8080`: the first visit asks for your family's name, your name, your email and a password, and makes you the owner. Nobody else can run that step again.

`gen-env` refuses to overwrite an existing `.env`, because a new master key would make every stored document unreadable. **Back the file up somewhere off the server.**

To stop: `docker compose down`. Your data stays in the `fdv_db-data` and `fdv_vault-data` volumes.

## Configuration

All configuration is through environment variables in `.env` (see [`.env.example`](.env.example)).

| Variable              | Default            | What it is                                                                                                                                         |
| --------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FDV_MASTER_KEY`      | generated          | The key that wraps every other key. **Back it up outside the server.** If it is lost, the documents are lost.                                      |
| `FDV_DB_PASSWORD`     | generated          | Password for the database owner role (`fdv`). Used for migrations and the job queue.                                                               |
| `FDV_DB_APP_PASSWORD` | generated          | Password for the application role (`fdv_app`). The API queries as this role, which owns nothing, so row-level security is enforced on every query. |
| `FDV_LOCAL_VAULT_DIR` | `/data/vault`      | Where the built-in local vault keeps encrypted files. In Docker this is the `fdv_vault-data` volume.                                               |
| `FDV_DISPLAY_NAME`    | `Our family vault` | What your family calls the vault. Shown on every screen.                                                                                           |
| `FDV_PORT`            | `8080`             | The port the web app listens on.                                                                                                                   |
| `LOG_LEVEL`           | `info`             | `fatal`, `error`, `warn`, `info`, `debug` or `trace`.                                                                                              |
| `FDV_VERSION`         | `latest`           | Image tag to run. Pin it to a release once you are past testing.                                                                                   |

Health endpoints, for your monitoring: `/healthz` (the API process is up) and `/readyz` (it can reach the database).

### Sign-in and sessions

- Passwords are hashed with Argon2id. Sign-in answers with a 15-minute access token and a 30-day refresh token that rotates on every use; a refresh token presented twice is treated as stolen and that device is signed out.
- Every signed-in device is listed under the household name; any of them can be signed out from another.
- The token signing key is derived from `FDV_MASTER_KEY`, so changing the master key signs everyone out.
- Sign-in attempts are limited to 10 per minute per address.

## How your files are protected

- The **server is the encryption boundary**. Every file version gets its own random AES-256-GCM key; that key is wrapped by a per-household scope key; scope keys are wrapped by the master key, which lives only in your `.env` (or a key file) — never in the database.
- Files are encrypted in 1 MB chunks, each with its own authentication tag, so a page in the middle of a large PDF can be served without decrypting the whole file, and a reordered, altered or truncated file is refused rather than decrypted into garbage.
- The **storage provider sees only ciphertext** and object sizes. No filenames, no document types, no names.
- **"Only me" documents** use a per-member key that other accounts, including the owner, do not hold.
- Every sign-in, sign-out, download, view of a private document and access change is written to an **append-only, hash-chained audit log**. The database refuses updates and deletes on it, and the worker recomputes every chain nightly — a row that was altered or removed breaks the chain from that point on.
- **Row-level security in PostgreSQL** keeps each household's rows invisible to every other household, enforced by the database rather than by application code. The application connects as a role that owns no tables, which is what makes the policies apply.
- **Backups of the database are encrypted** with the same master key.

The honest limit: someone who controls the whole server can read everything. For a self-hosted vault on the household's own machine, that is the right trade — it is what makes server-side search, thumbnails and automatic filing possible.

## Backups and recovery

_Documented with the first release that ships the export and backup jobs._ The shape of it:

1. **Your `.env`** (the master key) — keep a copy off the server.
2. **The database** — a nightly encrypted dump, retained 30 days.
3. **The files** — your local directory or your bucket. Optionally a second location as a mirror.
4. **The recovery sheet** — one printed page with where the files are, a recovery code, and how to open them with the offline recovery tool, with no server and no app.

### Where files are kept

Setup creates a local vault on the server (the `fdv_vault-data` volume) and uses it straight away. An owner can add an S3-compatible bucket under **Where your files are kept**: pick the provider (Amazon S3, Backblaze B2, Wasabi, Cloudflare R2, DigitalOcean Spaces, MinIO, or anything with an S3 address), paste the bucket name and two keys, and press **Test and save**. The test writes a small object, reads it back and deletes it, and tells you in plain words what happened. A place that has not passed its test cannot be chosen.

Objects are laid out as `<household>/<document>/<version>/<hash>.<ext>.enc`, so a bucket can always be read with the provider's own console — the files are ciphertext until the offline recovery tool (a later release) opens them with your recovery code.

### Rotating the master key

Rotation rewraps the small per-household keys; the encrypted files themselves are never rewritten, so it takes seconds regardless of how much you store.

```bash
docker compose run --rm -e FDV_MASTER_KEY_NEW="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')" api node apps/api/dist/cli.mjs rotate-master-key
```

Then put the new value in `.env` as `FDV_MASTER_KEY`, run `docker compose up -d`, and back the file up again. Everyone is signed out by the rotation, because sign-in tokens are derived from the same key.

## Upgrading

Images are version-tagged. Database migrations run automatically on start and are reversible one version back. Breaking API changes are announced in [`docs/api-changelog.md`](docs/api-changelog.md) with a deprecation window of four minor releases, so an older mobile app keeps working against a newer server and vice versa.

## Developing

Requirements: Node 22, pnpm 9, Docker.

```bash
pnpm install
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres   # a database for tests
DATABASE_ADMIN_URL=postgres://fdv:<FDV_DB_PASSWORD>@localhost:5432/fdv pnpm check   # lint + typecheck + tests
```

Integration tests run against a real PostgreSQL: each test file creates its own throwaway database, migrates it, and drops it. Without `DATABASE_ADMIN_URL` those tests are skipped and only unit tests run.

For a live-reloading API and web app: `pnpm --filter @fdv/api dev` and `pnpm --filter @fdv/web dev` (the Vite dev server proxies `/api` to port 3000).

Layout:

```
apps/api           the API service (Fastify)
apps/worker        background jobs (pg-boss)
apps/web           the web app (React, Vite)
packages/shared    types and helpers shared by API, worker and clients (the API contract)
packages/db        connection, migration runner, SQL migrations
docker/            nginx config and the Postgres init script
docs/              public operational docs (API changelog)
```

The three images are built from the one `Dockerfile` (targets `api`, `worker`, `web`).

Every change goes through a pull request with green CI. Commits follow [Conventional Commits](https://www.conventionalcommits.org/).

## Licence

[AGPL-3.0](LICENSE). Self-host it, modify it, run it for your family; if you run a modified version as a service, share your changes.
