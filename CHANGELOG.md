# Changelog

All notable changes to Family Document Vault. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Opening an Essential asks you to confirm it is you "to open an Essential document". It used to say "a document only you can see" about a passport the whole family can see.
- The thumbnail of an Essential or an Only me document is no longer kept in the browser's cache.
- **Sessions last as long as they are used, up to six months.** A session now lasts 30 days from when it was last used, and 180 days at most from the sign-in — for browsers and the phone app alike. Before, it ended 30 days after the sign-in however much it was used. Sessions open before the upgrade count their 180 days from when they began, so one older than that asks for the password at its next refresh.
- **Each phone is recognised as itself.** The app sends a random installation id (`X-FDV-Installation`), and new-device alerts go by it: updating the app no longer raises an alert, and a second phone on the same app version does. The alert and the list of signed-in devices name the phone: "the app on a Google Pixel 8a". A phone already signed in raises one alert the first time it signs in again after the upgrade, as the vault meets its installation id for the first time.

- `packages/shared` and `packages/client` are now MIT-licensed, so apps that talk to a vault can use them under any licence. The vault itself — server, worker and web app — stays AGPL-3.0. `pnpm lint` fails if either package starts using anything from the AGPL code.

### Added

- **The phone app can keep the Essentials for when there is no connection** (the app's side comes in its next release). The vault decides which: the Essentials each person can see — a teen only their own, a viewer none — and your own Only me ones only if you choose. It asks for your password once, lasts 30 days at most, and ends when the phone is signed out or your password changes; Settings → Signed-in devices says which devices keep Essentials. What was opened without a connection is in the activity log once the phone is back online. `FDV_OFFLINE_MAX_DAYS` (90 by default) is how long a phone may show them without checking in.
- **Read a document without downloading it.** Tap a document's preview and its pages open full size, one at a time: fit to the window, larger when you want to read the small print, turned with the arrows. The vault draws the pages itself, on your server, and keeps them encrypted like the file; Essentials are ready ahead of time, so the phone app can keep them for when there is no signal. The activity log says who looked at what — once per sitting, not once per page.
- iPhone photos (HEIC) now get a thumbnail and page previews: the worker image includes ImageMagick's HEIC support.
- **A phone that loses a refresh answer stays signed in.** On a network that drops answers, a phone could spend its refresh token without hearing back, and the next try looked like a stolen token — signed out. Now the token just replaced may be tried once more, within 30 seconds, from the same app installation; any other replay still signs the device out, for its owner and for a thief alike.
- **A session that ends says why** — expired, signed out, its token used twice, or the person taken out of the household — so the app can say so plainly (`error.reason`).
- **Documents say who issued them.** A family has a dozen bank statements, bills and letters from the same months; now each says whose it is — "Bank statement · Barclays · Sep 2026" — in lists and search results, without opening it. The card asks for it (with the household's own issuers to pick from, and, for a document already in the vault, a suggestion from its letterhead: "From Barclays?", filled in only if you say so). Search finds documents by who issued them and can narrow to one issuer. Statements, bills and policies are named for their issuer: "Barclays statement, September 2026". What a type used to call its issuer (its institution, provider, lender, insurer…) moves into this field; nothing is lost. Like a title, an Only me document's issuer is never shown to anyone else and never goes by email.
- **Adding a document asks what it is before anything is sent.** Choose the file, fill in the card — what it is, whose it is, who can see it, the dates — and Save; the file and its details go to the vault together. A document marked Only me is locked to you from the moment it arrives, never briefly visible to the rest of the family. Skip saves it with no details, to fill in later. Dates can be typed the way people write them: "14 Mar 2031", "March 2031" or just "2031". The name fills itself in from the person you choose ("Aisha's passport"), not from whoever is filing it, and the card says when you'll be reminded.

- **Adding a document can be retried safely.** If the connection drops or the answer is lost on the way back, trying again never makes a second copy: the vault recognises the same upload and answers with what the first try made. Choosing the same file again after an error in the web app counts as trying again. An upload that fails leaves nothing behind — no empty "Needs info" document — and one that overlaps an earlier try still arriving waits for it rather than doubling up. For apps: `GET /api/v1/uploads/{key}` says what became of an upload (see the API changelog).

### Fixed

- **A spreadsheet could run text from an export as a formula.** `index.csv` wrote a title, issuer, note or tag starting with `=`, `+`, `-` or `@` as it was, so opening the file in Excel or LibreOffice could run it — and any member can write a title. Such cells now start with an apostrophe and open as the text they are.
- A file larger than the vault's limit was cut off at the limit, and the part that arrived was kept as a new copy of the document before the vault said it was too big. Nothing is kept now.
- "Too many requests" said the request was wrong and not worth retrying. It now says to try again, and when.
- A new copy of a document uploaded at the moment the document was made private (or un-private) could be kept under the old setting, after which the document could never be moved again. The two now wait for each other, and an upload that finishes after such a change is refused so it can be sent again.

- **Once a request to take away somebody's owner role had lapsed, nobody could ask again.** A request nobody carries out lapses after thirty days, but nothing recorded that it had: the vault went on treating it as waiting, the People screen stopped showing it — so it could not be withdrawn — and asking about that person again said "Somebody has already asked for this". A lapsed request is now recorded as lapsed, including any that lapsed before this release, and asking again starts afresh, with the full seven days' notice and everybody told. A lapsed request can no longer be refused or withdrawn either: nothing will happen, so there is nothing to act on.
- Two owners asking at the same moment to take away the same person's owner role got an error; the second now hears that somebody has already asked.
- **A request about somebody who had stepped down could still be carried out.** An owner under notice who stepped down of their own accord — to a teen or a viewer, say — left the request standing: seven days later "Carry it out" made them an adult and told them they were no longer an owner. Stepping down now closes the requests about you, and a request is only ever carried out on somebody who is still an owner.
- An owner withdrawing a request was recorded as the person refusing it, so its history read "Sam refused" about something Sam never did. A withdrawal is now recorded as one — "You withdrew it" — and the ones made before this release are put right from the activity log.

## [0.4.5] - 2026-09-23

A fix every vault should take before it ever needs a backup, and the work
tagged 0.4.3 and 0.4.4 on the development branch.

### Security

- The nightly backup gave `pg_dump` the database owner's password on its command line, where any user of the machine could read it in the process list while the backup ran. It is passed in the environment now, as the restore's is — unless the connection string uses a setting that has no environment variable, which keeps the old way rather than lose the setting.

### Fixed

- **Restoring a backup gave a vault that could not read itself.** The nightly backup leaves out who may do what in the database, so that it loads anywhere — and nothing put that back, so a vault restored the way the README said could open none of its own data, or queue any work. The vault now gives its database user exactly its rights on every start, so a database restored from any backup already on disk can read itself from the first time the vault starts on it. **If you have restored a backup by hand, upgrade, then have everybody change their password**: a hand restore brings back sessions that had been signed out since the backup, and a password change ends them.
- **Restoring is one command now, and it checks its work.** `restore-backup` loads a backup into an empty database — never over one in use — brings a backup from an older release up to date, refuses one from a newer release, and checks the result the way the vault will read it before it says it is done. A file that was cut short or altered restores nothing at all. Everybody is signed out in the same transaction, and requests to change who is an owner are withdrawn to be asked again: a backup brings back sessions, passwords and refusals that were ended or changed after it was made. The README has a new Restoring section with the steps, for a lost database and for a new machine.
- A backup is written under a temporary name and renamed when it is whole, so one cut short by a restart can never be taken for the newest. The database's health check now waits for the server the vault connects to, not the setup server a new volume starts with first.
- The restore drill counted rows as the database's owner, so it passed backups the vault could not have used. It now restores into a scratch database and checks it as the vault's own database user, through the same privacy rules, then removes the copy, even if it is interrupted. CI now backs up the end-to-end vault, loses its database, restores it as the README says and signs back in, on every change.
- The README said database migrations could be reversed one version back. They cannot; the way back from an upgrade is the backup taken before it, and the README now says to take one.
- **Every vault said it was version 0.0.1.** The capability document now reports the release it actually is, stamped into the image when it is built; a release can no longer be tagged with a different number.
- The capability document said push notifications and share links were switched off, long after both had shipped. They now say what the vault can do: share links are on, and push is on whenever the vault has its notification keys.
- Amber status text — "Expires in 12 days", "Needs a name" — was too pale to read comfortably (3.6:1 against white, below the WCAG AA 4.5:1). It is darker now, and the red is too.
- Text boxes and drop-downs had an edge too faint to find (1.3:1 against white); it is now at least 3.5:1, as WCAG asks of a control's outline.
- **Reloading Settings could sign you out.** Its panels each asked for a fresh sign-in token at once, the vault saw one refresh token presented four times, took it as stolen and ended the session. Every screen now shares one refresh, however many things ask for it together.
- Losing the network looked like having no documents: the household appeared empty. It now says the vault cannot be reached, and you stay signed in for when it comes back.
- Two "confirm it's you" prompts at once could leave one of them waiting for ever. They now share one prompt, and both carry on when it is answered.

### Changed

- The colours, sizes, category names and member colours the apps draw with are now written once, in `@fdv/shared`, for the web and the phone alike; a test fails if the web's stylesheet ever disagrees with them, has a value they lack, or writes a colour outside them.
- The web app now talks to the vault through `@fdv/client`, a new package with no browser code in it, so the phone app can use the same client. The wire types moved to `@fdv/shared`, where the server uses them too.

## [0.4.2] - 2026-09-23

A privacy fix that every vault with more than one person in it should take, and
the password work that was tagged 0.4.1 on the development branch.

### Security

- **The reminder digests leaked titles across the privacy wall.** The daily and weekly digests — push and email alike — were built once for the whole household and sent to everybody in it. So the title of one adult's _Only me_ document reached the other adult's lock screen and inbox, and _Adults only_ titles reached teens and viewers. Titles, due dates and reminder notes were exposed, never a document's contents, but a title is often the sensitive part. Each person now gets their own digest, cut to what they may see by the same rule every list in the app uses, and somebody who may see none of it is sent nothing. Every email now goes to one address, not the whole family on one To: line. Present since 0.4.0, when other people could first be given a sign-in. **Upgrade if anyone besides you signs in to your vault.**
- **An owner could download another adult's export**, and with it that adult's _Only me_ documents: an export is built from what its requester can see, and the download let any owner through. An export is now its requester's alone; nobody else can list it, look it up or download it.
- **Taking somebody's sign-in away and then inviting them again handed their private documents to whoever accepted the invitation** — and whoever makes an invitation holds both its link and its code. A person who has had a sign-in can no longer be invited. An owner gives them their own sign-in back instead, from their page in People, and they sign in with the password only they know.
- **The list of shared links showed teens and viewers the titles of _Adults only_ documents** that had been shared out of the house, and **the tag list applied no rule at all**, so anybody could read the tags on documents they could not open. Both now follow the same rule as every other list.
- **A co-owner could take over another adult's account through the mail server.** The mail server set up in the app is one any owner can change, and password-reset links went through it — so an owner could point it at a mailbox of their own, ask for another adult's reset, and read their private documents. Reset links now go only through a mail server that nobody in the family can redirect: a new `FDV_SMTP_URL` set in `.env` by whoever runs the server, or the household's own, but only to its one owner. Otherwise nothing is sent and whoever runs the vault makes the link. **If more than one person signs in to your vault, set `FDV_SMTP_URL`** — see the README. For the same reason no email names a private document any more, even to the person it belongs to, and every other adult is told when the mail server is changed.
- **A share link outlived the reason it was allowed.** A link made to a family document kept working after its owner made it _Only me_, and after the person who made it was demoted to teen or viewer or had their sign-in taken away. A link now works only while the person who made it could still open the document themselves, asked every time it is opened. An export stops being downloadable once the person who asked for it can no longer see the adults-only documents in it.
- **Anyone could make themselves the owner of another adult's document and then mark it _Only me_**, taking it from the person it belonged to without it showing in their activity. A document that belongs to somebody with their own sign-in is now theirs to hand over, and a private document does not change hands at all.
- **Adding a passkey needed no second look**, so a few unattended minutes with an open session bought permanent access that outlived any later password change. Adding or removing one now asks for your password or an existing passkey, and a password reset removes every passkey. Starting two-step sign-in again no longer quietly switches it off.
- **Whoever sent an invitation chose the address the new person would sign in with — and so where their password resets would go.** An inviter who used an address they could read could later reset the person's password and read their private documents. The person joining now chooses their own sign-in address, and is told why it matters.
- **Switching on two-step sign-in needed no second look**, so a borrowed session could add its own authenticator and then pass every later check with it, up to setting a new password. It now asks for your password or a passkey first, as adding a passkey does.
- **Downloading an export asked nothing**, although asking for one did; it holds every _Only me_ document you have. It now asks too. Making a document private retires the exports other people made while they could see it, and an export that finishes building after its requester was demoted comes out already expired.
- An adult could quietly replace an owner's pending invitation with one of their own. Only whoever sent it, or an owner, can now.
- A person with no sign-in who owns private documents is no longer invited, since whoever accepted would get them.
- Replaying an upload's `Idempotency-Key` against a different document returned the other document's version — which could be somebody else's private upload, with its file name. It is refused now. A retried capture returns what the first attempt made instead of adding an empty document.
- A stored file's name in your storage no longer contains a fingerprint of its contents, which let whoever controls the bucket confirm that a file they already had was among somebody's private documents. Files stored before this keep their names.
- An upload that finishes after its document was made private is refused and asked to try again, rather than stored under the wrong key.
- Making a share link to a private or Essential document now asks who is asking, as opening it does.
- A teen can no longer add a new copy of somebody else's document.
- Several requests about another person's private document — changing who can see it, deleting its reminder, revoking its link, opening its file from a session that had gone cold — answered "not allowed" rather than "not there", which confirmed it existed. They now say it is not there, as everything else does.
- **A browser kept receiving notifications after its person signed out of it** — on a shared laptop, the next person to sit down saw the last one's digest — and a browser used with a stolen session kept receiving them after the password was changed. Notifications now stop when the sign-in that turned them on ends, a password change stops them everywhere else, and signing out of the web app turns them off for that browser.

### Added

- **Change your password**, in Settings. It also rewraps the key to your own _Only me_ documents, so they come with it rather than being left behind, and every other device you are signed in on is signed out. Somebody who signs in with a passkey and never had a password can set one by confirming it is them instead.
- **Forgotten password.** The sign-in page sends a link to the address you sign in with; it works once and stops working in an hour, and using it signs every device out. It does not sign you in, so two-step sign-in is still asked for afterwards. The page answers the same way whether or not the address is known.
- For a household with no mail server, `reset-password <email>` on the command line prints a one-time link for whoever runs the vault to hand over. **No owner or adult can reset anybody else's password**, deliberately: they could then sign in as that person and read their private documents.

### Fixed

- **Forgotten-password emails had no link in them.** The server dropped the link, and the "email only" flag, when it queued the message, so the email's button went to the front page and "your password was changed" was also pushed to lock screens. The tests passed because they used a separate, correct copy of the same code; there is now one copy. The link is also in the plain-text part of the email now, for mail clients that show no buttons.
- One mistyped address in the family no longer stops everybody else's email. Each person's digest is its own message now, and a mail server refusing one recipient used to mark the whole household's mail server as broken, which also silenced the security alerts.
- The API container was never given `FDV_BASE_URL`, `FDV_RP_ID` or `FDV_TRUST_PROXY`, so setting them in `.env` did nothing to it. Passkeys were checked against `http://localhost:8080` whatever address the vault was actually published at, which broke them on any TLS or non-default-port setup; `FDV_TRUST_PROXY` silently stayed on its default. Found while checking where a password-reset link pointed.
- A setting written as an empty string — which is what Compose hands a container for anything optional — is now treated as unset rather than as a value that fails validation at startup.
- A mistyped password inside the app — at the step-up prompt, or in the change-password form — signed you out, because the web app treated every 401 as a dead session. Only the two codes that mean the session is over end it now.

## [0.4.0] - 2026-09-23

Phase 3 — **Family.** The vault stops being one person's and becomes the
household's: other people can be given a way in, what each of them may do is
one enforced table, and the wall around "only me" now has an adversarial test
suite standing against it.

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
- A teen's documents are their own: one they add belongs to them, they can change and bin their own, and they can do neither to anybody else's.
- Passkeys. Sign in with a face, a fingerprint or a screen lock: nothing to remember, and nothing a convincing copy of the sign-in page could take, because the device checks the address itself. Add one per device in Settings, name them, remove them. The server keeps only a public key. A passkey also satisfies the rule that an owner cannot rely on a password alone, so an authenticator app is no longer the only way to meet it.
- HTTPS for the rest of the house: `docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d` puts Caddy in front of the vault, either with a certificate it issues itself for a name on your own network, or a real one from Let's Encrypt for a name you own. Browsers only treat `http://localhost` as secure, so until now a phone on the same wifi could not use passkeys, receive the day's reminders, or install the vault to its home screen. The README explains all three routes, including the one worth taking: Caddy plus a VPN, with nothing exposed to the internet.

### Fixed

- A change of role took up to fifteen minutes to take effect, because the role travelled in the sign-in token. It is now read from the household on every request, so somebody just made an owner is one immediately.
- A teen could move any family document to the trash, and restore it, although they could not edit one. The rule that a teen changes only their own documents now covers the trash as well.

### Changed

- `POST /api/v1/documents/{id}/visibility` answers `200` with the notice instead of `204`. See `docs/api-changelog.md`.
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
