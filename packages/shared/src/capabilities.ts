/**
 * The capability document: the first thing any client fetches from a server,
 * unauthenticated, before deciding what to show.
 *
 * Shape is part of the v1 API contract. Fields are only ever added; clients
 * must ignore fields they do not recognise.
 */

import type { AiReaderKind } from './ai-reader.js';

export const API_VERSION = 1 as const;
export const PRODUCT_ID = 'family-document-vault' as const;

export type Edition = 'self_hosted' | 'hosted';
export type ProtectionMode = 'standard' | 'private';

export interface CapabilityFeatures {
  passkeys: boolean;
  private_mode: boolean;
  /**
   * Email documents to the vault (0.8.0, S4; false before): true only while
   * the worker has a household mailbox set up (FDV_MAIL_IN_*) and has checked
   * it in its last two polls. An owner turns it on (GET, PUT /mail-in);
   * whoever may add documents confirms their address and is told where to
   * send (GET /mail-in/me, POST /mail-in/me/code).
   */
  email_ingest: boolean;
  push: boolean;
  share_links: boolean;
  bulk_import: boolean;
  multi_household: boolean;
  /**
   * Uploads are reserve-then-commit (0.4.8): a retry with the same
   * Idempotency-Key never makes a second document, overlapping tries get
   * 409 upload_in_progress, and GET /uploads/{key} says what became of one.
   */
  idempotent_capture: boolean;
  /**
   * POST /capture takes the card's details as a `metadata` field sent before
   * the file (0.4.9): the document is made complete, and wrapped for the
   * right people, from its first byte.
   */
  capture_metadata: boolean;
  /**
   * Documents carry `issued_by` (0.4.10): on views, edits and captures, in
   * search (matched, and filtered by `issued_by`), GET /issuers and
   * GET /documents/{id}/issuer-suggestions. An older vault refuses the
   * field, so send it only when this is on.
   */
  issued_by: boolean;
  /**
   * The vault draws each version's pages (0.4.12): GET
   * /versions/{id}/pages/{n} serves them as JPEGs, `preview_pages` on a
   * version says how many, and an Essential's are drawn ahead of time.
   */
  page_previews: boolean;
  /**
   * A phone may keep the Essentials for offline use (0.4.13): an offline
   * grant (POST /offline/grant, with the password), the complete set
   * (GET /offline/essentials), the pages to fill it, and the opens it
   * reports afterwards (POST /offline/opens).
   */
  offline_essentials: boolean;
  /**
   * The phone app can have its notifications through its own UnifiedPush
   * distributor (4.13). The same fact as `push`: the VAPID keys are set.
   */
  unified_push?: boolean;
  /**
   * The household keeps kinds of document of its own and changes the
   * built-in ones (0.5.11): created, changed, hidden and archived through
   * /document-types and /document-attributes by owners and adults, and
   * offered to everybody who files documents, each under one of the twelve
   * categories. Absent from older vaults, which have the built-ins only.
   */
  custom_types?: boolean;
  /**
   * Collections of documents (0.5.12): /collections, their items and
   * GET /documents/{id}/collections. Owners, adults and teens make them; each
   * reader is given only the documents in a collection they could see anyway.
   * Absent from older vaults.
   */
  collections?: boolean;
  /**
   * A kind reminds from any date it shows (0.5.15): `remind_from` and
   * `remind_leads` on kinds, `source` and `about` on reminders,
   * `reminders_by_source` on a kind's impact, the built-in Due date. The
   * server has them from 0.5.15, where it says `false`, and says `true`
   * from 0.5.16, when the web's editor for them shipped; a client offers
   * them only when this is true.
   * Absent from older vaults.
   */
  reminder_dates?: boolean;
  /**
   * People have photos (0.5.19): `photo`, `photo_status` and
   * `can_change_photo` on members, and PUT, DELETE and GET
   * /members/{id}/photo. The family sees everyone's, a viewer only their
   * own. Absent from older vaults, where a client shows initials.
   */
  member_photos?: boolean;
  /**
   * A link's options (5.18): POST /documents/{id}/share takes `expires_at`
   * (a date and time), `permission` (`view` or `download`), `max_opens` and
   * `max_downloads`; a link to view serves its pages at
   * /shared/items/{id}/pages/{n} and never the file. Absent from older
   * vaults, which take `expires_in_days` only; send the rest only when this
   * is true.
   */
  share_options?: boolean;
  /**
   * A collection can be shared outside the family (5.19): GET
   * /collections/{id}/share-preview, POST /collections/{id}/shares (always
   * with step-up), links to collections in GET /shares, and the recipient's
   * page giving each document the link still gives. Absent from older
   * vaults.
   */
  collection_shares?: boolean;
  /**
   * A link can ask for more than itself (5.20): a password the vault makes
   * up (`with_password`) or one the sharer types (`password`), and to open
   * in one browser only (`this_device_only`); every failed PIN, password or
   * code uses up the link's one counter of ten. Absent from older vaults,
   * which take `with_pin` alone.
   */
  share_second_factor?: boolean;
  /**
   * A link can ask for a code emailed to an address the sharer typed
   * (5.20, `code_email`; `POST /shared/code` sends it). Only through the
   * mail server of whoever runs the vault (FDV_SMTP_URL, A21), never the
   * household's own: false without one, and a client hides the option,
   * saying why (`SHARE_CODE_UNAVAILABLE`). Absent from older vaults.
   */
  share_email_code?: boolean;
  /**
   * An owner can remove a document in the Trash for good (5.24): POST
   * /documents/{id}/purge, always with step-up — at once for one they filed
   * or that is theirs, anybody else's 24 hours after asking. Absent from
   * older vaults, where nothing is ever removed.
   */
  remove_for_good?: boolean;
  /**
   * A person's details can be changed (5.25): PATCH /members/{id} with
   * If-Match on `version` (`409 conflict` when it moved on), `version` and
   * `can_edit` on members; and an owner's read-only view of somebody's
   * sign-in, GET /members/{id}/account, which asks an owner for two-step
   * sign-in or a passkey (A54). Absent from older vaults, which change
   * nobody's details.
   */
  member_edit?: boolean;
  /**
   * Somebody outside the family can be asked to send documents (5.21), and
   * what they send is looked at before it is filed (5.23): /upload-requests,
   * the sender's /drop routes, and /incoming — the files waiting, their
   * previews, their content, filing one and refusing one. For owners and
   * adults. Absent from older vaults.
   */
  upload_requests?: boolean;
  /**
   * People's identity details, sealed (5.26): GET, PUT /members/{id}/identity
   * and POST …/identity/reveal, a shared part and an Only me part each with
   * its own version; and GET, PUT /household/identity-audience (A34), wider
   * only after 72 hours' notice. Absent from older vaults, which keep none.
   */
  member_identity?: boolean;
  /**
   * An owner can lock somebody's sign-in and unlock it (5.28): POST and
   * DELETE /members/{id}/lock, owner powers (A54); a locked person's sign-in
   * is refused with `403 membership_suspended` once their credentials are
   * proven, and their sessions end with the reason `suspended`. After a
   * restore every sign-in but the owners' is paused until an owner turns it
   * back on (POST /members/{id}/resume; GET /after-restore's `sign_ins`).
   * Absent from older vaults, which lock nobody.
   */
  member_admin?: boolean;
  /**
   * An owner can sign somebody out everywhere (5.30, A53): DELETE
   * /members/{id}/sessions, an owner power (A54); a co-owner too, who is
   * told. A role change says what else it did (`RoleChangeResult.effects`):
   * Essentials on their phones ended, their requests closed, their exports
   * ended. Absent from older vaults.
   */
  sign_out_everywhere?: boolean;
  /**
   * An owner limits what a viewer can see (5.33, D6, A56–A59): PUT and
   * DELETE /members/{id}/access, an owner power (A54, `limit_access`);
   * GET /members/{id}/access/preview counts what a grant not yet saved
   * gives. An invitation for a viewer carries `restriction` — from an
   * adult it must (A27). `/me.restriction` tells a restricted viewer what
   * they can see. Absent from older vaults, which limit nobody this way.
   */
  access_restrictions?: boolean;
  /**
   * Someone outside the family with a sign-in of their own (5.34, D4, A28):
   * an invitation with `kind: 'guest'` — always a viewer's, always limited,
   * with `access_expires_at` within a year (`limits.guest_max_days`). A guest
   * is `role: 'viewer'` and `kind: 'guest'` on /me and GET /members; owners
   * list them with GET /members?kind=guest and renew them with POST
   * /members/{id}/renew (`renew_guest`). Absent from older vaults.
   */
  guests?: boolean;
  /**
   * What a document's pages say about it (5.37, A44):
   * GET /documents/{id}/suggestions proposes its kind, whose it is, when it
   * was issued and when it runs out, its number and who issued it — each
   * with a confidence and the cue it came from, only for fields it has no
   * value for, and only above `PROPOSAL_THRESHOLDS`. For whoever may change
   * the document; offered, never filled in. Absent from older vaults, which
   * have GET /documents/{id}/issuer-suggestions only (it stays).
   */
  detail_suggestions?: boolean;
  /**
   * GET /documents sorts by a column (Phase 6, R2, `DOCUMENT_SORTS`): `sort`
   * by title, kind, person, issued, expires, status, visibility,
   * collections or location, with `direction`, and filters for nobody's
   * (`member_id=none`), a collection (`collection_id`, or `none`) and where
   * the original is kept (`location`); a page carries `total`, and each
   * document its `collections`. A sort or filter by location is for whoever
   * sees locations (422 for anybody else). Absent from older vaults, which
   * refuse those sorts.
   */
  document_table?: boolean;
  /**
   * Many documents at once (Phase 6, I1): POST, GET /batches, GET, PATCH,
   * DELETE /batches/{id} — a batch with defaults that fill only what is
   * blank — POST /batches/{id}/items (one file a request, up to
   * BATCH_MAX_FILES), DELETE …/items/{itemId}, POST …/items/{itemId}/accept
   * (every detail of a capture, and a collection) and GET
   * …/items/{itemId}/pages/{n}. For whoever may add documents; a batch and
   * its items are its uploader's alone until accepted. Absent from older
   * vaults, which take one file at a time.
   */
  batches?: boolean;
  /**
   * The vault reads each item and suggests (Phase 6, I2): a batch's items
   * are read one at a time a household, and GET /batches/{id} (and an item
   * as POST …/items answers it) gives each its `read_failure`, `level`,
   * `tags`, `proposals` (each detail the card starts from, read from the
   * pages with a confidence, or the batch's default) and `clashes` — for
   * its uploader alone. Absent from older vaults, whose items have none.
   */
  batch_proposals?: boolean;
  /**
   * The review queue (Phase 6, I3): POST /batches/{id}/accept-ready files
   * every item Ready now, each as its untouched card would, and POST
   * …/accept-ready/undo takes them back into the queue for
   * ACCEPT_UNDO_MINUTES; GET /batches?with=levels counts each batch's
   * levels, and `counts.removed`. Absent from older vaults: accept each.
   */
  batch_review?: boolean;
  /**
   * The vault learns from your corrections (Phase 6, I4): each person's own
   * small rules — this issuer → this kind, this issuer → this person —
   * learned from what they accept and used only on their own items, where a
   * proposal says `from: 'learned'`. GET /batches/learned gives the caller
   * the count ("Of your last 50 accepted, 31 needed no change") and their
   * rules; DELETE /batches/learned forgets them. Absent from older vaults.
   */
  batch_learning?: boolean;
  /**
   * Duplicates as versions (0.8.0, S1): an item's `renewals` — documents the
   * uploader may change that it is probably a new version of, from what its
   * pages proposed — and POST …/items/{itemId}/accept with
   * `into_document_id`, which adds it to one as its new version, taken back
   * with …/accept-ready/undo. Absent from older vaults: accept, or discard.
   */
  batch_versions?: boolean;
  /**
   * A watched folder for network scanners (0.8.0, S3): true only while the
   * worker has the folder (FDV_WATCH_DIR) set, there and writable, and has
   * said so lately. An owner turns it on and chooses whose Inbox it fills
   * (GET, PUT /watch-folder); whoever it fills is told of a file it could
   * not add (GET /watch-folder/notices). Absent from older vaults.
   */
  watch_folder?: boolean;
  /**
   * Folder names → suggested details (0.8.0, S2): POST
   * /batches/{id}/items takes an optional `relative_path` field before the
   * file — where it was under the folder chosen or dropped — kept sealed and
   * given back to its uploader alone as the item's `folder`; and what its
   * segments say of the kind, whose it is and tags is proposed with
   * `from: 'folder'`. The scanner folder's subfolders are kept the same way.
   * Absent from older vaults, which refuse the field: send the file alone.
   */
  folder_suggestions?: boolean;
  /**
   * A computer that sends scans (0.8.0, D1): POST /device-pairings (a
   * one-time code, after the step-up), POST /devices/pair (the code traded
   * for an upload-only key), POST /device-uploads and GET /devices/me (the
   * only routes that take `Authorization: Device <id>.<key>`), and
   * GET /paired-devices, DELETE /paired-devices/{id}. Absent from older
   * vaults: there is no computer to pair.
   */
  device_uploads?: boolean;
  /**
   * Detail tags (0.9.0, T1): a tag's first `: ` splits a label from a value
   * ("locker: 12"), kept as written. The tag filter (`tag`) matches whatever
   * the case; `tag_label` filters GET /documents by a label, any value; and
   * GET /tags takes `limit` (up to 1,000) and gives each tag's `label`,
   * `value` and `changeable`. Tags are 40 characters at most and 50 a
   * document, as always, refused in words. Absent from older vaults, which
   * keep a tag in lower case and match it exactly.
   */
  tag_details?: boolean;
  /**
   * A tag renamed, merged or deleted across documents (0.9.0, T1): POST
   * /tags/rename (`from`, `to`, and `merge: true` into a tag that is there
   * already, else `409 tag_exists`) and POST /tags/delete (`tag`), for
   * whoever may change documents — on those they may change, and counted
   * only on those they can see. Absent from older vaults.
   */
  tag_management?: boolean;
  /**
   * The Reading check (0.9.0, R0): an owner's measure of the reader on the
   * family's own papers, numbers only. POST and GET /reading-checks,
   * GET /reading-checks/{id} (the summary, and the caller's own misses),
   * POST /reading-checks/{id}/cancel and DELETE /reading-checks/{id}; an
   * owner's alone. Absent from older vaults.
   */
  reading_check?: boolean;
  /**
   * The vault's reading model (0.9.0, R2): a small local text classifier
   * that reads a batch's pages beside the rules, one more cue for the kind
   * (`ItemSuggestion.model`); GET and PUT /household/reading turn it on or
   * off, an owner's. Absent from older vaults.
   */
  reading_model?: boolean;
  /**
   * The local AI reader (0.9.0, R4): an Ollama-compatible model on the
   * household's own server, set up by the operator in .env alone, that reads
   * a batch's pages beside the rules — one more cue, never Ready on its own
   * (`ItemSuggestion.local_ai`, the tags `local_ai`, `clash_local_ai`,
   * `local_ai_without`). True while a worker has one set up and said so
   * lately; GET and PUT /household/reading `{ local_ai }` turn it on or off
   * for the household, an owner's, and POST /household/reading/local-ai/test
   * tests it. Since AIR1 also true where an owner may set the reader in
   * Settings (`ai_reader_settings`), so that every client asks the notice.
   * Absent from older vaults.
   */
  local_ai?: boolean;
  /**
   * A collection from a checklist (0.9.0, C1): GET, POST and PUT
   * /collections/{id}/checklist and POST /collections/{id}/checklist/add —
   * a list read with plain rules, matched against what the reader may see,
   * kept on the collection, and its documents added only as its maker
   * ticks them. Absent from older vaults.
   */
  collection_checklist?: boolean;
  /**
   * Notes kept on their own (0.9.0, N1): a document of the built-in kind
   * `note` with no file, whose words are its `notes`, written with POST
   * and PATCH /documents as any document's are; GET /notes lists the
   * caller's, each with a preview, and finds within them (`q`). A note
   * takes no file (`422 note_has_no_file`), and its link is read on the
   * page (GET /shared/items/{id}/note). Absent from older vaults.
   */
  notes?: boolean;
  /**
   * The family's time zone (0.9.0, TZ): GET /household/timezone says the
   * zone every time is shown on, whether an owner chose it or it is the
   * server's default (FDV_TIMEZONE), and that default; an owner changes it
   * with PUT /household/timezone (null goes back to the default). The
   * profile's `timezone` is the zone in effect, with `timezone_source`.
   * Absent from older vaults.
   */
  household_timezone?: boolean;
  /**
   * No longer needed (0.9.0): POST /documents/{id}/no-longer-needed
   * (`reason`, up to 200 characters; `replaced_by`, a document the caller
   * can see) and DELETE to mark it needed again, for whoever may change the
   * document. While marked, its status is `no_longer_needed`, its
   * `no_longer_needed` says when, by whom, why and what replaced it (never a
   * replacement the reader may not see), nothing reminds of it, and
   * GET /documents?status=no_longer_needed lists them. Absent from older
   * vaults.
   */
  no_longer_needed?: boolean;
  /**
   * Each version's own details (0.9.0): a version a newer one replaced
   * keeps its dates, number, issuer and its kind's details, frozen as they
   * were (`VersionView.details`; `details_kept: false` for one replaced
   * before 0.9.0, never guessed); a new version starts from the one
   * before's, `details_unconfirmed` until somebody confirms them. GET
   * /documents/{id}/suggestions gives `renewal`, what the newest version's
   * pages read of the fields a renewal changes; POST
   * /documents/{id}/renewal makes them its details (If-Match), as a
   * renewal — its reminders made again — and POST
   * /documents/{id}/renewal/undo takes that back for RENEWAL_UNDO_MINUTES.
   * Absent from older vaults.
   */
  version_details?: boolean;
  /**
   * A share link shown again (0.9.0; the owner's decision of 11 Nov 2026):
   * the vault keeps a sealed copy of each link as it is made, and its PIN or
   * made-up password, and `POST /shares/{id}/reveal` shows them to the
   * account that made it, after confirming it's them (`reveal_share`).
   * `Share.revealable` says which. Links made before stay shown once.
   * Absent from older vaults.
   */
  share_reveal?: boolean;
  /**
   * The vault emails a share link to its recipient for whoever made it
   * (0.9.0; the owner's decision of 13 Nov 2026): `POST /shares/{id}/email`,
   * through the mail server of whoever runs the vault (FDV_SMTP_URL, A21)
   * and never the household's own — false without one, and a client offers
   * only Copy. Never the PIN, password or code, nor what the link is to.
   * `Share.emailable` says which links. Absent from older vaults.
   */
  share_link_email?: boolean;
  /**
   * 0.9.0 (V1, the phone's filter panel): GET /documents and GET /search
   * take several comma-separated values for `member_id`, `type_key`,
   * `category`, `status` and `visibility` (any of them), and the days
   * `added_from`/`added_to`, `issued_from`/`issued_to` and
   * `expires_from`/`expires_to` (`YYYY-MM-DD`, both included). Search
   * takes `type_key`, `status` and `visibility` too. Absent from older
   * vaults, which take one value each and no days.
   */
  document_filters?: boolean;
  /**
   * 0.9.0 (the owner's tidy-up of 11 Nov 2026): GET /documents and GET
   * /search take several tags, `tag` given once for each (`tag=a&tag=b`),
   * any of them; search takes `tag` at all. Absent from older vaults,
   * which take one tag, on the list only.
   */
  tag_filters?: boolean;
  /**
   * 0.9.0 (the owner's tidy-up of 11 Nov 2026): GET /documents and GET
   * /search take `notes=exclude`, documents without the notes — what the
   * phone's Documents tab and the web's Documents table keep to, and count.
   */
  notes_apart?: boolean;
  /**
   * Text messages (0.9.0, SMS1): this vault can send texts through the
   * household's own SMS Gate, once an owner has set it up and a test has
   * passed — GET /sms/status says whether it has (`{ ready }`, anybody
   * signed in). Owners set it up with GET, PUT and DELETE /sms/settings and
   * POST /sms/settings/test; anybody adds their own mobile number, and an
   * owner anybody's, with GET, PUT and DELETE /members/{id}/phone, POST
   * /members/{id}/phone/confirm and /resend: a code texted to it confirms
   * it. Absent from older vaults.
   */
  sms_texts?: boolean;
  /**
   * Notifications by text (0.9.0, SMS2): GET and PUT
   * /notifications/preferences carry `daily_text`, `alerts_text` and
   * `share_opened_text` (each off until turned on) and the quiet hours
   * `quiet_from` and `quiet_to` ("21:00" and "08:00" until chosen). Texts go
   * only to the person's own confirmed number, and only while the
   * household's texts are set up (GET /sms/status). Absent from older vaults.
   */
  sms_notifications?: boolean;
  /**
   * Codes by text (0.9.0, SMS3). A share link may ask for its code by text
   * (`second_factor: 'sms'` and `recipient_phone` on POST /documents/{id}/share
   * and /collections/{id}/shares; `Share.second_factor`, its `code_to` masked;
   * POST /shared/code texts it). An owner may text an invitation's code
   * (`invitee_phone` on POST /invitations and /members/{id}/invite;
   * `CreatedInvitation.code_texted_to` or `code_text_problem`). And each
   * person may ask for a code to their own confirmed number when their
   * password is reset and at sign-in (GET and PUT /auth/text-codes): a reset
   * then asks for it (`ResetPreview.text_code_to`; POST /password-resets/code
   * texts it; `code` on POST /password-resets/complete), and so does a
   * sign-in (`MfaChallenge.methods` has `text`; POST /auth/mfa/text texts it;
   * `method: 'text'` on POST /auth/mfa). Adults and teens may confirm it's
   * them with one (`StepUpState.text_to`; POST /auth/step-up/text; `text_code`
   * on POST /auth/step-up). Only ever in addition: never an owner's only
   * second step, nor what an owner's powers ask. Absent from older vaults.
   */
  sms_codes?: boolean;
  /**
   * The household as a document's owner (0.9.0, the owner's decision of 11
   * Nov 2026): `DocumentView.household_owned`, sent as `household_owned` on
   * POST and PATCH /documents and a capture's metadata; `member_id=household`
   * on GET /documents (a column sort) and GET /search, beside `none`, now
   * meaning Not sure yet (nobody, and not the household's); and each kind's
   * `belongs_to` (`'person' | 'household'`), changed on PATCH
   * /document-types/{key}, which a new document of the kind follows. Only
   * Not sure yet reads Needs a person. Absent from older vaults.
   */
  household_owner?: boolean;
  /**
   * Sensitive (0.9.0, AIR2 of the AI readers plan): each kind's
   * `sensitive_default` (per household; set on POST and PATCH
   * /document-types), and each document's own `sensitive` (null as its
   * kind says, true, false) with `sensitive_effective`, all said
   * (`sensitiveOf`) — on `DocumentView` and `SearchHit`. Sent as
   * `sensitive` on POST and PATCH /documents, a capture's metadata, a
   * batch item's accept, POST /incoming/{id}/accept and a batch's defaults
   * (`BatchDefaults.sensitive`); left out, kept as it is.
   * `sensitive=yes,no` on GET /documents and GET /search. A teen may make
   * a document sensitive, never not. Absent from older vaults.
   */
  sensitive_documents?: boolean;
  /**
   * The AI reader set in Settings (0.9.0, AIR1): an owner sets the reader's
   * kind, address, model, timeout and API key at Settings → Reading → AI
   * reader — GET, PUT (step-up `change_ai_reader`) and DELETE
   * /household/reading/ai-reader; POST /household/reading/ai-reader/test,
   * which must pass before it is used, and /household/reading/ai-reader/models,
   * both answered by the worker (GET /settings-checks/{id}: `ai_reader`,
   * `ai_models`). The key is never returned, only `set` and its last four
   * characters. Where the operator set FDV_LOCAL_AI_URL and
   * FDV_LOCAL_AI_MODEL, they win and are shown locked (`source: 'env'`).
   * Absent where the operator took it out of Settings
   * (FDV_AI_READER_SETTINGS=off), and from older vaults.
   */
  ai_reader_settings?: boolean;
  /**
   * The kinds of reader this vault reads with (AIR1): `['ollama']` in AIR1;
   * since AIR3 also `anthropic` and `openai_compatible`. Beside
   * `ai_reader_settings`; absent from older vaults.
   */
  ai_reader_kinds?: AiReaderKind[];
  /**
   * Who may be sent to a cloud reader, and how many (0.9.0, AIR3): a
   * sensitive paper's words only with the household's "Also send sensitive
   * papers" on, an Only me paper's never, and at most the reader's monthly
   * cap of papers. GET /household/reading/ai-reader says `send_sensitive`
   * and `month` ({ month, sent, cap, warned }); PUT
   * /household/reading/ai-reader/send-sensitive `{ send_sensitive }` sets
   * the switch — an owner's, with step-up `send_sensitive_papers`; a phone
   * shows both, read only. An OpenAI-compatible reader's `own_network`.
   * Beside `ai_reader_settings`; absent from older vaults.
   */
  ai_reader_send_sensitive?: boolean;
  /**
   * Neutral wording in notifications and email (0.9.0, H2): GET and PUT
   * /household/neutral-wording `{ neutral_wording: 'off' | 'health' |
   * 'sensitive' | 'all' }` — the household's, an owner's (PUT asks step-up
   * `neutral_wording` for a change that names any document the old choice
   * left unnamed; `403` to anybody else) — and GET and PUT
   * /notifications/wording, each person's own (`MyWordingView`:
   * `neutral_wording` `'household' | 'health' | 'sensitive' | 'all'`,
   * `household`, `in_effect` — the choices that apply; a line is neutral
   * when either says so; naming more to them asks the same step-up). Absent
   * from older vaults, which name every document but Only me by email.
   */
  neutral_wording?: boolean;
}

export interface CapabilityLimits {
  max_upload_bytes: number;
  /** `null` means unlimited, which is the self-hosted default. */
  max_members: number | null;
  /** `null` means unlimited, which is the self-hosted default. */
  max_storage_bytes: number | null;
  /**
   * The longest a share link may last, in days (5.18: FDV_SHARE_MAX_DAYS,
   * 90 unless the operator shortens it). An `expires_at` past it is refused.
   * Absent from older vaults, which take 90.
   */
  share_max_days?: number;
  /** The longest a guest's sign-in lasts before an owner renews it, in days (5.34, A28). */
  guest_max_days?: number;
}

export interface Deprecation {
  field: string;
  removed_in: string;
}

export interface Capabilities {
  product: typeof PRODUCT_ID;
  server_version: string;
  api_version: typeof API_VERSION;
  min_client_version: string;
  edition: Edition;
  protection_mode: ProtectionMode;
  /** True until the first-run wizard has created the household. */
  setup_required: boolean;
  features: CapabilityFeatures;
  limits: CapabilityLimits;
  deprecations: Deprecation[];
  branding: { display_name: string };
  /**
   * This installation, as a random identifier made once and never changed
   * (0.4.4). A client that approved a vault at an address can tell whether
   * the same vault still answers there. Absent from older servers.
   */
  instance_id?: string;
}
