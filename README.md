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
- **"Only me" is cryptographic.** Private documents are encrypted so that no other account — including the household owner — can open them. Their text is never indexed either, so searching them happens in two passes: everything shareable first, then your own sealed documents, opened inside your own session. One date is the exception: the one a kind of document reminds from, such as a bill's due date, which the vault can read as it can an expiry date, so it can remind the document's owner; everything else in its details stays sealed.
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

### Links for people outside the family

A share link is for someone who is not on your network — the letting agent, the
accountant — so with only the middle road above, nobody you send one to can open it. The
**public-only site** is a second address that serves just the page a link opens and the
few API routes that page calls, and nothing else: the front page, the sign-in and the
rest of the API answer 404 there. The family keeps using the internal address; only that
one page faces the internet.

```bash
docker compose -f docker-compose.yml -f docker-compose.tls.yml --profile public-only up -d
```

It needs, in `.env`:

- `FDV_PUBLIC_HOSTNAME` — a public DNS name for it, pointing at your home's internet
  address (`share.example.com`). Caddy gets its certificate from Let's Encrypt, so set
  `FDV_TLS_EMAIL` too.
- Your router forwarding ports 443 and 80 from the internet to this machine's
  `FDV_PUBLIC_HTTPS_PORT` and `FDV_PUBLIC_HTTP_PORT` (8443 and 8081 unless you change
  them), so it runs beside the internal site on 443.
- `FDV_PUBLIC_URL=https://share.example.com`, so the links the vault makes start with the
  address the people you send them to can reach. Without it a link starts with whichever
  address it was made at.

**Share links need an `https://` address**: the TLS overlay above, or this public-only
site. Opening a link gives the browser a cookie it keeps only on a secure page, so on
`http://192.168.1.20:8080` the document could never be downloaded; the page turns
**Open** off there rather than count an open that delivers nothing, and warns you when you
make such a link. `FDV_PUBLIC_URL` must start with `https://` (only `http://localhost` is
allowed, for trying things on this computer).

A link reads `https://share.example.com/s#…`. What is after the `#` is the link's secret.
A browser never sends that part to any server; the page reads it, takes it out of the
address bar and this tab's history, and opens nothing until the person presses **Open** —
so an email program's link checker, which fetches every link it sees, cannot open or use
up a link. The browser's own history of visited pages may still hold the whole link, and
may sync it to the person's other devices; no page can take it out of that. So for
anything sensitive, add a PIN and tell it to them some other way. Opening gives that
browser a session for 30 minutes of use, 4 hours at most and never past the link's own
end.

What the site serves: `/s`, `/shared/…` (links made before 0.5.14), their files under
`/assets/`, and `/api/v1/shared/*` (and, when upload requests arrive, `/drop` and
`/api/v1/drop/*`). Every answer carries `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff`, and a content security policy that allows no framing
and no script but the page's own. The vault counts requests per address — 20 a minute to
preview or open a link, 120 a minute inside an opened one — and Caddy passes each
caller's own address on, never one they wrote themselves.

What it cannot do: it is still a page on the internet. Anyone can knock on it, and a link
is only as private as the message you send it in; a PIN, told over the phone, is the
second lock.

A link can say more than who it is for:

- **Until when**: a date and a time on your household's clock (Settings → Household), with
  Tonight, Friday 5 pm and In a week one tap away. At least five minutes ahead, and at
  most `FDV_SHARE_MAX_DAYS` (90 unless you shorten it; the share sheet offers nothing
  longer): a link always ends.
- **View, or view and download.** A link to view shows the document's pages, each drawn
  by the worker with who the link is for and the day it was made written across the
  whole page, again and again on the slant (so a part cut out still carries it), in any
  script, and once more below it. It never gives the file itself, by any route. It shows
  the first 30 pages (of a PDF, or of a scanner's many-page TIFF), and you are told when
  a document is longer. The recipient can keep pictures of the pages, each marked; no page
  can stop a screenshot, and the page says so. Word and Excel files are shared only with
  download: the vault cannot draw their pages. A link's pages are removed when it ends.
- **How many opens.** Each press of Open that works is one; reloading the page it opened,
  turning its pages or downloading the file again there is not. A download is counted
  once per document for each open, and so is the line the activity log gets for it.
- **A second lock**, as many as you like of:
  - **a PIN or a password**: four digits, or a password the vault makes up (three short
    groups, easy to read out, and taken however they type its capitals, dashes and spaces)
    or one you type (8 characters or more, checked exactly). You tell them it some other
    way; the vault keeps only a scrambled copy.
  - **a code by email**: when they open the link, they ask for a six-digit code, which the
    vault emails to the address you typed — they never type one, and see it with most of it
    hidden. It works once, for 10 minutes, and only the newest code works; at most 3 are
    sent in 15 minutes and 10 a day.
    It proves they can read that inbox: it protects against a forwarded or misposted link,
    not a hacked mailbox. It goes **only through `FDV_SMTP_URL`**, the mail server whoever
    runs the vault sets, never the household's own, which any owner can point anywhere;
    without it the option is not offered, and the share sheet says why. The code is kept
    only as a keyed hash (from the master key), and the address is forgotten when the link
    ends.
  - **this browser only**: the first browser that opens it is the only one it opens in — one
    browser, not the whole device, so tell them to open it in the one they usually use, not
    a private window or their email app's own browser.

  Every wrong PIN, password or code counts against the same ten tries for the life of the
  link, and a wrong password and a wrong code get the same answer. After the tenth the link
  stops working, and you are told.

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
| `FDV_RATE_LIMIT_PER_MINUTE`        | `300`                                     | How many requests one address may make in a minute, beyond the tighter limits on signing in and opening links (60 to 100000). Raise it when many devices share one address.                                             |
| `FDV_LOCAL_VAULT_DIR`              | `/data/vault`                             | Where the built-in local vault keeps encrypted files. In Docker this is the `fdv_vault-data` volume.                                                                                                                    |
| `FDV_DISPLAY_NAME`                 | `Our family vault`                        | What your family calls the vault. Shown on every screen.                                                                                                                                                                |
| `FDV_PORT`                         | `8080`                                    | The port the web app listens on.                                                                                                                                                                                        |
| `LOG_LEVEL`                        | `info`                                    | `fatal`, `error`, `warn`, `info`, `debug` or `trace`.                                                                                                                                                                   |
| `FDV_VERSION`                      | `latest`                                  | Image tag to run. Pin it to a release once you are past testing.                                                                                                                                                        |
| `FDV_HOSTNAME`                     | `vault.local`                             | The name devices use, when the TLS overlay is running.                                                                                                                                                                  |
| `FDV_BASE_URL`                     | `http://localhost:8080`                   | What reminder emails and notifications link back to. Set it to the `https://` address once you have one.                                                                                                                |
| `FDV_CADDYFILE`                    | internal                                  | Which TLS setup to use: `./docker/caddy/Caddyfile.internal` or `./docker/caddy/Caddyfile.public`.                                                                                                                       |
| `FDV_PUBLIC_URL`                   | unset                                     | The public-only site's `https://` address, which share links start with. See [Links for people outside the family](#links-for-people-outside-the-family).                                                               |
| `FDV_SHARE_MAX_DAYS`               | `90`                                      | The longest a share link may last, in days (1 to 90). A link always ends; this only shortens the longest end the vault accepts.                                                                                         |
| `FDV_PUBLIC_HOSTNAME`              | unset                                     | The public-only site's name, for its certificate (profile `public-only`).                                                                                                                                               |
| `FDV_PUBLIC_HTTPS_PORT`            | `8443`                                    | The port the public-only site listens on for `https://`; forward the router's 443 to it.                                                                                                                                |
| `FDV_PUBLIC_HTTP_PORT`             | `8081`                                    | The port it listens on for `http://` (certificates, and the redirect); forward the router's 80 to it.                                                                                                                   |
| `FDV_TRUST_PROXY`                  | `private`                                 | Whose `X-Forwarded-For` to believe when recording who did what: `private` (the container network and a proxy on your LAN), `all`, or `none`.                                                                            |
| `FDV_SMTP_URL`                     | unset                                     | Your own mail server for password-reset links and the codes a share link can ask for, e.g. `smtps://user:app-password@smtp.fastmail.com:465`. Set it on the API and the worker. See [Passwords](#passwords).            |
| `FDV_SMTP_FROM`                    | `Family Document Vault <vault@localhost>` | Who those emails come from.                                                                                                                                                                                             |
| `FDV_PUSH_ALLOW_PRIVATE_ENDPOINTS` | `false`                                   | Let notifications go to addresses inside your own network — a UnifiedPush distributor (ntfy) on your LAN. Set it on both the API and the worker. See [Notifications on the phone app](#notifications-on-the-phone-app). |

Health endpoints, for your monitoring: `/healthz` (the API process is up) and `/readyz` (it can reach the database).

### Sign-in and sessions

- **Two-step sign-in** with an authenticator app (Google Authenticator, Authy, 1Password…) is set up in Settings and is required for owners. Sign-in then asks for the six-digit code after the password.
- Passwords are hashed with Argon2id. Sign-in answers with a 15-minute access token and a refresh token that rotates on every use.
- **A session lasts 30 days from when it was last used, and 180 days at most** from the sign-in: a device used every week stays signed in for half a year, then asks once for the password. This is the same for browsers and the phone app.
- A refresh token presented twice is treated as stolen and that device is signed out — with one exception, for answers that never arrive (a phone on a network that loses them, a browser page reloaded while it was refreshing): the token just replaced may be presented once more, within 30 seconds, by the same client — the same app installation, or the same browser from the same address. Anyone else presenting it, or presenting it later, ends the session.
- When a session ends, the app is told why — it expired, it was signed out, its token was used twice, or the person was taken out of the household — so it can say so in plain words.
- Every signed-in device is listed under the household name; any of them can be signed out from another.
- The token signing key is derived from `FDV_MASTER_KEY`. [Rotating the master key](#rotating-the-master-key) signs everyone out.
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

The link reads `https://vault.example/join#…`. What is after the `#` is its
secret, and a browser sends that part to no server, the vault and anything in
front of it included. The page reads it, then takes it out of the address bar
and that tab's history. The browser's own history of visited pages may still
hold the whole link, and no page can take it out of that: what protects it is
that it works once, only with the code, and not for long.

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
code. Like an invitation's, the link carries its secret after the `#`
(`https://vault.example/reset#…`), which no server is sent; the page takes it
out of the address bar and that tab's history, though not out of the
browser's own history of visited pages — which is why the link works once, and
only for an hour.

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
- it can carry a four-digit PIN or a password, which you give them some other way, ask
  for a code emailed to them, and open in one browser only;
- you can take it back at any moment;
- every time it is opened you see it, next to the link;
- and it reaches nothing else in the vault. There is no account at the other
  end and nothing to sign up for.

The link is shown once — the vault keeps only a hash of it — so a lost link is
replaced rather than recovered. A document moved to the trash stops being
shared straight away, without anyone having to remember the link exists.

A whole collection can go the same way: on the collection's page, **Share this
collection** lists what is in it that you can see, with what everybody the
collection is for may see already ticked. Only what you tick goes, and each is
checked again every time the link is used: one you can no longer see, one taken
out of the collection or moved to the trash, stops being sent, and the other end
is never told how many there were. **Keep it up to date** also sends what an
owner or an adult puts in the collection later — decided once, as it goes in:
only what the whole of its audience may see, never a private document, and
never anything that was in it when you shared it and you left unticked. What a
teen puts in stays in the family. Narrowing the collection or a document later
only takes away. Such a link lasts 30 days at most. Sharing a collection
always asks you to confirm it is you; a teen cannot share one; and deleting the
collection, or making it Only me, ends its links. Every link, to a document or a
collection, is in **Settings → Sharing**, to take back.

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

- **Reading happens on your server.** The worker runs Tesseract locally to make documents searchable, and draws page previews with poppler and ImageMagick; no page ever leaves the machine. Private documents' text, notes and details are stored encrypted under the owner's key and are not indexed. Page previews and thumbnails are encrypted under their document's own key, like the file, and, like every answer the vault gives, are sent with `Cache-Control: no-store`: no browser or phone keeps them.

The honest limit: someone who controls the whole server can read everything. For a self-hosted vault on the household's own machine, that is the right trade — it is what makes server-side search, thumbnails and automatic filing possible.

## Backups and recovery

Three things make up a complete backup:

1. **Your `.env`** — it holds the master key. Keep a copy off the server. Without it, nothing else below is readable.
2. **The database** — the worker writes an encrypted `pg_dump` every night (`FDV_BACKUP_CRON`, default 02:30) into the `fdv_vault-data` volume under `/data/backups`, keeping `FDV_BACKUP_RETAIN_DAYS` (30) days. Copy that folder somewhere else on a schedule of your own. From 0.5.8 an Only me document's notes and details are sealed under their owner's key, as its pages always were; backups made before then keep them unsealed until they rotate out.
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

**Everything since the backup was made is undone** — documents added since, and also passwords changed, people removed and share links revoked since. So pick the newest backup; afterwards everybody signs in again, with the password they had when it was made. Every share link is paused, since one you took back after the backup would otherwise work again: an owner turns back on the ones still wanted in **Settings → After a restore**, and nobody else can, not even whoever made the link. They can take their own links back there. A link to somebody's Only me document, which no owner can see, stays paused: if it is still needed, they take it back and make a new one. The restore lists what else to look at.

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

To go further back, name a file instead of `latest`, such as `/data/backups/fdv-2026-09-20T02-30-00-000Z.sql.enc`. A backup made before you last [rotated the master key](#rotating-the-master-key) also needs the key it was made with: add `-e FDV_MASTER_KEY_PREVIOUS=<old key>` to the restore command.

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

A photo chosen for a person rests for a few seconds in `<household>/members/<person>/incoming/<photo>.enc`, encrypted as it arrived, while the worker makes it into a small square picture; then it is deleted, and so is a file the worker could not use. The picture itself is kept, encrypted, in the database, so the nightly backups carry it (a removed photo stays in them until they expire, 30 days by default). The nightly clean-up takes away anything left half made there for a day. The one thing a restore can leave behind in that folder is a photo that was on its way when the database was lost: unreadable ciphertext, since its key went with the database.

### Rotating the master key

Rotation moves everything the master key protects onto a new key, in one database transaction: it rewraps the small per-household keys, and seals again the secrets the vault keeps for you — each person's two-step sign-in, an S3 bucket's credentials, the household's mail password. The encrypted files themselves are never rewritten, so it takes seconds regardless of how much you store.

First make the new key, and put it somewhere safe before you use it — beside your copy of `.env`, or in a password manager. After the rotation, nothing opens without it. This works in any shell, PowerShell and the Windows command prompt included:

```bash
node -p "require('crypto').randomBytes(32).toString('base64url')"
```

Take a backup, then stop the vault, so that nothing is written under the old key while the new one goes in. The rotation refuses to run while anything else is connected to the database.

```bash
docker compose exec worker node apps/worker/dist/cli.mjs backup-now
```

```bash
docker compose stop api worker
```

Rotate, with the new key in place of `<new key>`:

```bash
docker compose run --rm --no-deps -e FDV_MASTER_KEY_NEW=<new key> api node apps/api/dist/cli.mjs rotate-master-key
```

It says how many keys and secrets it moved and how many sessions it ended. Then put the new key in `.env` as `FDV_MASTER_KEY` (or in your key file, if you use `FDV_MASTER_KEY_FILE`), start the vault, and back `.env` up again:

```bash
docker compose up -d
```

Use `up -d`, never `docker compose start` or `restart`: those keep the key the containers were made with, the old one. The vault does not start on a key that does not open it: the api and the worker stop at once, and their logs say `FDV_MASTER_KEY does not open this vault`, and what to do. If it does not come up after a rotation, look there first.

If the command refuses before it starts (a new key that is the one in use, or that holds anything `.env` would change, such as a space, a quote or a `$`; the vault still running; no `DATABASE_ADMIN_URL`), or says `Nothing was changed`, the vault is as it was, on the old key: `docker compose up -d` starts it again. If it says `The database is already on the new key`, an earlier run finished: put the new key in `.env` as above.

**Everybody is signed out**, on every device, and signs in again. Two-step sign-in, passkeys, email, an S3 bucket, share links and invitations carry on working as before.

**Keep the old key** as long as you keep a backup made before the rotation: the nightly ones stay in `/data/backups` for `FDV_BACKUP_RETAIN_DAYS` (30) days, and your own copies as long as you keep them. Such a backup is encrypted under the old key, and so is everything in it. To restore one, follow [Restoring](#restoring) and give the old key beside the new one, as `FDV_MASTER_KEY_PREVIOUS`; the restore moves what the backup holds onto the current key before the vault opens it:

```bash
docker compose run --rm --no-deps -e FDV_MASTER_KEY_PREVIOUS=<old key> worker node apps/worker/dist/cli.mjs restore-backup latest
```

The restore drill takes it the same way: `docker compose exec -e FDV_MASTER_KEY_PREVIOUS=<old key> worker sh scripts/restore-drill.sh <file>`. If anything a backup holds opens with neither key, nothing in it is moved and the restore fails, saying what to do: a vault is never left partly under one key and partly under the other. After more than one rotation, give the key that particular backup was made with. Once the last backup made with the old key is gone, the old key can go too.

**If you rotated the master key with an earlier release** whose `rotate-master-key` only reported `rewrapped N scope key(s)`, that rotation moved only the per-household keys: the two-step sign-in secrets, an S3 bucket's credentials and the mail password stayed under the key before. Such a vault now does not start, and says that part of it opens and part does not. What to do depends on which key your `.env` holds.

If you put the rotation's new key in `.env`, as that README asked: after it, owners with two-step sign-in could not sign in (the code step failed with "Something went wrong"), and mail or an S3 bucket stopped working, while documents opened. Repair it with the key you had before that rotation, with the vault stopped:

```bash
docker compose run --rm --no-deps -e FDV_MASTER_KEY_PREVIOUS=<old key> api node apps/api/dist/cli.mjs repair-master-key
```

It moves whatever is still under the old key onto the one in `.env` and signs everybody out; if anything opens with neither key, it changes nothing and says what. Then `docker compose up -d`. A backup made since that rotation is restored the same way, with `FDV_MASTER_KEY_PREVIOUS` set to the key before it.

If you ran that README's command exactly as written, it made the new key inside the command and never showed it, and `.env` still holds the key from before. Then it is the other way round: after it, documents would not open (downloads failed), while signing in, two-step sign-in, mail and an S3 bucket kept working; and the vault now says that no scope key opens but the secrets do. The per-household keys are under a key nobody has, and no repair can bring them back. Restore a backup made before that rotation, as in [Restoring](#restoring), with your `.env` as it is and without `FDV_MASTER_KEY_PREVIOUS`. Nothing made after that backup can be opened without the lost key.

## Upgrading

Images are version-tagged, and `latest` is the newest release (a milestone or a fix to one — never a development build or a release candidate); set `FDV_VERSION` in your `.env` to stay on one version until you choose to move. Database migrations run automatically on start, and only forward: the way back from an upgrade is the image you had and the backup taken before it, restored with that image. An older release will not start on a database a newer one has upgraded (from 0.5.5; it says so in the API's and the worker's logs), because it would not see the documents in it. So take a backup first — `docker compose exec worker node apps/worker/dist/cli.mjs backup-now` — and if you ever need it, restore it as [above](#restoring). Breaking API changes are announced in [`docs/api-changelog.md`](docs/api-changelog.md) with a deprecation window of four minor releases, so an older mobile app keeps working against a newer server and vice versa.

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
