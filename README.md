# Family Document Vault

**Every important paper in the household, in one place — telling you its own status and warning you before it expires.**

Passports, birth certificates, licences, insurance policies, tax returns, bills. Scan or upload once; the vault files it, works out whether it is current, expiring or expired, and reminds you months ahead — not the week after. Files are encrypted by the server before they are written anywhere, and they live on **your** disk or **your** S3-compatible bucket.

Built for people whose whole skill floor is _scan, upload, download_. You should never have to see the words bucket, key, schema or encryption unless you go looking.

> **Status: 0.8.0.** The vault, its web app and its Android app are built in small, tested iterations. The [changelog](CHANGELOG.md) says what each release does, and [Upgrading](#upgrading) how to move from one to the next.

---

## What it does

- **Filing is done for you.** The app proposes the type, the person and the key dates; you confirm with one tap. A document saved with nothing but a photo is still a valid document.
- **Status is derived, never typed.** Nobody sets a document to "expired". Dates plus the rules for that document type produce the status, so a vault left alone for a year is still correct.
- **Reminders that lead.** A passport reminds you nine and six months before it expires; a car registration 45 and 7 days before. Renewing a document — uploading the new one — resolves its reminder automatically. Everything due lands in one message a day at 9 am your time, and a server that was switched off for a fortnight sends one summary, not fourteen.
- **It tells you what you do not have.** From a handful of questions at setup — do you own or rent, how many cars, is there a child in the family — the vault draws an outline for the documents that are missing: _No birth certificate for Aisha_, _No deed or title on file_. Each one says why it is there, and "Not for us" makes it go away for good (and can be undone).
- **Browse by person and by category**, with counts and status roll-ups, and full-text search across titles, tags, notes and the text inside the document.
- **Notes for what the family knows.** Where the stopcock is, how the boiler resets, who to call when the alarm goes off: kept in **Notes** with the documents, seen, shared and found as they are — and sent to somebody outside the family by a link, more safely than in an email. A note is not a to-do list or a chat, and not a password manager.
- **A household, not a user.** Members with or without their own sign-in (children, elderly parents), four simple roles, and three plain visibility levels per document: _Everyone in the family_, _Adults only_, _Only me_.
- **Sensitive papers are handled with extra care.** Passports, certificates, financial, tax and medical papers start out **Sensitive** (each household chooses which kinds, and any document can say yes or no). A sensitive paper that a teen, or a grown-up son or daughter, adds of their own starts as _Only me_; sharing one by a link asks first, and the link's page says "A document" unless you choose to show its title (a file they download keeps its own details, such as a PDF's title; a link to view only shows the pages); marking a shared paper sensitive offers to end its links; search shows no snippet of its words; the activity log calls it "a sensitive document"; and it is never sent to an AI reader outside your home network unless an owner says so.
- **"Only me" is cryptographic.** Private documents are encrypted so that no other account — including the household owner — can open them. Their text is never indexed either, so searching them happens in two passes: everything shareable first, then your own sealed documents, opened inside your own session. One date is the exception: the one a kind of document reminds from, such as a bill's due date, which the vault can read as it can an expiry date, so it can remind the document's owner; everything else in its details stays sealed.
- **Your storage.** Local disk by default; any S3-compatible bucket (AWS, MinIO, Backblaze B2, Wasabi, Cloudflare R2, DigitalOcean Spaces, Ceph, Storj …). Change later with a verified background migration; add a second location as a mirror.
- **Always exportable.** One button produces a ZIP of the originals plus a readable index. A document moved to the Trash can be brought back until an owner removes it for good.
- **The household survives its administrator.** Trusted contacts, a printable recovery sheet, and an offline recovery tool that decrypts your bucket without this software running.

## What it will run on

One `docker compose up`. Four containers: the API, a background worker (OCR, thumbnails, page previews, reminders), the web app, and PostgreSQL. No Redis, no message broker, no Kubernetes.

The worker reads the papers you add many at a time with plain rules and, beside them, a small text classifier of its own (a file of under a megabyte in the worker image), all on your server: no page goes to any outside service. Owners can turn the classifier off in Settings → Server and reading → Reading and the check.

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
node scripts/gen-env.mjs   # writes .env with a random master key, database passwords and a setup code
docker compose up -d
```

The first start builds the images (a few minutes), applies database migrations, and starts the four containers. Then open `http://localhost:8080`. The first visit walks you through setup: the **setup code** (`FDV_SETUP_TOKEN` in your `.env`), your family's name, your name, your email and a password (you become the owner — nobody can run that step again), then **two-step sign-in** for you — a passkey on this device, or a code from an authenticator app — a few quick questions about your household, the people whose documents you keep, and a starting list of what families like yours usually file.

The setup code means that only somebody who can read the server's `.env` can become the vault's owner: until setup is done, anybody who reaches the address — another computer on your network, or the internet if you published it — could otherwise claim it first. A `.env` made before 0.9.0 has no `FDV_SETUP_TOKEN`; then the API makes a code each time it starts, until the vault is set up, and writes it to its log: `docker compose logs api | grep setup`.

The vault will not start on the example file's secrets: copying `.env.example` to `.env` gives a master key and database passwords anybody can read, and the api and the worker stop at once and say so. Use `node scripts/gen-env.mjs`.

From then on: **Add** a document from a photo or a file, confirm what it is and whose it is, and it is filed — or add many at once, which wait in the **Inbox** until you accept them. Every document is in **Documents**, to sort and filter; browse by person or category from Home, or search — including the words inside scanned pages.

On the web, a document clicked in a list opens beside it, over the list, rather than in its place. Up to ten can be open at once: minimise one (Esc) and it waits in the tray at the right edge, just as it was; one minimised for 15 minutes is freed to save memory and opens again when chosen. Ctrl-click, or **Open as a page**, gives a document its own page, with an address to bookmark or share.

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

With the TLS overlay running, `:8080` answers this machine only (it is bound to
`127.0.0.1`): every other device comes in through Caddy and its certificate, and none
goes round it. Without the overlay, `:8080` stays open to your network, as that is how
the house reaches the vault. The overlay's `!override` needs Docker Compose 2.24.4 or
later.

### Who is asking

The activity log records the address each action came from, sign-in attempts are limited
per address, and a browser's refresh grace (see [Sign-in and sessions](#sign-in-and-sessions))
compares addresses. So the vault is careful about whose word it takes for an address:

- **nginx** (`:8080`) passes on the address a request came from, and nothing the caller
  wrote in `X-Forwarded-For`.
- **Caddy** (the TLS overlay) sends the API's requests to the API itself, with the address
  it was reached from, and takes no caller's word for one either.
- **The API** believes `X-Forwarded-For` only from the networks its own container is on —
  in the compose setup, nginx and Caddy (`FDV_TRUST_PROXY=network`, the default) — never
  from a device on your LAN, and only the one address that proxy wrote last; an entry
  that is not an address is not believed at all.

`FDV_TRUST_PROXY=private` believes any private address, as the vault did before. A
reverse proxy of your own in front of `:8080` is recorded as its own address, since nginx
takes nobody's word; use the TLS overlay for a certificate, or put your proxy in front of
the API on the vault's own network. Such a proxy must **overwrite** `X-Forwarded-For` with
the address it was reached from (Caddy and Traefik do by default; nginx with
`proxy_set_header X-Forwarded-For $remote_addr`), not add to what the caller sent: the API
takes only the last address, and nothing a caller wrote should reach it. On Docker
Desktop, every device can reach the vault as the Docker network's gateway, and so be
recorded as that one address.

**A proxy of your own must pass the vault's headers on as they are.** The web container
sends a `Content-Security-Policy` with every page: `script-src 'self' 'sha256-…'; object-src 'none';
base-uri 'none'` for the app (the hash allows the few lines at the top of the page that
choose light or dark before anything is drawn, and nothing else inline; stylesheets and fonts from
the vault alone), and a stricter one (no framing, no forms, and nothing loaded
from anywhere but the vault itself) with `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY` on the pages people outside
the family open (`/s`, `/shared/…`, `/drop`); the API adds a sandbox policy to everything
under `/api/v1/shared` and `/api/v1/drop`. Those pages, like the app, load their fonts
(Figtree and Fraunces, under the SIL Open Font License) from the vault itself: the browser
of somebody you send a link to asks no other site for anything. Do not replace, loosen or drop
the headers, and turn off anything in a proxy or a CDN that adds a script to pages
(analytics, "email address obfuscation", script optimisers): the policy blocks it, and the
page breaks. A proxy that rewrites the page's HTML (minifies it) changes that hash: the
dark theme is then drawn light for a moment as each page opens. They are a second line of defence behind the app, which never draws a note or
a file as HTML.

### Links for people outside the family

A share link is for someone who is not on your network — the letting agent, the
accountant — so with only the middle road above, nobody you send one to can open it. The
**public-only site** is a second address that serves just the page a link opens and the
few API routes that page calls, and nothing else: the front page, the sign-in and the
rest of the API answer 404 there. The family keeps using the internal address; only that
one page faces the internet.

The vault can send a link, or a request to send documents, itself: by email through
`FDV_SMTP_URL`, and by text through the household's own text messages (Settings → Text
messages), counted towards the month's texts. Either message says who it is from and when
it stops working, never what it is to or its PIN or password.

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

What the site serves: `/s`, `/shared/…` (links made before 0.5.14), a request's page to
send documents (`/drop`), their files under `/assets/`, `/api/v1/shared/*` and
`/api/v1/drop/*`. Every answer carries `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff`, and a content security policy that allows no framing
and no script but the page's own. The vault counts requests per address — 20 a minute to
preview or open a link, 120 a minute inside an opened one — and Caddy passes each
caller's own address on, never one they wrote themselves.

What it cannot do: it is still a page on the internet. Anyone can knock on it, and a link
is only as private as the message you send it in; a PIN, told over the phone, is the
second lock.

A link can say more than who it is for:

- **Until when**: a date and a time on your household's clock, with Tonight, Friday 5 pm
  and In a week one tap away. That clock is the family's time zone, which an owner chooses
  in Settings → Time zone; until one does, it is the server's `FDV_TIMEZONE`, UTC unless
  set (see [The family's time zone](#the-familys-time-zone)). At least five minutes ahead, and at
  most `FDV_SHARE_MAX_DAYS` (90 unless you shorten it; the share sheet offers nothing
  longer): a link always ends.
- **View, or view and download.** A link to view shows the document's pages, each drawn
  by the worker with who the link is for and the day it was made written across the
  whole page, again and again on the slant (so a part cut out still carries it), in any
  script, and once more below it. It never gives the file itself, by any route. It shows
  the first 30 pages (of a PDF, or of a scanner's many-page TIFF), and you are told when
  a document is longer. The recipient can keep pictures of the pages, each marked; no page
  can stop a screenshot, and the page says so. Word and Excel files, and
  [health records kept as they are](#health-records-from-a-patient-portal), are shared
  only with download: the vault cannot draw their pages. A link's pages are removed when
  it ends.
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

- **Email the link** (0.9.0): beside Copy the link, the vault can email a link to the person
  it is for, from the share sheet once it is made, or later from Sharing on a link you made
  (after confirming it's you). The email says who shared it and from which household, "a
  document" or "a collection of documents" — never its title — the link, when it stops
  working, and that a PIN or password will be given separately: never the PIN, the password
  or a code. It needs **`FDV_SMTP_URL`**, the same mail server that sends a link's code,
  never the household's own; without it, only Copy is offered. The limits are **3 emails a
  link** and **20 emails a person** in any 24 hours; there is no limit for the household as a
  whole. A message beside the link is plain text and may not name a website. A paused link
  is not emailed. The address is kept and shown only masked. Sharing says on each link and
  request where it was last emailed and by whom (_Emailed to j•••@e•••.com by Aisha_), to
  everyone who can see that link or request.

## Security checklist

A short list for whoever runs the vault. Each line links to where it is explained.

- **Reach it over HTTPS, not plain `http://` across a network.** On plain http every
  password and sign-in token crosses your Wi-Fi readable by anyone on it. Use
  [Tailscale](https://tailscale.com) with the internal Caddyfile, or the TLS overlay with a
  certificate Caddy issues itself (see [Reaching it from the rest of the
  house](#reaching-it-from-the-rest-of-the-house)), and set `FDV_BASE_URL` to that `https://`
  address. When `FDV_BASE_URL` is plain http to another machine (and not a Tailscale address
  or name, which Tailscale already encrypts), the API says so in its log as it starts.
- **Never forward `:8080` from your router to the internet.** If links must reach people
  outside the house, use the public-only site; if the whole vault must be on the internet,
  `Caddyfile.public` with HTTPS — and read those sections first. Prefer Tailscale.
- **Docker's published ports go round `ufw` and `firewalld`.** A firewall rule that blocks
  `:8080` does not stop Docker publishing it. On a VPS, or with a reverse proxy of your own on
  the same machine, keep the port to the machine itself, in `.env`:

  ```bash
  FDV_BIND=127.0.0.1
  ```

  (the TLS overlay does this for you). Unset, the port is published on every interface, IPv4
  and IPv6, as it always was. Or filter in the `DOCKER-USER` chain, which Docker leaves to
  you — for example, only your LAN may reach the vault through `eth0`, on your `FDV_PORT`,
  for IPv4 and for IPv6 (put your own LAN's ranges in; make the rules survive a reboot the
  way your distribution saves them):

  ```bash
  PORT=8080   # your FDV_PORT
  sudo iptables  -I DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport "$PORT" --ctdir ORIGINAL ! -s 192.168.1.0/24 -j DROP
  sudo ip6tables -I DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport "$PORT" --ctdir ORIGINAL ! -s fd00::/8 -j DROP
  ```

- **Pin `FDV_VERSION` and update monthly.** Read the [CHANGELOG](CHANGELOG.md), take a
  backup, change `FDV_VERSION`, then `docker compose pull && docker compose up -d` (see
  [Upgrading](#upgrading) and [Pinning a version](#pinning-a-version)); check the images'
  signatures first if you like ([Verifying the images](#verifying-the-images)). Keep the
  server's operating system and Docker updated too.
- **Run the restore drill monthly**: `docker compose exec worker sh scripts/restore-drill.sh`
  (see [Backups and recovery](#backups-and-recovery)).
- **Keep backups and the master key off the machine.** Turn on the off-site copy in Settings
  → Backups, and copy the files yourself. Keep `.env` (or the key file) somewhere else too —
  the master key in a password manager, say: without it no backup can be read.
- **Turn on two-step sign-in for everyone.** Owners must have it; for adults, turn on
  Settings → Privacy → **Two-step sign-in for adults** once they have set it up (see
  [Sign-in and sessions](#sign-in-and-sessions)).
- **Watch what the vault tells you.** Each person is told when a new device signs in to their
  account, when their password changes, and when sign-ins to their account keep failing (for
  an owner's account, the other owners are told too); owners are emailed when the off-site
  backup copy fails or has not gone for two days, when another owner lowers how many
  copies are kept there, and when the backups stop or the nightly check of the activity log
  fails. Settings → **Security & health** shows it all at a look — the last backup and its
  copy, the last restore drill, the activity log's check, and the day's failed sign-ins —
  each fine or saying where to fix it. Read **Activity** now and then. A mail
  server (Settings → Email, in and out) is what lets those emails reach you.

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

**A lost phone.** Sign it out from any other device — _Settings → Your account → Signed-in devices_ in
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

**Which versions work together.** The phone app needs a vault of **0.4.10 or later**;
an older one is told so in both version numbers, with the way to [upgrade](#upgrading).
The vault works with the app's **0.18.0 and later**, and says so to the app: an app older
than that is told, on whatever it asks, that it must be updated. It stays signed in and
keeps what it holds on the phone, and signing out still works. Within that range a newer vault adds to what it answers and never takes away
within the deprecation window (see [`docs/api-changelog.md`](docs/api-changelog.md)), so
an app that has not been updated keeps working, without what came after it. The app's 0.3.x adds **Send to my Inbox**
(a scan goes to your uploads, for the vault to read and you to accept on the web), which
needs a vault of **0.7.0 or later**; with an older vault, 0.3.x is as 0.2.3 was. The
uploader for computers (below) needs **0.8.0**.

## Sending scans from a computer

A scanner that saves to a folder on somebody's own Windows or Mac computer can send each
new scan straight into their uploads, with the **Family Documents Vault uploader**: a
small app that watches that folder. Nobody has to set up a network share on the server.
It needs a vault of **0.8.0 or later**.

**Pairing a computer.** Whoever scans — an owner, an adult or a teen; never a viewer or a
guest — opens _Settings → Your computers_ in the browser and chooses **Add a computer**.
The vault asks for their password again (unless they gave it in the last five minutes),
then shows a code like `KX7P-3M9Q-R4T` and the vault's address. They type both into the
uploader on the computer. The last three characters are a check of the address: the
uploader works them out from the address typed, and refuses to pair, before it sends
anything, when they differ — a mistyped address never gets the code. The code works
once, for 10 minutes; five wrong tries end it, a new code replaces the last, and closing
the dialog ends it. The person is emailed "A computer was added to your sign-in", with the
computer's name, what it runs and when, and it is in the activity log.

Set `FDV_DESKTOP_DOWNLOAD_URL` to where your family downloads the uploader, and the
pairing dialog links to it. Unset, it says to ask whoever runs the vault for it.

**What a computer's key can do.** Pairing gives the uploader a key of its own (the vault
keeps only its hash). That key does exactly one thing: it sends a file into its person's
own uploads — a batch a day, called "From _the computer's name_, _the date_" — where
they accept or discard it as any upload. A file sent twice is kept once. It is read and
proposed for like any other upload, and nobody else sees it until it is accepted: not
another adult, not an owner.

**What it cannot do.** It cannot open, list, search or download anything, sign in, or
change anything; every other part of the vault refuses it. A file is refused while its
person is locked, or waiting after a restore; when the day's batch is full (200 files)
or the computer has sent `FDV_DEVICE_DAILY_BYTES` that day (2 GB unless you change it);
and when it is too large or of a kind the vault does not keep — and the uploader says so.

**Removing one.** _Settings → Your computers_ lists each computer by name, with when it
was added and last sent something; **Remove** stops its key at once. Owners also see
every computer in the household, by name and person — never what one sent — and can
remove any. A computer is removed by itself when its person's sign-in is taken away or
they can no longer add documents (made a viewer); when they are signed out everywhere,
or an owner stops their password; and when their password is changed or reset — each
email says so. A restore removes every one too. Each person then pairs again.

## Connected apps

Another app — a money tracker, say — can send documents into the vault for
one person of the family, and ask what became of each. It needs a vault of **0.9.0 or
later**.

**What a connected app can do.** It acts as one owner or adult who signs in, and never
does more than that person could. It can send files of the kinds an owner allowed, which
go into that person's Inbox — or the Inbox of the person each is about (see _Whose Inbox_
below) — in a batch a day ("From Acme Money, 16 November 2026"), are read
and proposed for like any other upload, and wait there until the person files or removes
each. What it says about a file (whose it is, its kind, its dates, an amount) is only a
suggestion: where the vault reads the page differently, the card says both and waits for
the person. It can ask what became of what it sent — waiting, filed, refused or removed
— and take back a file that is still waiting.

**Whom it acts as.** An app acts **as itself** by default (from 0.9.0-dev.65): it is not
a person of the family and has no sign-in or hidden account, so it never shows up among
the family's people, counts or pickers, and the activity log names the app alone ("Acme
Money sent a file to Sara's Inbox", "Acme Money opened …", "Filed automatically from Acme
Money: …"). What it sends about a person goes to their Inbox (see _Whose Inbox_); anything
else goes to the Inbox of the person who **reviews** it (_Reviewed by_ in Settings: an owner
or an adult who signs in, at first the owner who connected it, who is told and asked
nothing more). If that person can't take it — locked, paused, no longer an adult, or gone —
such a send is refused for a moment (`503`, and the app tries again later) and the owners
are told once to choose somebody else; the app keeps working for everything else and is
not removed. A file it sent names the app, not a person, as who added it. It reads by its
grants and what it sent alone, never more than an app acting as an adult would. An owner
may still choose that it acts **as a person** — themselves, or another owner or adult, who
then turns it on themselves — and then everything below that says "the person it acts as"
holds as before. Apps connected before 0.9.0-dev.65 keep acting as their person. What an owner sets up ends
with them: when they leave, stop being an owner, or are signed out everywhere or stopped,
the apps acting as themselves they connected are removed and the API keys they generated
for such apps revoked, and the other owners are told.

**What it cannot do.** It cannot sign in, search, or change anything in the vault, and
it reads only what the next section says. It cannot send a kind it was not allowed (a
receipt, if you did not allow receipts), choose who sees what it sends beyond the app's
setting, or mark anything sensitive. Nobody else sees what it sent until the person
files it — not even an owner. Every other part of the vault refuses its requests.

**What a connected app can read.** Only if an owner allows it (_What it may do_ in
_Settings → Connected apps_: reading, and downloading, are each ticked separately; a new
app may only send unless you tick them). It reads the documents that what it sent became
(a paper of its own, for as long as it is in the vault, out of the Trash and not Only me
— whatever newer versions the family or another app added since; a family paper its file
was filed into as a new version is never its own), and those
its **read grants** cover: a kind (bank statements, say) or every kind of a
category (Bills & utilities), each for so many months back — 1 to 36 — counted on the
paper's date (its issue date, else its due date, else the day it was filed). For each it
is told the kind, title, dates, amount, who issued it, the account's last 4 digits, the
period, the tax year, the status and the current file's size and hash, as the vault has
them now; never whose it is, its notes, tags or number, where the paper is kept, or other
versions. It can download the current file (an attachment, never a page, counted against
1 GB a day unless an owner changes it; a file larger than that is taken in parts), and follow a feed of what changed since it last
asked, which says _unavailable_ — never why — for a document it may no longer read. It
**never** reads anything the person it acts as cannot see; anything Only me, even what it
sent; anything Essential or in the Trash; identity, legal, medical, education or pet
papers, whatever is granted (only Financial, Tax, Bills & utilities, Insurance, Work,
Property & vehicle and Other can be granted); or a paper somebody marked Sensitive. Kinds
that are Sensitive by default — statements, payslips, tax forms, loans — are read
through a grant only when the owner said yes to each of them; Settings asks, and asks
again for a kind that becomes Sensitive later or joins a granted category. A kind kept
as an Essential is never read through a grant.
The database keeps the same rule as the vault's own code: a request from an app is given
those documents and their current files, and nothing at all of any other table. Granting
more to an app that acts as somebody else waits for them to turn it on again, as any
widening does. Its reading is in the activity log: "Ahmed via Acme Money downloaded …", "…
read the details of …" (on the document's own Activity too), and "… looked up documents"
once an hour.

**Filing automatically.** An owner may switch on _File when everything is sure and
complete_ for an app. Then a file it sends is filed with nobody looking — as the person it
acts as, into their documents as Accept all Ready would file it, and Only me where their
own sensitive papers start so — but only when the vault read the pages itself and is sure
of the kind and of whose it is, and nothing the app said disagrees; the kind is one the
app may send, never identity, legal or medical, and never one kept as an Essential;
nothing the kind requires is missing; and it is not a near match or a renewal of a paper
already there, nor a copy of something here. A suggestion from the app alone is never
enough. Anything else waits in the Inbox as before. The app sees it as _filed_, and the
activity log says "Filed automatically from Acme Money: …" (a sensitive paper is never
named). Nothing on screen offers to undo it: the person changes it, or moves it to the
Trash, as any document. It stops at once when the app is paused or removed, and after a
restore. For moving older papers, it may be switched on for the
backfill allowance's window alone. Switching it on, for an app acting as somebody else,
waits for them to turn the app on again.

**Whose Inbox.** With _Send each paper to the Inbox of the person it's about_ on (the
default for an app connected from 0.9.0-dev.60; an app connected before keeps sending to
its person's Inbox until an owner switches it on), a file whose app names somebody — by
their id, or by a name that matches one person of the family, the whole name or a first
name only one person has — goes to **that person's** Inbox, when they are an owner or an
adult of the household who signs in and is not locked or paused. They review and file it
as their own, in a batch of their own ("From Acme Money, 16 November 2026"); filing
automatically, if on, files it as them by the same rule. Anything else goes to the Inbox of
the person the app acts as, as before: a file that names nobody, the household, a teen,
somebody without a sign-in, a guest, a name two people share or nobody has, and any paper
of a kind that usually belongs to the household (a utility bill). The app's daily limits
count everything it sends, whoever's Inbox. The app is never told whose Inbox a file went
to, and the activity log names it: "Ahmed via Acme Money sent a file to Sara's Inbox".
Switching it on, for an app acting as somebody else, waits for them to turn the app on
again.

**Downloading what it sent again.** An app allowed to download may always download again
the exact file it sent, by its own `external_id`, while that file is still in the vault —
even once it was filed into a family paper as a new version, or the family added a newer
file, and whether or not the app may read the document. Not while the document is in the
Trash or Only me, once it is removed for good, or once the family made it an identity,
legal or medical paper; not once the app let go of it. Its status says whether
(`content_available`), and each download counts against its daily download bytes and is in
the activity log, as its other downloads are.

**Opening a document from a connected app.** If an owner ticks _Show its user documents
it may read_ (with reading ticked too), the app can show its user a document it may read: it asks the vault
for a link at the moment the user clicks, and sends their browser straight to it. The link
works **once**, and only within **2 minutes**; opening it gives that browser **10
minutes** with the document, at the address it was opened from (a page reloaded from
another network is refused, and the user opens it again from the app). Opening it is one
deliberate click: the link's address is a small page, "Open the document", with an **Open**
button and nothing that opens it by itself — so a chat's preview of the link, or an email
scanner that opens it in a browser of its own, no longer uses it up. The browser is shown the pages the vault drew of the document, with "Opened through
Acme Money" across the top, on a page of its own (`/a`) — never the vault's own screens,
and never the file — and a light watermark across each page, "Opened through Acme Money ·
19 November 2026", drawn over the pages rather than into them. A
Word or Excel file has no pages to show. A download link, which saves the file instead,
needs _Download documents it is allowed_ ticked too, and every byte it gives counts against
the app's own downloads for the day: what the app may not download itself, its user may not
either (past it, the page says the download isn't available today). The vault asks again at every page
whether the app may still read the document: made Only me, moved to the Trash, the app
paused or removed, and the page ends. Each app may make 60 links an hour unless an owner
changes it (up to 600). The vault keeps only a hash of each link and of each browser's
session (its cookie is `__Secure-fdv_app_link`, sent to that page's own path alone), and
its logs cut the link out. Each opening is in the activity log, on the
document's own Activity too: "Ahmed via Acme Money opened …".

**Deleting.** If an owner ticks _Delete the documents it sent_, the app may delete a
document that a file it sent became (not a family paper its file was filed into as a new
version), while no newer file from the family has been added — never one it reads through
a grant, anything Only me, or anything else it may not read. An owner
chooses, for each app, what that does: **it lets go of it** (the default: the document
stays in the vault, and is no longer the app's), or **it moves it to the Trash**, as the
person it acts as would, where it can be restored for 30 days. Either way the app lets go
of it: taken out of the Trash, the document is the family's. The activity log says "Ahmed
via Acme Money let go of …; it is still in the vault" or "Ahmed via Acme Money moved … to the
Trash". A move to the Trash is also emailed to the document's person and every owner who
may see it ("Acme Money moved a document to the Trash"), naming the document only as the
family's neutral wording allows, and never a sensitive one; at most five such emails an app
a day, then one saying it moved more.

**Connecting one.** An owner opens _Settings → Connected apps → Connect an app_ and
confirms it is them with a passkey or an authenticator code — never the password alone,
so an owner must have two-step sign-in or a passkey. They name the app, choose whom it
acts as, and choose the kinds it may send, who sees what it sends (as each kind says,
adults only, everyone, or only that person), how much it may send a day, and optionally
the addresses it may come from (up to ten addresses, networks or host names).
The kinds are listed by category: ticking a category ticks all its kinds, and it shows
as partly ticked when only some are.
A host name (up to five, such as `feeds.example.com`) is checked against the addresses it
points to when a request comes, looked up again every few minutes; a name that cannot be
looked up lets nothing in. An app on a large cloud platform may call from addresses its
name doesn't list: give its published address ranges instead.
Then they **generate an API key** for it (see _API keys_ below) and give it to the app.
When the app acts as somebody else, it does nothing until that person turns it on in their own _Settings →
Connected apps_, again with a passkey or a code; they are emailed when it is connected.
When an owner later lets such an app do more — another kind, higher limits, more
addresses, a backfill, a wider audience, filing automatically, sending to the person a paper
is about — or generates it a key that may do more than its live keys (a new key that may
do the same or less, to replace one, asks nothing of them), it waits for that person to
turn it on again, and they are emailed. Letting it do less needs nothing from them.
Identity, legal and medical papers, and kinds kept as Essentials, are never among what
an app may send.

**Limits.** Each app may send 100 files and 500 MB a day unless an owner changes it, up
to `FDV_APP_DAILY_FILES` and `FDV_APP_DAILY_BYTES` (1,000 files and 5 GB unless you
change them); a day runs to midnight on the family's clock. For moving many older papers
at once, an owner can give a **backfill allowance**: higher daily limits until a date at
most 30 days ahead. Each app may make 120 requests a minute, besides the vault's limit
for each address.

**API keys.** An app proves who it is with an **API key the vault generates**: a
**client ID** (`fdvc_…`, which names the key and is no secret) and a **secret**
(`fdvs_…`, 32 random bytes). It sends both, as HTTP Basic authentication
(`Authorization: Basic base64(client_id:secret)`), to one route alone,
`POST /api/v1/apps/token`, and is given a **short-lived access token** for them (OAuth 2.0
client credentials); every other request carries that token, `Authorization: Bearer
fdvt_…` (see [The API, end to end](#the-api-end-to-end-for-an-integrator)). Only an owner
generates or revokes a key, in _Settings → Connected apps_, each time with a passkey or a
code. A key has:

- a name, if you want one ("Acme Money, live");
- **its own permissions**: some of what the app may do (send, read, download, show its
  user, delete). A request is held to the key's permissions and the app's, both, as they
  are when it arrives — narrowing the app narrows every key;
- **how long it lasts**: **90 days unless you choose otherwise** — 30, 90 or 365 days, any
  number of days from 1 to 3650, or never. _Never expires_ has to be chosen on purpose,
  and Settings warns that such a key works for years if it is ever copied.

**Access tokens.** A token lasts 15 minutes (`expires_in: 900`); the vault keeps only a
SHA-256 of it, never the token. It is bound to the key it was given for: it may do what
that key may do, and it stops working at once when the key is revoked or expires, or the
app is paused or removed. A key is given 10 tokens a minute at most, and an address may
try 60 times (an IPv6 address counted with the rest of its /64); the token route reads
only a form (`application/x-www-form-urlencoded`). An app keeps its token until it
nearly ends, and asks for another then, or when the vault answers `401
app_token_expired`. A token the vault never gave is `401 app_token_invalid`, and counts
as a guess, as a wrong secret does. **Basic on the other app routes still works for now,
and is deprecated**: each such answer carries a `Deprecation` header, and it will be
removed in a later 0.9.0 development build. Ask for a token and send it instead.

The vault shows the client ID and the secret **once**, with Copy buttons, and a
**connection string** to paste into the app (`fdvapp2.…`: the vault's address and the
client ID, and the secret too if you tick _Include the secret_). Each key that works
keeps its own _What to paste into …_ in Settings afterwards — the address and that key's
client ID, never the secret — with a Copy button. It keeps only a SHA-256
of the secret, so a lost secret cannot be shown again: generate a new key and revoke the
old one. An app has **two live keys at most** (not expired, not revoked), so it can move
to a new key without a gap; it can never add, renew or retire a key of its own. The
owners are emailed 14 days before a key expires (when it was made to last longer than
that) and again once it has, and both are in the activity log. Revoking a key takes
effect at its very next request, and ends what the key opened: a view or download link
it made, and a page opened from one. Settings lists the keys that work first, each with
its client ID, what it may do, when it was made, when it expires or "Never", and when it
was last used; revoked and expired keys are folded away below them, under _Revoked and
expired keys_. An app can ask the vault which key it is using, and when it
expires (`GET /api/v1/apps/me`), so it can warn its own users in time.

**Unusual use.** The owners are emailed, and the activity log says so, the first time a
key is used from a network it has never been used from (an IPv4 /24, or an IPv6 /64; not
for a key's very first network), and when an app's requests in a day go past five times
its usual day (the median of the week before) and past 200. Each at most once a key, or
an app, a day. If you didn't expect it, revoke the key and generate a new one. The vault
remembers 500 networks a key at most, and forgets one not seen for 90 days.

**Where it may call from.** An owner can list the addresses, networks or names an app
calls from (_Addresses it may send from_, on Connect and Change); left empty, any.
Settings recommends it while the list is empty: if the app always calls from fixed
addresses or a domain, list them, and a stolen key can't be used from anywhere else.

A request with a wrong secret, or a client ID the vault does not know, is refused alike
(`401 app_key_invalid`); an expired key is `401 app_key_expired`, a revoked one `401
app_key_revoked`. An address that sends more than 10 keys that do not work in a minute —
a client ID the vault does not know, or a wrong secret; an IPv6 address counted with the
rest of its /64 — waits for the minute to end (`429`); a right secret for a key that is
revoked or expired is never counted so. Requests must come over https; plain http is taken
only when `FDV_BASE_URL` is `http://localhost` and the request comes from that same
machine (a vault used on one machine). Neither the vault's log nor nginx's access log
keeps the `Authorization` header, the secret or a token.

**A login of your own in front of the vault.** If your proxy asks for a password of its
own (Caddy's `basicauth`, nginx's `auth_basic`), the vault leaves that `Authorization:
Basic` header alone: only one whose user is a client ID (`fdvc_…`) is taken for an app's
key.

Before 0.9.0-dev.63 an app signed each request with an Ed25519 key of its own (RFC 9421).
That is gone: an app connected that way stops working until an owner generates it an API
key, and its public keys were removed by the upgrade.

**Reaching it from the internet.** A connected app usually runs on the internet, and can
only reach the vault at an address on the internet: the public-only site (see [Links for
people outside the family](#links-for-people-outside-the-family)). It serves only the
pages a link opens until you set `FDV_PUBLIC_APPS=on` in `.env`, for the API and for the
`caddy-public` service; then it also serves the app routes (`/api/v1/apps/*`), the
vault's capability document (without the family's name), and the links an app makes for
its user's browser (`/api/v1/app-links/*` and the page `/a`), and nothing else. Every app
route still refuses a request without a connected app's API key, and the site
answers 404 to an address that hides a slash or a dot in its encoding. Settings warns while an app is connected and
`FDV_PUBLIC_APPS` is off. A vault reached only over Tailscale or the home network cannot
be connected to an app on the internet.

**Removing one.** _Settings → Connected apps_ lists each app with whom it acts as, what
it may do, its API keys, when it was last used, today's files and refused requests, and
how many of the files it sent wait for a look and were filed (every owner sees the app's
totals; its person, what came to their own Inbox — counts alone).
An owner can pause one, change what it may do, generate or revoke a key, and remove it
(which revokes every key it has); the person it acts
as can turn it on and remove it. A removed app's next request is refused; what it sent
stays in the Inbox for the person to decide, and what was filed stays in the vault. An app
is removed by itself when its person's sign-in is taken away or they can no longer act
for it (made a teen or a viewer), and when they are signed out everywhere or an owner
stops their password — not when they change their password. Everything an app does is in
the activity log, "Ahmed via Acme Money sent a file to their Inbox" (files sent within an
hour of each other are one line: "sent 12 files"). A restore pauses every app until an
owner turns each back on, and **revokes every API key** — one revoked since the backup
was made would otherwise work again — so an owner generates each app a new key and gives
it to the app; the restore's summary says so. An app reads its feed again from the start
after one; every link it made, and every page opened from one, ends.

**What is kept of what an app sent.** For a file the person removed, or the app took
back, the vault keeps its hash and size (never the file, its name or what the app said
of it) for 90 days, so the same file sent again is recognised and answered as already
decided. A file refused for its kind keeps only that it was refused. Both are then
forgotten.

### The API, end to end, for an integrator

Every route an app calls is under `/api/v1/`, over https to the address the connection
string gives (`$VAULT`).

0. **Get an access token** with your key, as OAuth 2.0 client credentials: the client ID
   and secret as HTTP Basic, the grant as a form. The answer is `{"access_token":
"fdvt_…", "token_type": "Bearer", "expires_in": 900, "scope": "documents.send …"}`;
   keep the token in memory, send it as `Authorization: Bearer $TOKEN` on every other
   request below, and ask for a new one shortly before it ends (or when a request is
   answered `401 app_token_expired`):

   ```sh
   TOKEN=$(curl -sS -u "$CLIENT_ID:$SECRET" -d grant_type=client_credentials \
     "$VAULT/api/v1/apps/token" | jq -r .access_token)
   ```

1. **Send a file, with your own `external_id`** — your idempotency key forever; sending
   it again with the same bytes is answered as before (`200`):

   ```sh
   curl -sS "$VAULT/api/v1/apps/intake" -H "Authorization: Bearer $TOKEN" \
     -F 'metadata={"external_id":"acme:doc-01","hints":{"kind":"bank_statement"}};type=application/json' \
     -F 'file=@statement.pdf;type=application/pdf'
   ```

2. **Check its state, and get the `document_id`** once the person (or automatic filing)
   has filed it: `waiting`, then `filed` with `document_id` and `version_id`:

   ```sh
   curl -sS "$VAULT/api/v1/apps/intake/acme:doc-01" -H "Authorization: Bearer $TOKEN"
   ```

3. **Fetch your exact file again, by your `external_id`** — the bytes you sent, whatever
   versions the family added since (needs _Download_):

   ```sh
   curl -sS -o mine.pdf "$VAULT/api/v1/apps/intake/acme:doc-01/content" -H "Authorization: Bearer $TOKEN"
   ```

4. **Fetch the document as it is now, by its `document_id`** — its details, and its
   current file (needs _Read_, and _Download_ for the file):

   ```sh
   curl -sS "$VAULT/api/v1/apps/documents/$DOCUMENT_ID" -H "Authorization: Bearer $TOKEN"
   curl -sS -o current.pdf "$VAULT/api/v1/apps/documents/$DOCUMENT_ID/content" -H "Authorization: Bearer $TOKEN"
   ```

5. **Make a view link for your user** (needs _Show its user documents_), and send their
   browser to its `url` at once. Don't fetch the `url` yourself: it is a page that opens
   nothing, and the browser opens the link from it (since 0.9.0-dev.68):

   ```sh
   curl -sS -X POST "$VAULT/api/v1/apps/documents/$DOCUMENT_ID/links" \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"mode":"view"}'
   ```

6. **Follow the changes feed**: without a cursor, everything you may read now; then only
   what changed since, `changed` (with the document as it is now) or `unavailable`
   (never why). Keep the `cursor` it answers for next time:

   ```sh
   curl -sS "$VAULT/api/v1/apps/changes?cursor=$CURSOR" -H "Authorization: Bearer $TOKEN"
   ```

`GET /api/v1/apps/me` is the connection test: what the app and this key may do, the key's
expiry, and the vault's version.

Sending the key itself as `Authorization: Basic` on these routes (as before
0.9.0-dev.72) still works for now and is **deprecated**: the answer carries a
`Deprecation` header, and it will be removed in a later 0.9.0 development build.

**API versioning.** Every route is under `/api/v1/`. `GET /api/v1/apps/me` gives the
vault's version (`vault.server_version`), and `GET /api/v1/capabilities` its capability
flags. [`docs/api-changelog.md`](docs/api-changelog.md) lists every change. During the
0.9.0 development builds a breaking change may still land inside `v1`, and is marked
**breaking** there (as API keys replacing request signing were, in 0.9.0-dev.63). From the
0.9.0 release on, a breaking change goes to a new path version (`/api/v2/…`), while `v1`
keeps working for a stated deprecation period of at least 6 months.

### The client library, for writing a connected app

The vault's own API client, [`packages/client`](packages/client/README.md) (`@fdv/client`,
MIT), makes a connected app's requests with its API key (`@fdv/client/apps`:
`createAppClient({ url, clientId, secret })`, and `parseConnectionString` for what
Settings gives) — it trades the key for an access token, keeps it in memory, asks for a
new one before it ends or when the vault says it has, and never logs it — and comes with
a fake vault to test against (`@fdv/client/testing`) that generates, revokes and expires
keys and tokens and answers as the vault does. It is not on
npmjs.com: every release attaches the client of that release to its
[GitHub release](https://github.com/mansoor/family-documents-vault/releases) as
`fdv-client-<version>.tgz`, and an app installs it by that URL, pinned to the version, with
npm or pnpm and no token (from CI too):

```json
{
  "dependencies": {
    "@fdv/client": "https://github.com/mansoor/family-documents-vault/releases/download/v0.9.0-dev.79/fdv-client-0.9.0-dev.79.tgz"
  }
}
```

It is ESM only, with TypeScript declarations (set `moduleResolution` to `node16`,
`nodenext` or `bundler`), and runs in Node 22 or later, browsers and React Native. It needs one package
from npm, `libphonenumber-js` (MIT), for the fake vault. The contract scenarios the fake and
the vault are both held to are their own entry, `@fdv/client/testing/contract`, which needs
`vitest` (5 or 6) in the app's own devDependencies; nothing else does, and the package
declares no dependency on it. The package's
[README](packages/client/README.md) shows a connected app's client and a test against the fake vault.
`pnpm client:pack` builds the same tarball from a checkout.

## Configuration

All configuration is through environment variables in `.env` (see [`.env.example`](.env.example)).

| Variable                                        | Default                                   | What it is                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FDV_MASTER_KEY`                                | generated                                 | The key that wraps every other key. **Back it up outside the server.** If it is lost, the documents are lost. The example file's placeholder, or a key too easy to guess, is refused at start (as are the example's `replace-me` database passwords).                                                     |
| `FDV_DB_PASSWORD`                               | generated                                 | Password for the database owner role (`fdv`). Given to [the migrate service](#the-migrate-service) and the worker (backups and restores), never to the API.                                                                                                                                               |
| `FDV_DB_APP_PASSWORD`                           | generated                                 | Password for the application role (`fdv_app`). The API queries as this role, which owns nothing, so row-level security is enforced on every query. The api and the worker check this as they start, and refuse to start if the role they connect as is a superuser, has `BYPASSRLS` or owns the tables.   |
| `FDV_SETUP_TOKEN`                               | generated                                 | The setup code first-run setup asks for, so that only somebody who can read this file becomes the owner. Unset (a `.env` from before 0.9.0), the API makes one each time it starts until the vault is set up, and writes it to its log. Not needed once set up.                                           |
| `FDV_MAX_UPLOAD_BYTES`                          | `104857600`                               | Largest single file the vault accepts (100 MB), uploaded, from the scanner folder or attached to an email.                                                                                                                                                                                                |
| `FDV_WATCH_DIR`                                 | unset                                     | A folder a scanner saves into, inside the worker: `/watch`, with the compose file's mount. Unset: none. See [Scanning straight into the vault](#scanning-straight-into-the-vault).                                                                                                                        |
| `FDV_WATCH_ROOTS`                               | `/watch`                                  | The folders mounted into the worker an owner may choose the scanner folder inside, comma-separated. `/`, or a folder holding the vault's own, is refused.                                                                                                                                                 |
| `FDV_WATCH_STABLE_SECONDS`                      | `10`                                      | How long a scan must stop changing before the worker takes it (2 to 3600); raise it for a slow scanner.                                                                                                                                                                                                   |
| `FDV_WATCH_INCOMPLETE_GRACE_SECONDS`            | `120`                                     | How long a scan that has stopped changing but looks unfinished waits before it is taken anyway (0 to 86400).                                                                                                                                                                                              |
| `FDV_MAIL_IN_HOST`                              | unset                                     | The household mailbox's IMAP server, e.g. `imap.gmail.com`. With `FDV_MAIL_IN_USER` and a password, email in can be turned on. See [Emailing documents to the vault](#emailing-documents-to-the-vault).                                                                                                   |
| `FDV_MAIL_IN_PORT`                              | `993`                                     | Its IMAP port: TLS from the first byte, the certificate verified.                                                                                                                                                                                                                                         |
| `FDV_MAIL_IN_USER`                              | unset                                     | The mailbox's sign-in, usually its address.                                                                                                                                                                                                                                                               |
| `FDV_MAIL_IN_PASSWORD`                          | unset                                     | Its app password; better, `FDV_MAIL_IN_PASSWORD_FILE`, a file holding it (a Docker secret). Worker only; never logged, shown or stored.                                                                                                                                                                   |
| `FDV_MAIL_IN_ADDRESS`                           | the user                                  | The address the family sends to, shown on Add, when `FDV_MAIL_IN_USER` isn't one.                                                                                                                                                                                                                         |
| `FDV_MAIL_IN_FOLDER`                            | `INBOX`                                   | The folder checked.                                                                                                                                                                                                                                                                                       |
| `FDV_MAIL_IN_POLL_SECONDS`                      | `300`                                     | How often the mailbox is checked (30 to 86400).                                                                                                                                                                                                                                                           |
| `FDV_MAIL_IN_AFTER`                             | `move`                                    | What happens to an email once its attachments are in: `move` to a `Filed` folder, or `delete`.                                                                                                                                                                                                            |
| `FDV_MAIL_IN_AUTHSERV_ID`                       | unset                                     | Your provider's `Authentication-Results` name (`mx.google.com` for Gmail): set, only mail it vouched for is taken, and an address may be confirmed from itself. Unset, items say "sender not verified".                                                                                                   |
| `FDV_MAIL_IN_ALLOWED_PORTS`                     | `993`                                     | The ports a mailbox set up in Settings may be on, comma-separated. `FDV_MAIL_IN_PORT` is yours, and not limited.                                                                                                                                                                                          |
| `FDV_MAIL_IN_ALLOW_PRIVATE`                     | `false`                                   | `true` lets a mailbox set up in Settings be at an address inside your own network (a mail server on the LAN). Off, the worker never connects to one for a household.                                                                                                                                      |
| `FDV_LOCAL_AI_URL`                              | unset                                     | An Ollama-compatible model on your own server or network, e.g. `http://ollama:11434`: `http://` or `https://`, no user or password in it. Worker only. Unset: no local AI. See [A local AI reader](#a-local-ai-reader).                                                                                   |
| `FDV_LOCAL_AI_MODEL`                            | unset                                     | The model it asks for, pulled there first, e.g. `qwen2.5:3b-instruct`. Needed with `FDV_LOCAL_AI_URL`.                                                                                                                                                                                                    |
| `FDV_LOCAL_AI_TIMEOUT_SECONDS`                  | `120`                                     | How long it may take over one paper before the paper is read without it (5 to 300).                                                                                                                                                                                                                       |
| `FDV_AI_READER_ALLOWED_PORTS`                   | `11434,1234,8000,8080,80,443`             | The ports an AI reader set in Settings may be on, comma-separated. Any other is refused, so its Test is no port scanner. `FDV_LOCAL_AI_URL` is yours, and not limited; Anthropic's fixed address is always 443. API and worker.                                                                           |
| `FDV_SMS_GATE_ALLOWED_PORTS`                    | `8080,80,443,8000,8443,8888`              | The ports SMS Gate's local server set in Settings may be on, comma-separated. Any other is refused, so its test is no port scanner of your network. Add the one your SMS Gate app uses if it isn't 8080, keeping the rest. API and worker.                                                                |
| `FDV_AI_READER_SETTINGS`                        | `on`                                      | `off` keeps the AI reader out of Settings: only `FDV_LOCAL_AI_URL` sets one. API and worker. See [A local AI reader](#a-local-ai-reader).                                                                                                                                                                 |
| `FDV_OFFLINE_MAX_DAYS`                          | `90`                                      | How many days a phone may show the Essentials it keeps without reaching the vault (1 to 365). See [Essentials on a phone](#essentials-on-a-phone).                                                                                                                                                        |
| `FDV_RATE_LIMIT_PER_MINUTE`                     | `300`                                     | How many requests one address may make in a minute, beyond the tighter limits on signing in and opening links (60 to 100000). Raise it when many devices share one address.                                                                                                                               |
| `FDV_DISPLAY_NAME`                              | `Our family vault`                        | The vault's name until it is set up. From then on every screen, and the phone app, shows the family's name, given at setup.                                                                                                                                                                               |
| `FDV_PORT`                                      | `8080`                                    | The port the web app listens on.                                                                                                                                                                                                                                                                          |
| `FDV_BIND`                                      | every interface                           | The address that port is published on. Unset, every interface, IPv4 and IPv6, so the house reaches it. `127.0.0.1` keeps it to this machine — a VPS, or a reverse proxy of your own: Docker's published ports go round `ufw` and `firewalld`. See [Security checklist](#security-checklist).              |
| `FDV_BACKUP_LATE_DAYS`                          | `2`                                       | How many days without a backup before Settings → Security & health says it is late and the owners are emailed (once, until a backup is made). Two assumes nightly backups: raise it if `FDV_BACKUP_CRON` backs up less often. API and worker (the compose file gives both).                               |
| `FDV_BACKUP_OFFSITE_LATE_DAYS`                  | `2`                                       | How many days without an off-site copy of the backups, while it is on, before the owners are told. Two assumes nightly backups: raise it if `FDV_BACKUP_CRON` backs up less often. API and worker (the compose file gives both). See [An off-site copy of the backups](#an-off-site-copy-of-the-backups). |
| `LOG_LEVEL`                                     | `info`                                    | `fatal`, `error`, `warn`, `info`, `debug` or `trace`.                                                                                                                                                                                                                                                     |
| `FDV_VERSION`                                   | `latest`                                  | Image tag to run. Pin it to a release once you are past testing.                                                                                                                                                                                                                                          |
| `FDV_HOSTNAME`                                  | `vault.local`                             | The name devices use, when the TLS overlay is running.                                                                                                                                                                                                                                                    |
| `FDV_BASE_URL`                                  | `http://localhost:8080`                   | What reminder emails and notifications link back to. Set it to the `https://` address once you have one.                                                                                                                                                                                                  |
| `FDV_CADDYFILE`                                 | internal                                  | Which TLS setup to use: `./docker/caddy/Caddyfile.internal` or `./docker/caddy/Caddyfile.public`.                                                                                                                                                                                                         |
| `FDV_PUBLIC_URL`                                | unset                                     | The public-only site's `https://` address, which share links start with. See [Links for people outside the family](#links-for-people-outside-the-family).                                                                                                                                                 |
| `FDV_SHARE_MAX_DAYS`                            | `90`                                      | The longest a share link may last, in days (1 to 90). A link always ends; this only shortens the longest end the vault accepts.                                                                                                                                                                           |
| `FDV_DESKTOP_DOWNLOAD_URL`                      | unset                                     | Where your family downloads the uploader app that sends scans from a computer. See [Sending scans from a computer](#sending-scans-from-a-computer).                                                                                                                                                       |
| `FDV_DEVICE_DAILY_BYTES`                        | `2147483648`                              | The most one paired computer may send in a day, in bytes (2 GB). Past it, its files are refused until the next day.                                                                                                                                                                                       |
| `FDV_PUBLIC_APPS`                               | `off`                                     | `on` serves the connected apps' routes on the public-only site too, so an app on the internet can reach the vault. Give it to `caddy-public` as well. See [Connected apps](#connected-apps).                                                                                                              |
| `FDV_APPS_LOCAL_HTTP`                           | `off`                                     | Development only. `on` lets connected apps call over plain http when `FDV_BASE_URL` is `http://localhost` (or `127.0.0.1`, `[::1]`); ignored for any other base URL. Never on a vault other machines can reach.                                                                                           |
| `FDV_APP_DAILY_FILES`                           | `1000`                                    | The most files an owner may let one connected app send in a day. Each app starts at 100.                                                                                                                                                                                                                  |
| `FDV_APP_DAILY_BYTES`                           | `5368709120`                              | The most bytes an owner may let one connected app send in a day (5 GB). Each app starts at 500 MB.                                                                                                                                                                                                        |
| `FDV_PUBLIC_HOSTNAME`                           | unset                                     | The public-only site's name, for its certificate (profile `public-only`).                                                                                                                                                                                                                                 |
| `FDV_PUBLIC_HTTPS_PORT`                         | `8443`                                    | The port the public-only site listens on for `https://`; forward the router's 443 to it.                                                                                                                                                                                                                  |
| `FDV_PUBLIC_HTTP_PORT`                          | `8081`                                    | The port it listens on for `http://` (certificates, and the redirect); forward the router's 80 to it.                                                                                                                                                                                                     |
| `FDV_TRUST_PROXY`                               | `network`                                 | Whose `X-Forwarded-For` to believe: `network` (the API's own network: nginx and Caddy, never your LAN), `private` (any private address), `all` or `none`. See [Who is asking](#who-is-asking).                                                                                                            |
| `FDV_SMTP_URL`                                  | unset                                     | Your own mail server for password-reset links, the codes a share link can ask for, and emailing a share link to its recipient, e.g. `smtps://user:app-password@smtp.fastmail.com:465`. Set it on the API and the worker. See [Passwords](#passwords).                                                     |
| `FDV_SMTP_FROM`                                 | `Family Document Vault <vault@localhost>` | Who those emails come from.                                                                                                                                                                                                                                                                               |
| `FDV_PUSH_ALLOW_PRIVATE_ENDPOINTS`              | `false`                                   | Let notifications go to addresses inside your own network — a UnifiedPush distributor (ntfy) on your LAN. Set it on both the API and the worker. See [Notifications on the phone app](#notifications-on-the-phone-app).                                                                                   |
| `FDV_RP_ID`                                     | the host of `FDV_BASE_URL`                | The domain passkeys belong to. Leave it unset unless the vault is served from a subdomain of a name the passkeys should work across.                                                                                                                                                                      |
| `FDV_TLS_EMAIL`                                 | unset                                     | Your address for Let's Encrypt, with `Caddyfile.public` or the public-only site.                                                                                                                                                                                                                          |
| `FDV_HTTPS_PORT`                                | `443`                                     | The port the TLS overlay's Caddy listens on for `https://`.                                                                                                                                                                                                                                               |
| `FDV_HTTP_PORT`                                 | `80`                                      | The port it listens on for `http://` (certificates, and the redirect to `https://`).                                                                                                                                                                                                                      |
| `FDV_OCR_MAX_PAGES`                             | `20`                                      | How many pages of a PDF or a scanner's TIFF are read (1 to 200): by the PDF's own text, and by OCR only where a page is a scan. The rest of a longer file is kept, but its words are not searched or suggested from.                                                                                      |
| `FDV_TIMEZONE`                                  | `UTC`                                     | The family's time zone until an owner chooses one in Settings: an IANA name, such as `Europe/London`. Set it on the API and the worker. See [The family's time zone](#the-familys-time-zone).                                                                                                             |
| `FDV_DIGEST_HOUR`                               | `9`                                       | The household's local hour for the day's reminders (0 to 23).                                                                                                                                                                                                                                             |
| `FDV_WEEKLY_HOUR`                               | `18`                                      | The local hour on Sunday for the weekly email summary (0 to 23).                                                                                                                                                                                                                                          |
| `FDV_BACKUP_CRON`                               | `30 2 * * *`                              | When the worker writes the nightly encrypted database backup (cron, in UTC).                                                                                                                                                                                                                              |
| `FDV_BACKUP_RETAIN_DAYS`                        | `30`                                      | How many days of backups are kept in `/data/backups` (1 to 365). Give the API the same (the compose file does): a sensitive document's delete confirmation names it.                                                                                                                                      |
| `FDV_VAPID_PUBLIC_KEY`, `FDV_VAPID_PRIVATE_KEY` | generated                                 | The keys notifications are signed with. `gen-env` makes them; changing them silences every device until it turns notifications on again.                                                                                                                                                                  |
| `FDV_VAPID_SUBJECT`                             | `mailto:vault@example.invalid`            | The contact push services are given for those keys.                                                                                                                                                                                                                                                       |

`FDV_MASTER_KEY_FILE` names a file holding the master key, read in place of
`FDV_MASTER_KEY`: see [Keeping the master key in a file](#keeping-the-master-key-in-a-file).

Two more are read by the API and worker images, but `docker-compose.yml` does not pass
them from `.env`, so setting them there changes nothing: they are for running the images
some other way. `FDV_RUN_MIGRATIONS` says whether the API's own start migrates the
database: unset, it does when it is given `DATABASE_ADMIN_URL` (the owning role) and
otherwise leaves it to [the migrate service](#the-migrate-service), refusing to start on a
database with migrations still to run. `FDV_LOCAL_VAULT_DIR` (default `/data/vault`) is where the
built-in local vault keeps encrypted files inside the containers, which is the
`fdv_vault-data` volume. To keep the files on another disk, mount a volume or a folder of
your own at `/data` for both `api` and `worker`, in a compose file of your own (an
override file is enough); the backups in `/data/backups` move with it. On a vault that
already holds documents, first stop it (`docker compose stop api worker`), copy what is in
the volume into the new folder, and give it to the containers' user (uid 1000), or every
document already filed stops opening and new uploads and backups fail:

```bash
docker run --rm -v fdv_vault-data:/from:ro -v /mnt/big/fdv:/to alpine sh -c "cp -a /from/. /to/ && chown -R 1000:1000 /to"
```

Then add the override and start it again (`docker compose up -d`).

Two more are read by the images and are not passed by `docker-compose.yml` either, and
need no setting: `FDV_BACKUP_DIR` (default `/data/backups`), where the worker writes the
nightly backups and where `restore-backup latest` looks; and `FDV_MIGRATIONS_DIR` (`/app/migrations`, set by the images themselves), where the
database's migrations are read from. `FDV_EDITION` (default `self_hosted`), which the API
reports to apps, should stay as it is on your own server; the compose file gives it to the
API **and the worker**, which both need it: on the hosted edition a reader set in Settings
is reached only over https at a public address, checked as it is saved and again at every
connection (a reader saved there keeps that rule even on a worker started without it). `FDV_DB_PORT` (default `5432`) is for development
only: the port `docker-compose.dev.yml` opens the database on (see
[Developing](#developing)).

Health endpoints, for your monitoring: `/healthz` (the API process is up) and `/readyz` (it can reach the database). `/readyz` never says why it could not: that is in the API's log.

### Hardened containers

Every container `docker-compose.yml` and `docker-compose.tls.yml` start is locked down:
no Linux capabilities (Caddy keeps one, to listen on ports 80 and 443), nothing gained
through setuid programs (`no-new-privileges`), a read-only root filesystem, and a ceiling
on processes and memory. What each may write to:

| Container        | Writable                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `api`, `migrate` | `/data` (the `vault-data` volume; `api` only) and a small `/tmp` in memory                       |
| `worker`         | `/data` (files and backups), and `/tmp`, its own `worker-tmp` volume on disk (exports are large) |
| `web` (nginx)    | a small `/tmp` in memory. It runs as nginx's own user, listening on 8080 inside the container    |
| `caddy`          | its two volumes (certificates and the local CA), and a small `/tmp` in memory                    |
| `postgres`       | its data volume; only `no-new-privileges` is added, as its own start needs the rest              |

The ceilings are generous, and each can be raised in `.env`:

| Variable                                                            | Default                | What it limits                                                                              |
| ------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| `FDV_WORKER_MEM_LIMIT`, `FDV_API_MEM_LIMIT`                         | `3g`, `1g`             | Memory for the worker (which reads and draws every upload) and the API.                     |
| `FDV_WEB_MEM_LIMIT`, `FDV_CADDY_MEM_LIMIT`, `FDV_MIGRATE_MEM_LIMIT` | `256m`, `256m`, `512m` | Memory for nginx, Caddy and the migrate service.                                            |
| `FDV_WORKER_PIDS_LIMIT`, `FDV_API_PIDS_LIMIT`                       | `512`, `256`           | Processes and threads, for the worker and the API.                                          |
| `FDV_WEB_PIDS_LIMIT`, `FDV_CADDY_PIDS_LIMIT`                        | `256`, `256`           | The same, for nginx and Caddy.                                                              |
| `FDV_WORKER_CPUS`, `FDV_API_CPUS`, `FDV_WEB_CPUS`, `FDV_CADDY_CPUS` | `0` (no cap)           | CPUs each may use, such as `1.5`. Docker refuses more than the machine has, so none is set. |

The worker is the one most likely to need more: it has 3 GB unless you say otherwise, and
reading a long scan, drawing a very large photo or building an export of everything can
use much of it at once. If the worker keeps restarting while such jobs run, or a container
stops with `Exited (137)` or `OOMKilled` in `docker compose ps -a` or `docker inspect`,
raise its memory, say `FDV_WORKER_MEM_LIMIT=4g` in `.env`, and run `docker compose up -d`. Caddy runs as root inside its container, as its image does, and
reads the Caddyfile you mount without being able to override file permissions: keep the
Caddyfile readable by everyone (`chmod 644`), as it is when checked out. nginx listens on
`8080` inside its container, which the compose files use, and still on `80`, so a compose
override or Caddyfile of your own from before keeps working.

### The migrate service

`docker compose up -d` first runs `migrate`, a one-shot container from the api image: it
applies the database migrations and the job queue's schema as the role that owns the
tables (`FDV_DB_PASSWORD`), checks that the master key opens the vault, and exits. The
api and the worker start only once it has finished without an error, so neither starts on
the wrong key or a half-upgraded database. The API itself is never given the owning role's
password: it runs on the application role alone, which row-level security holds to each
household. The worker keeps the owning role, because the nightly backup must read every
household and a restore recreates the tables.

`docker compose ps -a` shows it as `Exited (0)` once it is done; that is how it should
look. If the api and the worker do not start, `docker compose logs migrate` says why (a
wrong master key, say, with what to do). Nothing in `.env` changes for it. As it passes,
it records which key opened the vault (an HMAC of a key derived from it, never the key),
and the API, which cannot open every household's keys itself, refuses to start on any
other.

**If you start services one at a time with `--no-deps`** (an upgrade script such as
`docker compose up -d --no-deps api`, say), nothing runs `migrate` for you: run it first,

```bash
docker compose run --rm --no-deps migrate
```

then start the rest. Otherwise the api and the worker refuse to start on a database with
this release's migrations still to run, and say this same command. `docker compose up -d
--wait` waits for `migrate` to finish, not to keep running, from Docker Compose 2.7.0 (the
TLS overlay needs 2.24.4 or later in any case).

### Keeping the master key in a file

By default the master key is in `.env` as `FDV_MASTER_KEY`, and so in the environment of
the containers that use it, where `docker inspect` can read it. The recommended way is to
keep it in a file instead, given to the migrate service, the api and the worker as a
Docker secret (`FDV_MASTER_KEY_FILE=/run/secrets/fdv_master_key`, which
[`docker-compose.secrets.yml`](docker-compose.secrets.yml) sets). Move the **same** key,
never a new one (for a new key, see [Rotating the master key](#rotating-the-master-key)):

```bash
mkdir -p secrets
grep '^FDV_MASTER_KEY=' .env | cut -d= -f2- | tr -d '\r\n' > secrets/fdv_master_key
sudo chown 1000:1000 secrets/fdv_master_key && chmod 400 secrets/fdv_master_key
echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.secrets.yml' >> .env
docker compose up -d
```

`COMPOSE_FILE` makes every plain `docker compose` command use both files (add
`:docker-compose.tls.yml` too if you use HTTPS; on Windows separate them with `;`); a
command that names its files with `-f` must name `docker-compose.secrets.yml` as well. Once
the vault has started, remove the `FDV_MASTER_KEY=` line from `.env` and run
`docker compose up -d` again. While both are set they must hold the same key: two
different keys are refused at start, never one quietly preferred. Back up the file
outside the server, as you did `.env`; it, not `.env`, is now what makes the documents
readable. `secrets/` is ignored by git and never enters an image. Set
`FDV_MASTER_KEY_SECRET` in `.env` to keep the file somewhere else.

### The family's time zone

Every time the vault shows — when something happened, when a link ends, "edited 9:14" —
is on one clock, the family's, for everyone, whatever zone their own browser or phone is
in. Reminders and digests arrive at their hour on it (`FDV_DIGEST_HOUR`,
`FDV_WEEKLY_HOUR`). Somebody whose browser is in another zone sees the zone after each
time ("5:25pm BST", or "GMT+5:30" where a zone has no short name), so nobody travelling
is misled; emails and notes read outside the app always name it. A date without a time —
an expiry, a birthday, the day a reminder falls due — is the same day everywhere, and
never moves.

Which zone that is: the one an owner chooses in **Settings → Time zone** (any IANA name,
found by city or offset, or this browser's own in one click); until an owner chooses one,
the server's default, `FDV_TIMEZONE`; and UTC when neither is set. Set the default in
`.env`, for the API and the worker alike:

```bash
FDV_TIMEZONE=Europe/London
```

A name that is not a time zone stops both at start, saying so, and so does an
abbreviation or an offset (`EST`, `+05:30`): give a region and a place. A name is kept as
the server spells it (`europe/london` is `Europe/London`). An owner can go back to
the server's default from the same page, and everyone else reads the zone there. Changing
it moves nothing stored: a link that ends at a moment still ends then, only said on the
new clock; the next digest goes at the household hour on it. A change made over a
weekend can skip that week's Sunday summary, when the new zone's Sunday evening has
already passed. The change is in the activity log. Apps can read and set it too: `GET` and `PUT /api/v1/household/timezone`
(`{"timezone": "Europe/London"}`, or `null` for the server's default), an owner's to
change; `PUT /api/v1/profile` with `timezone` still works. There is no per-person zone.

Before 0.9.0 every household was on UTC unless an owner had set a zone through the API.
Upgrading keeps any zone an owner set; a household that never set one follows
`FDV_TIMEZONE` from then on. A household whose owner chose UTC itself (the activity log
says so) keeps UTC, and does **not** follow an `FDV_TIMEZONE` you set later: an owner
there moves it with "Use the server's default" in Settings → Time zone.

### Sign-in and sessions

- **Two-step sign-in** — a code from an authenticator app (Google Authenticator, Authy, 1Password…), or a passkey — is set up in Settings → Your account. With an authenticator app, sign-in then asks for the six-digit code after the password.
- **Owners must have it.** An owner who signs in with a password and has neither an authenticator app nor a passkey can only set one up, or sign out: the vault answers every other request `403 two_step_setup_required` until one is set up, and then the same sign-in goes on. The first owner sets it up as part of first-run setup.
- **A password alone never opens it for them.** Once they have a passkey or an authenticator app, sign-in asks for it after the password — **Use your passkey**, or the code — and a sign-in that has not given it can only confirm it's them with one, or sign out. Adding or removing a passkey or an authenticator app, or setting a new password by confirming it's you, takes a passkey or a code too, never the password. A code by text never counts.
- Phone app before 0.20.0: an owner without two-step must set it up in a browser.
- **Adults too, where the household asks it.** Settings → Privacy → **Two-step sign-in for adults**, an owner's to change (with a passkey or a code): on, every adult is held to it as owners are. It is **on for every household made with 0.9.0 or later**, and **off for households made before**, so that nobody who signs in with a password alone today is stopped without warning after an upgrade: an owner there turns it on once the adults have set it up. A code by text never counts as two-step sign-in for this: it is not available to owners, and lets the person in with the password alone when texts cannot be sent.
- **Passkeys ask for your PIN, fingerprint or face** every time they are used, and when they are made. A passkey on a phone or a computer always does; a security key needs a PIN set on it. **After upgrading, a passkey-only owner signs in with the passkey; a security key without a PIN needs one set, or the owner reset.** Every passkey counts as two-step sign-in, one added before 0.9.0 included, and is asked for a PIN or a fingerprint as it is used: one on a security key with no PIN cannot give one, and does not sign in or confirm it's you until a PIN is set on the key. An owner with no other way in is given one by a password reset from another owner, or the operator's.
- **Exporting everything**, and connecting an app, take a passkey or a code from an authenticator app, never the password alone: somebody with neither is asked to set up two-step sign-in first.
- Passwords are hashed with Argon2id. Sign-in answers with a 15-minute access token and a refresh token that rotates on every use.
- **A session lasts 30 days from when it was last used, and 180 days at most** from the sign-in: a device used every week stays signed in for half a year, then asks once for the password. This is the same for browsers and the phone app.
- A refresh token presented twice is treated as stolen and that device is signed out — with one exception, for answers that never arrive (a phone on a network that loses them, a browser page reloaded while it was refreshing): the token just replaced may be presented once more, within 30 seconds, by the same client — the same app installation, or the same browser from the same address. Anyone else presenting it, or presenting it later, ends the session. Every refresh token names the session it belongs to, so this holds for any token the vault ever gave that session, however many refreshes ago: somebody who copied a token and used it, and its successor, before you did is caught when yours comes in, and you are when theirs does. (A device that still holds a token from before this kind is given one of the new kind at its next refresh, and the vault remembers the old token from then on, however many refreshes later; tokens it had replaced before the upgrade are remembered only as before.)
- **Sign out everywhere.** An owner can sign somebody out of every device at once from their page (**People → their name → Account**), with a passkey or a code from an authenticator app — for a lost phone, or a password somebody else knows. Another owner too, who is told by email; anybody it is about is emailed. Their sign-in stays as it was: they sign in again with their own password. To keep them out, lock their sign-in instead.
- When a session ends, the app is told why — it expired, it was signed out, its token was used twice, or the person was taken out of the household — so it can say so in plain words.
- Every signed-in device is listed in **Settings → Your account → Signed-in devices**; any of them can be signed out from another, and **Sign out my other devices** signs out every one but the one you are using, once you have confirmed it's you (asked first, as anything that cannot be undone is).
- **In a browser, the refresh token is never where the page's scripts can read it.** It is an `HttpOnly` cookie, `SameSite=Strict`, sent back only to `/api/v1/auth`; the page keeps only the 15-minute access token, in memory, and renews it with the cookie when it loads. The cookie is `Secure` whenever the vault was reached over **https** — as the proxy in front of it says, believed only from the vault's own network (`FDV_TRUST_PROXY`) — so once given over https it never travels over plain http. Over plain http on the home network (port 8080) a browser would not keep a `Secure` cookie, so there it is not; another reason to [put the vault behind https](#reaching-it-from-the-rest-of-the-house). A browser still signed in from before 0.9.0 spends the token it kept, once, for the cookie, and forgets it. The phone app, and any other client, keeps its refresh token as before.
- **A code from an authenticator app works once.** A code already given, or one from before it, is refused at signing in, at confirming it's you and at setting the app up: a code seen over your shoulder, or passed on by a copy of the sign-in page, does not work a second time. Wait for the next one.
- The token signing key is derived from `FDV_MASTER_KEY`. [Rotating the master key](#rotating-the-master-key) signs everyone out.
- Sign-in attempts are limited to 10 per minute per address, and **five failures on one account make signing in to it from an unknown device wait**: a minute, then five, then fifteen — never longer — whichever addresses they come from. Devices that have signed in before are counted on their own. See [Security events](#security-events).

### Inviting the rest of the family

Everybody in the household is a **member** — including a child or an elderly
parent who never signs in and simply has documents. Giving someone a sign-in
is a separate step, on the People screen:

1. An adult chooses **Invite someone to sign in**, says whether they are
   family, and under **Who is it for?** picks someone of the family who does
   not sign in yet, or Someone new; then gives an email address (which becomes
   their sign-in) and a role. Two other ways in: tick **Invite them to sign up
   now** as you **Add someone** aged 13 or over, or press **Invite to sign up**
   on their page (People → their name).
2. The vault produces a **link** and an eight-character **code**, and shows
   them once. Send them separately — the link in a message, the code by phone
   or in person. Anyone holding both can sign in as that person.
3. They open the link, which tells them whose vault it is, who invited them
   and what they will be able to do, then type the code and choose their own
   password. That password also unlocks their own _Only me_ documents, so the
   vault cannot reset it for them.

**Age decides the role**, by the date of birth on their page: nobody under 13
is given a sign-in; from 13 to 17 only as a Teen; from 18 any role but Teen.
With no date of birth, any role you may hand out. When a child of the family
turns 13, the owners see "Sara is 13 today" on Home, with **Invite Sara to
sign up** and **Dismiss**, and the day's email says only that someone can now
have their own sign-in. Only an owner can change the date of birth of a child
under 13 who does not sign in.

The invitation lasts seven days and can be cancelled at any time. Five wrong
codes and it stops working, and a new one can then be made. Nothing is
emailed — the vault does not need a mail server to bring somebody in, and you
pass the invitation on yourself.

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

Changing somebody's role says first what else it changes, and does it on
every device they use. Made a teen or a viewer (or anybody made a viewer),
their phone stops keeping Essentials: it removes them at its next sync, and
keeping them again asks for their password. No longer an adult, their
requests to send documents close, and files sent for them alone to look at go
to the owners; their exports stop working. The activity log says so, to the
owners and to them.

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

**Changing one** is in Settings → Your account. Your password is not only a way in: it also
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
docker compose exec api node apps/api/dist/cli.mjs reset-password 'someone@example.com'
```

It prints a one-time link to hand over directly.

**An owner can start a reset for somebody else.** From a person's page (Account
→ Send a password reset) an owner — with two-step sign-in or a passkey, never
for another owner, never for somebody locked — starts one, and the vault says
which way it goes:

- with **`FDV_SMTP_URL`** set, the link goes to that person's own address, as
  above, and no owner sees it;
- without it, **the owner is given a one-time link that sets the person's
  password**, to hand over — offered only while the person keeps nothing
  private: no Only me documents, collections or identity details (in the Trash
  or deleted too), no request to send documents that only they review, no
  export. Whoever spends that link chooses the password and can sign in with
  it, so it is a working way in for as long as the person keeps that password.
  It stops working if they gain anything private before it is used. The person
  is told, on the web, the next time they sign in (until they say they have
  seen it), and should then set a password of their own: every change of the
  password after a link like this removes each passkey and two-step sign-in
  added since it was used, and ends each share link made as them since, and
  the notice lists any there are;
- for anybody else, a teen with private documents included, it is the command
  line above.

"Stop their current password now", offered only where a link can reach the
person, signs them out everywhere and stops their password; they choose a new
one through the link. A passkey of theirs still signs them in until then — lock
their sign-in to keep them out. Taking somebody's private documents by resetting
their password would be the one thing the privacy wall exists to prevent, so the
only route that works whatever they keep belongs to whoever holds the master key
— who can already read everything.

### Seeing what has happened

**Activity** (What has been happening) is the household's activity log, written
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

**Activity** on a document's page shows the same log for that one document:
the lines about it, and about its links outside the family — its own links and
links to a collection it was in, removed ones included. They are exactly the
lines the whole log shows you about it, so a link's lines are still only for
whoever is told of the link. A collection's link counts only while it gave the
document: from when the link was made with it ticked, or when it followed it in,
until it was left out of the link (as it was made sensitive) or taken out of the
collection. When making a document Only me or Adults only ends a collection's
link for it, the log says only how many links ended, not which, so that link's
own lines aren't shown for the document; what was downloaded or looked at of the
document through it still is. A chip at the top names the document; its **×**
shows the whole log again.

**Download CSV**, beside Print, saves the lines the page's filters keep — who,
what happened, which days, and the document of its chip — as a spreadsheet:
every such line the log shows you, not only those loaded, newest first, in the
same words, with when (on the family's clock, and in UTC), who, what sort of
thing and the document each is about (a sensitive one "a sensitive document").
It holds at most 50,000 lines, and reads at most a minute's worth of the log;
past that, the newest, and the page and the file's last row say so. Downloading it is a line in the log itself. The file
opens in a spreadsheet as it is (UTF-8), and no cell of it is ever read as a
formula.

### Reading a document

A document's page shows its pages beside its details on a wider screen (from 768
pixels), turned with Previous and Next or Page Up and Page Down, and under its
facts on a phone. **Read it full size** there, or a tap on the preview, opens
them one at a time, fit to the window, larger with **+**, turned with the arrows
(or the arrow keys).

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

**Print**, beside Download, prints its pages and a sheet of its details (each
ticked or not first): the pages the worker drew, fetched as its page fetches
them, so printing asks to confirm it is you where reading its pages does, each
page printed is in the log as each page read is, and the first 30 pages are
the most it prints — **Download** the file to print the rest, or a file it
doesn't draw. A note prints from its own **Print**; a collection's page prints
what is in it as a table, with the columns and filters its table has and a box
to tick beside each if wanted; and **Activity** prints the lines its filters
keep, with who, what and which days said at the top. Each prints on its own,
black on white, with nothing of the app around it and the vault's name and the
day it was printed at the foot.

### Health records from a patient portal

Besides PDFs, photos, scans, and Word and Excel files, the vault keeps the
files a patient portal or a hospital hands out, **as they are**:

- **C-CDA** documents (`.xml`), sent as `application/xml` or `text/xml`;
- **FHIR** exports (`.json`), sent as `application/json` or `application/fhir+json`;
- **DICOM** images (`.dcm`), with the standard 128-byte preamble and `DICM` after it;
- and a **ZIP** (`.zip`) of a DICOM folder or a portal's whole export.

They are added from **Add**, as a new version, or in **Add many** — not
through the scanner folder, email in, a request link or a paired computer,
which take scans. The vault never opens them: it doesn't read their words,
run OCR or an AI reader on them, draw pages or a thumbnail, or unzip a ZIP.
Each is sealed like any other file and **downloaded only** — always as an
attachment, never sniffed, and XML and JSON as `application/octet-stream`, so
no browser renders them. A link to view can't give one; a link to download
can. What a file is is checked from its bytes, not its name: `DICM` at byte
128 for DICOM, `PK` for a ZIP, and XML and JSON must be UTF-8 text that starts
as they do (they are not parsed further). A file sent with no type, or as
`application/octet-stream` or `text/plain`, is known by its ending; one with no
ending at all — a hospital CD's `IM00001` — is kept if its bytes are a DICOM
image or a ZIP. Newline-delimited JSON (`.ndjson`, a bulk FHIR export) isn't
taken: put it in a ZIP. A record is kept and downloaded under its own name
with the ending of what it is (`.xml`, `.json`, `.dcm`, `.zip`). In **Add
many**, a folder's `.xml`, `.json` and `.zip` files are left out, and the page
says how many — a folder holds many of them that aren't health records, such
as a photo export's notes: choose health record files one at a time.

The size limit is the vault's own, `FDV_MAX_UPLOAD_BYTES` — 100 MB unless
you change it — for each file, a ZIP included. A DICOM study of hundreds of
images can be larger than that: add it in parts, as several ZIPs, or raise
the limit (your reverse proxy's body limit too, if it has one). There is no
viewer for any of them. **Keep the portal's PDF as well**: it is the readable
copy, and it's the one to share with a doctor to view.

### How well the vault reads your papers

**Settings → Server and reading → Reading and the check** measures the vault's reader on
your own papers. It reads again the last documents somebody filed through
review — accepted from Many documents or the Inbox, so a person checked the
details — that you can see, and counts how often it would have got the kind,
whose it is and the expiry right: once without the rules it learned from
corrections, and once with your learning, on the documents you filed
(optimistic, since the rules were learned from the same papers; on anybody
else's it is the same as without). The worker does it in the background,
behind everything else, on the same tools that read new uploads; a few
hundred documents can take a while. Nothing is changed and nothing is
learned. Only the numbers are kept, and a check is its owner's alone:
another owner sees only that one is running or finished, and whose. Which
documents needed typing is kept for seven days.

Documents filed through review before upgrading to 0.9.0 are counted only
if their batch or request was still in the vault then (a batch goes 30
days after it was made); those whose batch had already gone are not.

To compare one release's reader with another's on a test vault, the worker
prints the same numbers, and nothing else, for a household:

```bash
docker compose exec worker node apps/worker/dist/cli.mjs reading-check --household <household id> --n 50
```

It reads with the general reader alone: no Only me document, anybody's,
and no learned rules (it says so beside the numbers). It keeps nothing.

### A local AI reader

If the server has the memory for it, a small language model can read the
papers added many at a time — from Add → Many documents, the scanner folder
and email — beside the vault's own rules. It runs on **your server, or a
machine on your network you control** — prefer the same host, or https —
(or, if you choose, a cloud reader: see below), and it is **off** until you set it up and an owner
turns it on for the household in **Settings → Server and reading → Reading and the check**. Turned
on, it reads **everyone's** uploads in the household, and each of them is
told so where they add papers ("Read by the household's local AI, on
ollama:11434"). Everything else works the same with it or without it.

What it does, and does not:

- It suggests the kind, whose it is, who issued it, the dates and the number,
  for you to check. A detail it suggested says "suggested by the local AI",
  and the card waits at **Check**; where it reads a paper differently from the
  rules, the card keeps the rules' reading, says so, and waits too. **It never
  makes a document Ready**, on its own or with anything else, and accepting
  what it suggested teaches the vault nothing.
- What the worker sends it, only to the address in `.env`, and nothing else:
  - the start of the words (6,000 characters at most) of **every paper anybody
    in the household adds many at a time** once an owner turns it on — **Only
    me papers included**, since the reader runs on each uploader's own uploads;
  - when an owner runs the Reading check with it on, the words of the **filed
    documents that owner can see**;
  - the household's kinds of document, and the **first names** of the family
    the person who added it may file for (a teen, themselves alone) — **whole
    names** where two of the family share a first name.

  The model's server may keep what it is sent in its own logs (Ollama can), so
  it should be one you control: the same host as the vault, or reached over
  https. The vault's own log says how long it took, never a word of the paper
  or of the answer.

- What it answers is held to a fixed form, and each value to the page: a
  date that is not among the paper's own dates, or a number or name not on
  it, is dropped. Anything else — an answer that is not that form, or one
  that tries to follow instructions written on the paper — is ignored.
- Slow or not running, a paper is read without it once its time is up
  (`FDV_LOCAL_AI_TIMEOUT_SECONDS`, 120 unless set), and its card says "Read
  without the local AI". After three failures in a row it rests for five
  minutes, and papers are read without it straight away.

**Hardware.** A 3-billion-parameter model such as `qwen2.5:3b-instruct` needs
about 2 GB of disk and 4 GB of free memory. On a processor alone it is slow:
measured on a small four-core office PC (a 35 W Ryzen 5 PRO 3400GE, shared
with other work), a paper took 28 seconds at the median and one in ten over
a minute, one in a hundred over two (and is then read without it); a batch of a hundred papers takes
the better part of an hour longer than without it. A graphics card Ollama can use makes it many times faster, and
is optional. A smaller model (`qwen2.5:1.5b-instruct`) is quicker and reads
less well.

**Setting it up**, with the compose file's own optional `ollama` service
(never started unless asked for, its models kept in a volume of their own):

```bash
docker compose --profile local-ai up -d
docker compose exec ollama ollama pull qwen2.5:3b-instruct
```

Then in `.env`:

```bash
FDV_LOCAL_AI_URL=http://ollama:11434
FDV_LOCAL_AI_MODEL=qwen2.5:3b-instruct
```

and `docker compose --profile local-ai up -d` again, so the worker reads them.
**Settings → Server and reading → Reading and the check** then says which model at which address,
and whether it answered; **Test** sends it a one-line question of its own —
none of your papers — and says how long it took. Turn it on there.

The compose file's `ollama` is on a network of its own with the worker alone,
and publishes no port. An Ollama already running on another machine you
control will do too — over https where the papers cross your network
(`FDV_LOCAL_AI_URL=https://ai.home.example:11434`, behind a TLS proxy of your
own); plain http only on a network you trust end to end — or anything that
answers Ollama's `/api/chat` with JSON schemas (Ollama 0.5 or later). It must
be your own. `http://` or `https://`, with no user name or password in it.
The worker resolves its name once for each paper, within the paper's time,
talks to that address, and follows no redirect.

**Or set it in Settings** (0.9.0). Where `FDV_LOCAL_AI_URL` and
`FDV_LOCAL_AI_MODEL` are not set, an owner can set the reader in **Settings →
Server and reading → Reading and the check → The AI reader**: its address (the
address alone, such as `http://192.168.1.30:11434`), the model, an API key if
it needs one (sent as `Authorization: Bearer`, kept encrypted, never shown
again) and how long a paper may take. Saved, it is used only once its **Test**
passes. Settings says whether it runs **on your own network** or is **a cloud
service** (an address that resolves to a public one). The worker resolves the
address for every call and checks it first — never link-local or cloud
metadata, and on the hosted edition never inside a network at all — calls only
Ollama's own `/api/chat` and `/api/tags`, and never shows what the reader
answered, so it can't be used to look at other machines. Where the two `.env`
settings are set they win, and Settings shows them locked;
`FDV_AI_READER_SETTINGS=off`, given to the API and the worker, keeps the reader
out of Settings altogether.

**A cloud reader: Anthropic or an OpenAI-compatible server** (0.9.0). The
same card offers two more kinds of reader, for a household that would rather
not run a model of its own:

- **Anthropic** (Claude): no address to type — the vault calls
  `https://api.anthropic.com/v1/messages` with the API key from your
  Anthropic account (`x-api-key`), and lists its models from `/v1/models`. It
  is always a cloud service.
- **OpenAI-compatible**: OpenAI itself (`https://api.openai.com`), or LM
  Studio, vLLM or llama.cpp's server. The vault calls `/v1/chat/completions`
  and `/v1/models` there and nothing else, with `Authorization: Bearer` only
  if you give it a key. It is a cloud service unless you tick **It is on my
  own network** _and_ its address is a private one (localhost, a private
  range, `.local`, or a name that resolves to one).

Both are held to the same guards as the local reader: the address resolved
and checked for every call, no redirects or proxies, only their own paths, a
reply not in their API's shape refused and never shown, and the same timeout,
queue and rest after failures.

**What a cloud reader is sent:** the words the vault read from a paper (never
the page or the file), the names of your kinds of document and your family's
display names. **What it is never sent:**

- **an Only me paper**, ever;
- **a paper marked Sensitive** — by its kind's **Sensitive by default**
  (passports, licences, certificates, bank statements, tax and medical
  papers start so) or its own choice — unless an owner turns on **Also send
  sensitive papers** (step-up; off unless turned on; every owner is emailed,
  and it is in the activity log each time it changes). It holds for the
  reader it was turned on for alone: changing the kind of reader or its
  address turns it off, and a reader set in `.env` taking over — or its
  address changing there — counts as off until an owner turns it on for
  that one.
- **a paper added many at a time whose batch names no kind**: it counts as
  sensitive, whatever the vault's own rules guess it is. Only a batch that
  says its kind lets that kind's **Sensitive by default** decide. With **Also
  send sensitive papers** on, a paper whose batch names neither its kind nor
  who can see it is still held back, as if Only me — nobody can yet say who
  may open it.

Such a paper is read on the server alone, and its card says why ("Read here
only: sensitive", or "only you can open it"). The rule is asked again before
every paper — and once more right before its words go, after waiting its
turn — so a paper made Only me or sensitive while it was being read is not
sent, and changing a kind's default changes what is sent from the next paper
on.

**What it may cost** is capped: at most **the monthly limit** you set (500
unless you change it) papers a calendar month go to a cloud reader, counted on
the household's own clock (its time zone, else `FDV_TIMEZONE`). At 80% the
owners are emailed, once that month; past it, papers are read without it
("Read here only: this month's limit reached") until next month. Settings
shows how many so far. The vault keeps which paper went to which reader, when
and how long it took — for a little over a year, and never a word sent or
received. Whether the provider keeps what it was sent is up to its own terms
(Settings links Anthropic's and OpenAI's).

On the hosted edition only https to a public address is allowed, and only
the providers named in its subprocessor list: Anthropic, and an
OpenAI-compatible reader only at `https://api.openai.com`.

On the vault's made-up test papers ([docs/smart-exit.md](docs/smart-exit.md),
"A local AI (R4)"), `qwen2.5:3b-instruct` cut the papers needing typing by a
quarter — mostly ones the vault could not otherwise name — and the cards Ready by a
quarter too, where it read a paper otherwise than the rules. Run the
[Reading check](#how-well-the-vault-reads-your-papers) with it on and off to
see what it does on your own papers.

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
signed out — from the phone, from **Settings → Your account → Signed-in devices**, which
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

- it stops working after seven days, or whatever you set; a sensitive
  document's link starts as view-only (download, for a file that can't be
  shown) and for seven days, which you can change;
- it can carry a four-digit PIN or a password, which you give them some other way, ask
  for a code emailed to them, and open in one browser only;
- you can take it back at any moment;
- every time it is opened you see it, next to the link, and **Who opened it**
  lists each time and the browser it was opened in (never an address) — for
  whoever made the link and the owners, and, for a sensitive document, for the
  person it belongs to as well, whoever made the link;
- and it reaches nothing else in the vault. There is no account at the other
  end and nothing to sign up for.

The link is shown once — the vault keeps only a hash of it — so a lost link is
replaced rather than recovered. A document moved to the Trash stops being
shared straight away, without anyone having to remember the link exists.

A whole collection can go the same way: on the collection's page, **Share this
collection** lists what is in it that you can see, with what everybody the
collection is for may see already ticked. Only what you tick goes, and each is
checked again every time the link is used: one you can no longer see, one taken
out of the collection or moved to the Trash, stops being sent, and the other end
is never told how many there were. **Keep it up to date** also sends what an
owner or an adult puts in the collection later — decided once, as it goes in:
only what the whole of its audience may see, never a private document, and
never anything that was in it when you shared it and you left unticked. What a
teen puts in stays in the family. Narrowing the collection or a document later
only takes away. Such a link lasts 30 days at most. Sharing a collection
always asks you to confirm it is you; a teen cannot share one; and deleting the
collection, or making it Only me, ends its links. Every link, to a document or a
collection, is in **Sharing**, to take back.

Whoever makes a collection can let others manage it: in **Managers** on the
collection's page, choose someone in the family who can already see it. A
manager can add and remove documents, use its checklist and rename it; the
maker decides, for each manager, whether they may also change who it is for,
delete it, or choose managers themselves. A manager never sees more than they
could before, can never make the collection for people its maker isn't one of,
and the activity log says who changed what. If the maker can no longer change
it (their sign-in is gone, say), an owner can take its managers away, and can
delete it unless a manager may still delete it.

**Links and requests that no longer work** are listed apart in **Sharing**, under
**No longer working**: the first 20, and **Show N more** for the rest. The vault removes
each one a while after it ended, each night: **90 days** unless an owner chooses
otherwise in **Settings → Privacy → Links and requests that no longer work** — after 30
days, 90 days or 1 year, or never. Adults see the choice there too; only an owner changes
it, and choosing a shorter time asks first and says what will go the next night. It
counts from when the link or request was taken back, closed, or reached its end. One that
is only paused, used up (a page already opened on it keeps working until its end), or
stopped after ten wrong codes is not removed until its end has passed too. Clinicians'
emergency links are not touched.

**After upgrading to 0.9.0-dev.53, or restoring a backup made before it,** the time counts
from the upgrade (or the restore) for anything that ended before it: nothing is removed
sooner than 90 days later, or whatever an owner chooses, however long ago it ended.

What stays: the activity log keeps every line about each — when it was made, opened,
emailed and taken back, and what came in — shown to exactly the people who saw them
before. Documents sent through a request stay where they were filed, and their history
still says they came through a request link. A request is not removed while a file it
brought is still waiting in the Inbox. What goes: the link or request itself; with a link,
its **Who opened it** list (each opening stays in the activity log) and its view-only
pages (deleted first, as they already are when it ends); with a request, the list of what
it asked for and the record of each file that was refused (the file itself was deleted
when it was refused). A record that the vault emailed a link or a request stays, but no
longer says which one.

### My cabinet

**Documents** can also be seen as a **Cabinet**: the same papers laid out the
way you file them at home, in cabinets, drawers and folders. **Arrange my
cabinet** draws one from what the vault already knows — by person, then topic,
then year; by topic, then year, then person; or by person, then kind — and
shows it before you keep it; then rename, hide, reorder or merge its drawers
and folders. A folder is a saved question ("Tax papers dated 2025, for Ahmed"),
so it fills itself as papers are added, and one paper can be in several
folders without being copied; **Open in the table** shows a folder's question
as the table's filters, and a document's page says which of your folders it
is in. Each person's cabinet is their own, and an owner can't see anyone
else's. A folder only ever narrows what its person can already open: its
count and its contents follow the same rules as the table and search. It
needs no setting of its own.

Inside a folder, papers sit behind **dividers**: a year each, newest first,
or the folder's own named date ranges ("Elementary", "Middle school"…, from
a person's date of birth if you like), with **Other years** for the rest.
A paper that fits no folder's rule can be **pinned** into one by hand from
its page or the table's bar: it shows first there, counted once, and stops
showing by itself if you can no longer open it.

A paper's page can also say **which folder of your cabinet the original is
in** (_Study cabinet › Drawer 2 › Tax 2025_), beside the words written for
where it is kept — offered right after a scan, and for many at once from the
table. The folder's names are kept with the document, so everyone who sees
where originals are kept reads them; they follow a rename. **Print folder
labels** prints each folder's name with a code that opens that folder in the
vault, after signing in; the code holds only the vault's address for it.

A paper filed from a folder — **Add many** with a folder, a subfolder of the
scanner folder, or a computer's watched folder — keeps the folder it came
from (_Taxes/2025_, never the file's name), seen by whoever sees where
originals are kept. **Keep my folder tree** turns those folders into a
cabinet called **My folders** — a drawer for each top folder, a folder for
each folder under it, each holding the papers from it, now and later. It is
shown first, added beside what your cabinet already holds, and asks before
it's added to a cabinet you have. A paper's folder can be forgotten, never
changed by hand.

### Caregivers, and turning 18

Anyone can let someone in the family see their medical papers — **Let
someone see my medical papers**, on their own page or in **Settings →
Caregivers**. The caregiver (an owner or an adult) then sees those papers,
Only me ones included, marked **Shared with you as caregiver**, and can read
them and save a copy, never change or share them. Nothing else is opened.
Revoke at any time; every look is listed for the person, with when, and for
the owners (who looked and when, never which paper). An owner can name a
caregiver for someone without a sign-in; it reaches their Only me papers only
once they keep it themselves.

When someone turns 18 with medical papers the family can see, they are asked
once whether to keep them visible to the family or make them Only me; if
they have no sign-in, the owners are reminded to ask them in person, and if
they still sign in as a teen, to change their role to adult first. Everyone
already 18 or over is asked once too, the first time. It needs no setting of
its own.

### Notes

**Notes**, in the left bar, keep what the family knows and keeps nowhere else:
where things are, how things work, who to call. Each is written with a
formatting toolbar — headings, lists and checklists, links, quotes — and read
as it was written. A note is a document without a file: it has the same
_Everyone in the family_, _Adults only_ and _Only me_ (an Only me note is
encrypted as an Only me document is), tags, collections, search, the Trash, and
a place in every export as a Markdown file in `Notes/`. **Share a link** on a
note sends it to somebody outside the family to read on the page, with the same
end date, PIN, password, emailed code and one-browser options as a document's
link: safer than pasting it into an email, which stays in their inbox, and
yours, for ever.

A note is not a password manager. Everyone who can see a note can read and
search it, and the vault says so when a note looks as if it holds a password
or a PIN: keep those in a password manager, or at the very least in an Only me
note. Notes need no setting of their own.

### Scanning straight into the vault

A network scanner, or a printer's "scan to folder", can save straight into a
folder on the server. Each scan then lands in one person's Inbox to look over,
as if they had added it.

**Who can write to the folder can fill that person's Inbox, and who can read
it sees scans on their way in, and the ones it rejected.** Share it with the
scanner alone, on your home network, with a password of its own.

1. **Make the folder**, beside your `docker-compose.yml`, owned by the
   containers' user (uid 1000) and open to nobody else:

   ```bash
   mkdir scanner && sudo chown 1000:1000 scanner && sudo chmod 700 scanner
   ```

   It must be a bind mount of its own: never inside `vault-data` or any other
   volume of the vault's. On Docker Desktop (Windows or macOS) `mkdir scanner`
   is all: a folder from your own disk is mounted as one every container user
   can write, so there is nothing to `chown`, and the folder is as private as
   your own account's files.

2. **Mount it into the worker.** In `docker-compose.yml`, uncomment
   `# - ./scanner:/watch` under the worker's `volumes`, add `FDV_WATCH_DIR=/watch`
   to `.env`, and run `docker compose up -d`. Only the worker needs it.
   `FDV_WATCH_DIR` is the folder used until an owner chooses another in
   Settings; it may be left out, and the folder chosen there instead. An owner
   may choose any folder inside `/watch` (one per scanner, say:
   `/watch/office`), or inside the folders you name in `FDV_WATCH_ROOTS`
   (comma-separated, `/watch` by default) and mount there too. None of the
   vault's own folders, nor a folder above one — `/data`, where it keeps
   files and backups, `/tmp`, `/app`, `/run/secrets` — can be chosen, nor
   anything reached through a link out of those folders: the API refuses it,
   and the worker refuses it again every time it looks. **`/data` is the
   vault's own volume, so a scanner folder can never be under it**: mount
   the scanner folder at `/watch` (or a root of your own), never at, say,
   `/data/scanner`. **Never mount a folder above the vault's data volume**
   (the host folder that holds `vault-data`, or `/`) into the worker as a
   root: the worker refuses a root that is `/` or holds one of its own
   folders, says so in its log and in Settings, and compares folders by
   device and inode as well as by name, so a bind mount of its own data
   inside a scanner folder is never walked. The next
   upgrade brings a new `docker-compose.yml`, which has the line commented out
   again; to keep the mount through upgrades, put it in a
   `docker-compose.override.yml` beside it instead (Compose reads that file by
   itself when no `-f` is given; with `-f` files, add `-f docker-compose.override.yml`):

   ```yaml
   services:
     worker:
       volumes:
         - ./scanner:/watch
   ```

3. **Point the scanner at it.** Share the host's `scanner` folder over SMB or
   FTP, with everything the scanner writes owned by the uid-1000 account and
   private to it, so the worker can delete the files and any folders the
   scanner makes. Most scanners name each file by the date and time, so no
   two are alike. With Samba:

   ```ini
   [scanner]
     path = /srv/fdv/scanner
     valid users = scanner
     force user = fdv
     create mask = 0600
     directory mask = 0700
     read only = no
   ```

   (`fdv` here is the host account with uid 1000; `scanner` the account the
   scanner signs in with.) With vsftpd, the same: `guest_enable=YES`,
   `guest_username=fdv`, `local_umask=077`, and the folder as that user's
   `local_root`.

4. **Turn it on.** An owner, in **Settings → Server and reading → Scanner folder**,
   chooses whose Inbox it fills: themselves, or anyone in the family who signs
   in and adds documents, never a viewer. The page says whether the folder is
   ready and, if not, why: not set, not there, not writable, or not a folder
   the vault may use. Under **Which folder**, an owner can keep the server's
   own (`FDV_WATCH_DIR`) or choose another, typed or browsed to, and
   **Verify** it first: the worker says, check by check, whether it is there
   and is a folder, is inside the folders it may use with no link out of
   them, is none of the vault's own, whether the vault can see into it, make,
   move and delete a file in it (a hidden test file, removed afterwards), and
   how much room is left. Under **Kept scans**, how many days a scan is kept
   once it is in the vault (below).

What happens to each file:

- The worker looks every 15 seconds. It takes a file once its size and time
  haven't changed for `FDV_WATCH_STABLE_SECONDS` (10 by default) and it looks
  complete for its kind (a PDF's end marker, a JPEG's, a PNG's, a Word or
  Excel file's). One that looks unfinished waits
  `FDV_WATCH_INCOMPLETE_GRACE_SECONDS` more (two minutes by default) and is
  then taken anyway: a motion photo or a PDF with more after its end is
  fine, and a scan that really was cut short shows its bad pages in the
  Inbox. A scanner that pauses longer than both in the middle of a file can
  still be taken part-way: raise `FDV_WATCH_STABLE_SECONDS` for it. It polls
  rather than waiting for the system to say a file changed, which bind
  mounts on Docker Desktop never do.
- One worker watches, however many run, by holding a Postgres advisory lock
  for as long as it runs. That needs `DATABASE_URL` to reach Postgres
  directly, as the compose file does: not through PgBouncer or another pooler
  in transaction mode, which would let two workers watch at once.
- Files in folders inside it are taken too. Hidden files (a name starting with
  `.`), names a program uses while it saves (`~…`, `….tmp`, `….part`) and the
  `rejected` and `processed` folders are left alone. The worker never follows a link, to a
  file or a folder. Just before it reads, moves or deletes a file it checks
  that the file is the one it listed and that its real path is inside the
  folder; on Linux, the worker's own system, it checks the open file itself.
  Anything else it leaves alone, and names to nobody.
- The folders inside it can say what a scan is. If the scanner saves into
  `Passports/Ahmed`, say, the vault suggests a passport, and Ahmed's, as
  Add → Many documents does for a folder chosen there. The folder's name is
  kept encrypted with the file, for that person alone.
- It is encrypted into that person's batch of the day, "Scanner, 12 Oct" on the
  household's calendar, read and proposed for like anything they upload.
  Until they accept it nobody else sees it, not even an owner.
- **Only once it is safely stored is it moved out of the way**, to
  `processed/<date>/` in the folder (the household's date, the folders it was
  in kept under it; a name already there becomes "scan (2).pdf"), and
  **deleted after the number of days an owner sets: 7 unless they change it**,
  up to 365. 0 deletes it at once instead. **Scans kept there are not
  encrypted until they're deleted; anyone who can open the server's folder
  can read them**: keep the folder private (step 1), or set 0 days. The
  worker deletes only the scans it kept, each recorded as it moved it
  there, and only while it is still that very file: one put in its place is
  left alone, and **anything else saved into `processed` is never touched,
  nor added**. The vault's own `processed` has a `.fdv-processed` file in
  it; one it didn't make is never used (Settings says so: rename it), and
  scans are deleted once stored instead. Scans kept in a folder chosen
  before are deleted in time while the vault may still use that folder;
  otherwise Settings says how many are left there, to delete by hand. A kept
  scan is known by its birth time where the file system has one, so a
  change to its permissions or attributes (Samba's DOS attributes, an
  antivirus) doesn't hide it; where there is none and it changed, it is
  left in place and counted in Settings, never deleted. After a
  [restore](#restoring), scans kept since the backup was made are counted in
  Settings and never deleted by the vault: delete them by hand. A household that had the
  scanner folder set up before 0.9.0 keeps 0 days after the upgrade, so its
  scans are still deleted at once until an owner chooses to keep them.
- A file the vault can't take is moved to `rejected/` (only uid 1000 can open
  it), with a note beside it (`<name>.txt`) saying why. That happens when it
  isn't a PDF, JPEG, PNG, TIFF, HEIC, WebP, Word or Excel file, is larger
  than `FDV_MAX_UPLOAD_BYTES`, is empty, can't be read, or is a hard link to
  a file kept somewhere else. That person sees "A scanned file couldn't be
  added" in Needs attention. Delete the file and its note once you have
  dealt with them.
- A file the worker has dealt with that is still in the folder — stored but
  not deleted, or meant for `rejected/` but not moved (the folder's
  permissions) — is counted for the owners in Settings, so they can delete
  it by hand; a file that couldn't be moved also says so in that person's
  Needs attention.
- It pauses while that person's sign-in is locked or waiting after a restore,
  while they can no longer add documents, while the vault can't open their key
  (the wrong `FDV_MASTER_KEY`) or has nowhere to keep files, and once the
  day's batch is full (200 files). Settings says why. Scans wait in the folder
  meanwhile.

Nothing in the folder is encrypted, and the folder is not backed up: a scan
sits there until it is stored, then in `processed/` for the days kept, and
what was rejected until you deal with it. If you scan health papers there,
fewer days — or 0 — keeps them private sooner; Settings says so beside the
number of days.

### Emailing documents to the vault

The family can email documents to a mailbox of the household's own. The
worker checks it every few minutes, and each attachment from someone in the
family goes into their Inbox to look over, as if they had added it.

A medical record forwarded this way has already passed through your email
provider, and a copy stays in your sent mail until you delete it; Settings
says so. For health papers, adding them in the vault directly keeps them out
of email altogether. Email in takes PDFs, photos, Word and Excel files, not
[health records kept as they are](#health-records-from-a-patient-portal).

1. **Make a dedicated mailbox**, used for nothing else: say a new Gmail
   address, `smith.vault@gmail.com`. Everything sent to it is read by the
   vault, and its password is given to the worker, so never use anybody's own
   mailbox. The vault signs in with an app password over IMAP, so the
   provider must offer both. These do:
   - **Gmail** (`imap.gmail.com`): turn on 2-Step Verification for the new
     account, then make an app password at
     [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords),
     giving it any name. IMAP is always on.
   - **Fastmail** (`imap.fastmail.com`): **Settings → Privacy & Security →
     Manage app passwords**, with access to mail (IMAP).
   - **iCloud Mail** (`imap.mail.me.com`): an app-specific password, from
     **Apple Account → Sign-In and Security**.
   - **A mail server of your own** (Dovecot, say), on port 993 with a
     certificate for its name.

   **Outlook.com and Hotmail don't work**: Microsoft no longer lets other apps
   sign in to them with a password or an app password, only by its own
   sign-in (OAuth), which the vault doesn't do.

2. **On Gmail, keep the family's mail out of Spam**: in Gmail's **Settings →
   See all settings → Filters and Blocked Addresses → Create a new filter**,
   put the family's addresses in **From** (separated by `OR`), then **Create
   filter → Never send it to Spam**. The vault only looks in the folder you
   set.
3. **Tell the worker.** Put the password in a file the worker reads, a Docker
   secret, rather than in `.env`: it is then never in the environment of
   anything. In `.env`:

   ```bash
   FDV_MAIL_IN_HOST=imap.gmail.com
   FDV_MAIL_IN_USER=smith.vault@gmail.com
   FDV_MAIL_IN_PASSWORD_FILE=/run/secrets/mail_in_password  # or FDV_MAIL_IN_PASSWORD=…
   FDV_MAIL_IN_AUTHSERV_ID=mx.google.com                    # Gmail's: see "a forged sender" below
   ```

   and give the worker the secret in a `docker-compose.override.yml`:

   ```yaml
   services:
     worker:
       secrets: [mail_in_password]
   secrets:
     mail_in_password:
       file: ./mail_in_password.txt
   ```

   (the file holding the app password alone, readable by you alone). Then run
   `docker compose up -d`. Only the worker is given these. The password is
   never logged, never sent to the browser or the phone, never stored in the
   database, and taken out of the worker's environment as soon as it is read,
   so no tool the worker runs is handed it.

   **Or set it up in Settings**, with nothing on the server: an owner, in
   **Settings → Server and reading → Email, in and out → Email in → Set up the mailbox**, fills in the
   IMAP server and port (993), the sign-in and its app password, the folder
   (INBOX), what happens to an email once its attachments are in, the
   provider's authserv-id ("Gmail: mx.google.com") and how often it is
   checked, and saves. That mailbox is the one checked for the household,
   whatever `FDV_MAIL_IN_*` says; **Remove this mailbox** goes back to the
   server's own. The app password is stored encrypted, under a key of its own
   derived from the master key with the household bound in: it is never shown
   again (only that one is set), never logged, never in an export, and the
   worker hands it to the IMAP connection alone — and only to the server,
   port and sign-in it was typed for: change any of them and type the app
   password again. Saving the mailbox asks you to confirm it is you. The
   server must be on port 993 and at an address outside your server's own
   network: set `FDV_MAIL_IN_ALLOWED_PORTS` or `FDV_MAIL_IN_ALLOW_PRIVATE=true`
   in `.env` (the worker's) to allow another port, or a mail server on your
   LAN. **Test the mailbox** signs in to what is saved, opens the folder
   read-only and says how many messages are there, whether the server can
   move and delete one email alone (MOVE, UIDPLUS), and — when the newest
   three emails' Authentication-Results all name the same server — a hint at
   the authserv-id; check it against your provider's documentation before
   you copy it, as anybody can write that header into an email. Those
   headers are all it reads: no email is moved or marked. After a
   [restore](#restoring) the mailbox comes back with its password, which opens
   as before with the same master key; a backup made before you
   [rotated the master key](#rotating-the-master-key) is moved onto the new
   one by the restore, with `FDV_MASTER_KEY_PREVIOUS`, as the other secrets
   are. If it ever does not open, Settings says so: type the app password in
   again.

4. **Turn it on.** An owner, in **Settings → Server and reading → Email, in and out → Email in**. The page
   says whether the mailbox is set up and when the worker last checked it,
   the last problem it had (a refused sign-in, an unreachable server, a
   certificate it couldn't verify), how much mail it left alone, and whether
   the family can confirm their addresses.
5. **Each person confirms their address once**, on **Add** (and Home), where
   anyone who adds documents sees "Email documents to <the mailbox> from
   <their sign-in email>". Confirming proves the address is theirs, in one of
   two ways:
   - **With the sender check on** (`FDV_MAIL_IN_AUTHSERV_ID`, below): they get
     a code, and send an email from their address to the mailbox with the code
     as its subject (the page has a link that writes it). The vault confirms
     the address only if your provider vouches that the email really came from
     it.
   - **With the vault's own mail server** (`FDV_SMTP_URL`, see
     [Passwords](#passwords)): the vault emails a code to their address, and
     they type it in. A code lasts a day and works once; five wrong tries and
     it is spent; a code a minute, and five a day.

   With neither set, nobody can confirm an address, and both pages say why.
   An address is confirmed only while it is still that person's sign-in.

The vault connects over TLS on port 993 (`FDV_MAIL_IN_PORT`), and checks the
server's certificate and name: there is no setting to turn that off.

What it takes, and from whom:

- **Only mail From the confirmed sign-in address of someone in the family who
  adds documents** (an owner, an adult or a teen), and only into **that
  person's** Inbox. A teen's mail goes to the teen alone. A viewer's or a
  guest's is never taken. An address with anything but plain ASCII in it is
  never matched, so a look-alike address can't pass for a family one.
  **Without the sender check, "From" is only what the email says**: anyone
  who knows the mailbox's address can send an email that says it is from a
  family member, and its attachments land in that person's Inbox, marked
  "sender not verified" (see "a forged sender" below).
- **Attachments the vault keeps**, told by their bytes, not their names: PDF,
  JPEG, PNG, TIFF, HEIC, WebP, Word and Excel. Pictures in the body under
  20 KB (signatures, logos) are left out on purpose. Attachments of an email
  forwarded as an attachment are taken too.
- Each goes into that person's batch of the day, "Email, 13 Oct", read and
  proposed for like anything they upload. Nothing is filed until they accept
  it.
- **The email's text and subject are not kept.** Its MIME is read in a
  sandboxed thread of the worker, with a deadline and a memory limit, never on
  the API.
- An email larger than 50 MB is not downloaded at all. Attachments not added
  — not a kind the vault keeps, larger than `FDV_MAX_UPLOAD_BYTES`, more than
  100 in one email, or in an email forwarded too many times over — are told to
  their person in Needs attention, how many and why, as is an email with
  nothing to add or one that couldn't be read.

What happens to the mail afterwards:

- Once every attachment of an email is in the vault, the email is **moved to
  a folder called `Filed`**, which the vault makes in the mailbox, or
  **deleted** with `FDV_MAIL_IN_AFTER=delete`. (Gmail's "deleted" depends on
  its IMAP settings: by default it archives.) An email with anything not
  added — too large, an attachment skipped, unreadable — is never deleted:
  it is moved to `Filed` even then, so nothing is lost. A worker that stops
  halfway adds nothing twice and loses nothing: the email stays where it was
  until it is filed, and an attachment its person removed meanwhile is not
  added again.
- The vault moves or deletes one email only where the server can do just
  that (IMAP's MOVE and UIDPLUS, which Gmail, Fastmail, iCloud and Dovecot
  have). A server without them could take other emails with it, so then the
  vault leaves each email it has added where it is, marked as read, never
  fetches it again, and says so in Settings; without UIDPLUS, `delete` falls
  back to moving.
- **Everything else is left exactly where it was, unread**: mail from
  strangers, from an address not confirmed yet, or that fails the sender
  check below. Settings counts it, so you can clear it out now and then, and
  each person sees, on Add, how many of their own wait and from when.
- While someone's sign-in is locked, or waits after a restore, or their day's
  batch is full (200), their email waits in the mailbox too, and comes in
  once it can.

**The risk: a forged sender.** Anyone can write anybody's address in an
email's From. Without a check, a stranger who learns the mailbox's address
could put files in a family member's Inbox: they would see them there, and
remove them, but should not have to. So:

- **Set `FDV_MAIL_IN_AUTHSERV_ID`** to the name your provider puts first in
  its `Authentication-Results` header: `mx.google.com` for Gmail (open any
  email's original headers to see it). The vault then reads only the first
  `Authentication-Results` header of an email, which your provider adds as
  the email arrives, and only if it carries that name; it reads it strictly,
  and accepts the email only if it says the sender passed DMARC for the
  From's own domain, or, with no DMARC result, carries a DKIM signature of
  exactly that domain. Anything a sender wrote is ignored. It works with any
  provider that puts its own `Authentication-Results`, under its own name, on
  top of every email it receives (Gmail, Fastmail, iCloud, most others):
  look at a few emails' headers to find the name, and check it is always the
  same. A provider whose header is out of the standard's grammar, or carries
  no name, is never trusted: its email then counts as not verified.
- Without it, the vault goes by the From alone, warns owners in Settings, and
  marks every item from an email **"sender not verified"** on its card.
- Either way, nothing emailed in is ever filed without its person accepting
  it.

`FDV_MAIL_IN_FOLDER` (`INBOX`) is the folder checked, and
`FDV_MAIL_IN_POLL_SECONDS` (300) how often. If the mailbox refuses the
sign-in, the vault tries less and less often, up to an hour apart, so the
provider doesn't lock the account; Settings says so. One worker checks the
mailbox however many run, as for the scanner folder: `DATABASE_URL` must
reach Postgres directly.

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

### Security events

**Failed sign-ins are counted per account.** A wrong password, or a code
(from an authenticator app or by text) that didn't match, counts against the
account, whichever address it came from. After **five**, signing in to that
account with a password or a code waits **a minute**; the next failure makes
it wait **five minutes**, and every one after that **fifteen**, never longer.
While it waits the vault answers `429 sign_in_throttled`, with `retry_after`
(seconds) and `Retry-After`, even to the right password. The count starts
again 24 hours after the first failure it counts, when a sign-in succeeds,
or when the password is reset. Each try is reserved before it is checked, so
tries sent at the same moment cannot get past the limit. An address with no
account here is counted and answered exactly the same, so none of this tells
anybody which addresses have accounts. "Forgot password" also answers after
the same half-second whatever the address.

**Your own devices are never made to wait by somebody else.** Each sign-in
gives the device a proof that it has signed in to the account — in a
browser an `HttpOnly` cookie (`fdv_device`, beside the refresh token's, with
the same rules), to an app that keeps it a `device_proof` it sends back —
good for 90 days and renewed at each sign-in. A device that shows one is
counted on its own: whoever keeps failing from elsewhere makes only
_unknown_ devices wait, never the phone or browser you already use (its own
wrong tries still make it wait). The proof opens nothing; it only keeps your
device's count apart. An app that doesn't keep it (the phone app until it
does) is counted with the unknown devices. **A passkey never waits**: it has
nothing to guess.

**Confirming it's you is counted per session.** A wrong password or code
when confirming it's you, or a wrong current password when changing it,
counts on that session alone — only somebody already signed in reaches it —
and waits in the same steps, never making your sign-in wait.

**What is recorded.** Each failure is a line in the person's **Activity** —
_A sign-in to Sam's account failed: the password was wrong_ — saying which
step failed (password, code or passkey) and whether signing in now waits,
never what was typed nor the address, at most ten lines an hour per account.
The person and the owners see these lines; nobody else does. A failure for an
address with no account is never in anybody's Activity.

**Who is told.** After five failures in an incident — it lasts until a day
passes with no failure — the person is emailed (and pushed to on browsers
where they turned notifications on, and sent one text if they asked for
alerts by text), **once per incident**. If the password was right and only
the code was wrong, the email says so: somebody knows the password. For an
owner's account, **the other owners are emailed too**, once per incident
(never texted).

**In the API's log.** Every failure and every wait is a line in the API's
log, with the account's id (never an address typed) and where it came from:

```bash
docker compose logs api | grep '"event":"sign_in_failed"'
```

```bash
docker compose logs api | grep '"event":"sign_in_throttled"'
```

`docker compose logs --since 24h api` narrows either to the last day. New
devices signing in are covered [above](#when-a-new-device-signs-in).

## How your files are protected

- The **server is the encryption boundary**. Every file version gets its own random AES-256-GCM key; that key is wrapped by a per-household scope key; scope keys are wrapped by the master key, which lives only in your `.env` (or a key file) — never in the database.
- Files are encrypted in 1 MB chunks, each with its own authentication tag, so a page in the middle of a large PDF can be served without decrypting the whole file, and a reordered, altered or truncated file is refused rather than decrypted into garbage.
- The **storage provider sees only ciphertext** and object sizes. No filenames, no document types, no names.
- **"Only me" documents** use a per-member key that other accounts, including the owner, do not hold.
- Every sign-in, sign-out, download, view of a private document and access change is written to an **append-only, hash-chained audit log**. The database refuses updates and deletes on it, and the worker recomputes every chain nightly — a row that was altered or removed breaks the chain from that point on.
- **Row-level security in PostgreSQL** keeps each household's rows invisible to every other household, enforced by the database rather than by application code. The application connects as a role that owns no tables, which is what makes the policies apply.
- **Backups of the database are encrypted** with the same master key.

- **Reading happens on your server.** The worker reads the text a PDF or a Word file carries, runs Tesseract locally (English) only for scans and photos, and draws page previews with poppler and ImageMagick; no page ever leaves the machine. What the pages say is offered back as suggestions for a document's empty details, which fill a field only when somebody taps them, and are never stored. Private documents' text, notes and details are stored encrypted under the owner's key and are not indexed. Page previews and thumbnails are encrypted under their document's own key, like the file, and, like every answer the vault gives, are sent with `Cache-Control: no-store`: no browser or phone keeps them.

The honest limit: someone who controls the whole server can read everything. For a self-hosted vault on the household's own machine, that is the right trade — it is what makes server-side search, thumbnails and automatic filing possible.

## Backups and recovery

Three things make up a complete backup:

1. **Your `.env`** — it holds the master key. Keep a copy off the server. Without it, nothing else below is readable.
2. **The database** — the worker writes an encrypted `pg_dump` every night (`FDV_BACKUP_CRON`, default 02:30 UTC) into the `fdv_vault-data` volume under `/data/backups`, keeping `FDV_BACKUP_RETAIN_DAYS` (30) days. That is the same volume as the files: have the vault copy each backup off the machine ([below](#an-off-site-copy-of-the-backups)), or copy that folder somewhere else on a schedule of your own. From 0.5.8 an Only me document's notes and details are sealed under their owner's key, as its pages always were; backups made before then keep them unsealed until they rotate out.
3. **The files** — the `fdv_vault-data` volume (`/data/vault`) for the local vault, or your bucket. They are ciphertext; the master key and the database together open them.

A document deleted for good stays in the backups made before, until they age out: its details in the database backups for `FDV_BACKUP_RETAIN_DAYS`, its file in any copy of the files you keep, for as long as you keep it. For a sensitive document, moving it to the Trash and deleting it for good say so, with the number of days (when the API is given `FDV_BACKUP_RETAIN_DAYS`, as the compose file does; otherwise "until your backups age out").

Useful commands (run inside the worker container):

```bash
docker compose exec worker node apps/worker/dist/cli.mjs backup-now
```

```bash
docker compose exec worker sh scripts/restore-drill.sh
```

The restore drill restores the newest backup into a scratch database beside your own, checks it the way the vault will read it — as the vault's own database user, through the same privacy rules — and drops it again. Your vault is not touched. Run it after you change anything about your backups, and once a month.

### An off-site copy of the backups

A backup on the same disk as the vault is lost with it. An owner can have the worker copy each backup to a bucket on any S3-compatible service — Amazon S3, Backblaze B2, Wasabi, MinIO on another machine — in **Settings → Backups**: the address (empty for Amazon S3 itself), region, bucket, an optional folder in it, an access key ID and its secret key, and how many copies to keep (30). Changing it takes a passkey or a code. Save, then **Send a test** (a small file is written in the folder, read back, listed and deleted); only once a test has passed can the copy be turned on, and a new bucket, key or secret waits for a test of its own. The secret key is kept encrypted under the master key, like the vault's other saved passwords, and is never shown again.

- **What goes:** after each nightly backup, and each `backup-now`, the backup file exactly as the worker wrote it — the database alone, already encrypted with the master key — named as on the server (`fdv-<time>.sql.enc`). Nothing is decrypted to send it. **The document files are not in a backup, so they are not in the copy either**: keep a copy of the `fdv_vault-data` volume's `/data/vault` (or of your storage bucket) yourself.
- **What is removed:** only the vault's own older copies, by that name, directly in the folder you chose, beyond the number you keep — and only if the key may delete. Nothing else in the bucket is touched. When an owner lowers the number while the copy is on, the other owners are emailed.
- **The key:** give the vault a key for that bucket (and folder) only, which may write objects (`PutObject`, and the multipart upload calls for a large backup), read them back (`HeadObject`/`GetObject`) and list the folder (`ListBucket`). Deleting (`DeleteObject`, and `AbortMultipartUpload` to tidy a failed upload) is optional, and **leaving it out is the safer choice**: a server taken over with a key that may delete could wipe every copy along with the vault. With a key that may not delete, the test says so, Settings shows it, the copy still goes, and the vault removes nothing: turn on the bucket's versioning or Object Lock (B2 calls it file lock), and add a lifecycle rule that deletes copies after, say, 30 days.
- **Tidy failed uploads:** a backup larger than 16 MB goes in parts; one cut short leaves parts behind that the bucket bills for. Add a lifecycle rule that aborts incomplete multipart uploads after a few days (most providers offer one).
- **Status:** Settings → Backups says when the last copy went, and why the last one did not. The owners are emailed once when a copy fails, or when none has gone for two days (`FDV_BACKUP_OFFSITE_LATE_DAYS`, for backups less often than nightly), and not again until one goes or the copy is turned on again. The worker's log says the provider's own words. Each copy is a job of its own, given three hours, and never makes the backup again.
- **Only where the database holds one household**, the self-hosted vault's, and never on the hosted edition, whose operator keeps the backups.
- **The master key reads them.** A copy is no use without the master key it was made with: keep `.env` or the key file (or the key itself, in a password manager) somewhere other than the server and the bucket. After you [rotate the master key](#rotating-the-master-key), the copies made before are still under the old key: keep it as long as you keep them.

**To restore from an off-site copy**, download the newest `fdv-….sql.enc` from the bucket with your provider's own console or tool, put your `.env` (with the master key) beside `docker-compose.yml`, follow [Restoring](#restoring) to clear the database, and mount the file into the restore (`chmod 644` it first):

```bash
docker compose run --rm --no-deps -v "$PWD/fdv-2026-11-20T02-30-00-000Z.sql.enc:/restore.sql.enc:ro" worker node apps/worker/dist/cli.mjs restore-backup /restore.sql.enc
```

The files come from your own copy of them, put back first, as [Restoring](#restoring) says for a new machine. A restore turns the off-site copy off and untested, whatever the backup said: it may name a bucket or a key given up since. An owner sends a test and turns it on again in Settings → Backups.

### Restoring

A restore goes into an empty database, never over a vault that is running: it refuses to. It gives the vault's database user its privileges back, brings a backup from an older release up to date, and checks the result before it says it is done. It refuses a backup from a newer release than the one you run — restore that with the newer release (`FDV_VERSION`).

**Everything since the backup was made is undone** — documents added since, and also passwords changed, people removed and share links revoked since. So pick the newest backup; afterwards everybody signs in again, with the password they had when it was made. Every share link is paused, since one you took back after the backup would otherwise work again: an owner turns back on the ones still wanted in **After a restore**, which Home leads to while anything is paused, and nobody else can, not even whoever made the link. They can take their own links back there. A link to somebody's Only me document, which no owner can see, stays paused: if it is still needed, they take it back and make a new one. At first only the owners can sign in: everybody else's sign-in is paused, since a lock an owner put on somebody after the backup would otherwise be undone, and an owner turns each back on, one tap each, in the same place; that needs the owner's two-step sign-in or a passkey (Settings → Your account), so an owner without either sets one up first. A sign-in that was locked when the backup was made stays locked until an owner unlocks it, even if the lock was due to end by itself. A link or a request somebody made works again only once both it and their sign-in are turned back on. The off-site copy of the backups is turned off until an owner tests it and turns it on again. The restore lists what else to look at.

**A document removed for good can come back from an older backup as a record, never as a file.** A backup holds only the database; an owner removing a document from the Trash for good deletes its files there and then. So a restore from a backup made before the removal brings its details back without its file: the restore looks for every file, lists the documents whose files are gone, and each of them says "The file was removed for good" when it is opened. An owner can remove such a record for good again, from the Trash. The restore also clears every request to remove a document for good: an owner who still wants one gone asks again, and whoever filed it has a day again.

**Put your files in place before you restore.** The restore marks a file removed only when the place your files are kept clearly holds the others: if that folder is not there (a drive not mounted, say), the bucket cannot be reached, or none of the files it should hold is there, it marks nothing and says why. If you put files back after a restore, have the vault look again, and their documents open as before:

```bash
docker compose run --rm --no-deps worker node apps/worker/dist/cli.mjs recheck-files
```

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

To go further back, name a file instead of `latest`, such as `/data/backups/fdv-2026-09-20T02-30-00-000Z.sql.enc` (in Git Bash on Windows, put `MSYS_NO_PATHCONV=1` in front of any command that names a path inside a container, or Git Bash rewrites it). A backup made before you last [rotated the master key](#rotating-the-master-key) also needs the key it was made with: add `-e FDV_MASTER_KEY_PREVIOUS=<old key>` to the restore command.

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

**Export everything** in Settings → Your data makes a ZIP of every original plus a readable index — the way to leave, and a second backup that needs no software at all. It holds the photos and identity details you can see as well: your own identity details whole, Only me included, and other people's without their ID numbers, which the vault shows only when you confirm it's you.

### Notifications and email

**Notifications work out of the box.** Open the vault, go to _Settings → Notifications_, and turn them on: the day's reminders arrive on that device even when the vault is closed. Nothing is configured, no account anywhere is involved, and the signing keys are generated into your `.env`. On iPhone and iPad, add the vault to the home screen first — Apple only allows notifications for installed web apps.

**Email is optional and uses your own mail account.** Every other adult is told whenever an owner changes it, because everything the vault emails travels through it — and for the same reason no email or notification ever names an Only me document, even to the person it belongs to: it says “One of your private documents”. In **Settings → Server and reading → Email, in and out → Where email comes from**, an owner picks a provider (Gmail, Fastmail, iCloud, Outlook, Amazon SES, Postmark, or anything else with an SMTP server), pastes an address and an app password, and presses **Save and send a test**. A real message goes to your own address, and if it does not arrive the screen says why in plain words. Reminders then come from an address your family recognises, and no third party ever handles them.

Each person chooses what they want: the day's reminders on their devices, the same by email, and a summary every Sunday evening.

**Neutral wording.** Emails and notifications can be read by more people than the family — whoever runs the mail server, or anyone who picks up a phone — so they need not name your documents. In **Settings → Privacy → Neutral wording in notifications and email**, an owner chooses which documents are not named: **Off** (every document is named by its title), **Health documents only** (documents in the Medical category), **Sensitive documents only** (the default: documents marked Sensitive), or **All documents**. A document not named is said as "A reminder about a document — Due in 7 days", with no title, kind, person or note. A change that would name a document the old choice left unnamed asks the owner to confirm it's them. Each person can also choose Health, Sensitive or All documents for what is sent to them in **Settings → Notifications**: a document is left unnamed when the household's choice or theirs says so, so the household's choice always applies as well. It covers the email digest and the Sunday summary, and notifications in the browser. Texts and the phone app's notifications never name a document anyway.

### Text messages

The vault can send texts: the codes that confirm a mobile number, sign-in, step-up and reset codes, the alerts and reminders people ask for by text, and links you send. An owner sets it up in **Settings → Server and reading → Text messages**, choosing who sends them:

- **SMS Gate for Android** — an app on a phone your family owns ([sms-gate.app](https://sms-gate.app)), reached on your home network (recommended), through SMS Gate's cloud relay, or through a server of your own. Texts go out on that phone's own plan. On the home network the address is the one the app shows under Local server: a private address is fine, but the port must be 8080 (SMS Gate's own), 80, 443, 8000, 8443 or 8888 unless you allow others with `FDV_SMS_GATE_ALLOWED_PORTS`, and it is never this server itself (`localhost`, `127.0.0.1`, `host.docker.internal`), a link-local address, or one of the vault's own services (`postgres`, `api`…). The port list is what keeps the vault's own services out; the names are checked too, as a best effort, by name alone. A local server saved on a port the vault no longer reaches shows as failed in Settings → Text messages, saying which port, and texts stop until it is changed and tested. If a test can't reach the phone, Settings says only that; why (no answer, refused, a wrong password) is in the API's log, `"event":"sms_problem"`, and the worker's for the texts it sends.
- **Twilio** — a paid service on the internet. Sign up at [twilio.com](https://www.twilio.com), buy a number that can send texts (or set up a Messaging Service), and copy the **Account SID** and **Auth Token** from the Twilio Console's front page. In Settings, choose Twilio, paste them, and give either the **From number** (with its country code, such as `+447700900123`) or the **Messaging Service SID** (`MG…`). If your family's numbers are in another country than the Twilio number's, allow that country under the Console's Geo permissions; a trial account texts only the numbers verified in it.

**Twilio's costs are yours.** Twilio charges your own Twilio account for every text, at its prices; the vault adds nothing, pays for nothing and never sees your bill. The **most texts in a month** setting (200 unless you change it) caps what the vault sends, whatever asks — links take half of it at most, so sign-in codes always have room — and the screen shows how many have gone this month.

Whichever you choose, nothing is sent until **Send a test** goes through it, and changing provider, number, account or secret waits for a test of its own. One provider at a time: switching forgets the other's settings and its password or Auth Token. The password and the Auth Token are kept encrypted under the master key (rotating it moves them, and so does a restore of an older backup), are never shown again, and are never in an export or a log. The vault asks Twilio how each text is doing, as it asks SMS Gate; Twilio never calls the vault, so nothing has to reach your server from the internet. A text is never sent twice: if Twilio can't say whether it took one (a server error, a dropped connection), the vault counts it as sent and leaves it, so check the Twilio Console's logs if somebody says a code never came. A text never names a document.

Only SMS Gate and Twilio for now. The vault sends texts through one small interface, so another provider (Vonage, MessageBird or Plivo, say) can follow without changing anything that sends a text.

### Notifications on the phone app

The Android app gets its notifications through **UnifiedPush**, not Google: install a distributor app on the phone — [ntfy](https://ntfy.sh) is the usual one — and the vault's notifications go through it. Nothing else is needed on the server; the same keys that sign browser notifications sign these.

What the phone is sent says nothing a lock screen should not: _how many_ things need attention and the date, or a word for what happened — a new device signed in, a change of owner, this phone was signed out. No titles, no names. The app asks the vault for the rest once it is unlocked. Every message is encrypted to the phone (RFC 8291), so ntfy.sh and the servers between see only ciphertext and timing.

- **The public ntfy.sh works**, and needs nothing from you.
- **Your own ntfy on your network** also works, but the vault refuses by default to send anything to an address inside its own network — otherwise whoever registers a device could point the vault at your router or a cloud metadata service. Set `FDV_PUSH_ALLOW_PRIVATE_ENDPOINTS=true` in `.env` (it applies to both the API and the worker) if your distributor is on your LAN.
- Push addresses must start with `https://`.
- Signing out, signing a device out from another, a password change or reset, and taking a sign-in away all remove that phone's notifications at once — and tell the phone, so the app can forget what it holds.
- _Settings → Notifications_ lists every browser and phone that hears from the vault, marks the ones that have stopped working ("Not working — last tried …"), and sends a test to any of yours. A device the push service says is gone is removed by itself; one that keeps failing is marked after ten tries in a row.

### Where files are kept

Setup creates a local vault on the server (the `fdv_vault-data` volume) and uses it straight away. An owner can add an S3-compatible bucket under **Settings → Server and reading → Storage**: pick the provider (Amazon S3, Backblaze B2, Wasabi, Cloudflare R2, DigitalOcean Spaces, MinIO, or anything with an S3 address), paste the bucket name and two keys, and press **Test and save**. The test writes a small object, reads it back and deletes it, and tells you in plain words what happened. A place that has not passed its test cannot be chosen.

Objects are laid out as `<household>/<document>/<version>/<hash>.<ext>.enc`, with a version's thumbnail and page previews beside it (`….thumb.enc`, `….p1.enc`), so a bucket can always be read with the provider's own console — the files are ciphertext until the offline recovery tool (a later release) opens them with your recovery code.

A photo chosen for a person rests for a few seconds in `<household>/members/<person>/incoming/<photo>.enc`, encrypted as it arrived, while the worker makes it into a small square picture; then it is deleted, and so is a file the worker could not use. The picture itself is kept, encrypted, in the database, so the nightly backups carry it (a removed photo stays in them until they expire, 30 days by default). The nightly clean-up takes away anything left half made there for a day. The one thing a restore can leave behind in that folder is a photo that was on its way when the database was lost: unreadable ciphertext, since its key went with the database.

### Rotating the master key

Rotation moves everything the master key protects onto a new key, in one database transaction: it rewraps the small per-household keys, and seals again the secrets the vault keeps for you — each person's two-step sign-in, an S3 bucket's credentials, the household's mail password, and the household mailbox's app password set in Settings. The encrypted files themselves are never rewritten, so it takes seconds regardless of how much you store.

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

Rotate, with the new key in place of `<new key>`. It runs in the `migrate` service's container, which has the owning role the rotation needs (the api's does not):

```bash
docker compose run --rm --no-deps -e FDV_MASTER_KEY_NEW=<new key> migrate node apps/api/dist/cli.mjs rotate-master-key
```

It says how many keys and secrets it moved and how many sessions it ended. Then put the new key in `.env` as `FDV_MASTER_KEY` (or in your key file, if you use `FDV_MASTER_KEY_FILE`), start the vault, and back `.env` up again:

```bash
docker compose up -d
```

Use `up -d`, never `docker compose start` or `restart`: those keep the key the containers were made with, the old one. The vault does not start on a key that does not open it: the migrate service stops, the api and the worker do not start, and `docker compose logs migrate` says `FDV_MASTER_KEY does not open this vault`, and what to do (a worker started some other way says the same in its own log). If it does not come up after a rotation, look there first.

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
docker compose run --rm --no-deps -e FDV_MASTER_KEY_PREVIOUS=<old key> migrate node apps/api/dist/cli.mjs repair-master-key
```

It moves whatever is still under the old key onto the one in `.env` and signs everybody out; if anything opens with neither key, it changes nothing and says what. Then `docker compose up -d`. A backup made since that rotation is restored the same way, with `FDV_MASTER_KEY_PREVIOUS` set to the key before it.

If you ran that README's command exactly as written, it made the new key inside the command and never showed it, and `.env` still holds the key from before. Then it is the other way round: after it, documents would not open (downloads failed), while signing in, two-step sign-in, mail and an S3 bucket kept working; and the vault now says that no scope key opens but the secrets do. The per-household keys are under a key nobody has, and no repair can bring them back. Restore a backup made before that rotation, as in [Restoring](#restoring), with your `.env` as it is and without `FDV_MASTER_KEY_PREVIOUS`. Nothing made after that backup can be opened without the lost key.

## Upgrading

Images are version-tagged, and `latest` is the newest release (a milestone or a fix to one — never a development build or a release candidate); set `FDV_VERSION` in your `.env` to stay on one version until you choose to move (see [Pinning a version](#pinning-a-version)). Upgrade with the `docker-compose.yml` (and any other compose file you use) of the new release, your `.env` as it is, and `docker compose pull && docker compose up -d`. Database migrations run automatically on start, by [the migrate service](#the-migrate-service), and only forward: the way back from an upgrade is the image you had and the backup taken before it, restored with that image. An older release will not start on a database a newer one has upgraded (from 0.5.5; it says so in the API's and the worker's logs), because it would not see the documents in it. So take a backup first — `docker compose exec worker node apps/worker/dist/cli.mjs backup-now` — and if you ever need it, restore it as [above](#restoring). Breaking API changes are announced in [`docs/api-changelog.md`](docs/api-changelog.md) with a deprecation window of four minor releases, so an older mobile app keeps working against a newer server and vice versa.

### Pinning a version

`FDV_VERSION` chooses the vault's three images (api, worker, web); unset, it is `latest`,
which moves whenever a release does, at your next `docker compose pull`. To move only
when you decide, name the release in `.env`:

```bash
FDV_VERSION=0.9.0
```

and change it, then `docker compose pull && docker compose up -d`, after reading what
changed in [`CHANGELOG.md`](CHANGELOG.md) and taking a backup. For an exact image rather
than a tag, use its digest, from the release's build summary or
`docker buildx imagetools inspect ghcr.io/mansoor/family-documents-vault/api:0.9.0`, in a
compose override of your own (`image: ghcr.io/mansoor/family-documents-vault/api@sha256:…`,
and the same for `migrate`, `worker` and `web`). The other images the compose files run
(PostgreSQL, Caddy, Ollama) are pinned by digest in the files themselves. Use the compose
files of the release you name: an image from before 0.9.0-dev.74 has no `migrate`
command, so with this release's files its migrate service fails and nothing starts.

### Verifying the images

From 0.9.0 every image the release workflow pushes is signed with
[cosign](https://docs.sigstore.dev/cosign/system_config/installation/), keyless: the
signature is issued to this repository's release workflow for that tag, and recorded in
the public Rekor log. Each image also carries its build provenance and a software bill of
materials. To check an image before you run it (cosign 2 or later):

```bash
cosign verify ghcr.io/mansoor/family-documents-vault/api:0.9.0 \
  --certificate-identity-regexp '^https://github\.com/mansoor/family-documents-vault/\.github/workflows/ci\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

and the same for `worker` and `web`. It prints the verified signature, with the digest it
covers, or fails. To see what an image was built from, and what it contains:

```bash
docker buildx imagetools inspect ghcr.io/mansoor/family-documents-vault/api:0.9.0 --format '{{ json .Provenance }}'
docker buildx imagetools inspect ghcr.io/mansoor/family-documents-vault/api:0.9.0 --format '{{ json .SBOM }}'
```

### From 0.4.5 to 0.8.0

0.8.0 follows 0.4.5 as the release `latest` points to. There was no 0.6.0 and no 0.7.0:
their release candidates (0.6.0-rc.1, 0.7.0-rc.1 and 0.7.0-rc.2) never became releases,
and everything in them is in 0.8.0. The 0.5.x, 0.7.0-dev and 0.8.0-dev tags between were
development builds; from any of those, or from a release candidate, the same steps apply,
and the notes for a 0.5.x vault are in step 6. Its migrations (`0022` to `0072`) run by
themselves the first time the new API starts, in one go; nothing needs doing by hand.
0.4.5 has no guard against a database a newer release has upgraded, so **never start the
0.4.5 images on it again**: going back means restoring the backup below with them.

Run every command from the folder that holds your `docker-compose.yml` and `.env`, and
give each the same `-f` files (and `--profile public-only`) you always use.

1. **Take a backup, and copy it off the server**, with your `.env` beside it:

   ```bash
   docker compose exec worker node apps/worker/dist/cli.mjs backup-now
   ```

   It is written to `/data/backups` in the `fdv_vault-data` volume
   (`fdv-<time>.sql.enc`, the time in UTC). This copies the folder out, as `./backups`
   (run it while there is no `./backups` folder yet, or it lands in `./backups/backups`):

   ```bash
   docker compose cp worker:/data/backups ./backups
   ```

2. **Read the two changes that can break a 0.4.5 setup, and prepare for them first.**
   - **With the TLS overlay, `:8080` now answers this machine only** (it is bound to
     `127.0.0.1`). A device that still opens `http://<the server's address>:8080` beside
     the Caddy name stops reaching the vault: give it the `https://` address instead, or
     run without the overlay.
   - **Whose address is believed changed.** `FDV_TRUST_PROXY` now defaults to `network`,
     and the web container's nginx passes on the address a request came from, never what
     a caller wrote in `X-Forwarded-For`. With a reverse proxy of your own in front of
     `:8080`, every device is now recorded as the proxy, and shares one sign-in limit with
     every other: use the TLS overlay for the certificate instead, or put your proxy on the
     vault's own network in front of the API, as [Who is asking](#who-is-asking) says.
     `FDV_TRUST_PROXY=private` does not bring the old behaviour back for a proxy in front of
     `:8080`.

   Nothing else needs preparing: no setting was removed or renamed, and nothing an app or
   a script of yours calls has gone (see the 0.8.0 summary in
   [`docs/api-changelog.md`](docs/api-changelog.md), which says what answers differently).
   Bookmarks to the old Settings pages (`/settings/sharing`, `/settings/trash` and the
   rest) still open, at their new places.

3. **Bring the files beside `.env` up to the release.** The images are not all of it:
   `docker-compose.yml`, `docker-compose.tls.yml` and the `docker/` folder (the Caddy
   files, and the database's first-start script) come from your folder, and 0.4.5's would
   leave the new settings unpassed and the TLS overlay as it was. In a clone (your `.env`
   and `./backups` are not in git, and stay):

   ```bash
   git fetch --tags && git checkout v0.8.0
   ```

   Otherwise download `docker-compose.yml`, `docker-compose.tls.yml`,
   `docker-compose.dev.yml` and the `docker/` folder from the v0.8.0 release into the
   folder, keeping `.env` and any `docker-compose.override.yml` of yours. A line you
   changed in `docker-compose.yml` itself (the scanner folder's mount, say) is lost, and
   in a clone `git checkout` refuses until it is undone: move it into the override file
   first. The TLS overlay now needs Docker Compose 2.24.4 or later
   (`docker compose version`), for its `!override`. If you run the public-only site, every
   `docker compose` command from here on takes `--profile public-only` too, with the
   overlay's `-f` files.

4. **Rehearse the restore.** The restore drill restores the newest backup into a scratch
   database beside yours, checks it, and drops it:

   ```bash
   docker compose exec worker sh scripts/restore-drill.sh
   ```

   To rehearse the upgrade itself, restore the backup with the new images in a project of
   its own, `fdvrehearse`, which shares nothing with your vault but the backup file and
   `.env`. Name your backup's file in place of `fdv-<time>.sql.enc`:

   ```bash
   FDV_VERSION=0.8.0 docker compose -p fdvrehearse -f docker-compose.yml pull api worker
   FDV_VERSION=0.8.0 docker compose -p fdvrehearse -f docker-compose.yml up -d --wait postgres
   FDV_VERSION=0.8.0 docker compose -p fdvrehearse -f docker-compose.yml run --rm --no-deps -v "$PWD/backups/fdv-<time>.sql.enc:/restore.sql.enc:ro" worker node apps/worker/dist/cli.mjs restore-backup /restore.sql.enc
   docker compose -p fdvrehearse -f docker-compose.yml down -v
   ```

   It brings the 0.4.5 backup up to date (`backup brought up to date`, with 51 migrations),
   and ends by saying what it restored — households, people, documents, `database schema
72` — and what a restore leaves to do. As the rehearsal has none of your files, it also
   says they could not be looked for. Its last line says to start the vault: in a
   rehearsal, don't. On Windows, in PowerShell, set the version first (`$env:FDV_VERSION = "0.8.0"`), leave
   `FDV_VERSION=0.8.0` off each line and write `${PWD}` for `$PWD`; then
   `Remove-Item Env:FDV_VERSION`. In Git Bash on Windows, put `MSYS_NO_PATHCONV=1` in
   front of the restore line too, or Git Bash turns `/restore.sql.enc` into a Windows
   path and the restore says it cannot read `C:/Program Files/Git/restore.sql.enc`.
   Start no worker in a rehearsal (it would send real
   reminders from restored data), and only ever use `down -v` with `-p fdvrehearse`.

5. **Upgrade.** Set `FDV_VERSION=0.8.0` in `.env`, then:

   ```bash
   docker compose pull
   docker compose up -d
   ```

   The database is migrated first — by the API as it started, in 0.8.0; from
   0.9.0-dev.74 by [the migrate service](#the-migrate-service) — and the rest wait for it.

   With the TLS overlay, start Caddy again too. It reads its Caddyfile only when its
   container starts, and `up -d` leaves a container whose own definition has not changed
   as it is, still serving 0.4.5's Caddyfile:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d --force-recreate caddy
   ```

   With the public-only site, add `--profile public-only` and name `caddy-public` after
   `caddy`.

6. **Check that it took.** The API's log says how many migrations it ran (51, from 0.4.5),
   and the vault says which version it is:

   ```bash
   docker compose logs api | grep migrate
   curl -s http://localhost:8080/api/v1/capabilities   # or your FDV_PORT
   ```

   The first says `[migrate] 51 applied` (and `up to date` on every start after), and the
   second starts `{"product":"family-document-vault","server_version":"0.8.0"`. Sign in:
   every person, document, reminder and Only me document is as it was. A share link made
   on 0.4.5 still opens, with its PIN, until it ends (its address is the old kind,
   `/shared/…`, which 0.9.0 will stop answering). If you ever restore the backup from
   step 1 on 0.8.0, as [Restoring](#restoring) says, everybody but the owners is paused
   until an owner turns them back on, which needs that owner's two-step sign-in or a
   passkey: an owner from 0.4.5 without either turns it on first.

   **From a 0.5.x development build** (or a 0.7.0 release candidate) the steps are the
   same, with fewer migrations: from 0.5.35, the restore drill says `schema=55`, the
   rehearsal `backup brought up to date` with 17, and the API `[migrate] 17 applied`
   (`0056` to `0072`). The two changes in step 2 came in 0.5.33: from 0.5.33 or later
   there is nothing to prepare. Step 3 still matters: 0.8.0's `docker-compose.yml` passes
   the settings for the scanner folder, email in and computers, which no earlier one
   does. A share link
   made since 0.5.14 is the new kind (`/s#…`) and opens as it did.

7. **What to look at afterwards.** What is new needs no setting, with three exceptions
   worth a minute: `FDV_SMTP_URL` (a mail server of yours, for password-reset links and
   the codes a share link can ask for: see [Passwords](#passwords)); `FDV_PUBLIC_URL` and
   the public-only site, for share links and requests to send documents that reach people
   outside your network (see
   [Links for people outside the family](#links-for-people-outside-the-family)); and
   two-step sign-in or a passkey for every owner, without which an owner cannot lock a
   sign-in, start a reset, sign somebody out everywhere, limit what a viewer sees, change
   another person's identity details, or decide whether Only me documents can be shared
   outside the family (Settings → Privacy; on unless an owner turns it off). Making a
   document Only me now asks what becomes of your own links to it: they end, unless you
   keep them. A viewer who already had a sign-in keeps seeing the family's documents until
   an owner limits them (People → their name → Account); no viewer sees birthdays, the
   household's answers, or where the paper originals are kept. A will, a vehicle logbook,
   an employment contract or a title deed with no expiry no longer needs one: such a
   document that said "Needs an expiry date" is complete now.

   **The settings that are new or changed since 0.4.5** (each is in
   [Configuration](#configuration), with its default; none is needed):
   - changed: `FDV_TRUST_PROXY` defaults to `network` (was `private`; step 2);
     `FDV_SMTP_URL` also carries the codes a share link can ask for, and the codes that
     confirm an address for email in; the worker takes every `LOG_LEVEL` the API does
     (`trace` and `fatal` too); `FDV_MAX_UPLOAD_BYTES` is also the largest file the
     scanner folder and email in take (0.8.0's compose file passes it from `.env` to the
     worker too);
   - new: `FDV_PUBLIC_URL`, `FDV_PUBLIC_HOSTNAME`, `FDV_PUBLIC_HTTPS_PORT` and
     `FDV_PUBLIC_HTTP_PORT` (the public-only site), `FDV_SHARE_MAX_DAYS`,
     `FDV_RATE_LIMIT_PER_MINUTE`, `FDV_OFFLINE_MAX_DAYS` and
     `FDV_PUSH_ALLOW_PRIVATE_ENDPOINTS` (the phone app), and `FDV_MASTER_KEY_PREVIOUS`
     (given to a restore, never kept in `.env`);
   - new in 0.8.0: `FDV_WATCH_DIR`, `FDV_WATCH_STABLE_SECONDS` and
     `FDV_WATCH_INCOMPLETE_GRACE_SECONDS` (the scanner folder); `FDV_MAIL_IN_HOST`,
     `FDV_MAIL_IN_PORT`, `FDV_MAIL_IN_USER`, `FDV_MAIL_IN_PASSWORD` or
     `FDV_MAIL_IN_PASSWORD_FILE`, `FDV_MAIL_IN_ADDRESS`, `FDV_MAIL_IN_FOLDER`,
     `FDV_MAIL_IN_POLL_SECONDS`, `FDV_MAIL_IN_AFTER` and `FDV_MAIL_IN_AUTHSERV_ID` (email
     in); `FDV_DEVICE_DAILY_BYTES` and `FDV_DESKTOP_DOWNLOAD_URL` (computers).

   **Three new pieces, each optional and each off until you set it up:**
   - **the scanner folder**, a folder on the server a network scanner saves into
     (`FDV_WATCH_DIR`): see [Scanning straight into the vault](#scanning-straight-into-the-vault);
   - **email in**, a household mailbox the family sends documents to (`FDV_MAIL_IN_*`):
     see [Emailing documents to the vault](#emailing-documents-to-the-vault);
   - **computers**, the family's own computers sending scans with the uploader app
     (`FDV_DEVICE_DAILY_BYTES`, `FDV_DESKTOP_DOWNLOAD_URL`): see
     [Sending scans from a computer](#sending-scans-from-a-computer). This one is on
     already: anybody who adds documents finds it in _Settings → Your computers_.

   **The web app has a new layout**: a sidebar from 1024 px (icons alone from 768 px, and
   the bottom bar on a phone), with Documents as a table to sort, filter and act on many
   at once, Inbox, Sharing, Activity and Trash each a page of their own, and Settings in
   sections (Your account, Your computers, Notifications, Privacy, Kinds of document,
   Your data, For owners). **Add → Many documents** sends up to 200 files at once into **Inbox → Your
   uploads**, where the vault reads each, suggests what it is, and waits for you to accept
   it; nobody else sees them until you do. A file already in the vault says so, and a
   renewal can be added as a new version of the document it renews. Inviting somebody can
   start as you add them (see [Inviting the rest of the family](#inviting-the-rest-of-the-family)).

   **Which apps need which vault.** Every app released so far works with 0.8.0, without
   what came after it:
   - the phone app's **0.3.x** adds **Send to my Inbox**, which needs a vault of **0.7.0
     or later** (0.8.0 here); with an older vault it works as 0.2.3 did;
   - the **uploader for computers, 0.1.0**, needs a vault of **0.8.0 or later**;
   - an older phone app, and any script written against 0.4.5's API, keep working.

## Developing

Requirements: Node 22, pnpm 9, Docker.

```bash
pnpm install
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres   # a database for tests
DATABASE_ADMIN_URL=postgres://fdv:<FDV_DB_PASSWORD>@localhost:5432/fdv pnpm check   # lint + typecheck + tests
docker compose up -d && pnpm e2e                                                  # end to end, in a real browser, against the containers
```

Integration tests run against a real PostgreSQL: each test file creates its own throwaway database, migrates it, and drops it. Without `DATABASE_ADMIN_URL` those tests are skipped and only unit tests run.

For a live-reloading API and web app: `pnpm --filter @fdv/api dev` and `pnpm --filter @fdv/web dev` (the Vite dev server proxies `/api` to port 3000). On a fresh database the API writes the setup code to its output as it starts (`[setup] …`), unless `FDV_SETUP_TOKEN` is set. `DATABASE_URL` must be the application role, not the owning one: the API refuses to start otherwise. The end-to-end run reads the setup code from `.env` (or `FDV_SETUP_TOKEN`), and its first owner sets up two-step sign-in with an authenticator app, whose key it keeps in `.e2e-owner-totp` (or reads from `FDV_E2E_TOTP_SECRET`) for every later sign-in, the restore drill's (`scripts/ci-restore.sh`) included.

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

**Phone apps the vault works with.** [`apps/api/src/phone-apps.json`](apps/api/src/phone-apps.json)
lists every phone app released, with the vault tag whose `packages/client` it carries, and
`min_client_version`, the oldest app this vault works with: the one place either is
written. Each phone release adds its row there, with the exact tag its `vendor/fdv` submodule
points at. CI (and `node scripts/test-focused.mjs`)
runs the client contract with the client of every app at or above the minimum, each as at
its tag (`pnpm test:older-client --all-supported`): a server change that breaks a
supported app fails until it is fixed, or until the minimum is raised on purpose — every
app below it is then told to update (`426 app_update_required`) on its next call.

## Licence

The vault — the server, the worker and the web app — is [AGPL-3.0](LICENSE). Self-host it, modify it, run it for your family; if you run a modified version as a service, share your changes.

Two packages are MIT instead, so that anyone can build an app that talks to a vault, under whatever licence they like:

- [`packages/shared`](packages/shared/LICENSE) — the API's types and the helpers every client needs (dates, statuses, reminder wording, design tokens);
- [`packages/client`](packages/client/LICENSE) — the API client, its fake vault for testing, and the contract both are held to.

Each has its own `LICENSE` file; everything else in the repository is under the root [LICENSE](LICENSE). `pnpm lint` checks that neither MIT package depends on, or imports, anything else in the repository, and `pnpm client:pack` that the client's release tarball carries nothing but those two packages' code.
