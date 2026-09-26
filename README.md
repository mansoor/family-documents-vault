# Family Document Vault

**Every important paper in the household, in one place — telling you its own status and warning you before it expires.**

Passports, birth certificates, licences, insurance policies, tax returns, bills. Scan or upload once; the vault files it, works out whether it is current, expiring or expired, and reminds you months ahead — not the week after. Files are encrypted by the server before they are written anywhere, and they live on **your** disk or **your** S3-compatible bucket.

Built for people whose whole skill floor is _scan, upload, download_. You should never have to see the words bucket, key, schema or encryption unless you go looking.

> **Status: early development.** The repository is being built in small, tested iterations. The stack starts and runs, but there is nothing to put documents into yet. This README grows with every release; the [changelog](CHANGELOG.md) says what actually works.

---

## What it does

- **Filing is done for you.** The app proposes the type, the person and the key dates; you confirm with one tap. A document saved with nothing but a photo is still a valid document.
- **Status is derived, never typed.** Nobody sets a document to "expired". Dates plus the rules for that document type produce the status, so a vault left alone for a year is still correct.
- **Reminders that lead.** A passport reminds you nine and six months before it expires; a car registration 45 and 7 days before. Renewing a document — uploading the new one — resolves its reminder automatically. Everything due lands in one message a day at 9 am your time, and a server that was switched off for a fortnight sends one summary, not fourteen.
- **It tells you what you do not have.** From a handful of questions at setup — do you own or rent, how many cars, is there a child in the family — the vault draws an outline for the documents that are missing: _No birth certificate for Aisha_, _No deed or title on file_. Each one says why it is there, and "Not for us" makes it go away for good (and can be undone).
- **Browse by person and by category**, with counts and status roll-ups, and full-text search across titles, tags, notes and the text inside the document.
- **A household, not a user.** Members with or without their own sign-in (children, elderly parents), four simple roles, and three plain visibility levels per document: _Everyone in the family_, _Adults only_, _Only me_.
- **"Only me" is cryptographic.** Private documents are encrypted so that no other account — including the household owner — can open them. Their text is never indexed either, so searching them happens in two passes: everything shareable first, then your own sealed documents, opened inside your own session.
- **Your storage.** Local disk by default; any S3-compatible bucket (AWS, MinIO, Backblaze B2, Wasabi, Cloudflare R2, DigitalOcean Spaces, Ceph, Storj …). Change later with a verified background migration; add a second location as a mirror.
- **Always exportable.** One button produces a ZIP of the originals plus a readable index. Deletion is reversible for 30 days.
- **The household survives its administrator.** Trusted contacts, a printable recovery sheet, and an offline recovery tool that decrypts your bucket without this software running.

## What it will run on

One `docker compose up`. Four containers: the API, a background worker (OCR, thumbnails, page previews, reminders), the web app, and PostgreSQL. No Redis, no message broker, no Kubernetes.

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

The first start builds the images (a few minutes), applies database migrations, and starts the four containers. Then open `http://localhost:8080`. The first visit walks you through setup: your family's name, your name, your email and a password (you become the owner — nobody can run that step again), a few quick questions about your household, the people whose documents you keep, and a starting list of what families like yours usually file.

From then on: **Add** a document from a photo or a file, confirm what it is and whose it is, and it is filed. Browse by person or category from Home, or search — including the words inside scanned pages.

`gen-env` refuses to overwrite an existing `.env`, because a new master key would make every stored document unreadable. **Back the file up somewhere off the server.**

To stop: `docker compose down`. Your data stays in the `fdv_db-data` and `fdv_vault-data` volumes.

## Reaching it from the rest of the house

`http://localhost:8080` is all you need on the machine the vault runs on: browsers treat
localhost as a secure origin, so everything works there. They do **not** extend that to
`http://192.168.1.20:8080`, and three things a family wants depend on it:

- **Passkeys** — the browser refuses to create one on an insecure origin.
- **The day's reminders arriving on a phone** — web push needs a service worker, which
  needs HTTPS.
- **Installing the vault to a home screen** as an app.

So before you hand the address to anyone else in the house, give it a certificate. The
compose overlay does it with [Caddy](https://caddyserver.com):

```bash
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
```

**A name for the house, with a certificate Caddy issues itself** (the default). Set
`FDV_HOSTNAME` in `.env` to a name every device can resolve — a Tailscale name, an mDNS
name like `vault.local`, or one your router serves — and set `FDV_BASE_URL` to the
matching `https://` address, since that is what reminder emails link back to. Caddy makes
its own certificate authority the first time it starts. Each device trusts that CA once:

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./vault-ca.crt
```

Install `vault-ca.crt` on each phone and laptop (iOS: Settings → General → VPN & Device
Management, then Certificate Trust Settings; Android: Settings → Security → Encryption &
credentials; macOS: Keychain Access, set to Always Trust; Windows: Trusted Root
Certification Authorities). Nothing leaves your network and no certificate authority is
contacted.

**A real name from Let's Encrypt.** If the vault is reachable from the internet at a name
you own, point `FDV_CADDYFILE=./docker/caddy/Caddyfile.public` at it, set `FDV_HOSTNAME`
and `FDV_TLS_EMAIL`, and open ports 80 and 443. Caddy gets and renews the certificate
itself. Think about this one first: a vault on the open internet is a vault anyone can
knock on.

**The middle road, and the one worth taking.** Run [Tailscale](https://tailscale.com) on
the server and on the family's devices, use the internal Caddyfile with the Tailscale name
as `FDV_HOSTNAME`, and nothing is exposed to the internet at all — every device reaches
the vault over the private network, with a name and a certificate that just work.

## Phones and other apps

The phone app talks to the same API as the web app, at the same address. Nothing needs
turning on for it; what follows is what the vault offers a phone, and what the phone
checks before it trusts the vault.

**The address.** Give the phone the address you open in the browser. With `https://` —
the Caddy overlay, or Tailscale, above — nothing more is needed. If Caddy made its own
certificate authority, install `vault-ca.crt` on the phone once: on Android, _Settings →
Security → Encryption & credentials → Install a certificate → CA certificate_ (the app
trusts certificates you install yourself); on iPhone, install the profile, then turn on
full trust for it under _Settings → General → About → Certificate Trust Settings_. Until
then the app says the phone doesn't trust the vault's certificate yet, and shows these
steps, rather than "can't reach". A certificate for another name, or one that has run
out, gets its own words.

**Plain `http://` on the home network** works too, within limits the app keeps to:

- only to a private address — `192.168.x.x`, `10.x.x.x`, `172.16.x.x`–`172.31.x.x`, a
  Tailscale `100.64.x.x`–`100.127.x.x` address, or a name ending in `.local`, `.lan` or
  `.home.arpa` — never to anything on the internet;
- only over Wi-Fi or Ethernet, never on mobile data, where "private" addresses belong to
  the carrier;
- only after the person has been told, once per vault, what it means;
- and never a password or a token until the vault answering has shown it is the one that
  was approved — it checks the vault's installation id before sending anything, and again
  whenever the phone changes network. The same address on a café's Wi-Fi is somebody else.

A pasted invitation, password-reset or share link is fine as an address: the app keeps
only the vault's address from it, never the secret in it, and offers to open the link in
the browser, where those are finished.

**Notifications** come through UnifiedPush: see
[Notifications on the phone app](#notifications-on-the-phone-app). A distributor on your
own network needs `FDV_PUSH_ALLOW_PRIVATE_ENDPOINTS=true`.

**Essentials for when there is no signal**: see
[Essentials on a phone](#essentials-on-a-phone). `FDV_OFFLINE_MAX_DAYS` (90 by default)
is how long a phone may show them without checking in.

**A lost phone.** Sign it out from any other device — _Settings → Signed-in devices_ in
the browser, or in the app on another phone. At once, the vault:

- ends that phone's session, so its tokens stop working, and its permission to keep
  Essentials;
- removes its notification devices and, if it hears through UnifiedPush, tells it "you
  were signed out": the phone deletes the Essentials it kept as that message arrives, with
  the app closed;
- if the phone never hears (it is off, or has no distributor), it hides what it kept after
  `FDV_OFFLINE_MAX_DAYS` without checking in, and deletes it the next time it reaches the
  vault.

What the phone keeps is encrypted, and opens only after the phone's own lock — its
fingerprint, face or screen lock. Changing your password signs out every other device of
yours the same way.

**How long a phone stays signed in** is the same as a browser: 30 days from when it was
last used, 180 days at most (see [Sign-in and sessions](#sign-in-and-sessions)).

**An older vault.** The app says which version of the vault it needs; an older one is
told so in both version numbers, with the way to [upgrade](#upgrading).

## Configuration

All configuration is through environment variables in `.env` (see [`.env.example`](.env.example)).

| Variable                           | Default                                   | What it is                                                                                                                                                                                                              |
| ---------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FDV_MASTER_KEY`                   | generated                                 | The key that wraps every other key. **Back it up outside the server.** If it is lost, the documents are lost.                                                                                                           |
| `FDV_DB_PASSWORD`                  | generated                                 | Password for the database owner role (`fdv`). Used for migrations and the job queue.                                                                                                                                    |
| `FDV_DB_APP_PASSWORD`              | generated                                 | Password for the application role (`fdv_app`). The API queries as this role, which owns nothing, so row-level security is enforced on every query.                                                                      |
| `FDV_MAX_UPLOAD_BYTES`             | `104857600`                               | Largest single file the vault accepts (100 MB).                                                                                                                                                                         |
| `FDV_OFFLINE_MAX_DAYS`             | `90`                                      | How many days a phone may show the Essentials it keeps without reaching the vault (1 to 365). See [Essentials on a phone](#essentials-on-a-phone).                                                                      |
| `FDV_LOCAL_VAULT_DIR`              | `/data/vault`                             | Where the built-in local vault keeps encrypted files. In Docker this is the `fdv_vault-data` volume.                                                                                                                    |
| `FDV_DISPLAY_NAME`                 | `Our family vault`                        | What your family calls the vault. Shown on every screen.                                                                                                                                                                |
| `FDV_PORT`                         | `8080`                                    | The port the web app listens on.                                                                                                                                                                                        |
| `LOG_LEVEL`                        | `info`                                    | `fatal`, `error`, `warn`, `info`, `debug` or `trace`.                                                                                                                                                                   |
| `FDV_VERSION`                      | `latest`                                  | Image tag to run. Pin it to a release once you are past testing.                                                                                                                                                        |
| `FDV_HOSTNAME`                     | `vault.local`                             | The name devices use, when the TLS overlay is running.                                                                                                                                                                  |
| `FDV_BASE_URL`                     | `http://localhost:8080`                   | What reminder emails and notifications link back to. Set it to the `https://` address once you have one.                                                                                                                |
| `FDV_CADDYFILE`                    | internal                                  | Which TLS setup to use: `./docker/caddy/Caddyfile.internal` or `./docker/caddy/Caddyfile.public`.                                                                                                                       |
| `FDV_TRUST_PROXY`                  | `private`                                 | Whose `X-Forwarded-For` to believe when recording who did what: `private` (the container network and a proxy on your LAN), `all`, or `none`.                                                                            |
| `FDV_SMTP_URL`                     | unset                                     | Your own mail server for password-reset links only, e.g. `smtps://user:app-password@smtp.fastmail.com:465`. See [Passwords](#passwords).                                                                                |
| `FDV_SMTP_FROM`                    | `Family Document Vault <vault@localhost>` | Who those emails come from.                                                                                                                                                                                             |
| `FDV_PUSH_ALLOW_PRIVATE_ENDPOINTS` | `false`                                   | Let notifications go to addresses inside your own network — a UnifiedPush distributor (ntfy) on your LAN. Set it on both the API and the worker. See [Notifications on the phone app](#notifications-on-the-phone-app). |

Health endpoints, for your monitoring: `/healthz` (the API process is up) and `/readyz` (it can reach the database).

### Sign-in and sessions

- **Two-step sign-in** with an authenticator app (Google Authenticator, Authy, 1Password…) is set up in Settings and is required for owners. Sign-in then asks for the six-digit code after the password.
- Passwords are hashed with Argon2id. Sign-in answers with a 15-minute access token and a refresh token that rotates on every use.
- **A session lasts 30 days from when it was last used, and 180 days at most** from the sign-in: a device used every week stays signed in for half a year, then asks once for the password. This is the same for browsers and the phone app.
- A refresh token presented twice is treated as stolen and that device is signed out — with one exception, for phones on networks that lose answers: the phone app may present the token it has just replaced once more, within 30 seconds, from the same installation. Anyone else presenting it, or presenting it later, ends the session.
- When a session ends, the app is told why — it expired, it was signed out, its token was used twice, or the person was taken out of the household — so it can say so in plain words.
- Every signed-in device is listed under the household name; any of them can be signed out from another.
- The token signing key is derived from `FDV_MASTER_KEY`, so changing the master key signs everyone out.
- Sign-in attempts are limited to 10 per minute per address.

### Inviting the rest of the family

Everybody in the household is a **member** — including a child or an elderly
parent who never signs in and simply has documents. Giving someone a sign-in
is a separate step, on the People screen:

1. An adult chooses **Invite someone to sign in**, gives their name, an email
   address (which becomes their sign-in) and a role.
2. The vault produces a **link** and an eight-character **code**, and shows
   them once. Send them separately — the link in a message, the code by phone
   or in person. Anyone holding both can sign in as that person.
3. They open the link, which tells them whose vault it is, who invited them
   and what they will be able to do, then type the code and choose their own
   password. That password also unlocks their own _Only me_ documents, so the
   vault cannot reset it for them.

The invitation lasts seven days and can be cancelled at any time. Five wrong
codes and it stops working. Nothing is emailed — the vault does not need a
mail server to bring somebody in, and you pass the invitation on yourself.

The four roles:

| Role       | Can                                                                                                                      | Cannot                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| **Owner**  | Everything, including storage, people and emergency contacts                                                             | —                                                                      |
| **Adult**  | Everything day to day: add, edit and download every _Everyone_ and _Adults only_ document, manage their own private ones | Change storage, remove people, see another adult's _Only me_ documents |
| **Teen**   | Their own documents, plus anything shared with the whole family                                                          | See _Adults only_ documents, or change anyone else's                   |
| **Viewer** | Open and download what the family shares                                                                                 | Change anything. For an accountant, a lawyer, a carer                  |

An owner can hand out any role. An adult can give a teen or a viewer a
sign-in, but only an owner can make another adult or owner, because that
opens the adults-only documents.

### Two owners, and what happens when that ends

Several people can be owners at once, with identical powers, so that the
household keeps running when one of them cannot. Making somebody an owner is
immediate, and every other adult is told.

**Taking an owner's role away is not immediate.** It starts a seven-day
notice: everybody is told at once, the person it is about can refuse at any
time during it, and after the seven days an owner still has to come back and
carry it out. A shared vault during a bad separation is a real situation, and
a one-tap lockout would be a weapon rather than a feature. Stepping down
yourself is immediate.

**At least one owner always remains.** That is enforced by the database, not
by the app, because a household with no owner cannot appoint one.

Taking away somebody's sign-in leaves the person: their record, their
documents and their own private key are untouched, and an invitation brings
them back. Only an owner can do it, and not to another owner.

### Passwords

**Changing one** is in Settings. Your password is not only a way in: it also
unlocks your own _Only me_ documents, so changing it moves that key across too,
and every other device you are signed in on is signed out. If you sign in with
a passkey and never had a password, you can set one by confirming it is you.

**Forgetting one** is answered from the sign-in page: the vault emails a link to
the address you sign in with. It works once, stops working after an hour, and
signs every device out and removes every passkey when it is used. It does not
sign you in — if two-step sign-in is switched on, you are still asked for the
code.

**Which mail server carries that link matters.** The mail server an owner sets
up in the app is one any owner can change — and point at a mailbox of their
own. A reset link read by somebody else is a way into your private documents,
so the vault only sends one:

- through **`FDV_SMTP_URL`**, a mail server set in `.env` by whoever runs the
  server, if there is one — this is the setting to add if more than one person
  signs in to your vault; or
- through the household's own mail server, but only to the household's **one
  owner**, who is the only person who could redirect it.

Anybody else is sent nothing, and the page answers exactly as it would have.
Whoever runs the vault can make them a link from the command line:

```bash
docker compose exec api node apps/api/dist/cli.mjs reset-password someone@example.com
```

It prints a one-time link to hand over directly.

**No owner or adult can reset another person's password**, and that is
deliberate rather than an omission: they could then sign in as that person and
read their private documents, which is the one thing the privacy wall exists to
prevent. The two routes above are the only ones, and the second belongs to
whoever holds the master key — who can already read everything.

### Seeing what has happened

Settings → **What has been happening** is the household's activity log, written
as sentences: _Sarah downloaded "Home insurance policy" — yesterday, 4:12pm._
Owners, adults and teens can read it; a viewer cannot.

Nothing appears in it that the reader could not already see. Lines about a
private document are in its owner's copy of the list and nobody else's — left
out entirely rather than shown with the details removed, because "somebody did
something to a document" between two adults is worse than silence. The full
hash-chained record is separate, is verified nightly, and is in the export.

Reading a document's pages is in the log too: every page is recorded in the
hash-chained record, and the list shows one sitting with a document — the
pages one person looked at, each within ten minutes of the next — as one line:
_Sarah looked at "Passport"_.

### Reading a document

Tap a document's preview to read it full size: its pages one at a time, fit to
the window, larger with **+**, turned with the arrows (or the arrow keys).

The worker draws the pages — JPEGs, 1600 pixels on the long edge, with no
EXIF or location data — encrypted with the document's own key and stored
beside it (`<object>.p1.enc`, `.p2.enc`…). Essentials are drawn as soon as
they are added, or marked Essential, so the phone app can keep them for when
there is no connection; everything else is drawn the first time somebody opens
it, which takes a few seconds. The first 30 pages are drawn; for more than
that, or for a Word or Excel file, **Download** opens the file itself.

After upgrading to 0.4.12, the worker draws the Essentials already in the vault
in the background, up to 200 each time it starts. Somebody waiting to read a
page is always drawn for first.

A page the worker cannot draw — a damaged file, or a picture larger than
16,000 pixels across or 128 megapixels, which the worker refuses rather than
decode — is tried three times and then shows "no preview"; the file itself
is unaffected and **Download** still opens it. An Essential's is tried again
the next time the worker starts, a day later at the soonest.

Opening an Essential, or anything marked Only me, asks you to confirm it is
you if you have not done so in the last five minutes — for its pages as for
its file.

### Essentials on a phone

The phone app can keep the household's Essentials — passports, policies, the
will — for when there is no connection. Which ones is the vault's decision,
and the phone keeps no others:

- only Essentials, and only ones the person can see;
- owners and adults: all of those; teens: only their own; viewers: none;
- a person's own Only me Essentials only if they choose to keep those too.

Keeping them asks for the person's password again (not a code: the
authenticator is usually on the same phone). That permission lasts 30 days at
most, never longer than the phone's sign-in, and ends when the phone is
signed out — from the phone, from **Settings → Signed-in devices**, which
says which devices keep Essentials, or by a password change on any device. When
it ends, the phone removes what it kept the next time it checks in. It never
skips the "confirm it's you" the vault asks before opening an Essential
online.

A phone shows what it keeps for up to `FDV_OFFLINE_MAX_DAYS` (90 by default)
without reaching the vault, then hides it until it has checked in. When it
next connects it reports what was opened, and the activity log says so:
_Sarah's phone kept "Passport" for offline use_; _Sarah opened "Passport" on
their phone without a connection_ — dated when the report arrived, with the
phone's own time kept in the record.

### Sending one document to somebody outside the family

The landlord wants the tenancy agreement; the accountant wants last year's tax
return. On the document, **Share a link** makes a read-only link to that one
document:

- it stops working after seven days, or whatever you set;
- it can carry a four-digit PIN, which you give them some other way;
- you can take it back at any moment;
- every time it is opened you see it, next to the link;
- and it reaches nothing else in the vault. There is no account at the other
  end and nothing to sign up for.

The link is shown once — the vault keeps only a hash of it — so a lost link is
replaced rather than recovered. A document moved to the trash stops being
shared straight away, without anyone having to remember the link exists.

### When a new device signs in

If somebody signs in on a device your account has not used before, you are
told — by push, and by email if the household has a mail server set up. It
cannot be switched off, because it is about who can get into your vault.

The phone app says which installation it is, so each phone is recognised as
itself: updating the app is not a new device, and a second phone is — one
alert per new installation, naming the phone ("the app on a Google Pixel
8a"). A browser only describes itself, so a browser update can make a
familiar computer look new: it errs towards telling you about a sign-in you
already knew about rather than staying quiet about one you did not.

## How your files are protected

- The **server is the encryption boundary**. Every file version gets its own random AES-256-GCM key; that key is wrapped by a per-household scope key; scope keys are wrapped by the master key, which lives only in your `.env` (or a key file) — never in the database.
- Files are encrypted in 1 MB chunks, each with its own authentication tag, so a page in the middle of a large PDF can be served without decrypting the whole file, and a reordered, altered or truncated file is refused rather than decrypted into garbage.
- The **storage provider sees only ciphertext** and object sizes. No filenames, no document types, no names.
- **"Only me" documents** use a per-member key that other accounts, including the owner, do not hold.
- Every sign-in, sign-out, download, view of a private document and access change is written to an **append-only, hash-chained audit log**. The database refuses updates and deletes on it, and the worker recomputes every chain nightly — a row that was altered or removed breaks the chain from that point on.
- **Row-level security in PostgreSQL** keeps each household's rows invisible to every other household, enforced by the database rather than by application code. The application connects as a role that owns no tables, which is what makes the policies apply.
- **Backups of the database are encrypted** with the same master key.

- **Reading happens on your server.** The worker runs Tesseract locally to make documents searchable, and draws page previews with poppler and ImageMagick; no page ever leaves the machine. Private documents' text is stored encrypted under the owner's key and is not indexed. Page previews and thumbnails are encrypted under their document's own key, like the file, and, like every answer the vault gives, are sent with `Cache-Control: no-store`: no browser or phone keeps them.

The honest limit: someone who controls the whole server can read everything. For a self-hosted vault on the household's own machine, that is the right trade — it is what makes server-side search, thumbnails and automatic filing possible.

## Backups and recovery

Three things make up a complete backup:

1. **Your `.env`** — it holds the master key. Keep a copy off the server. Without it, nothing else below is readable.
2. **The database** — the worker writes an encrypted `pg_dump` every night (`FDV_BACKUP_CRON`, default 02:30) into the `fdv_vault-data` volume under `/data/backups`, keeping `FDV_BACKUP_RETAIN_DAYS` (30) days. Copy that folder somewhere else on a schedule of your own.
3. **The files** — the `fdv_vault-data` volume (`/data/vault`) for the local vault, or your bucket. They are ciphertext; the master key and the database together open them.

Useful commands (run inside the worker container):

```bash
docker compose exec worker node apps/worker/dist/cli.mjs backup-now
```

```bash
docker compose exec worker sh scripts/restore-drill.sh
```

The restore drill restores the newest backup into a scratch database beside your own, checks it the way the vault will read it — as the vault's own database user, through the same privacy rules — and drops it again. Your vault is not touched. Run it after you change anything about your backups, and let it reassure you occasionally.

### Restoring

A restore goes into an empty database, never over a vault that is running: it refuses to. It gives the vault's database user its privileges back, brings a backup from an older release up to date, and checks the result before it says it is done. It refuses a backup from a newer release than the one you run — restore that with the newer release (`FDV_VERSION`).

**Everything since the backup was made is undone** — documents added since, and also passwords changed, people removed and share links revoked since. So pick the newest backup; afterwards everybody signs in again, with the password they had when it was made. The restore lists what else to look at, such as share links that work again.

**If you lost the database but not the `fdv_vault-data` volume** (your files, and the backups in `/data/backups`), stop the vault, clear the database, and restore the newest backup into it:

```bash
docker compose down
```

```bash
docker volume rm fdv_db-data
```

```bash
docker compose up -d --wait postgres
```

```bash
docker compose run --rm --no-deps worker node apps/worker/dist/cli.mjs restore-backup latest
```

```bash
docker compose up -d
```

To go further back, name a file instead of `latest`, such as `/data/backups/fdv-2026-09-20T02-30-00-000Z.sql.enc`.

**On a new machine**, start from the three things above. Put your `.env` beside `docker-compose.yml`, and put your copy of the files back into the `fdv_vault-data` volume, owned by the container's user:

```bash
docker run --rm -v fdv_vault-data:/data -v "$PWD/vault-data-copy:/from:ro" alpine sh -c "cp -a /from/. /data/ && chown -R 1000:1000 /data"
```

Then run the commands above from `docker compose up -d --wait postgres` on. If the backup file is not in the volume, mount it into the restore instead; it must be readable by that user (`chmod 644` it):

```bash
docker compose run --rm --no-deps -v "$PWD/fdv-2026-09-20T02-30-00-000Z.sql.enc:/restore.sql.enc:ro" worker node apps/worker/dist/cli.mjs restore-backup /restore.sql.enc
```

**Never use `docker compose down -v`.** It deletes the files and the backups along with the database. If you run the vault behind TLS (`docker-compose.tls.yml`), give every `docker compose` command above the same `-f` files you always use.

A database restored by hand — loaded with `psql` from `decrypt-backup <file> out.sql`, as this README once said — can read itself again from the first time the vault starts on it. But nothing signed anybody out: a phone signed out, or a password changed, since that backup is signed in again. Have everybody change their password, which signs out everything else of theirs, or restore again with `restore-backup`.

**Export everything** in Settings makes a ZIP of every original plus a readable index — the way to leave, and a second backup that needs no software at all.

### Notifications and email

**Notifications work out of the box.** Open the vault, go to _Settings → How you hear about things_, and turn them on: the day's reminders arrive on that device even when the vault is closed. Nothing is configured, no account anywhere is involved, and the signing keys are generated into your `.env`. On iPhone and iPad, add the vault to the home screen first — Apple only allows notifications for installed web apps.

**Email is optional and uses your own mail account.** Every other adult is told whenever an owner changes it, because everything the vault emails travels through it — and for the same reason no email ever names a private document, even to the person it belongs to; that is left to notifications, which are encrypted to your own device. An owner picks a provider (Gmail, Fastmail, iCloud, Outlook, Amazon SES, Postmark, or anything else with an SMTP server), pastes an address and an app password, and presses **Save and send a test**. A real message goes to your own address, and if it does not arrive the screen says why in plain words. Reminders then come from an address your family recognises, and no third party ever handles them.

Each person chooses what they want: the day's reminders on their devices, the same by email, and a summary every Sunday evening.

### Notifications on the phone app

The Android app gets its notifications through **UnifiedPush**, not Google: install a distributor app on the phone — [ntfy](https://ntfy.sh) is the usual one — and the vault's notifications go through it. Nothing else is needed on the server; the same keys that sign browser notifications sign these.

What the phone is sent says nothing a lock screen should not: _how many_ things need attention and the date, or a word for what happened — a new device signed in, a change of owner, this phone was signed out. No titles, no names. The app asks the vault for the rest once it is unlocked. Every message is encrypted to the phone (RFC 8291), so ntfy.sh and the servers between see only ciphertext and timing.

- **The public ntfy.sh works**, and needs nothing from you.
- **Your own ntfy on your network** also works, but the vault refuses by default to send anything to an address inside its own network — otherwise whoever registers a device could point the vault at your router or a cloud metadata service. Set `FDV_PUSH_ALLOW_PRIVATE_ENDPOINTS=true` in `.env` (it applies to both the API and the worker) if your distributor is on your LAN.
- Push addresses must start with `https://`.
- Signing out, signing a device out from another, a password change or reset, and taking a sign-in away all remove that phone's notifications at once — and tell the phone, so the app can forget what it holds.
- _Settings → How you hear about things_ lists every browser and phone that hears from the vault, marks the ones that have stopped working ("Not working — last tried …"), and sends a test to any of yours. A device the push service says is gone is removed by itself; one that keeps failing is marked after ten tries in a row.

### Where files are kept

Setup creates a local vault on the server (the `fdv_vault-data` volume) and uses it straight away. An owner can add an S3-compatible bucket under **Where your files are kept**: pick the provider (Amazon S3, Backblaze B2, Wasabi, Cloudflare R2, DigitalOcean Spaces, MinIO, or anything with an S3 address), paste the bucket name and two keys, and press **Test and save**. The test writes a small object, reads it back and deletes it, and tells you in plain words what happened. A place that has not passed its test cannot be chosen.

Objects are laid out as `<household>/<document>/<version>/<hash>.<ext>.enc`, with a version's thumbnail and page previews beside it (`….thumb.enc`, `….p1.enc`), so a bucket can always be read with the provider's own console — the files are ciphertext until the offline recovery tool (a later release) opens them with your recovery code.

### Rotating the master key

Rotation rewraps the small per-household keys; the encrypted files themselves are never rewritten, so it takes seconds regardless of how much you store.

```bash
docker compose run --rm -e FDV_MASTER_KEY_NEW="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')" api node apps/api/dist/cli.mjs rotate-master-key
```

Then put the new value in `.env` as `FDV_MASTER_KEY`, run `docker compose up -d`, and back the file up again. Everyone is signed out by the rotation, because sign-in tokens are derived from the same key.

## Upgrading

Images are version-tagged. Database migrations run automatically on start, and only forward: the way back from an upgrade is the image you had and the backup taken before it. So take one first — `docker compose exec worker node apps/worker/dist/cli.mjs backup-now` — and if you ever need it, restore it as [above](#restoring). Breaking API changes are announced in [`docs/api-changelog.md`](docs/api-changelog.md) with a deprecation window of four minor releases, so an older mobile app keeps working against a newer server and vice versa.

## Developing

Requirements: Node 22, pnpm 9, Docker.

```bash
pnpm install
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres   # a database for tests
DATABASE_ADMIN_URL=postgres://fdv:<FDV_DB_PASSWORD>@localhost:5432/fdv pnpm check   # lint + typecheck + tests
docker compose up -d && pnpm e2e                                                  # end to end, in a real browser, against the containers
```

Integration tests run against a real PostgreSQL: each test file creates its own throwaway database, migrates it, and drops it. Without `DATABASE_ADMIN_URL` those tests are skipped and only unit tests run.

For a live-reloading API and web app: `pnpm --filter @fdv/api dev` and `pnpm --filter @fdv/web dev` (the Vite dev server proxies `/api` to port 3000).

Layout:

```
apps/api           the API service (Fastify)
apps/worker        background jobs (pg-boss)
apps/web           the web app (React, Vite)
packages/shared    types and helpers shared by API, worker and clients (the API contract) — MIT
packages/client    the API client every app uses, its fake vault and contract tests — MIT
packages/db        connection, migration runner, SQL migrations
packages/crypto    envelope encryption, scope keys, passwords
packages/storage   where encrypted files are kept: local disk or S3
docker/            nginx config and the Postgres init script
docs/              public operational docs (API changelog)
```

The three images are built from the one `Dockerfile` (targets `api`, `worker`, `web`).

Every change goes through a pull request with green CI. Commits follow [Conventional Commits](https://www.conventionalcommits.org/).

## Licence

The vault — the server, the worker and the web app — is [AGPL-3.0](LICENSE). Self-host it, modify it, run it for your family; if you run a modified version as a service, share your changes.

Two packages are MIT instead, so that anyone can build an app that talks to a vault, under whatever licence they like:

- [`packages/shared`](packages/shared/LICENSE) — the API's types and the helpers every client needs (dates, statuses, reminder wording, design tokens);
- [`packages/client`](packages/client/LICENSE) — the API client, its fake vault for testing, and the contract both are held to.

Each has its own `LICENSE` file; everything else in the repository is under the root [LICENSE](LICENSE). `pnpm lint` checks that neither MIT package depends on, or imports, anything else in the repository.
