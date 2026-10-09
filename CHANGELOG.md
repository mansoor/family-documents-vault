# Changelog

All notable changes to Family Document Vault. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.7.0-dev.8] - 2026-10-09 — Phase 6, R5: the whole app as one

### Changed

- **Every page has its own title** in the browser tab and history, such as "Documents – Family Document Vault". A title never names a document or a person.
- **Back from a document** returns to where you opened it, and the table's sort, filters and chosen rows are kept. Focus goes back to the row you opened. Opened from a link, Back goes Home. Edit, then Save or Back, no longer sends you round in a loop.
- **Focus no longer drops to the top of the page** when you:
  - go from Welcome to Sign in, sign in, or sign out;
  - choose a file to add;
  - share a link;
  - change who can see a document.
- **The reader's +, − and = keys** follow the single-key shortcuts switch, which is now called "Single-key shortcuts" and lists every key it turns off.
- **Search keeps everything you type**, even typed quickly, and stays in step with Back and Forward.
- **Pages that are loading or couldn't load** say so: Home, Needs attention, the Trash and the Documents count.
- **Moving a document to the Trash from its page** now says so on Home, once.
- **The same words everywhere:** "Move to the Trash", and "Who can see it".
- **At 400% zoom** the phone list's Select bar no longer covers the rows.
- **The "files are waiting" email** links to Inbox → Files sent to you.
- **README:** the Trash is emptied only by an owner, and signed-in devices are under Settings.

### Added

- **End-to-end tests at 1280 × 800** for the sidebar and `/`, the Documents table, a document's two panes, and a batch through the queue.

## [0.7.0-dev.7] - 2026-10-09 — Phase 6, R4: Home, People, Collections, Activity and Trash for wide screens

### Changed

From 768 px wide, these screens use the width. On a phone each stays as it was.

- **Home** is a dashboard of cards: Needs attention, Recently added, Categories, People and Collections, plus Your uploads waiting for those who add many. Its notices stay above the cards.
- **People** is a table of the family, with name, relationship, role, sign-in and number of documents. Owners have Family and Outside the family as tabs.
- **Collections** is a grid of cards: how many documents, whose, who it's for, and who it's shared with.
- **Activity** is a table of when, who and what happened.
  - Filters for who, what happened, and from and to. The dates are the household's days, and the address keeps the filters.
  - Times are on the household's clock.
  - On a phone, Activity gains the filters and links to the documents too.
- **The Trash** is a table where you can choose many and bring them back. Owners can also remove them for good, with the usual asks and one "Confirm it's you" for the whole run. Anything that can't be done is named and stays chosen.

### Added

- **API:** each line from `GET /api/v1/audit` gains `actor_member_id`, given only when the line itself names that member, and a coarse `kind` (added, changed, opened, shared, people, sign-in, trash). Older clients ignore both.

## [0.7.0-dev.6] - 2026-10-09 — Phase 6, R3: a document in two panes

### Changed

- **A document's page has two panes from 768 px.**
  - **The left pane holds the details:** status and who can see it, Download, suggestions, the facts, other details, notes, history, collections, sharing and the Trash.
  - **The right pane holds the pages,** beside them as you scroll. Page 1 shows on arrival. Turn pages with Previous/Next, or with Page Up and Page Down while the pages have focus. Open them full size in the reader.
  - **Essential and Only me documents** ask you to confirm it's you before their pages show.
- **On a phone** the page is one column as before. The pages now come right after the facts, so you no longer scroll to the bottom to reach them.
- **Notes now come before the history** of versions.
- **One page viewer** now serves both the document page and the review queue.
- **Wording:** when the vault couldn't draw a PDF's pages, the page now says so, rather than calling it a kind of file the vault doesn't draw.

## [0.7.0-dev.5] - 2026-10-09 — Phase 6, I3: the review queue

### Added

- **The batch's page is a review queue.**
  - **Filters:** Ready, Check, Not recognised, Problems and Done, each with a count. The address keeps the filter.
  - **Accept all Ready** asks first, then files every file that is Ready at that moment. A toast with **Undo** stays until you close it, and Undo works for 5 minutes. Undo takes the files back into the queue, unless someone else has already done something with the document: opened, downloaded or shared it, added it to a collection, set a reminder, exported it, or changed it.
- **Each file opens in two panes:** the details on the left, already filled from what the pages say, and the pages on the right, with keyboard paging.
  - **Accept and next** (Enter) files it and opens the next one.
  - **Skip** moves on without deciding.
  - **Not a document, remove it** asks first.
  - A duplicate's button reads "Accept anyway".
  - At the end, the queue says what was done.
- **Your uploads in the Inbox** gains "Accept all Ready (n)" and "Review n" for each batch.

### Changed

- **API:** `POST /api/v1/batches/{id}/accept-ready` and `…/accept-ready/undo`, `GET /api/v1/batches?with=levels`, and the feature flag `features.batch_review`.
- **Opening or downloading a document waits for an Undo of it** that is under way, and answers "not found" if the Undo removed it.
- A write that races the removal of what it refers to now answers 409 `gone_meanwhile` instead of failing.
- Removing a storage place that still holds files is refused with 409 `vault_has_files`.

### Database

- **Migration 0064** adds the Undo window for files accepted together, and the database rules that let only their uploader take them back, within it, and only while nobody else has touched the document.

## [0.7.0-dev.4] - 2026-10-08 — Phase 6, I2: the vault reads each upload and suggests

### Added

- **The vault reads each file in your uploads** once its first page is drawn. It reads one file at a time for each household, so a big batch never holds up anyone else.
  - **What it suggests:** the kind, whose it is, the dates, the number and who issued it, each with how sure it is.
  - **Privacy:** what it reads and suggests is sealed, kept only until you decide, and seen only by you. It never draws on documents you cannot see.
- **Each file gets a level and tags** on the batch's page.
  - **Ready:** the kind and person are clear, and nothing the kind needs is missing.
  - **Check:** something is unsure or missing, or the pages disagree with the batch: "The pages say Sara, the batch says Ahmed".
  - **Not recognised.**
  - **Problems:** a duplicate, or pages that couldn't be read (blank, password-protected, too slow, or out of the vault's reach for a day).
  - **Kinds that usually stay narrower:** when the pages look like a medical record or similar, who can see it is kept narrower, and the tag says so.
  - **Teens:** a teen's upload is always their own. When the pages name someone else, the file is not Ready.
- **The "Is this right?" card starts from what the pages say.**
  - Each suggested detail is marked with how sure the vault is ("suggested · 92%"), and the mark goes when you change it.
  - When the pages and the batch disagree, the card shows both values, and the pages' value is one click away.
- **The batch's page says how reading is going**: "Reading 3 of 20…", or "Waiting its turn to be read" behind other uploads.

### Changed

- **API:** batch items gain `read_failure`, `level`, `tags`, `proposals` and `clashes`, behind the feature flag `features.batch_proposals`. Accepting is unchanged: it takes what you send, plus the batch's defaults.

### Database

- **Migration 0063** keeps each upload's read text and suggestions, sealed, until the file is decided. It also tracks reading attempts.

## [0.7.0-dev.3] - 2026-10-08 — Phase 6, I1: many documents at once

### Added

- **Add → Many documents** on a computer. Choose files or a folder, or drop them, up to 200 at a time.
  - **Defaults for the whole batch (optional):** whose documents they are, the kind, who can see them, where the paper copies are kept, a collection, tags, and Essential.
  - **Sending:** files go up one after another. Progress is shown for each file and for the batch. You can stop after the current file, and send the rest later.
  - **Refused files:** a file the vault refuses is listed with the reason, and the rest carry on.
  - **Leaving the page:** the upload carries on while the vault is open in the tab, and a strip at the top shows how far it has got.
  - **Carrying on:** a batch can be carried on later. Files already in it are skipped.
- **Your uploads, in the Inbox.** It sits beside Files sent to you, and lists your batches with how many files wait in each and when the batch ends.
  - **A batch's page** lists its files with their first page, size and any duplicate: a document already in the vault, or a file already in your uploads.
  - **Accept** opens the "Is this right?" card, filled from the batch's defaults where a detail is blank, and files the document with every detail: kind, title, person, dates, number, who can see it, where it is kept, collection, tags and Essential.
  - **Remove** takes a file away, and **Remove the batch** takes away everything not yet accepted.
- **Only you see your uploads until you accept them.** No other member sees them, an owner included: not their names, their number, or a line in the activity log. Files nobody accepts are removed 30 days after the batch was made.
- **Teens get an Inbox** for their own uploads.

### Changed

- **API:**
  - `POST /api/v1/batches`, `GET /api/v1/batches`, and `GET`, `PATCH` and `DELETE /api/v1/batches/{id}`;
  - `POST /api/v1/batches/{id}/items`: one file per request, with an `Idempotency-Key`;
  - `DELETE …/items/{itemId}`, `POST …/items/{itemId}/accept` and `GET …/items/{itemId}/pages/{n}`;
  - the feature flag `features.batches`.

  Everything older clients send is unchanged.

- `/incoming` now opens Inbox → Files sent to you.

### Database

- Migration **0062** adds `intake_batch`, which only its uploader can read, and lets `incoming_file` hold batch items. Restore brings batches back, dropping any waiting file whose bytes have gone. Backups include batches; exports leave out files not yet accepted.

## [0.7.0-dev.2] - 2026-10-07 — Phase 6, R2: documents as a table

### Added

- **Documents is a table** on screens 768 px and wider.
  - **Columns:** title, kind, person, issued, expires, status, who can see it, where the original is kept, and collections.
  - **Sorting:** click a column to sort by it.
  - **Columns menu:** hides columns, and this device remembers your choice.
  - **Long values:** text that is cut short shows in full on hover or focus.
  - **Narrower screens:** from 768 to 1023 px the table scrolls sideways, with the checkbox and title kept in view.
  - **Phones:** under 768 px, Documents is the list it was, with filters and sorting in a sheet.
- **Filters:** person (or nobody's), kind, status, who can see it, collection (or none) and tag. Filters are kept in the address, so a link opens the same view and Back works.
- **Select many, then act on all of them at once.** You can:
  - add them to a collection;
  - set where the originals are kept;
  - change who can see them;
  - move them to the Trash.

  Each action is offered only when it applies to every selected document. A run that fails for some says which documents and why, and keeps them selected. Changing who can see them, and the Trash, ask first.

- **Making many documents Only me at once** asks one question about all your links to them: end them, or keep them.
- **Keyboard:** the table is one stop for Tab. Arrow keys, Page Up and Page Down, Home and End move around inside it.
- **Back from a document** returns to the table as you left it: your sort, what you had loaded, and what you had selected.

### Changed

- **API:** `GET /api/v1/documents` gains:
  - column sorts with a direction;
  - the filters above;
  - signed page markers;
  - a page size of up to 200, and a total.

  Each document carries the collections you may see. Older sorts and older clients are unchanged.

- **Viewers and guests** get no location column, sort, filter or action, and a document's status never asks them where the original is kept.

## [0.7.0-dev.1] - 2026-10-07 — Phase 6, R1: the app's shell

The first step of the new web layout. 0.6.0 continues on `release/0.6.0`, and Phase 6's builds are numbered `0.7.0-dev.N` until 0.7.0. The `latest` images stay on the newest release on `main`.

### Changed

- **The web app has one layout around every screen, at three widths.**
  - **At 1024 px and wider**, a sidebar holds Home, Documents, People, Collections, Needs attention, Inbox (with how many wait for you), Sharing, Activity and Trash, with Settings at the foot. Each shows only where your role has that screen.
  - A bar on top has search, Add, and your account menu (your name, Settings, Sign out).
  - **From 768 to 1023 px**, the sidebar shows its icons alone, each named.
  - **Under 768 px**, the bottom bar stays, with Reminders now called Needs attention. A menu at the top left opens the other sections, Settings and Sign out.
- **Settings holds settings only:** Your account, Notifications, Household and Your data. Where email comes from is a page of its own.
- **Features have their own places:** Inbox (files sent to you), Sharing, Activity, Trash, and People outside the family (a tab on People, for owners). After a restore is reached from a banner on Home while anything is paused.
  - Every old address (`/settings/sharing`, `/settings/trash`, `/settings/activity`, `/settings/guests`, `/settings/after-restore`, `/incoming`, and the rest) goes to its new place, so links in older emails still work.
- **Keys:** `/` goes to the search box and `n` to Add. Neither works while you are typing, and you can turn both off on a device under Settings → Your account.
- **Lists use more of a wide screen;** forms keep a width that is easy to read.
- **Signing out** lands on Sign in.

### Accessibility

- A skip link to the page, landmarks for the navigation, the bar and the page, and focus on each new page's heading.

## [0.6.0-rc.1] - 2026-10-06 — iteration 5.41, the Phase 5 release candidate

The release candidate for 0.6.0, which gathers every 0.5.x release since 0.4.5. It is for the owner's demonstration. Once that passes, 0.6.0 goes to `main` and the `latest` images move to it.

### Added

- **Upgrading from 0.4.5 to 0.6.0** is described step by step in the README. It covers updating the compose files beside your `.env`, the backup and restore rehearsal to do first, and the two changes that can break a 0.4.5 setup.
- The README lists every `FDV_*` setting with its default.
- **Only me and share links.**
  - When you make a document Only me and you have links to it, you choose whether to end them or keep them. Keeping them is for the rare case where you work on a document with someone outside the family before the other adults may see it.
  - Owners decide whether Only me documents may be shared outside the family at all (Settings → Household). It is on by default. When it is off, new links to an Only me document are refused, and the ones that exist pause until it is turned back on.
  - Nobody is told how many links other people have to their Only me documents.

### Changed

- **Where a document's paper original is kept is seen only by owners, adults and teens.**
  - Viewers (family or not), guests, people opening a share link and people sending you files never see it.
  - Searching cannot match on it for them.
  - Emails, notifications and activity lines never mention it to them.
  - A document's status never asks them where it is kept.
- **Taking someone's sign-in away and giving it back keeps any lock or pause.** The other owners are told, and so is the person, including any limits they still have. A locked sign-in can't be deleted out from under its lock.
- **Changing another person's identity details is an owner power.** It needs two-step sign-in, and a passkey or a code to confirm, as showing their numbers already does.
- **Phone notifications:** registering a phone for notifications can't take over another person's phone while they are signed in on it. Once their session has ended, the next person can register it.

### Fixed

- **Sign-in:** a passkey sign-in or confirmation that names no credential is refused properly instead of failing.
- **Worker log levels:** the worker accepts every log level the API does (`trace` and `fatal` used to stop it).
- **Household time zone:** setting it through `PUT /api/v1/profile` alone no longer counts as answering the household questions.

### Security

- **Password-reset links waiting to be emailed are sealed.** A link waiting in the job queue can't be read there; the worker opens it as it sends.
- **A new security test runs every kind of outside or limited caller against every API route.** It fails if a route is added without a rule. It also checks that no planted secret ever appears in an answer, an email, a notification, a queued job or the activity log.

## [0.5.38] - 2026-10-06 — iteration 5.37

The vault reads what it can from a document's pages, and suggests its details.

### Added

- **"We read the pages — is this right?"** A document's page offers a chip for each empty detail the vault could read: what kind it is, whose it is, the issued and expiry dates, the number and the issuer.
  - One tap fills that one detail. Nothing is ever filled without a tap, and nothing you typed is overwritten.
  - Each chip shows how sure the vault is, for example "suggested · 92%". Anything it is less sure of is not offered at all.
  - "Not now" puts the card away for that document. The Edit card offers the same chips under empty fields.
- **The vault reads Word documents too.** Their words are found by search.
- **Only people who may change a document are offered suggestions.**
  - Viewers and guests never are.
  - An Only me document's pages are read only for its owner.
  - Nothing read is stored, logged or sent anywhere.

### Changed

- **PDFs that already carry their words are read directly**, so their search text is ready at once, and only scanned pages are photo-read. A scan with a printed line on it, such as a scanner's header, is still photo-read in full.
- **Tables in PDFs keep each label beside its value**, so search snippets of statements and schedules read better.
- A passport's issuer is suggested as its country.
- **Dates such as 03/04/2031 are read only when their order is clear**, from other dates on the page or the household's country.
- A person is suggested only when the page names them with their surname, never from a first name alone or a payee line.

### Security

- **Reading a Word file, and working out suggestions, each run apart from the rest of the vault**, under a time limit. A file made to be slow is given up on, and reminders, mail, backups and other people's requests carry on.

## [0.5.37] - 2026-10-06 — iteration 5.35

Notes you can write, with a little formatting.

### Added

- **Notes on every document.** Anyone who may change a document can add or edit its one note, and teens can on their own documents.
  - The editor has Bold, Italic, List, Numbered, Checklist and Link, with Ctrl/Cmd+B and I, a Write / Preview switch, and a counter.
  - The note shows who last edited it and when, on the household's clock. Viewers and guests see when, but not by whom.
  - If someone else changed the note while you were writing, you see their version and choose: keep theirs, or save yours over it. A change to anything else on the document saves your note anyway.
  - Drafts are kept in the browser only for documents everyone in the family can see, and only for the person who wrote them. They are gone when you sign out.
  - Links show their full address. An address that hides its real target (invisible characters, or a name before the site) stays plain text.
- The activity log records that a note was added, changed or removed, never what it says.
- "Answer the questions" on an empty Needs attention page opens just the household questions, already filled in with your answers.

### Changed

- Search results show a note's words without its formatting marks.
- Editing only a note no longer also logs "changed the details".
- The web app now tells the browser to run only its own scripts, as a second line of defence.

### Fixed

- "Export everything" is shown only to people who may export.
- A panel could ignore Escape pressed at the very moment it finished saving.

## [0.5.36] - 2026-10-05 — iteration 5.34

Someone outside the family, such as an attorney or an accountant, can have a sign-in of their own: always limited, always with an end, and never shown among the family.

### Added

- **Guests.** The invite form first asks "Is this person family?". For someone from outside, it offers to share a collection with them or ask them to send documents, before giving them a sign-in.
  - A guest always has limits on what they can see, and their access ends on a day an owner chooses, at most a year away. An owner can renew it.
  - A guest owns no documents, has no identity details, and does not appear in People, owner pickers or suggestions.
  - The activity log names them, for example "Guest — Jane Smith, attorney".
  - When their access ends they are signed out, and they cannot sign in again until an owner renews it.
- **People outside the family**, in Settings, for owners: each guest's limits and end, renewing, changing their name and description, signing them out everywhere, taking their sign-in away and giving it back, and removing a guest who never signed in.
- A guest's Home says when their access ends, and the page they accept the invitation on gives the end date on the household's clock.

### Changed

- An owner's invitation for a guest, for a viewer who sees every family document, or that gives adults-only documents or replaces limits already set, now asks for a passkey or a code, never only the password.
- An adult can invite a guest only with limits within what the adult can see, never with adults-only documents, and cannot bring back a guest whose sign-in was taken away.
- Collection warnings say "(guest)" for a guest.

### Security

- Signed-in people can read only the accounts of their own household. Only owners can read the accounts of people whose sign-in was taken away.
- Guests and limited viewers can no longer read the vault's storage and mail-server settings.

## [0.5.35] - 2026-10-05 — iteration 5.33

Owners can now limit what a viewer sees, from the web.

### Added

- **"What they can see"** on a viewer's account card. An owner picks people, kinds of document and Everyone collections, and can include documents that belong to no one, adults-only documents, and an end date. A live count says how many documents the viewer will see before anything is saved. Changing the limits asks for a passkey or a code.
- **Invitations can carry limits.** "Limit what they can see" on the invite form applies the limits the moment the invitation is accepted, so a new viewer is never unlimited, even for a moment.
  - An adult inviting a viewer must limit them, and cannot include adults-only documents. Owners can still invite a viewer who sees every family document.
- **Owners see a banner** while any viewer can see every family document, with a link to limit them.
- **A limited viewer's Home** says what they can see, for example "You can see: Tax return documents for Ahmed and your own." Viewers also get a Collections section for the collections given to them and any they made.
- **Adding a document to a collection that a viewer was given** says who will now see it, for example "Jane (viewer) will be able to see this."
- When someone who keeps Only me documents is limited, an owner is asked to confirm first, and the person is told.
- Limits that need confirming again after a sign-in is given back show "Keep these limits".
- The activity log records when limits are set, changed or removed, for owners, the person and whoever made the change. It records counts only, never what was named.
- The phone gets a plain notice when more people are about to see someone's identity details, beside the in-app notice and the email.

### Changed

- Only Everyone collections can be given to a viewer. A collection that stops being Everyone, or goes to the Trash, stops being given at once, and bringing it back does not give it again.
- If a kind or person that limits named is deleted, the limits stay narrowed to it and the card says so. Saving the card never widens them; "Give every kind instead" does, and says so.
- The email sent when a sign-in is given back says when an owner has limited what the person can see.
- An owner's invitation replaces limits already set on that person only if those limits are older than the invitation. An adult's invitation never replaces them.

### Fixed

- Home's "N things need attention" link is a link again for screen readers, and its count is still announced.
- Someone who cannot add documents no longer sees "Add your first document" on an empty Home; it says "Nothing here for you yet."

## [0.5.34] - 2026-10-05 — iteration 5.32

Limiting what a viewer can see, enforced by the database. The screens for setting limits come in the next release.

### Added

- **A viewer's access can be limited** to the documents of certain people, certain kinds of document, or certain Everyone collections. An owner can also include adults-only documents, and documents that belong to no one.
  - A limited viewer always sees their own documents, never anyone else's Only me documents, and nothing of anyone else's when nothing is named.
  - The limits can end on a date. Once they end, the viewer sees nothing until an owner looks again.
- The limits belong to the person, so taking their sign-in away and giving it back keeps them, and an owner is asked to confirm them again.
- After a restore, the screen that lists the sign-ins to turn back on shows each limited viewer's limits.

### Changed

- The database itself keeps a limited viewer inside their limits. Everything follows them: documents and their files, pages, text, reminders, links, collections, people, kinds, activity lines, sessions and exports.
- A limited person can only be a viewer. To give them another role, an owner removes their limits first.
- A share link lends no more than its maker may see now. A link made by someone whose access was later limited is paused for anything outside their limits.
- Deleting a kind or person that limits named narrows what the viewer sees; it never widens it.

### Fixed

- Document lists no longer read each document's versions one by one.

## [0.5.33] - 2026-10-04 — iteration 5.30

Role changes reach every device; sign out everywhere.

### Added

- **Sign out everywhere**, for owners, from a person's Account card. It ends every session and device that person has, and their phone is told at once. It asks for a passkey or an authenticator code. The person is emailed, and a co-owner signed out this way is pointed to the activity log.
- **Changing someone's role** now opens a dialog that lists what will happen, for example "Their phone removes the Essentials it keeps at its next sync" or "Their upload requests close". Afterwards it says what did happen.

### Changed

- A role change that lets someone see less now reaches their devices: the offline copies their phone keeps are removed at its next sync. Upload requests they can no longer make are closed; only ones that still worked are counted.
- **Stolen sign-ins are caught more reliably.** If any earlier sign-in token of a session is used again, that session ends, not only when it is the most recent one. Sessions open at upgrade join in from their next refresh.
- **The vault takes nobody's word for a visitor's address** except its own web server's. A device on your home network can no longer pretend to be somewhere else, for sign-in limits or in the activity log.
  - The new default is `FDV_TRUST_PROXY=network`.
  - If you run your own reverse proxy in front of the vault, it must replace `X-Forwarded-For` rather than add to it. Otherwise every visitor is recorded at the proxy's address.

### Upgrading

- **TLS overlay (Caddy).** The vault's web port is now bound to this machine only, `127.0.0.1`, and Caddy talks to the API directly. This needs Docker Compose 2.24.4 or later.
- **Update your checkout too.** The Caddyfiles are read from it, so update it along with the images. With an old Caddyfile everything still works, but the API sees Caddy's address for everyone.
- **Without the TLS overlay**, the vault stays reachable on your home network on port 8080, as before.

### Security

- Under the TLS overlay, slow or never-finished requests are cut off, as nginx did before. An upload over the size limit is refused and its connection closed, instead of being read to the end.

## [0.5.32] - 2026-10-04 — iteration 5.29

A password reset an owner starts.

### Added

- **Send a password reset**, for owners, from a person's Account card. It asks for a passkey or an authenticator code. Which way it works depends on the vault and on the person:
  - **If the vault sends its own email**, the link goes only to that person's own address. The owner never sees it.
  - **If it doesn't, and the person keeps nothing private**, the owner is shown a link once, for an hour, to hand to them. Private here means Only me documents, details or collections, files waiting for their review, or an export. The link stops working if they start keeping something private before it is used.
  - **Otherwise**, it can't be done from the vault. The dialog shows the command for whoever runs the server.
- "Stop their current password now" ends their sessions at once and makes them choose a new password through the link. It isn't offered when no link can reach them.
- The person is told, by email and in the app at their next sign-in. The other owners are told too. No owner can reset another owner, or someone who is locked.

### Changed

- **Every password reset now ends the person's exports**, including their own "forgot my password" and the server command.
- After a reset link an owner was handed, the person's next password change removes every passkey, two-step sign-in and share link added since. Whoever used the link could have added them, and the notice lists them.

### Security

- No owner ever holds a working password for someone who keeps anything private. This holds while a link waits, and whoever spends it.
- A sign-in, password change or new passkey that was in flight when a reset or lock happened is refused, rather than slipping in afterwards.

## [0.5.31] - 2026-10-04 — iteration 5.28

Lock a sign-in.

### Added

- **Lock a sign-in**, for owners, from a person's Account card. Locking someone:
  - signs them out everywhere, and their phone is told;
  - takes back the invitations they sent, and any password reset waiting for them;
  - ends their exports;
  - pauses their share links and upload requests, or ends them for good if you choose.
    A lock can end on a date you set, or when you unlock. The person is told by email, and the other owners are told too. It asks for a passkey or an authenticator code.
- Owners can't be locked; ask them to become an adult first. You can't lock yourself, and a locked person can't be made an owner.
- Only owners and the person see that someone is locked. Everyone else just sees their links and requests as paused.

### Changed

- **After a restore, everyone's sign-in except the owners' is paused until an owner turns it back on** on the After a restore screen, one tap each. A backup can't know about a lock made after it, so this keeps a lock from being silently undone.
- While anyone is locked or paused, the audience for identity details can't be widened, because they couldn't be told. Locking someone withdraws a widening that was waiting.
- Reminders, digests and alerts skip people who are locked or paused.

### Security

- A locked person is refused only after their password and code or passkey are proven, so the refusal reveals nothing about which accounts exist. A switched-off account's passkey sign-in is now refused too.
- The database itself keeps at least one owner who can sign in, and only an owner can lock or unlock anyone.

## [0.5.30] - 2026-10-03 — iteration 5.27

Identity details on the web, and in the export.

### Added

- **Identity details** on each person's profile, between About and their documents. ID numbers and hidden fields stay as dots until you press Show, or Copy. Both ask you to confirm it's you, and each is noted in the activity log. Another person's Only me details don't appear at all.
- **Edit identity details.** You can mark any of your own details Only me; nobody else in the family can open those. Owners can edit everyone's shared details. If someone else saved a change first, you are told and shown theirs.
- **Fill from documents** suggests numbers, dates and issuers from the person's identity documents you can see. Nothing is filled until you press Use this, and a number from an Only me document goes into your Only me details.
- **"Add their details now"** when adding someone.
- **Settings → Family → Who can see identity details**, for owners. Letting more people see them waits 72 hours. Everyone is told, and a banner on Home shows the date.
- **The export** now holds each identity record you may read, as JSON and in its page, and the photos of the people you may see. Your own record is complete. Other people's ID numbers stay hidden in it, and their Only me details are never in it.

### Changed

- Exports end early, so they can't be downloaded any more, in three cases:
  - after a restore;
  - when someone's role changes so they see fewer people's identity details;
  - when a person takes details out of what others can see.
- After a restore, the screen says who can see identity details now.

### Fixed

- Some tests that timed out under load have more time.

## [0.5.29] - 2026-10-03 — iteration 5.26

Identity records, sealed. This release adds the server side; the screens come in the next one.

### Added

- **Each person's identity details**, kept sealed in the vault: names, birth, nationalities, government IDs (each with a number, issuer, dates and an optional link to its document), emails, phones, addresses, work, custom fields and notes.
  - Each record has a shared part and an **Only me** part.
  - Nobody else in the family can open your Only me part, owners included.
  - ID numbers and hidden custom fields stay masked until someone reveals them.
- **Who may see them.** By default, owners see everyone's shared details, and everyone sees their own. Owners can let all adults, or everyone in the family, see shared details too. Viewers only ever see their own.
- **Revealing a number.** Revealing your own numbers asks you to confirm it's you. Revealing someone else's needs a passkey or an authenticator code. Each reveal is noted in the activity log, without the values. The person sees a line when someone else reveals their numbers.

### Changed

- Letting more people see identity details waits 72 hours. Everyone with a sign-in is told, in the app and by email if the vault sends mail, and can mark anything Only me first. Making the audience narrower takes effect at once.
- A widening is refused while someone's sign-in is switched off, because they could not be told.
- After a restore, the identity audience goes back to owners and each person, and any widening that was waiting is withdrawn.

### Security

- Each part is sealed with its own key. The Only me part is sealed under that person's own key, and the database itself refuses to show it to anyone else.
- Whoever runs your vault's server holds the master key, and so could open these details. The vault says so where it matters.

## [0.5.28] - 2026-10-03 — iteration 5.22

Ask for documents, and the page that sends them.

### Added

- **Ask someone for documents**, from Sharing or from a person's page. Owners and adults choose:
  - a title, a message, and up to ten named things to send (a W-2, a 1099);
  - when the request ends;
  - how it is protected: a password, an emailed code, or this browser only, and how many visits it allows;
  - how many files, and how big;
  - what kinds of file;
  - who reviews what arrives.
    The link and a made-up password are shown once, to hand over.
- **The sender's page.** Whoever has the link opens it, chooses files for each thing asked for, and sees each one arrive. They can remove one or stop it before Finish, add a note, then Finish. Every problem is said in plain words: a file too large or of a kind not taken, the request full, ended or used up, or the vault busy.
- Sharing lists the requests you review: files received, visits used, and where each stands. You can take one back. After a restore, paused requests are listed with the paused links, and owners can turn them back on.

### Changed

- A password the vault made up for a request is checked the way a share link's is: capitals, spaces and dashes don't matter. A typed password is still checked exactly.
- A sender who loses their connection is never asked to send a file twice. The page checks with the vault what arrived, and if it can't tell yet, says so and checks again.
- The share sheet's "This browser only" note sits right under its label on a phone, and the end's date and time stack on a narrow screen.

### Security

- Every call from the sender's page names its request, and the vault refuses one whose session belongs to another request.
- A request whose visits are used up can still be found only by the browser already in it; everyone else is refused, and nothing is counted.

## [0.5.27] - 2026-10-03 — iteration 5.23

Files sent to you: look before they are filed.

### Added

- **Files sent to you.** What somebody outside the family sends through a request link now waits in its own inbox for whoever reviews that request. You can look at its pages, then file it as a new document or as a new version of one, or refuse it. The form is filled from the request's hints.
- A file the vault could not scan for viruses says so: "Not scanned for viruses".
- Reviewers are told how many files are waiting, by push and by email, once their pages are ready. The message says how many and nothing else.
- A version's history says it was "Sent through a request link", and names the request.
- If whoever asked for the files can no longer review them, the waiting files go to the owners, with a line in the activity log.

### Changed

- A file left waiting for 30 days is removed. So is what is left of a file once it has been filed or refused.
- Refusing a file removes its name, the sender's note and its contents. The dialog says exactly what goes and what stays.
- Removing a document for good also removes the file it was filed from.

### Security

- The database lets a reviewer file a waiting file only once, only as themselves, and only as the version they are making of it. Files moved to the owners are the owners' alone.
- A restore drops waiting files whose contents have gone since the backup. It does so only where the files are clearly kept, and the report says how many.

## [0.5.26] - 2026-10-03 — iteration 5.25

Change a person's details; the owner's view of a sign-in.

### Added

- **Edit details** on a person's profile: their name, date of birth and relationship. Owners can change anybody's; adults their own and those of people who don't sign in; teens their own. If somebody else saved a change first, you are told, and shown what they saved.
- An owner can record that somebody has **passed away** — only someone who no longer signs in — after confirming it's them. Any invitation waiting for that person is taken back, and they can never be given a sign-in.
- **The Account card**, for owners, on each person's profile: their role and sign-in email, whether two-step sign-in is on, how many passkeys, when they last signed in, and the devices they are signed in on — never an address or a secret. It asks for a passkey or an authenticator code; an owner without two-step sign-in is shown how to turn it on. Each look is noted in the activity log, for the owners and the person.

### Changed

- From now on, new powers given to owners need two-step sign-in; what owners could already do is unchanged.
- Adding a person checks that the date of birth is a real day and not in the future, as editing does.
- The activity log says which details changed, never what they were changed to.

### Security

- The database itself refuses to give a sign-in to somebody recorded as passed away, and refuses changes to a person beyond what the role allows.

## [0.5.25] - 2026-10-02 — iteration 5.24

Removing a document for good.

### Added

- **An owner can remove a document for good**, from Settings → Trash: its record, its files, its previews and pages, wherever the vault keeps them. Nothing empties the Trash by itself; that has not changed.
- A document the owner filed goes at once. Anybody else's needs a day's notice: the owner asks, the person who filed it and the other owners are told at once, and the filer can Bring it back, which cancels the request. The owner can remove it 24 hours after asking, if it is still in the Trash. Removing always asks you to confirm it's you.
- The activity log keeps its lines about a removed document, shown only to those who could see the document, with its title as "a document".

### Changed

- A restore from a backup made before a removal brings back the document's record but not its file: the document says "The file was removed for good", and the restore lists them. Put your files back before restoring; `recheck-files` clears the mark from any file that comes back. A restore also clears every request to remove.
- Export everything lists a document whose file was removed, with a note, instead of failing.
- An export made before a removal keeps its copy until it expires (seven days at most), and a phone that kept the document offline deletes it at its next sync.

### Fixed

- An S3 bucket that cannot be reached is given up on after 10 seconds to connect, and 20 to check or delete a file, rather than holding things up for minutes.

## [0.5.24] - 2026-10-02 — iteration 5.21

Ask someone to send documents: the server. The pages for it come in the next releases.

### Added

- **Upload requests, on the server.** An owner or an adult can ask somebody outside the family — the accountant, the solicitor — to send documents in, through a write-only link. A request can say what to send (up to ten things) and carry a message, and is protected the way a share link is: a password, a code emailed to the sender (with operator mail), this browser only, a number of visits, and an end of at most 90 days. It takes PDFs and photos, and Word and Excel files if asked; a file with macros is always refused. Up to 10 files and 200 MB a request, and 2 GB waiting across the household.
- What comes in waits, encrypted and apart from the family's documents, until somebody reviews it and files it. A request marked "review by me" is seen only by whoever made it.
- For now this is the API only (see `docs/api-changelog.md`); the web's pages for making a request, for the sender and for reviewing what came in follow.

### Security

- The sender's link reaches only its own request, its sessions and the files it sends, in every table of the database, and its lines in the activity log are checked as they are written, as a share link's are.
- Files are judged by their bytes, never their names. Word and Excel files are looked inside with limits, so a crafted file cannot tie up the vault.

## [0.5.23] - 2026-10-02 — iteration 5.20

A second factor for someone with no account.

### Added

- **Protect a link** — a document's or a collection's — with more than a PIN:
  - **A password**, either one the vault makes up (three short groups, easy to read out over the phone; capitals, spaces and dashes don't matter when it is typed) or one you type (at least 8 characters).
  - **A code emailed to the recipient**, which they ask for on the page. Each code works once, for 10 minutes, and only the newest one works. The email carries no link, no title and no names. This needs the mail server of whoever runs the vault (`FDV_SMTP_URL`). The household's own mail settings are never used for it, and without operator mail the option is not offered.
  - **This browser only**: the link opens only in the first browser that opens it. The page tells the recipient to use their usual browser, not a private window or their email app's.
- A link has one count of ten wrong tries for its whole life, whatever was wrong — a password, a code or a PIN — and every wrong answer reads the same.
- Codes can be sent three times in 15 minutes and ten times a day per link.

### Changed

- A link's activity notes when a code was emailed, and to which inbox, masked.
- The address a code goes to is cleared as soon as the link ends.
- After a master-key rotation, a browser keeps opening the links it opened before.

### Security

- The cookie that ties a link to one browser is made by the vault and signed. A cookie planted in the browser beforehand is never adopted.
- A code is stored only as a keyed hash. Neither a database dump nor a backup can check one without the master key.

## [0.5.22] - 2026-10-02 — the master key, from 0.5.0-rc.2

The 0.5.0 line's fix for rotating the master key, brought into this line.

### Security

- **Rotating the master key moves everything it protects.** Until now `rotate-master-key` moved only the per-household keys, so after a rotation owners could not finish two-step sign-in, mail and an S3 bucket stopped working, and nobody was signed out. It now moves all of it in one transaction and signs everybody out, and refuses while the vault is running or without `DATABASE_ADMIN_URL`. The API, the worker and every backup check that the master key opens the vault and stop with a plain message when it does not. A vault an earlier rotation left partly under each key is mended with `repair-master-key`; a backup made before a rotation is restored with `FDV_MASTER_KEY_PREVIOUS`. If you rotated the master key on any earlier 0.5 release, read "Rotating the master key" in the README before upgrading: this release will not start on a vault that rotation left half-moved, and says what to do.

## [0.5.21] - 2026-09-28 — iteration 5.19

Share a collection.

### Added

- **Share a collection** with someone outside the family — the solicitor, the mortgage adviser — in one link. The sheet ticks what everyone the collection is for may see; anything else is shown unticked with the reason ("Adults only — include anyway?"), and a private document can never go. The recipient gets exactly what was ticked, each document checked again on every visit, and never learns how many were left out.
- **Keep it up to date**: a collection's link can follow it, so documents an owner or adult puts in later go out too — only those everyone the collection is for, now and when the link was made, may see, never one left unticked, never a teen's. Such a link lasts 30 days at most. Adding to a collection that is shared outside says who it is shared with.
- Sharing a collection always asks you to confirm it's you, and when someone else shares one of your collections you are told by email (who, not what or with whom).
- The end date, view only and "opened so many times" options from 0.5.20 work for a collection's link too.
- Settings → Sharing lists a collection's links to those who may share and can see the collection and everything in it; they can take one back.

### Changed

- Deleting a collection or making it Only me ends its links at once, even while someone is opening them; turning it back does not bring them back.
- A link taken back says who took it back, and a collection's link says when it ended with its collection.
- A recipient whose link ends while a page or a download is on its way is told the link has stopped working, and nothing is counted.
- Activity times now come from the database's clock.

### Security

- A shared link's own activity lines are checked by the database as they are written: its own name, only documents it gives, the log's latest line, and only what a line of its kind may say — so the tamper check always verifies.
- A share link reaches only what its page needs, in every table of the household and none of the sign-in tables.
- A collection's link's activity (opened, downloaded, looked at) is shown only to those who are given the link.

## [0.5.20] - 2026-09-28 — iteration 5.18

Share links: until a date and time, view or download, so many opens.

### Added

- A share link can end at a date and time of your choosing — "Tonight", "Friday 5 pm", "In a week", or any moment, in the household's time zone — up to `FDV_SHARE_MAX_DAYS` days (90 by default).
- **View only**: the recipient sees the document's pages, each marked across the page and along the foot with who it was shared with and when, and cannot download the file. Up to the first 30 pages are shown; both sides are told when a document has more. Word and Excel files cannot be shared this way.
- **Opened so many times**: a link can be opened a set number of times; opening it again in the same sitting, or turning pages, does not count. The family's list says how many opens and downloads are left.
- Watermarks are drawn in the recipient label's own script — Arabic, Devanagari, Chinese, Japanese, Korean, emoji.

### Changed

- A link that has used up its opens tells the recipient so, instead of the general "this link cannot be opened".
- A link made with no end, or by an older app asking for more days than the vault allows, ends at the vault's limit.

### Fixed

- Multi-page TIFF scans show every page (up to 30) instead of the first; counting their pages no longer runs out of memory on large scans.

## [0.5.19] - 2026-09-27 — iteration 5.17c

A person's profile, and their photo.

### Added

- A name on People opens that person's profile: their photo, relationship and birthday, their documents, and — for owners — their sign-in. A name on Home still opens their documents, which now link back to "About" them.
- Profile photos: choose one, frame it, and it is made into a small square with the location and camera details taken out; the photo as sent is not kept. JPEG photos up to 128 megapixels work; HEIC, WebP and PNG up to about 50 (an iPhone's largest). You can set your own; an owner can set anyone's; an adult can set it for someone without a sign-in. Viewers see initials.
- Initials tell people apart: Aisha and Ahmed become "Ai" and "Ah", Sam Khan and Sam Malik "SK" and "SM", Sara and Sam Khan "Sr" and "Sm".
- "Add someone" asks for a relationship (optional).
- Owners see a note on each profile about where SSNs and other ID numbers are kept until they get their own sealed place.

### Changed

- A document a teen files for themselves, of a kind that is Adults only by default (an ID card, say), starts as their own Only me rather than being visible to everyone. A teen can switch the documents they filed between Only me and Everyone; documents an adult filed for them stay as the adult left them.
- A viewer no longer sees other people's relationship, as they already could not see birthdays.
- An address with a malformed id says "Nothing in the vault has that id." instead of a server error.

### Security

- The activity log's tamper check could be broken for good by a request that spelt an id in capital letters; entries are now written exactly as the log stores them, so they always verify.

## [0.5.18] - 2026-09-27 — iteration 5.17b

Lists are called collections.

### Changed

- Lists of documents are now **collections**, everywhere: Home's "Collections", "Add to a collection", "Make a collection", and a document is _in_ a collection rather than on a list. A document can be in several at once, and a collection is what you gather to hand over — for the solicitor, the mortgage, the move.
- The API's `/api/v1/lists` routes are now `/api/v1/collections`, with no aliases: nothing but this vault's own web app used them. The database tables are renamed in place; every collection, its documents and their order are kept.
- Activity lines about lists written before this release are no longer shown; new ones say "collection".

## [0.5.17] - 2026-09-27 — iteration 5.17

Invitation and password-reset links the same way as share links.

### Added

- `FDV_RATE_LIMIT_PER_MINUTE` (300 by default): how many requests one address may make in a minute, beyond the tighter limits on signing in and opening links. Raise it when many devices share one address.

### Changed

- New invitation and password-reset links look like `/join#…` and `/reset#…`: the part after `#` never reaches a server or a proxy on the way, and the page takes it out of the address bar and this tab's history as soon as it has read it, then sends it in the request itself. The browser's own history may still keep the link; what protects it is that it works once and expires — an hour for a reset — and an invitation also needs its code.
- Links made before this release still work until they expire. The old address forms of the vault's routes for these links are deprecated and will be removed in 0.9.0.
- Going back to a reset or invitation page after using its link says the link has been used, instead of asking for it again.
- The email field when joining can be left empty, as its hint says.

### Security

- An invitation's five tries at its code hold however many guesses arrive at once: each try is counted before the code is checked.

## [0.5.16] - 2026-09-27 — iteration 5.16b

Reminders from any date, on the web.

### Added

- Settings → Kinds of document → Reminders: switch reminders on, choose the date to remind from — Expires, Due date, or one of the family's own date fields the kind shows — and how long before, from "On the day" to "9 months". A sentence says exactly what will happen ("We'll remind you 7 days and 1 day before its due date"), and when a kind shows two dates it says which one reminds. Before saving, it says how many documents lack the date and which reminders move or stop — counting only the documents you can see.
- On the card, the reminder sentence sits under the date it is about, and says a due date is reminded of once. On an Only me document it says the vault can read that one date so it can remind you.
- Reminders say what they are about: "Council tax — Due date: 10 Oct, in 7 days", with the day you'll hear of it underneath in Coming up.

### Changed

- The lead-time choices moved from under Expires to the new Reminders section.
- A snooze that would go past a due date becomes "On the day"; which day is "today" follows the household's time zone.

## [0.5.15] - 2026-09-27 — iteration 5.16a

Reminders from any date, on the server: the editor's Reminders section comes in the next release.

### Added

- "Due date" in the field library, for bills, council tax, school fees and anything else that falls due.
- A kind of document can remind before any date it asks for — Expires, Due date, or a date field of the family's own — with the same choices of how long before. One date per kind; nothing repeats.
- Each reminder now says which date it is about, in the kind's own word: "Council tax — Due date: 10 Oct, in 7 days".

### Changed

- A document filed after some of its reminder days have passed gets one reminder due now, the nearest, not one for each day already gone.
- A due date that has already passed when a document is filed makes no reminders; a bill filed after it was paid does not land in Needs attention. An expiry that has passed still does, as before.
- Snoozing a reminder about a due date never puts it off past the due date.
- "Lapsed" in the reminder email follows the date a reminder is about, not the day it was sent.

### Security

- On Only me documents the vault can read the one date a kind reminds from, as it can an expiry date, so it can remind their owner; everything else in their details stays sealed. It opens that date only in its owner's own changes and when a kind's reminders move to it.

## [0.5.14] - 2026-09-26 — iteration 5.16

Share links whose secret stays out of the address a server sees.

### Added

- New share links look like `/s#…`: the part after `#` never reaches a server or its logs, and the page takes it out of the address bar and this tab's history as soon as it has read it. The browser's own history may still keep the link, so put a PIN on anything sensitive.
- Opening a link is always a click: the page first shows who shared it, from which family, what protection it has and until when — nothing is opened, counted or logged until Open. A PIN goes in the request, never in the address.
- An opened link lasts 30 minutes of quiet, and at most four hours or until the link itself ends, whichever is sooner. Every request checks the link again: taking it back, a restore, the tenth wrong PIN, or the document going to the Trash or out of its sharer's sight ends it at once.
- Settings → After a restore: a restore pauses every share link, because a link taken back after the backup was made would otherwise work again. An owner turns back on the ones that should still work; whoever made a link can take it back.
- A public-only site (`docker/caddy/Caddyfile.public-only`, the `public-only` profile) that serves only the share page and what it needs, and answers nothing else — sign-in included. `FDV_PUBLIC_URL` makes new links use its address; it must be https.

### Changed

- Links made before this release keep working through their old address until they expire; no new ones are made that way. Their routes are listed as deprecated and will be removed in 0.9.0.
- The share page's answers tell browsers to send no referrer, not to guess content types, not to be framed and not to be indexed.

### Security

- The session a link opens is a cookie only the vault's share routes receive, kept in the database only as a hash, so a copy of the database or a backup cannot open anything.
- Wrong PINs are counted in the same step that checks them, so parallel guesses cannot get past ten; the tenth locks the link once, and its sharer is told.
- Over a plain-http address the share page does not open a link it could not deliver, so nothing is counted as opened.

## [0.5.13] - 2026-09-26 — iteration 5.15

Lists on the web.

### Added

- Lists on Home and on their own screen: make a list, say who it is for — everyone in the family, teens and up, the adults, or only you — rename it, and delete it. A list's page shows only what you may see on it, and counts only that; its maker is told which documents some of the list's audience can't see. Someone who can only view still sees no lists.
- "Add to a list" in every document's ⋯ menu — on Home, in search, on a person's page, in reminders and on other lists — and on the document page, which also names the lists the document is on.
- "Select" in search: tick several documents and put them on a list at once, up to 200. They all go on, or — if one can't — none do, and it says so. While selecting, tapping a row ticks it.
- Taking a document off a list, and deleting a list, ask first.

### Fixed

- The back button on every screen has its arrow in the middle, and is as large as the app's other buttons.

## [0.5.12] - 2026-09-26 — iteration 5.14

Lists of documents, on the server: the screens come next.

### Added

- Lists of documents — "For the accountant", "The house" — each for everyone in the family, for teens and up, for the adults, or for its maker alone. A list shows each reader only the documents they may see, and counts only those; a list outside someone's reach does not exist for them, name and all. Someone who can only view sees no lists yet.
- Only a list's maker changes it. A maker who is moved to another role, or loses their sign-in, still sees and can delete what they made; an owner can delete a list nobody can change any more, but never reads more of it.

### Fixed

- Reloading a page at the moment it was renewing its sign-in no longer signs you out. The one allowance phones had for an answer lost on the way now holds for a browser too: the same browser, from the same address, within 30 seconds, once.

### Security

- The database itself keeps a list that is for its maker alone invisible to everyone else, and keeps a list's items from anybody the list is not for.

## [0.5.11] - 2026-09-26 — iteration 5.12

### Added

- Settings → Kinds of document: hide a built-in kind the family never needs, add the family's own (an allotment tenancy, a season ticket), and choose what the card asks for each — which fixed fields it shows and what they are called, which details from the shared library, which are required, when to be reminded before it expires, who sees a new one by default, and whether it is usually Essential. A preview shows the card as it will be, and before saving it says what the change would affect — counting only the documents you can see.
- Letting more people see a kind's new documents by default asks an owner to confirm it's them; an adult can make it narrower, not wider.

### Changed

- A kind that is hidden or archived is no longer offered when adding a document; documents already filed under it keep it.
- A kind that is Only me by default starts at Adults only when the document is somebody else's.

## [0.5.10] - 2026-09-26 — iteration 5.11

The family's own kinds of document, on the server: an owner or an adult can make a kind of document, change what the card asks for it, hide a built-in one the family never needs, archive their own, and delete one nobody uses. The screens come in the next release.

### Added

- Making, changing, hiding, archiving and deleting kinds of document, and adding fields to the library they share; every change is in the activity log. What a change would affect is shown first — counting only the documents you can see.
- Letting more people see a kind's new documents by default (for example making wills visible to the whole family) is for an owner only, and asks to confirm it's them; making it narrower is for any adult.
- When a kind's reminder times change, or its expiry is switched on or off, its documents' reminders follow — without reminding anyone of what has already passed.

### Changed

- A scan queued on a phone for a kind that has since been deleted is filed without a kind, and as privately as it can be, rather than refused.
- A kind of document that defaults to Only me no longer files somebody else's document as Only me.
- Someone who can only view reads the kinds of document the documents they can see are filed under, not every kind the family has made.

### Fixed

- The hourly reminder email is no longer sent twice when a kind's reminders change while it is being sent, and one household's trouble no longer stops the others'.

## [0.5.9] - 2026-09-26 — iteration 5.10

### Added

- Adding or editing a document now asks for its kind's own details — a passport's number, a car's VIN and registration plate, a will's executor — each in the kind's own words, with a date, a pick-list or a yes/no switch where that fits. Required ones are marked, and Save says which are still missing (or "Skip for now" when adding).
- A notes box on the card, kept exactly as written, line breaks and all. An Only me document's notes are sealed as they are saved.
- The document page lists its details, and any the kind no longer asks for under "Other details", where they can be removed.

### Changed

- A vehicle registration now asks for its registration plate: cars without one read "Needs a registration plate" until it is added.

### Fixed

- Editing a document no longer turns an expiry of a month or a year (such as "March 2031") into a day.
- An edit refused because someone else changed the document at the same time keeps what you typed, shows their changes, and can be saved again.
- An amount typed with a comma for the decimal point ("12,50") is refused with a word of explanation rather than kept as 1250.

## [0.5.8] - 2026-09-26 — iteration 5.9

### Security

- An Only me document's notes and details are now sealed with its owner's own key, as its pages' words already were: they leave the plain table, the search index and every backup from now on, and only their owner's own requests open them. Existing ones are sealed when the worker starts, and again after a restore, before the vault opens. Backups made before this release keep them unsealed until they rotate out.
- A household export is now locked with the key of the person who asked for it, not the household's, since it holds that person's Only me documents.
- The database itself refuses an Only me note or detail written in plain text, should any path ever try.

### Changed

- Lists of documents, and a phone's offline set, no longer carry the notes and details of Only me documents; they say whether there are notes (`has_notes`), and the document itself shows them to its owner.

## [0.5.7] - 2026-09-26 — iteration 5.8

A kind of document's own details — a car's VIN, a will's executor, a policy's cover — are now kept properly: checked against what the kind asks for, found by search, and in the export. Screens to fill them in come next.

### Added

- Search finds a document by its details, for documents the family or the adults can see. An Only me document's details stay out of the search index.
- The export lists each document's details, a column for each, named as its kind names them, and guarded against spreadsheet formulas like every other cell.

### Changed

- A passport without its number or expiry, a driving licence without its expiry, and an insurance policy without its insurer or expiry now read "Needs a passport number" and the like. Nothing is ever refused for want of one; add it and the document reads as its dates say.
- An edit to a document's details changes only the details it sends, so two people editing different details both keep theirs.

### Security

- A document's details are checked: only the ones its kind asks for, each of its own kind, 16 KB in all at most — also when two edits arrive at once.

## [0.5.6] - 2026-09-26 — iteration 5.7

Groundwork for the family's own kinds of document: a household can now have types of its own, and its own changes to the built-in ones (hiding one, asking for different details), kept behind the same wall as its documents. Nothing in the app makes them yet, so every list of types is as it was.

### Changed

- A kind of document the household has hidden is no longer offered, unless a document you can see still uses it; phones that already have such a document keep finding its kind, offline too.

### Fixed

- Text containing a NUL character is refused as a mistake in the request, instead of failing on the server.
- A phone's offline set, and a page of documents of many kinds, no longer look each kind up separately.

### Security

- The built-in kinds of document can no longer be changed by the application at all, and neither can the record of which upgrades the database has had.
- A restore now also checks that no view reads past the households' walls, and that the rules for the household's own kinds of document came back.

## [0.5.5] - 2026-09-26 — iteration 5.6

### Security

- The database itself now answers each kind of caller by its own rule, as a second wall behind the application's checks. A share link is given only the document it was made for, and the newest scan of it, while the link is live, has not been locked by wrong PINs, its maker can still see the document, and the document is out of the Trash; it can change nothing but its own counts of opens and wrong PINs. Sign-in, invitation and reset pages, and anything that does not say who is asking, are given no documents and no exports at all.
- The activity log shows a line only to those a rule names. Every line shown today is shown to the same people; a kind of line added later stays hidden until its audience is decided.
- A restore now checks that these rules came back with the database.

### Fixed

- A release no longer starts on a database a newer release has upgraded: the API and the worker stop with a message saying to run that release, or to restore the backup taken before the upgrade. Without it, an older image put back after this upgrade would start and show an empty vault. Releases before this one do not have the check: going back past 0.5.5 means restoring the backup taken before the upgrade.

## [0.5.4] - 2026-09-26 — iteration 5.5

Groundwork for sharing lists of documents, upload requests and viewers limited to what they are given: every conversation with the database now says who is asking — somebody signed in, the vault itself, a share link, an upload request, or somebody not yet known. Nothing anybody sees changes yet; the next release lets the database refuse what the asker may not see.

## [0.5.3] - 2026-09-26 — iteration 5.4

### Added

- **Quick actions on every document.** A ⋯ beside each document in a list — on Home, in search, on a person's page and in Reminders — offers what the document's own page offers, without going there first: Open, Download, Read full size, Edit details, Share a link, Who can see, Essential on or off, Add a new version, and Move to Trash. You are offered only what you are allowed to do: a viewer sees Open and Download, and a teen can change only their own documents. Downloading an Only me or Essential document still asks you to confirm it is you. If somebody else changed a document since the list was shown, turning Essential on or off loads the list again and says so, rather than overwriting their change. On a phone the actions rise from the bottom of the screen; on a wider screen they open beside the ⋯. The keyboard works too: the arrow keys move through them, and Escape closes them.

### Security

- **Turning Essential off, or taking a document out of Only me, asks you to confirm it is you.** Opening an Essential or an Only me document asks who is asking, but turning Essential off — one tap from the ⋯ — took that question away without asking it, so a session left open on an unlocked computer could download the document straight after. The vault now asks first, as it does before a download; the web app asks from the ⋯, from Who can see and from the edit page. Turning Essential on and making something Only me ask nothing.

### Fixed

- **"Just checking it is you" has the keyboard.** Over the Share sheet it could not be reached without a mouse: Tab went back into the sheet underneath. Wherever it appears, focus now starts in it, Tab stays in it, Escape answers it (and not the sheet under it), and focus goes back where it was afterwards.
- **A link, its PIN, or "Only you can open this" is never lost to Escape.** While a link is being made or a change to who can see is being saved, Escape and Cancel leave the sheet open, so what comes back is shown. These are shown once, only there.
- **A document made Only me from a search keeps its notice until you have read it.** The search used to run again straight away and take the document, and the notice with it, off the screen; it now runs again after "I understand". Your private documents' results stay on screen while it runs, with what the ⋯ said beside them.
- **The menu beside the ⋯ always fits on the screen.** On a wider screen it could run off the bottom, with Move to Trash out of reach. It now opens on the side with room, and scrolls inside itself when there is not enough.
- Moving the only document in a list to the Trash left the keyboard nowhere; focus goes to the list's heading now. A search result that leaves the results leaves focus on the line that counts them.
- Turning Essential off and on again before the list had come back said the document "was changed somewhere else". The second change is now made on the copy the first one saved.
- **Share a link is offered only for a document with a file**, from the ⋯ and on the document's page. With no file yet, the vault always refused it.

## [0.5.2] - 2026-09-26 — iteration 5.3

### Security

- **A viewer is given documents, not the family.** A viewer — an accountant or an attorney with a sign-in, say — could see everybody's date of birth, the household's answers (whether you own a home, how many cars, a business) and the suggestions worked out from them ("No passport for Aisha"). A viewer now sees only their own date of birth, none of the household's answers, and no suggestions.
- **How email is set up is for whoever may change it.** Anyone signed in could read the mail server's settings through the API — the host, the sign-in (often the owner's own address) and its last error. Only an owner sees them now; everyone else is told whether email works.
- **An invitation link on its own shows the address masked.** Anyone holding the link saw the full email it was sent to; it now reads "j•••@example.com" until the code is entered, and leaving the address empty when joining keeps the one it was sent to.

### Fixed

- **`latest` moved to 0.5.1 anyway.** The tool that names the images adds `latest` by itself for any version without a pre-release part, so 0.5.1 — a development build — became `latest` despite the rule 0.5.1 introduced. That is turned off: only a release on `main` moves `latest` now. A vault that follows `latest` may be on 0.5.1, which has the same database as 0.5.0; it moves to 0.5.0 when that is released.

## [0.5.1] - 2026-09-26 — iterations 5.1 and 5.2

The first of Phase 5, on the development branch. 0.5.0 itself is kept on its own branch until the Phase 4 demonstration.

### Added

- **Settings → Trash** lists the documents moved to the Trash, most recent first, and brings any of them back. The vault could always do this; the web app had no way to ask.

### Changed

- **Move to Trash**, with a trash icon, in place of "Move to the bin". It asks first in the app's own dialog rather than the browser's, with Cancel where Enter lands, and Escape keeps the document too. It no longer says a document can be brought back "within 30 days": nothing empties the Trash by itself, so it can be brought back any time. People who cannot change a document — a viewer, or a teen for somebody else's — are no longer offered a button that would refuse them. The activity log says "moved … to the Trash" and "took … out of the Trash".
- **"We noticed something missing" folds away**, on Home and on Reminders, with the number of things in brackets — "We noticed something missing (3)". Your browser remembers whether you folded it.
- **A document's history says who added each version, and exactly when**: "added 26 Sept 2026, 3:12pm by Sarah". It used to say only the date. A viewer is told when, not who — as with the activity log, which a viewer does not see — and somebody whose sign-in was taken away is still named.
- "Show older" at the bottom of "What has been happening" came back after the last page, and loaded that page again.
- **`latest` means a release.** The `latest` images move only for a release on `main` — a milestone or a fix to one — never for a tag on the development branch (like this one) or a release candidate, which publish their own version only. A vault that follows `latest` gets releases; pin `FDV_VERSION` to be exact.
- Every change to the server is now checked against the client the phone app already in use carries, so an upgrade cannot break a phone in somebody's pocket.
- **"What has been happening" is a table**: exactly when, and what happened, left-aligned. Point at a time to see it in words ("yesterday, 4:12pm").

## [0.5.0] - 2026-09-25 — Phase 4 — Pocket

The vault, ready for the family's phones: a scan filed exactly once however
the connection behaves, with its details sent with it; sessions that last as
long as they are used; pages the vault draws itself; the Essentials a phone
may keep for when there is no signal, and a record of what was opened there;
and notifications to phones through UnifiedPush that name nothing.

### Security

- **Rotating the master key moves everything it protects.** `rotate-master-key` used to rewrap only the per-household keys: the two-step sign-in secrets, an S3 bucket's credentials and the mail password stayed under the old key, so after a rotation owners could not finish signing in and mail and S3 stopped working — and nobody was actually signed out. It now moves all of it in one transaction and signs everybody out; it refuses while the vault is running or without the owning database role (`DATABASE_ADMIN_URL`), and says when an earlier run already finished. The API, the worker and every backup now check that the master key opens the vault, and stop with a plain message when it does not — after a rotation, put the new key in `.env` and run `docker compose up -d`, not `start` or `restart`. A vault left partly under each key by an earlier rotation is mended with the new `repair-master-key`, and a backup made before a rotation is restored with `FDV_MASTER_KEY_PREVIOUS`. See "Rotating the master key" in the README.

- Every phone route was attacked together for the release (`phase4-exit.test.ts`): a capture retried and overlapped a hundred ways makes one document; a second adult gets no title or id of the first adult's private documents from any phone route; signing out a phone ends its session, its permission to keep Essentials and its notifications at once, and tells it; a replayed refresh token loses the session; push addresses aimed inside the vault's network are refused however they are written.
- `localhost` (and any name ending in `.localhost`) is refused as a push address by name, not only when DNS says it is this machine.
- **No working link ends up in a log.** A share link's token, a password reset's and an invitation's were written into the API's and nginx's request logs — with a share's PIN beside it, since a download carries it on the address — so a log pasted into a bug report handed over a working link. Both logs now write `[redacted]` in their place and keep no query string at all (a PIN, or what somebody searched for), and nginx no longer logs the referring page.
- **Only those who may share see where documents were shared.** Any teen or viewer could list every link to a document they could see — who it was for ("the divorce lawyer"), who made it and how often it was opened. The list is now empty for them.
- **Nothing the vault sends is kept in a device's HTTP cache.** A phone's HTTP stack keeps a disk cache of whatever it is allowed to: it could keep lists of documents and people after the phone was signed out; after an upgrade it went on saying the vault was on its old version for five minutes; and the check a phone makes over plain http — that it is still talking to your vault — could be answered from that cache after the phone changed networks. Every API answer now says `Cache-Control: no-store` unless its route says otherwise (the capability document said `public, max-age=300`), and `@fdv/client` asks for nothing to be kept or reused with every request. Thumbnails too: an everyday document's could be kept by a browser, on a shared computer after its sign-out as well. What earlier versions let a browser keep stays in its cache until the browser drops it, so signing out of the web app now tells the browser to clear what it kept of the vault (`Clear-Site-Data`; browsers act on it over https and on `localhost`). On a shared computer reached over plain http, clear the browser's cache once yourself.

### Added

- README: **Phones and other apps** — what a phone needs from the vault and what it checks: https and the certificate a vault makes itself, plain http on the home network and its limits, notifications, Essentials for no signal, and what signing out a lost phone does.
- **Notifications on the phone app, through UnifiedPush** (ntfy or another distributor): the day's reminders, a new device signing in, a change of owner, and "this phone was signed out". What a phone is sent carries no titles and no names — a count and a date, or a word for what happened — encrypted to the phone; the app asks the vault for the rest once it is unlocked. `features.unified_push`.
- _Settings → How you hear about things_ lists every browser and phone that hears from the vault, says which have stopped working and when they were last tried, and which are signed out, and sends a test to any of yours.
- `FDV_PUSH_ALLOW_PRIVATE_ENDPOINTS` for a push distributor on your own network.
- **The phone app can keep the Essentials for when there is no connection** (the app's side comes in its next release). The vault decides which: the Essentials each person can see — a teen only their own, a viewer none — and your own Only me ones only if you choose. It asks for your password once, lasts 30 days at most, and ends when the phone is signed out or your password changes; Settings → Signed-in devices says which devices keep Essentials. What was opened without a connection is in the activity log once the phone is back online. `FDV_OFFLINE_MAX_DAYS` (90 by default) is how long a phone may show them without checking in.
- **Read a document without downloading it.** Tap a document's preview and its pages open full size, one at a time: fit to the window, larger when you want to read the small print, turned with the arrows. The vault draws the pages itself, on your server, and keeps them encrypted like the file; Essentials are ready ahead of time, so the phone app can keep them for when there is no signal. The activity log says who looked at what — once per sitting, not once per page.
- iPhone photos (HEIC) now get a thumbnail and page previews: the worker image includes ImageMagick's HEIC support.
- **A phone that loses a refresh answer stays signed in.** On a network that drops answers, a phone could spend its refresh token without hearing back, and the next try looked like a stolen token — signed out. Now the token just replaced may be tried once more, within 30 seconds, from the same app installation; any other replay still signs the device out, for its owner and for a thief alike.
- **A session that ends says why** — expired, signed out, its token used twice, or the person taken out of the household — so the app can say so plainly (`error.reason`).
- **Documents say who issued them.** A family has a dozen bank statements, bills and letters from the same months; now each says whose it is — "Bank statement · Barclays · Sep 2026" — in lists and search results, without opening it. The card asks for it (with the household's own issuers to pick from, and, for a document already in the vault, a suggestion from its letterhead: "From Barclays?", filled in only if you say so). Search finds documents by who issued them and can narrow to one issuer. Statements, bills and policies are named for their issuer: "Barclays statement, September 2026". What a type used to call its issuer (its institution, provider, lender, insurer…) moves into this field; nothing is lost. Like a title, an Only me document's issuer is never shown to anyone else and never goes by email.
- **Adding a document asks what it is before anything is sent.** Choose the file, fill in the card — what it is, whose it is, who can see it, the dates — and Save; the file and its details go to the vault together. A document marked Only me is locked to you from the moment it arrives, never briefly visible to the rest of the family. Skip saves it with no details, to fill in later. Dates can be typed the way people write them: "14 Mar 2031", "March 2031" or just "2031". The name fills itself in from the person you choose ("Aisha's passport"), not from whoever is filing it, and the card says when you'll be reminded.
- **Adding a document can be retried safely.** If the connection drops or the answer is lost on the way back, trying again never makes a second copy: the vault recognises the same upload and answers with what the first try made. Choosing the same file again after an error in the web app counts as trying again. An upload that fails leaves nothing behind — no empty "Needs info" document — and one that overlaps an earlier try still arriving waits for it rather than doubling up. For apps: `GET /api/v1/uploads/{key}` says what became of an upload (see the API changelog).

### Changed

- Every answer says which version of the vault gave it (`X-FDV-Server-Version`), so the phone app notices an upgrade from what it already asks instead of asking again each time it comes to the front.
- Push addresses must start with `https://`, and the vault will not send a notification to an address inside its own network (loopback, private, link-local, cloud metadata) unless you allow it — however the address is written, an IPv4 address inside an IPv6 one included — checked when a device registers and again, on the address DNS gives then, every time one is sent.
- A push service gets ten seconds to answer, so one that never does cannot hold up everybody's reminders. A "this phone was signed out" message its push service would not take is tried again for about four hours.
- The Sunday summary stays an email: the phone app hears of the day's reminders.
- Every way a session ends — signing out, signing it out from another device, refresh-token reuse, a password change or reset, a removed sign-in — now removes that session's notification devices at once.
- A browser that already has notifications on tells the vault again when you sign in, so its notifications follow the new sign-in.
- A device the push service says is gone (404 or 410) is removed and the removal recorded in the activity log; one refused outright (400, 401, 403, 413) is marked not working; one that fails for a while (429, 5xx, no answer) is marked only after ten failures in a row, and one success resets that.
- Opening an Essential asks you to confirm it is you "to open an Essential document". It used to say "a document only you can see" about a passport the whole family can see.
- The thumbnail of an Essential or an Only me document is no longer kept in the browser's cache.
- **Sessions last as long as they are used, up to six months.** A session now lasts 30 days from when it was last used, and 180 days at most from the sign-in — for browsers and the phone app alike. Before, it ended 30 days after the sign-in however much it was used. Sessions open before the upgrade count their 180 days from when they began, so one older than that asks for the password at its next refresh.
- **Each phone is recognised as itself.** The app sends a random installation id (`X-FDV-Installation`), and new-device alerts go by it: updating the app no longer raises an alert, and a second phone on the same app version does. The alert and the list of signed-in devices name the phone: "the app on a Google Pixel 8a". A phone already signed in raises one alert the first time it signs in again after the upgrade, as the vault meets its installation id for the first time.
- `packages/shared` and `packages/client` are now MIT-licensed, so apps that talk to a vault can use them under any licence. The vault itself — server, worker and web app — stays AGPL-3.0. `pnpm lint` fails if either package starts using anything from the AGPL code.

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
