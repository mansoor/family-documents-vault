import {
  addFolderTree,
  askedFolders,
  compareFolders,
  ARRANGE_BY,
  CABINET_CHANGED,
  CABINET_FILTER_KEYS,
  CABINET_LIMITS,
  CABINET_TOO_BIG,
  drawCabinet,
  dividerKeyOf,
  dividerMode,
  layoutProblemOf,
  OTHER_YEARS,
  PIN_IN_TRASH,
  PIN_LIMITS,
  rangesNewestFirst,
  TOO_MANY_PINS,
  type FolderDivider,
  type PinsMoved,
  type CabinetGroup,
  type CabinetLayout,
  type CabinetFromFolders,
  type CabinetView,
  type DocumentPage,
  shortName,
  THE_HOUSEHOLD,
  NOT_SURE_YET,
  HOUSEHOLD_MEMBER_FILTER,
  CLOCK_TIME,
  QUIET_FROM_DEFAULT,
  QUIET_TO_DEFAULT,
  MY_WORDINGS,
  myWordingOf,
  NEUTRAL_WORDING_DEFAULT,
  NEUTRAL_WORDINGS,
  rulesInEffect,
  type MyWording,
  type MyWordingView,
  type NeutralWording,
  type NeutralWordingView,
  type Preferences,
  maskPhone,
  parsePhone,
  PHONE_CODE_MINUTES,
  PHONE_CODE_TRIES,
  phoneCodeText,
  inviteCodeText,
  mayStepUpByText,
  SMS_OWNER_NEEDS_FACTOR,
  textCodeText,
  type MemberPhoneView,
  type MfaChallenge,
  type TextCodePurpose,
  type TextCodeSettings,
  NOTE_KIND,
  ZIP_LEFT_OUT,
  ZIP_MAX_DOCUMENTS,
  attachmentDisposition,
  csvCell,
  noteMarkdown,
  safeExtension,
  safeFileName,
  zipFileName,
  zipNames,
  zipTooLarge,
  noteMatchWords,
  notePreview,
  numbersOnly,
  READING_CHECK_N,
  READING_MISSES_KEEP_DAYS,
  scoreReading,
  type ReadingCheckDetail,
  type ReadingCheckSummary,
  type ReadingCheckView,
  type ReadingChecksList,
  type ReadingMiss,
  type ReadingRow,
  CHECKLIST_TEXT_MAX,
  checkChecklist,
  checklistMissing,
  itemAgain,
  readChecklist,
  savedItem,
  type ChecklistAdded,
  type ChecklistContext,
  type ChecklistDoc,
  type ChecklistItem,
  type CollectionChecklist,
  DEVICE_PLATFORMS,
  DEVICE_REFUSALS,
  deviceBatchName,
  deviceName,
  nextLocalMidnight,
  normalisePairingCode,
  relativePathProblem,
  PAIRING_ALPHABET,
  PAIRING_ATTEMPTS,
  PAIRING_CODE_LENGTH,
  PAIRING_MINUTES,
  showPairingCode,
  type DeviceMe,
  type DevicePaired,
  type DevicePairingCode,
  type DevicePausedReason,
  type DevicePlatform,
  type DeviceUploaded,
  type PairedDevice,
  BATCH_MAX_FILES,
  batchVisibility,
  correctionsOf,
  learningOf,
  LEARNED_RULES_MAX,
  LEARNING_OUTCOMES_KEPT,
  LEARNING_WINDOW,
  isLearned,
  itemFolder,
  levelItem,
  appFilesItself,
  RELATIVE_PATH_MAX,
  lessonIssuer,
  periodic,
  lessonTrusted,
  ruleTrusted,
  shapeLessonOf,
  SHAPES_MAX,
  suggestFromFolder,
  teach,
  teachShape,
  unteachShape,
  can,
  normaliseTag,
  normaliseTags,
  tagDetail,
  tagKey,
  tagLabelKey,
  tagsProblem,
  belongsTo,
  canEditIdentity,
  canSee,
  canSeeCollection,
  canSeeIdentity,
  CATEGORY_LABELS,
  describeEvents,
  checkCaptureMetadata,
  checkExtra,
  COLLECTION_AUDIENCES,
  COLLECTION_DESCRIPTION_MAX,
  COLLECTION_ITEMS_PAGE,
  COLLECTION_ITEMS_PAGE_MAX,
  COLLECTION_NAME_MAX,
  collectionItemHint,
  CORE_FIELDS,
  DECEASED_REFUSAL,
  DECEASED_SIGNED_IN,
  DOCUMENT_PAGE_MAX,
  deriveStatus,
  effectiveVisibility,
  EXPIRY_ALWAYS_REQUIRED,
  GUEST_ALWAYS_LIMITED,
  HOUSEHOLD_OR_PERSON,
  SENSITIVE_BY_DEFAULT,
  SENSITIVE_SHARE_CONFIRM,
  sensitiveOf,
  claimedRecordFormat,
  deliveredType,
  recordFileName,
  isRecordFormat,
  viewNotPossibleWords,
  TEEN_KEEPS_SENSITIVE,
  GUEST_MAX_DAYS,
  GUEST_ONLY_VIEWER,
  guestAccessEnded,
  guestAccessEndedWords,
  guestEndProblem,
  IDENTITY_AUDIENCES,
  canonicalZone,
  IDENTITY_EDIT_REFUSAL,
  IDENTITY_NOTICE_HOURS,
  identityAudienceRank,
  identityChanges,
  identityFilled,
  identityTooLong,
  IDENTITY_TOO_LONG,
  inCollectionAudience,
  incomingFileName,
  LOCK_MAX_DAYS,
  LOCK_NOTE_MAX,
  maskIdentity,
  mergeIdentityWrite,
  onlyEveryone,
  restrictionSummary,
  youCanSee,
  revealIdentity,
  libraryHasName,
  missingFields,
  NO_LONGER_NEEDED_REASON_MAX,
  nextReminder,
  remindingDateOptional,
  parseRecurrence,
  REVIEW_NOTE,
  yearlyReviewOffered,
  reminderLabel,
  ageOn,
  CHILD_BIRTHDAY_REFUSAL,
  childBirthday,
  localToday,
  oldEnoughToSignIn,
  ROLE_NOT_FOR_AGE,
  roleSuitsAge,
  TOO_YOUNG,
  turnedThirteenWords,
  PHOTO_MAX_BYTES,
  PHOTO_TYPES,
  PREVIEW_MAX_PAGES,
  PRIVATE_BY_DEFAULT,
  PRIVATE_TO_THEM,
  PURGE_NOTICE_HOURS,
  refusalFor,
  RESET_LINK_MINUTES,
  resetCommand,
  seesLocation,
  placeWords,
  PLACE_SEPARATOR,
  PLACE_NOT_IN_CABINET,
  NAME_HOLDS_SEPARATOR,
  ORIGINAL_PLACE_MOST,
  type OriginalPlaceBulkResult,
  shareEndWords,
  suspensionInEffect,
  TYPE_IN_USE,
  TYPE_LABEL_MAX,
  UNSEEN_DOCUMENTS,
  type AccessGrant,
  type ActivityEvent,
  type AccessPreview,
  type BatchDefaults,
  type BatchDuplicate,
  type BatchItemView,
  type BatchLearning,
  type BatchReadFailure,
  type BatchReadState,
  type DetailProposal,
  type ItemProposals,
  type Proposed,
  type KeptRule,
  type KeptShape,
  type PaperReading,
  type ShapeTaught,
  type LearnedClash,
  type Capabilities,
  isLoopbackName,
  isPrivateAddress,
  mailInAddressRefused,
  type MailInMailboxView,
  type MailInView,
  type CreatedShare,
  type RevealedShare,
  type Share,
  type ShareOpening,
  type DocumentLinkOpening,
  type ShareEmailed,
  isShareAddress,
  maskEmail,
  SHARE_LINK_EMAIL_UNAVAILABLE,
  SHARE_LINK_EMAILS,
  shareLinkMessage,
  type CaptureMetadata,
  type CollectionAudience,
  type CollectionDetail,
  type CollectionManagers,
  type CollectionPowers,
  type CollectionView,
  type CoreField,
  type CoreFieldRule,
  type DateValue,
  type DocumentAttributeView,
  type DocumentTypeImpact,
  type DocumentTypeView,
  type TypeField,
  type DocumentView,
  type IncomingFileView,
  type UploadRequestView,
  type IdentityAudience,
  type FamilyTimeZone,
  type EndedSharing,
  type EndedSharingDays,
  type IdentityAudienceView,
  type IdentityFields,
  type IdentityPart,
  type IdentityPartView,
  type DetailSuggestions,
  type IssuerSuggestions,
  type Invitation,
  type MemberAccess,
  type MemberAccount,
  type MemberKind,
  type MemberSuspension,
  type MyRestriction,
  type OfflineGrant,
  type OfflineItem,
  type PausedSignIn,
  type PersonReminderView,
  type ReminderView,
  type ResetNotice,
  type ResetPath,
  isDocumentSort,
  LOCATION_SORT_REFUSAL,
  maySortByLocation,
  OLDER_DOCUMENT_SORTS,
  STATUS_ORDER,
  statusRank,
  type DocumentSort,
  type Role,
  type Tokens,
  type VersionView,
  type Visibility,
  ACCEPT_READY_MAX,
  ACCEPT_UNDO_MINUTES,
  untouchedAccept,
  type BatchAcceptInput,
  type BatchAcceptReadyResult,
  type BatchLevelCounts,
  type BatchUndoResult,
  type UndoKept,
  type BelongsTo,
  AI_READER_KINDS_OFFERED,
  type AiReaderView,
  GROWN_UP_ANSWERED,
  GROWN_UP_EXPLAINED,
  GROWN_UP_ONLY_ME_THEIRS,
  GROWN_UP_QUESTION,
  GROWN_UP_THEIRS_TO_ANSWER,
  roleFirstWords,
  mayGiveCare,
  mayNameOwnCaregiver,
  turnedEighteenWords,
  type CaregiverGrantView,
  canEditEmergency,
  canSeeEmergency,
  choosesEmergency,
  EMERGENCY_DEFAULT_AUDIENCE,
  EMERGENCY_DOCUMENT_KINDS,
  EMERGENCY_FIELD_KEYS,
  EMERGENCY_LINK_DEFAULT_HOURS,
  EMERGENCY_LINK_MAX_HOURS,
  type EmergencyAudience,
  type EmergencyDocumentKind,
  type EmergencyDocumentRef,
  type EmergencyFieldKey,
  type EmergencyFields,
  type EmergencyLink,
  type EmergencyView,
  type GrownUpQuestionView,
  type ChangedShare,
  type ChangedUploadRequest,
  type RevealedUploadRequest,
} from '@fdv/shared';
import {
  fakeAppFilesAutomatically,
  fakeAppRoutes,
  fakeExpireAppKey,
  type FakeApp,
} from './fake-apps.js';
import type { FetchLike, ResponseLike } from '../http.js';
import { partsOf, readBody, type Part } from './body.js';
import { storedZip } from './zip.js';

/**
 * A vault in memory, for testing clients without a server.
 *
 * It covers the endpoints a client's session and capture paths lean on,
 * and it behaves the way the real API does where behaving differently
 * would hide bugs: refresh tokens rotate, and presenting a spent one ends
 * the session. `contract.ts` runs the same scenarios against this and
 * against the real API, so the two cannot drift apart unnoticed.
 */

interface FakeSession {
  id: string;
  refresh: string;
  previous: string | null;
  revoked: boolean;
  /** The app installation that signed in (X-FDV-Installation), as the real vault keeps it. */
  installation?: string | null;
  /** When the refresh token was last replaced, and whether its one replay is spent. */
  rotatedAt?: number;
  graceUsed?: boolean;
  /** Tokens a grace replay touched: presented again, they end the session. */
  graceTokens?: string[];
  /**
   * Every token it has been given and replaced (5.30): as the real vault's
   * tokens name their session, any of them presented again ends it.
   */
  spent?: string[];
  /** Why it ended, as the real vault says it: since 5.28 `suspended`, by a lock. */
  endedBecause?: 'revoked' | 'reused' | 'suspended';
  /** Its offline grant, as the real vault keeps it on the session (0.4.13). */
  offlineGrant?: OfflineGrant | null;
  /**
   * Whose it is, when it is not the fake's own person's (5.28): somebody
   * in `signIns`, who signed in with their own password.
   */
  memberId?: string;
}

/** Somebody's mobile number in the fake (SMS1), and the code out for it. */
export interface FakePhone {
  /** E.164. */
  number: string;
  confirmed_at: string | null;
  /** The newest code texted, while it can still be typed. */
  code: string | null;
  code_expires_at: number | null;
  attempts: number;
  updated_at: string;
}

export interface FakeVaultState {
  setupRequired: boolean;
  /**
   * Each person's own cabinet (0.9.0, C1), by member id, as GET /cabinet
   * gives it: theirs alone, saved to the version last read.
   */
  cabinets?: Record<string, CabinetView>;
  /**
   * The papers each person pinned into their folders (0.9.0, C2), by
   * member id: shown only while they may open the paper, out of the Trash.
   */
  cabinetPins?: Record<
    string,
    Array<{ folder_id: string; document_id: string; pinned_at: string }>
  >;
  /** The household's name, as set up: a container in a folder's name (S2). */
  householdName?: string | null;
  email: string | null;
  password: string | null;
  sessions: FakeSession[];
  /** access token → session id */
  access: Map<string, string>;
  documents: FakeDocument[];
  /**
   * The household's types: a few real ones, by default. GET /document-types
   * answers them as the real vault does (0.5.6): one set `hidden` is left
   * out unless a document uses it, or the client asks with `?all=true`.
   */
  types: DocumentTypeView[];
  /** What GET /document-attributes answers (0.5.6). */
  attributes: DocumentAttributeView[];
  /** What GET /members answers: the one person the fake signs in as, by default. */
  members: Array<{
    id: string;
    display_name: string;
    /** Null for somebody with no sign-in (yet). */
    role: string | null;
    is_me: boolean;
    /** Their photo, once made (0.5.19). */
    photo?: { id: string } | null;
    /** A photo on its way: the next GET /members answers it made, as the vault's worker would. */
    photo_status?: 'processing' | 'failed' | null;
    can_change_photo?: boolean;
    /** Their details (5.25): changed by PATCH /members/{id}, each change a new version. */
    date_of_birth?: string | null;
    relationship?: string | null;
    is_deceased?: boolean;
    version?: number;
    can_edit?: boolean;
    /**
     * Of the family, or a guest from outside it (5.34): a guest is left out
     * of GET /members but for themselves, and an owner lists them with
     * `?kind=guest`. Their sign-in ends at `access_expires_at`.
     */
    kind?: MemberKind;
    access_expires_at?: string | null;
  }>;
  /**
   * Invitations (5.34): what POST /invitations makes and POST
   * /invitations/accept spends — the person made at once (a guest never
   * among the family), their sign-in, role, limits and end once accepted.
   */
  invitations: FakeInvitation[];
  /**
   * The owner's view of each person's sign-in (5.25), by member id: what
   * GET /members/{id}/account answers an owner with two-step sign-in. The
   * fake's owner has none unless a test says (`ownerTwoStep`), and is
   * refused it, as the real vault refuses an owner with only a password.
   */
  memberAccounts: Map<string, MemberAccount>;
  ownerTwoStep: boolean;
  /**
   * Whether an adult signed in has a passkey or a code (CL2), for what asks
   * one of anybody, as confirming a connected app's key does: they have,
   * unless a test sets this to false (`403 two_step_required`).
   */
  adultTwoStep?: boolean;
  /**
   * People's identity details (5.26), by member id: each part's fields, as
   * the real vault keeps them sealed, and its version. The fake signs in as
   * `fake-member`; another person's Only me part is not there for it.
   */
  identities: Map<
    string,
    Partial<Record<IdentityPart, { fields: IdentityFields; version: number; updated_at: string }>>
  >;
  /** Who reads other people's shared identity details (A34), and a widening waiting its 72 hours. */
  identityAudience: IdentityAudience;
  /**
   * People whose sign-in is switched off, by member id: they could not be
   * told of a wider audience, so it is refused while there are any (5.26).
   */
  signInsOff: string[];
  /**
   * Other people's sign-ins (5.28): each signs in with its own email and
   * password as the person it names, one of `members`, and its sessions are
   * theirs. Its tokens and GET /me, locking and unlocking, the account card
   * and GET /after-restore know who is asking; everything else the fake
   * answers as its one person, whoever asks.
   */
  signIns: Array<{ member_id: string; email: string; password: string }>;
  /**
   * Sign-ins locked by an owner or paused after a restore (5.28), by member
   * id — the fake's own person, `fake-member`, included: a test sets one to
   * show a phone its paused screens. While one is in effect (a lock past
   * its `until` is over, by the clock) the person's sign-in is refused once
   * the password is right (`403 membership_suspended`) and their sessions
   * answer `401 session_ended` with the reason `suspended`, as the real
   * vault's do. `pauseSignIns()` pauses them as a restore does.
   */
  suspensions: Map<string, MemberSuspension>;
  /** The household's clock (5.28): the end of a lock is said in it. UTC, as a new vault's. */
  timezone: string;
  /**
   * Whether `timezone` is an owner's choice or the server's default (0.9.0,
   * TZ), and that default: GET and PUT /household/timezone answer them.
   */
  timezoneSource: 'household' | 'server_default';
  serverTimezone: string;
  /**
   * How long ended links and requests are kept (0.9.0, RQ): 30, 90 or 365
   * days, or null for never. GET and PUT /household/ended-sharing answer it;
   * the fake removes nothing.
   */
  endedSharingDays: EndedSharingDays | null;
  /**
   * What an owner has limited each viewer to (5.33), by member id: what PUT
   * and DELETE /members/{id}/access write, what the preview counts by the
   * real vault's rule, and what GET /me tells the viewer. The fake's lists
   * of documents are not narrowed by it: a phone is (5.36).
   */
  restrictions: Map<string, FakeRestriction>;
  /**
   * Whether whoever runs the vault gave it a mail server (FDV_SMTP_URL),
   * as the contract's real vault has: a reset an owner starts (5.29) then
   * goes by it, `mail`. Without one, `handover` for somebody who keeps
   * nothing private, `operator` for anybody in `keepsPrivate`.
   */
  operatorMail: boolean;
  /**
   * People who keep something private (5.29), by member id: the fake keeps
   * no record of what, as the real vault tells an owner nothing of what.
   */
  keepsPrivate: string[];
  /**
   * That an owner made a link to hand over for somebody's sign-in (5.29),
   * by member id: GET /me's `reset_notice` for them until DELETE
   * /me/reset-notice.
   */
  resetNotices: Map<string, ResetNotice>;
  /** Every password reset an owner started (5.29), in order, for assertions: never a link. */
  resetsStarted: Array<{ member_id: string; path: ResetPath; stop_now: boolean }>;
  identityPending: IdentityAudienceView['pending'];
  /** The photo on its way for each person, by member id: made at the next GET /members (0.5.19). */
  photosOnTheirWay: Map<string, string>;
  /**
   * The role the fake signs everybody in as: an owner, unless a test says
   * otherwise. A viewer is not told who added each version (0.5.11).
   */
  role: Role;
  /** Upload keys and what each made; a key is for one kind of request. */
  captures: Map<string, FakeUpload>;
  /**
   * POST /documents' Idempotency-Keys (0.9.0-dev.45), by household, account,
   * person and key, as the vault scopes them: the body it came with
   * (canonical JSON), the document it made and when. A key answers for 24
   * hours, as the vault's, by `now`.
   */
  createKeys?: Map<string, { body: string; document_id: string; at: number }>;
  /**
   * The fake's clock, in milliseconds, for what it times by it (a create's
   * Idempotency-Key's 24 hours): set it to see time pass. Left out, the
   * real one (`Date.now()`).
   */
  now?: () => number;
  /** What GET /reminders answers, whatever the state asked for. */
  reminders: ReminderView[];
  /** What GET /documents/{id}/issuer-suggestions answers, by document; "unavailable" if unset. */
  issuerSuggestions: Map<string, IssuerSuggestions>;
  /**
   * What the pages propose, by document (5.37): GET
   * /documents/{id}/suggestions answers it — less any field the document
   * has a value for by then, as the vault leaves those out — and
   * "unavailable" if unset.
   */
  detailSuggestions: Map<string, DetailSuggestions>;
  /**
   * What GET /versions/{id}/pages/{n} answers, by version: how many pages
   * are drawn, or a kind of file the vault cannot draw. A version the fake
   * made and nobody set here is still being drawn (`preview_pending`).
   */
  pages: Map<string, number | 'unsupported'>;
  /**
   * Essentials a phone may keep (0.4.13): the set GET /offline/essentials
   * answers (Only me items only under a grant that includes them), the
   * grant in force, and the ids of the opens already received.
   */
  offlineEssentials: { items: OfflineItem[]; received: Set<string> };
  /**
   * Collections of documents (0.5.12), as the real vault keeps them: each made by
   * the one member the fake signs in as — or, put here by a test, by one of
   * `state.members`, or by somebody with no sign-in there — and marked
   * deleted, never removed.
   */
  collections: FakeCollection[];
  /**
   * Requests to send documents (0.5.21), as GET /upload-requests answers
   * them: made by the one member the fake signs in as. A test may set a
   * request's `files_received` to stand for files that came in (5.31's
   * incoming push).
   */
  uploadRequests: UploadRequestView[];
  /**
   * What each request handed over as it was made (0.9.0, LK), by request id:
   * its link, and the password the vault made up — kept, as the vault keeps
   * a sealed copy, to show whoever asked again. A request with none here
   * stands for one made before copies were kept: shown once.
   */
  uploadRequestCopies?: Record<string, { token: string; password: string | null }>;
  /**
   * Files sent through a request and waiting to be looked at (0.5.23), as
   * GET /incoming answers them, with their bytes: a test puts one here as a
   * sender would send it, ready (its scan and pages done) unless it says.
   */
  incoming: FakeIncoming[];
  /**
   * Many documents at once (Phase 6, I1): each batch with its uploader, by
   * member id, and its items — removed ones kept, as the vault keeps a
   * removed item's row until its batch goes.
   */
  batches: FakeBatch[];
  /**
   * What the vault learned from each person's corrections (I4), by member
   * id: their rules, and their newest accepts for the count. Theirs alone.
   */
  learned: Record<string, FakeLearning>;
  /**
   * The owners' reminders that somebody turned 13 (after 0.7.0), as the
   * vault's worker makes them: by `id`, the person, and the day. GET
   * /reminders/people answers an owner those not dismissed, while the
   * person may still be invited, in the real vault's words.
   */
  personReminders: Array<{ id: string; member_id: string; fire_at: string; dismissed: boolean }>;
  /**
   * Caregivers for somebody's medical papers (0.9.0, H1b), as the real vault
   * keeps them: named by the person (kept as made) or by an owner for
   * somebody without a sign-in (kept once the person says so); revoked by
   * the person, an owner for somebody without a sign-in, or the caregiver.
   */
  caregivers?: FakeCaregiver[];
  /**
   * Each person's emergency information (0.9.0, H4), as the vault keeps it:
   * what was typed, who sees it besides the person and the owners, and its
   * version (the ETag).
   */
  emergency?: FakeEmergency[];
  /** Clinician's links to somebody's emergency information (H4), and each opening. */
  emergencyLinks?: FakeEmergencyLink[];
  /** The caregivers' looks, as GET /members/{id}/caregiver-views gives them to the person. */
  caregiverLooks?: Array<{
    person: string;
    caregiver: string;
    document_id: string | null;
    action: 'opened' | 'downloaded' | 'previewed';
    at: string;
  }>;
  /** Turning-18 questions (H1b), as the vault's worker asks them; a test seeds them. */
  grownUp?: Array<{
    member_id: string;
    turned_on: string;
    papers: number;
    answer: 'keep' | 'only_me' | null;
  }>;
  /**
   * Computers that send scans (0.8.0, D1), with their keys in the clear, as
   * only a fake may keep them; a revoked one kept, as the vault keeps it.
   */
  devices?: FakeDevice[];
  /** Connected apps (0.9.0, APP1), with their public keys and what each sent. */
  connectedApps?: FakeApp[];
  /** Pairing codes, one a person, as only a fake may keep them. */
  pairings?: Array<{ code: string; member_id: string; expires_at: number; attempts: number }>;
  /**
   * The Reading checks (0.9.0, R0), newest first: an owner's. A check the
   * fake is asked for waits once, then is read as the fake's own reader
   * reads — what each item's pages proposed, against the document now.
   */
  readingChecks?: FakeReadingCheck[];
  /**
   * The household mailbox set up in Settings (0.9.0, O1), and the app
   * password it was saved with, as only a fake may keep it; and where one may
   * be, as the worker says (FDV_MAIL_IN_ALLOWED_PORTS, FDV_MAIL_IN_ALLOW_PRIVATE).
   */
  mailbox?: (MailInMailboxView & { secret: string | null }) | null;
  /**
   * Links to documents outside the family (0.9.0), each with what was
   * handed over as it was made — in the clear, as only a fake may keep
   * them — to show its maker again (POST /shares/{id}/reveal). A document's
   * only: the fake shares no collection.
   */
  shares?: FakeShare[];
  mailInAllowedPorts?: number[];
  mailInAllowPrivate?: boolean;
  /**
   * Text messages (0.9.0, SMS1): whether the household's SMS Gate is set up
   * and a test passed (GET /sms/status; true unless a test says not), and
   * each person's mobile number, by member id, with the code the fake texted
   * it — kept here, as only a fake may keep a code, so a test reads it and
   * types it back.
   */
  smsReady?: boolean;
  phones?: Map<string, FakePhone>;
  /**
   * The AI reader set in Settings (0.9.0, AIR1), as GET
   * /household/reading/ai-reader answers an owner: none saved, unless a test
   * says. The phone reads it, and changes nothing (AIR4).
   */
  aiReader?: AiReaderView;
  /** Every text the fake sent, in order: to whom, and what it said. */
  texts?: Array<{ to: string; text: string }>;
  /**
   * Codes by text to one's own number (0.9.0, SMS3): whether each person,
   * by member id, asked for one at sign-in and at a reset; the newest code
   * out for each person and purpose (`memberId:purpose`), kept as only a
   * fake may keep one; and the sign-ins waiting for their texted code, by
   * interim token.
   */
  textCodes?: Map<string, { sign_in: boolean; reset: boolean }>;
  textCodesOut?: Map<string, { code: string; expires: number; attempts: number }>;
  mfaWaiting?: Map<string, { memberId: string; installation: string | null }>;
  /**
   * What each person wants to hear, and how (GET and PUT
   * /notifications/preferences), by member id: the vault's defaults until
   * they change one — texts among them since SMS2, each off.
   */
  preferences?: Map<string, Preferences>;
  /**
   * Neutral wording in notifications and email (0.9.0, H2): the household's
   * choice (Sensitive documents only until an owner changes it), and each
   * person's own by member id (as the household says until they choose).
   */
  neutralWording?: NeutralWording;
  myWording?: Map<string, MyWording>;
  /** Every request, in order, for assertions. */
  calls: Array<{ method: string; path: string }>;
  /** When true, every request fails as if the network were down. */
  offline: boolean;
  /**
   * The activity log, as far as the fake keeps one (R4): each document
   * created, oldest first. GET /audit says it in the real vault's words,
   * with who did it and what sort of thing.
   */
  activity?: ActivityEvent[];
}

/**
 * A link as the fake keeps it (0.9.0): its view, who made it (a member id),
 * and what was handed over. `shown_once`, set by a test, is a link made
 * before the vault kept copies: listed, never revealable.
 */
export interface FakeShare {
  share: Share;
  made_by: string;
  token: string;
  pin: string | null;
  password: string | null;
  shown_once?: boolean;
  /**
   * The emails the vault sent of it (0.9.0, `POST /shares/{id}/email`): to
   * whom and with what message, in the clear as only a fake may, and when.
   */
  emailed?: { to: string; message: string | null; at: string }[];
  /**
   * Whether its page shows the document's title (0.9.0, H1a): as its maker
   * chose, or null — as the document is (`linkShowsTitle`).
   */
  show_title?: boolean | null;
  /**
   * The times it was opened (0.9.0, H5), oldest first, as a test seeds
   * them: the fake opens no link itself.
   */
  openings?: ShareOpening[];
  /**
   * The documents a collection's link gives (0.9.0, H5), as a test seeds
   * them: ticked or followed. The fake makes no collection's link itself.
   */
  items?: string[];
}

/** A viewer's limits, as the fake keeps them (5.33): the flags always said. */
/** An invitation as the fake keeps it (5.34): its secrets in the clear, as only a fake may. */
/** A person's emergency information, as the fake keeps it (H4). */
export interface FakeEmergency {
  member: string;
  fields: EmergencyFields;
  audience: EmergencyAudience;
  chosen: string[];
  version: number;
  updated_at: string;
}

/** A clinician's link, as the fake keeps it (H4): its secret in the clear, as only a fake may. */
export interface FakeEmergencyLink {
  id: string;
  member: string;
  fields: EmergencyFieldKey[];
  token: string;
  pin: string | null;
  recipient_label: string | null;
  created_by: string;
  created_at: string;
  expires_at: string;
  revoked: boolean;
  openings: Array<{ at: string; network: string | null; user_agent: string | null }>;
}

/** A caregiver grant, as the fake keeps it (H1b). */
export interface FakeCaregiver {
  id: string;
  person: string;
  caregiver: string;
  granted_by: string;
  granted_at: string;
  confirmed: boolean;
  revoked: boolean;
}

export interface FakeInvitation {
  view: Invitation;
  token: string;
  code: string;
  restriction: AccessGrant | null;
  by_owner: boolean;
  /**
   * Who made it, by member id: a later invitation for the same person, from
   * its maker or an owner, takes its place (as the real vault's does).
   * Absent for one a test made: then only an owner replaces it.
   */
  by_member?: string;
}

export interface FakeRestriction extends AccessGrant {
  limits_people: boolean;
  limits_types: boolean;
  reconfirm_since: string | null;
  private_confirmed: boolean;
  updated_at: string;
}

/** A file sent in, as the fake keeps one (0.5.23): its view, and what it is. */
export type FakeIncoming = IncomingFileView & {
  bytes: Uint8Array;
  /** Filed or refused: no longer waiting, and answered `already_decided`. */
  decided?: 'accepted' | 'rejected';
};

type FakeDocument = {
  id: string;
  title: string | null;
  revision?: number;
  /** In the Trash since (5.1): out of every list but the Trash's. */
  deleted_at?: string | null;
  /** An owner asked to remove it for good, then (5.24). */
  purge_requested_at?: string | null;
  /**
   * Filed by somebody other than the one person the fake signs in as: a test
   * sets it, to have an owner ask before removing it for good (5.24).
   */
  filedBySomeoneElse?: boolean;
  /**
   * When its note's words last changed, and who changed them, by member id
   * (5.35): set as the real vault sets it, only when the words change.
   */
  notes_updated_at?: string | null;
  notes_updated_by?: string | null;
  /**
   * No longer needed (0.9.0): when, by whom (a member id), why, and what
   * replaced it, as the real vault keeps it. Absent or null while needed.
   */
  no_longer_needed?: {
    at: string;
    by: string | null;
    reason: string | null;
    replaced_by: string | null;
  } | null;
  /**
   * Where the original is, as a place in somebody's cabinet (0.9.0, C3), as
   * the real vault keeps it: the names, and whose folder it is while it is
   * (`by`, a member id, with `folder_id`; both null once let go).
   */
  original_place?: {
    path: [string, string, string];
    by: string | null;
    folder_id: string | null;
  } | null;
  /**
   * The folder it came from (0.9.0, C4), as the real vault keeps it: set
   * as it is filed from a batch's item that had one, forgotten after.
   */
  source_folder?: string | null;
  /** Who filed it from a batch, by member id (C4): whose folder tree it is part of. */
  filed_by?: string;
} & Omit<CaptureMetadata, 'title'>;

/** A computer that sends scans, as the fake keeps one (0.8.0, D1). */
export interface FakeDevice {
  id: string;
  key: string;
  name: string;
  platform: DevicePlatform;
  member_id: string;
  added_at: string;
  last_used_at: string | null;
  revoked: boolean;
}

/** A Reading check, as the fake keeps one (0.9.0, R0). */
export interface FakeReadingCheck {
  view: ReadingCheckView;
  /** Whose misses: the asking owner's member. */
  member_id: string;
  misses: ReadingMiss[] | null;
  misses_until: string | null;
  /** Asked for once while waiting: then it is read. */
  asked: number;
}

/** A batch, as the fake keeps one (Phase 6, I1): its uploader's alone. */
export interface FakeBatch {
  id: string;
  member_id: string;
  /** A computer's batch for a day (0.8.0, D1): which computer, and which day. */
  device_id?: string;
  device_day?: string;
  name: string | null;
  created_at: string;
  ends_at: string;
  defaults: BatchDefaults;
  items: FakeBatchItem[];
}

/** One person's rules and count (I4), as the fake keeps them. */
export interface FakeLearning {
  rules: KeptRule[];
  /** The layouts of senders' papers learned (0.9.0, R1), as the vault keeps them, sealed. */
  shapes?: KeptShape[];
  /** Newest first: each accepted item read, whether it needed no change, and what it taught. */
  outcomes: Array<{
    item_id: string;
    unchanged: boolean;
    confirmed: string[];
    contradicted: string[];
    /** The rules it removed, as they were, for an Undo to put back (I4-3). */
    removed: KeptRule[];
    /** What it taught a shape (R1), for an Undo to take back. */
    shape?: ShapeTaught;
    accepted_at: number;
  }>;
}

/** One file in a batch: its hash a stand-in of the right shape, the same for the same bytes. */
export interface FakeBatchItem {
  id: string;
  name: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  arrived_at: string;
  state: 'waiting' | 'accepted' | 'removed';
  document_id: string | null;
  /** The uploader's Idempotency-Key for it, when sent (the I1 review). */
  key?: string;
  /** Its bytes, exactly as sent (CL3): the version an accept makes keeps them. */
  bytes?: Uint8Array;
  /**
   * Read for its details (I2), as the vault's worker would read it: a test
   * (or the contract's `readBatchItems`) sets these; `waiting` until then.
   */
  reading?: BatchReadState;
  read_failure?: BatchReadFailure | null;
  /** What its pages proposed, once read. */
  proposal?: DetailProposal | null;
  /** Where a sure rule of the uploader's disagreed with the pages, as the worker sealed it (I4). */
  learned_clash?: LearnedClash | null;
  /**
   * The page's shape and its labelled dates and numbers, as the worker seals
   * them beside the proposal (0.9.0, R1): what an accept teaches a shape.
   */
  paper?: PaperReading | null;
  /** Filed by Accept all Ready (I3): until when Undo takes it back. */
  undo_until?: string;
  /** Where it was under the folder chosen (S2), as the vault keeps it, sealed. */
  folder?: string;
}

/** A collection of documents, as the fake keeps one (0.5.12). */
export interface FakeCollection {
  id: string;
  name: string;
  description: string | null;
  audience: CollectionAudience;
  owner_member_id: string;
  created_at: string;
  updated_at: string;
  /** Moved by a change to its name, words or audience — never its items — as its ETag says. */
  revision: number;
  deleted: boolean;
  /** In the order they were put in it. */
  items: Array<{ document_id: string; added_at: string }>;
  /** Its checklist (0.9.0, C1), as its maker kept it; absent for none. */
  checklist?: { items: ChecklistItem[]; saved_at: string } | null;
  /**
   * Who manages it besides its maker (0.9.0), each one of `state.members`
   * (the fake's own person is 'fake-member'), with what they may do besides.
   */
  managers?: Array<{
    member_id: string;
    may_change_audience: boolean;
    may_delete: boolean;
    may_choose_managers: boolean;
    added_at: string;
  }>;
}

/** What the fake keeps from an edit; anything else it refuses to pretend to keep. */
const FAKE_EDITABLE = [
  'type_key',
  'extra',
  'title',
  'owner_member_id',
  // The household's, or Not sure yet (0.9.0).
  'household_owned',
  // Sensitive: as its kind says, yes or no (0.9.0, AIR2).
  'sensitive',
  'identifier',
  'issued_by',
  'issued',
  'expires',
  'notes',
  'tags',
  // The whole edit card saved (0.9.0): taken, as the vault takes it.
  'confirm_details',
  // Where the original is, as a folder of the editor's cabinet (0.9.0, C3).
  'original_place',
  // The folder it came from, forgotten (0.9.0, C4): null alone.
  'source_folder',
];

/** A document's version, as an If-Match names it: changed by every edit. */
const etagOf = (doc: FakeDocument) => `"${doc.id}.${doc.revision ?? 1}"`;

/** The AI reader as a vault with none saved says it (AIR1; AIR3's switch off, nothing sent). */
const fakeAiReaderView = (): AiReaderView => ({
  source: 'settings',
  kinds: [...AI_READER_KINDS_OFFERED],
  env: null,
  reader: null,
  https_only: false,
  send_sensitive: false,
  month: { month: new Date().toISOString().slice(0, 7), sent: 0, cap: 500, warned: false },
});

/**
 * The fixed fields as a built-in asks for them (0.5.6): every one shown, in
 * the app's own words — but an expiry only for a type that expires, and the
 * issuer by the type's word for it. Required, and named, as the built-in
 * says (0.5.7: a passport's number and expiry).
 */
function coreOf(
  type: { expiry_driver: string | null; issued_by_label?: string | null },
  own: Partial<Record<CoreField, Partial<CoreFieldRule>>> = {},
): Record<CoreField, CoreFieldRule> {
  const core = Object.fromEntries(
    CORE_FIELDS.map((f) => [f, { shown: true, required: false, label: null, ...own[f] }]),
  ) as Record<CoreField, CoreFieldRule>;
  core.expires.shown = type.expiry_driver !== null;
  core.issued_by.label = type.issued_by_label ?? null;
  return core;
}

const builtin = (
  t: Omit<DocumentTypeView, 'builtin' | 'hidden' | 'core'>,
  core: Partial<Record<CoreField, Partial<CoreFieldRule>>> = {},
): DocumentTypeView => ({
  short_label: null,
  issuer_noun: null,
  // A person's, as every kind was before 0.9.0, unless it says.
  belongs_to: 'person',
  // Sensitive by default as the release seeds it (0.9.0, AIR2, 0090).
  sensitive_default: SENSITIVE_BY_DEFAULT.includes(t.key),
  ...t,
  builtin: true,
  hidden: false,
  core: coreOf(t, core),
});

/** Health's kinds as the real vault seeds them (0.9.0, H3, 0101). */
function healthKinds(): DocumentTypeView[] {
  const text = (key: string, label: string) => ({
    key,
    label,
    kind: 'text' as const,
    required: false,
  });
  const date = (key: string, label: string) => ({
    key,
    label,
    kind: 'date' as const,
    required: false,
  });
  const medical = {
    category: 'medical',
    reminder_leads: [] as number[],
    usually_essential: false,
    default_visibility: 'adults' as const,
  };
  const signed = { issued: { label: 'Signed' }, issued_by: { shown: false } };
  return [
    builtin(
      {
        ...medical,
        key: 'insurance_card',
        label: 'Health insurance card',
        fields: [text('group_number', 'Group number')],
        expiry_driver: 'expires_on',
        reminder_leads: [30, 7],
        usually_essential: true,
        issued_by_label: 'Insurer',
        short_label: 'Insurance card',
      },
      { identifier: { label: 'Member ID' } },
    ),
    builtin(
      {
        ...medical,
        key: 'explanation_of_benefits',
        label: 'Explanation of benefits',
        fields: [
          date('date_of_service', 'Date of service'),
          text('amount_you_owe', 'Amount you may owe'),
        ],
        expiry_driver: null,
        issued_by_label: 'Insurer',
        short_label: 'Explanation of benefits',
        issuer_noun: 'explanation of benefits',
      },
      { identifier: { label: 'Claim number' } },
    ),
    ...(
      [
        ['lab_result', 'Lab result'],
        ['visit_summary', 'Visit summary'],
        ['imaging_report', 'Imaging report'],
      ] as const
    ).map(([key, label]) =>
      builtin({
        ...medical,
        key,
        label,
        fields: [date('date_of_service', 'Date of service')],
        expiry_driver: null,
        issued_by_label: 'Provider',
        short_label: label,
      }),
    ),
    builtin({
      ...medical,
      key: 'vaccination_record',
      label: 'Vaccination record',
      fields: [
        text('vaccines', 'Vaccines'),
        date('date_given', 'Date given'),
        date('next_dose_due', 'Next dose due'),
      ],
      expiry_driver: null,
      remind_from: 'next_dose_due',
      // The fake keeps a date field's lead times here, as it answers them (remindingFrom).
      reminder_leads: [30, 7],
      issued_by_label: 'Provider',
      short_label: 'Vaccination record',
    }),
    builtin(
      {
        ...medical,
        key: 'advance_directive',
        label: 'Advance directive / living will',
        fields: [text('agent', 'Health care agent')],
        expiry_driver: null,
        usually_essential: true,
        issued_by_label: null,
        short_label: 'Advance directive',
      },
      signed,
    ),
    builtin(
      {
        ...medical,
        key: 'healthcare_proxy',
        label: 'Healthcare proxy / power of attorney',
        fields: [text('agent', 'Agent')],
        expiry_driver: null,
        usually_essential: true,
        issued_by_label: null,
        short_label: 'Healthcare proxy',
      },
      signed,
    ),
    builtin(
      {
        ...medical,
        key: 'hipaa_authorization',
        label: 'HIPAA authorization',
        fields: [text('authorized_person', 'Shared with')],
        expiry_driver: 'expires_on',
        reminder_leads: [30],
        issued_by_label: 'Provider',
        short_label: 'HIPAA authorization',
      },
      { issued: { label: 'Signed' } },
    ),
  ];
}

const FAKE_TYPES: DocumentTypeView[] = [
  builtin(
    {
      key: 'passport',
      label: 'Passport',
      category: 'identity',
      fields: [],
      expiry_driver: 'expires_on',
      reminder_leads: [270, 180],
      usually_essential: true,
      default_visibility: 'household',
      issued_by_label: 'Issuing country',
    },
    { identifier: { required: true, label: 'Passport number' }, expires: { required: true } },
  ),
  builtin({
    key: 'bank_statement',
    // Called what it is since 0.9.0 (0077): investment statements are their own.
    label: 'Bank statement',
    category: 'financial',
    fields: [
      { key: 'account_last4', label: 'Account (last 4)', kind: 'text', required: false },
      { key: 'period', label: 'Period', kind: 'text', required: false },
    ],
    expiry_driver: null,
    reminder_leads: [],
    usually_essential: false,
    default_visibility: 'adults',
    issued_by_label: 'Institution',
    short_label: 'Bank statement',
    issuer_noun: 'statement',
  }),
  builtin({
    key: 'birth_certificate',
    label: 'Birth certificate',
    category: 'identity',
    fields: [
      { key: 'registration_no', label: 'Registration number', kind: 'text', required: false },
      { key: 'place_of_birth', label: 'Place of birth', kind: 'text', required: false },
    ],
    expiry_driver: null,
    reminder_leads: [],
    usually_essential: true,
    default_visibility: 'household',
    issued_by_label: null,
  }),
  // A bill since 0.9.0 (0087): a Due date reminding in place of Expires,
  // its amount a Bill amount, and usually the household's.
  builtin({
    key: 'utility_bill',
    label: 'Utility / bill',
    category: 'bills',
    fields: [
      { key: 'account', label: 'Account', kind: 'text', required: false },
      { key: 'amount', label: 'Bill amount', kind: 'text', required: false },
      { key: 'due_date', label: 'Due date', kind: 'date', required: true },
    ],
    expiry_driver: null,
    reminder_leads: [],
    remind_from: 'due_date',
    remind_leads: [7, 1],
    usually_essential: false,
    default_visibility: 'household',
    issued_by_label: 'Provider',
    short_label: 'Bill',
    issuer_noun: 'bill',
    belongs_to: 'household',
  }),
  // 0.8.0 (S5, 0072): kinds a client a release older than these has never seen.
  builtin(
    {
      key: 'credit_card_statement',
      label: 'Credit card statement',
      category: 'financial',
      fields: [
        { key: 'account_last4', label: 'Card (last 4)', kind: 'text', required: false },
        { key: 'amount', label: 'Amount', kind: 'text', required: false },
      ],
      expiry_driver: 'expires_on',
      reminder_leads: [7, 1],
      usually_essential: false,
      default_visibility: 'adults',
      issued_by_label: 'Card issuer',
      short_label: 'Credit card statement',
      issuer_noun: 'statement',
    },
    { expires: { label: 'Payment due' } },
  ),
  // 0.9.0 (C1, 0077): two more a client older than them has never seen.
  builtin({
    key: 'investment_statement',
    label: 'Investment statement',
    category: 'financial',
    fields: [
      { key: 'institution', label: 'Institution', kind: 'text', required: false },
      { key: 'account_last4', label: 'Account (last 4)', kind: 'text', required: false },
      { key: 'period', label: 'Period', kind: 'text', required: false },
    ],
    expiry_driver: null,
    reminder_leads: [],
    usually_essential: false,
    default_visibility: 'adults',
    issued_by_label: 'Institution',
    short_label: 'Investment statement',
    issuer_noun: 'statement',
  }),
  builtin({
    key: 'pay_statement',
    label: 'Pay statement / payslip',
    category: 'financial',
    fields: [
      { key: 'period', label: 'Period', kind: 'text', required: false },
      { key: 'amount', label: 'Amount', kind: 'text', required: false },
    ],
    expiry_driver: null,
    reminder_leads: [],
    usually_essential: false,
    default_visibility: 'adults',
    issued_by_label: 'Employer',
    short_label: 'Pay statement',
    issuer_noun: 'pay statement',
  }),
  builtin({
    key: 'school_report',
    label: 'School report',
    category: 'education',
    fields: [{ key: 'year', label: 'Year', kind: 'year', required: false }],
    expiry_driver: null,
    reminder_leads: [],
    usually_essential: false,
    default_visibility: 'household',
    issued_by_label: 'School',
    short_label: 'School report',
  }),
  // 0.9.0 (H3, 0101): Health's kinds, kept for adults and Sensitive by default.
  ...healthKinds(),
  // 0.9.0 (N1, 0078): a note kept on its own — the vault's kind, hidden from
  // the kinds to file a paper as, and listed where a note uses it.
  {
    ...builtin(
      {
        key: NOTE_KIND,
        label: 'Note',
        category: 'other',
        fields: [],
        expiry_driver: null,
        reminder_leads: [],
        usually_essential: false,
        default_visibility: 'household',
        issued_by_label: null,
        short_label: 'Note',
      },
      {
        identifier: { shown: false },
        issued_by: { shown: false },
        issued: { shown: false },
        expires: { shown: false },
        physical_location: { shown: false },
        notes: { label: 'Note' },
      },
    ),
    hidden: true,
  },
];

/** What GET /document-attributes answers: some of the library the real vault starts with. */
const FAKE_ATTRIBUTES: DocumentAttributeView[] = [
  { key: 'account_last4', label: 'Account (last 4)', kind: 'text', choices: null, builtin: true },
  { key: 'period', label: 'Period', kind: 'text', choices: null, builtin: true },
  { key: 'place_of_birth', label: 'Place of birth', kind: 'text', choices: null, builtin: true },
  {
    key: 'registration_no',
    label: 'Registration number',
    kind: 'text',
    choices: null,
    builtin: true,
  },
  { key: 'tax_year', label: 'Tax year', kind: 'year', choices: null, builtin: true },
  // What a bill reminds from, when its household says so (0.5.15).
  { key: 'due_date', label: 'Due date', kind: 'date', choices: null, builtin: true },
];

/**
 * The date a kind reminds from, as the real vault answers it (0038): the
 * one it keeps, while it shows that date and has lead times; else null.
 * The fake keeps a kind's date in `remind_from` and its lead times in
 * `reminder_leads`, and answers both as the vault does (`typeAnswer`).
 */
function remindingFrom(t: DocumentTypeView): string | null {
  const from = t.remind_from ?? null;
  if (from === null || t.reminder_leads.length === 0) return null;
  if (from === 'expires') return t.expiry_driver !== null ? from : null;
  return t.fields.some((f) => f.key === from && f.kind === 'date') ? from : null;
}

/**
 * A stand-in for a file's SHA-256 (I1): 64 hex digits, the same for the
 * same bytes and, in a test, different for different ones. Not SHA-256.
 */
function standInHash(bytes: Uint8Array): string {
  let out = '';
  for (let seed = 0; seed < 8; seed++) {
    let h = (0x811c9dc5 ^ seed) >>> 0;
    for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

interface FakeUpload {
  kind: 'capture' | 'version';
  document_id: string;
  version_id: string;
  /** The version as GET /documents/{id}/versions lists it (0.5.11). */
  version_no: number;
  filename: string;
  mime: string;
  byte_size: number;
  uploaded_at: string;
  /** Its bytes, for a connected app's download (0.9.0, APP2). */
  bytes?: Uint8Array;
  /** The connected app that added it, by name, when it acted as itself (0.9.0, APP8). */
  uploaded_by_app?: string;
}

/** The fake's installation id, as a real vault reports its own. */
export const FAKE_INSTANCE_ID = '3b9e1d2c-7a6f-4e5d-9c8b-1a2f3e4d5c6b';

/** Upload keys are UUIDs, written the usual way. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many days a phone shows its Essentials without reaching the vault: the vault's default. */
const FAKE_OFFLINE_MAX_DAYS = 90;

/** The one person the fake signs in as, unless somebody in `signIns` signs in (5.28). */
const ME = 'fake-member';

export function createFakeVault(): {
  fetch: FetchLike;
  state: FakeVaultState;
  /**
   * What a restore does to sign-ins (5.28, A55): every one but the owners'
   * paused, for an owner to turn back on — the fake's own person's too,
   * when `role` is not an owner — a lock in force kept as a lock, with no
   * end of its own any more; and every session ended, as a restore ends
   * them (`revoked`).
   */
  pauseSignIns: () => void;
  /**
   * What a person's filing does to what a connected app sent (0.9.0, APP2),
   * as the fake has no Inbox for it: the send, by its external id, filed as
   * this document, its newest file the one it became: as a document of its
   * own, or `asVersion` into one that was there. The app reads a document
   * its send made as its own, while a file of its own is the newest.
   */
  fileAppIntake: (
    appId: string,
    externalId: string,
    documentId: string,
    asVersion?: boolean,
  ) => void;
  /**
   * What the pages of a file a connected app sent read (0.9.0, APP4), as
   * the vault's worker would read them: the fake reads nothing itself. While
   * the app files automatically, the fake files it, as the app's person,
   * exactly when the vault would (`appFilesItself`); otherwise it waits, as
   * it would for review. Answers which. A near match is not worked out here.
   */
  readAppFile: (
    appId: string,
    externalId: string,
    proposal: DetailProposal,
  ) => Promise<'filed' | 'waiting'>;
  /**
   * A connected app's API key past its expiry now (0.9.0, APP6), as time
   * would make it: its next request is `401 app_key_expired`. Throws for a
   * client ID the fake never gave.
   */
  expireAppKey: (clientId: string) => void;
} {
  const state: FakeVaultState = {
    setupRequired: true,
    email: null,
    password: null,
    sessions: [],
    access: new Map(),
    documents: [],
    captures: new Map(),
    reminders: [],
    issuerSuggestions: new Map(),
    detailSuggestions: new Map(),
    pages: new Map(),
    offlineEssentials: { items: [], received: new Set() },
    // Each reminds from Expires where it expires and has lead times, as
    // every kind did before 0.5.15 — but a vaccination record, from its
    // next dose (0.9.0, H3).
    types: FAKE_TYPES.map((t) => ({
      ...t,
      remind_from:
        t.key === 'vaccination_record'
          ? 'next_dose_due'
          : t.expiry_driver !== null && t.reminder_leads.length > 0
            ? 'expires'
            : null,
    })),
    attributes: FAKE_ATTRIBUTES.map((a) => ({ ...a })),
    members: [{ id: 'fake-member', display_name: 'Fake Owner', role: 'owner', is_me: true }],
    invitations: [],
    photosOnTheirWay: new Map(),
    memberAccounts: new Map(),
    ownerTwoStep: false,
    identities: new Map(),
    identityAudience: 'owners_and_self',
    identityPending: null,
    signInsOff: [],
    signIns: [],
    suspensions: new Map(),
    timezone: 'UTC',
    timezoneSource: 'server_default',
    serverTimezone: 'UTC',
    endedSharingDays: 90,
    restrictions: new Map(),
    operatorMail: true,
    keepsPrivate: [],
    resetNotices: new Map(),
    resetsStarted: [],
    role: 'owner',
    collections: [],
    uploadRequests: [],
    incoming: [],
    batches: [],
    learned: {},
    personReminders: [],
    devices: [],
    pairings: [],
    calls: [],
    offline: false,
  };
  /** What each document accepted from a batch was made of, by its stand-in hash (I1). */
  const filedFrom = new Map<string, string>();
  let n = 0;
  const next = (prefix: string) => `${prefix}-${++n}`;
  /** A document's versions: what each upload to it, or the capture that made it, stored. */
  /** ZIPs waiting for their ticket's download (DL review): each taken once. */
  const zipTickets = new Map<string, ResponseLike>();
  let zipTicketCount = 0;
  const versionsOf = (documentId: string) =>
    [...state.captures.values()].filter((c) => c.document_id === documentId);

  // Kinds of document, managed (0.5.10): each kind's version, which every
  // change moves on, as its ETag says.
  const revisions = new Map<string, number>();
  /** What each document's last "Use these" replaced (0.9.0), for its Undo. */
  const renewals = new Map<
    string,
    { versionId: string; by: string; before: Record<string, unknown>; revision: number }
  >();
  const typeTag = (t: DocumentTypeView) => `"${t.key}.${revisions.get(t.key) ?? 1}"`;
  const bump = (t: DocumentTypeView) => revisions.set(t.key, (revisions.get(t.key) ?? 1) + 1);
  /**
   * A kind as the real vault answers it: its ETag, and an expiry required
   * exactly when it expires, whatever its rule once said (0.5.10). The date
   * it reminds from and its lead times (0.5.15); `reminder_leads` is
   * Expires's alone, `[]` while a date field reminds, as an older phone
   * reads it; and the reminding field always required.
   */
  const typeAnswer = (t: DocumentTypeView): DocumentTypeView => {
    const from = remindingFrom(t);
    return {
      ...t,
      // But a built-in's the family adds only if there is one (0.9.0, H3).
      fields: t.fields.map((f) =>
        f.key === from && !remindingDateOptional(t.builtin ? t : null, f.key)
          ? { ...f, required: true }
          : f,
      ),
      reminder_leads: t.remind_from && t.remind_from !== 'expires' ? [] : [...t.reminder_leads],
      remind_from: from,
      remind_leads: [...t.reminder_leads],
      ...(t.core
        ? {
            core: {
              ...t.core,
              expires: { ...t.core.expires, required: t.expiry_driver !== null },
            },
          }
        : {}),
      // Each paper its own document, never a renewal of the last (0.9.0).
      periodic: periodic(t),
      etag: typeTag(t),
    };
  };
  /**
   * What a kind reminds from after a change, by the rules the real vault
   * keeps (`nextReminder`, 0.5.15), worked out on `next`, the kind as it
   * will be: a refusal, or null with `next` changed.
   */
  const remind = (
    before: DocumentTypeView | null,
    next: DocumentTypeView,
    body: Record<string, unknown>,
  ): ResponseLike | null => {
    const out = nextReminder(
      {
        remind_from: body.remind_from as string | null | undefined,
        remind_leads: body.remind_leads as number[] | undefined,
        reminder_leads: body.reminder_leads as number[] | undefined,
        fields: body.fields as TypeChange['fields'],
      },
      before
        ? {
            reminding: { from: remindingFrom(before), leads: leadsOf(before.reminder_leads) },
            expires: before.expiry_driver !== null,
          }
        : null,
      {
        expires: next.expiry_driver !== null,
        dates: next.fields.filter((f) => f.kind === 'date').map((f) => f.key),
        key: next.builtin ? next.key : undefined,
      },
    );
    if ('problem' in out) {
      return fail(422, 'validation_failed', out.problem.message, out.problem.detail);
    }
    next.remind_from = out.from;
    next.reminder_leads = out.leads;
    // Required, but for a built-in's date the family adds only if there is one (H3).
    if (
      out.from !== null &&
      out.from !== 'expires' &&
      !remindingDateOptional(next.builtin ? next : null, out.from)
    ) {
      next.fields = next.fields.map((f) => (f.key === out.from ? { ...f, required: true } : f));
    }
    return null;
  };
  /**
   * A change to a kind's fixed fields and its own fields, as the real vault
   * makes it: each fixed field key by key (Expires on or off is whether it
   * expires, and an expiry is required exactly when it does), its own
   * fields from the library by key, names 80 characters at most. A refusal,
   * or null.
   */
  const changeType = (t: DocumentTypeView, change: TypeChange): ResponseLike | null => {
    const asked = change.core?.expires;
    if (asked?.required !== undefined) {
      const expires = asked.shown ?? t.expiry_driver !== null;
      if (asked.required !== expires) {
        return fail(
          422,
          'validation_failed',
          expires ? EXPIRY_ALWAYS_REQUIRED : 'A field has to be shown to be required.',
          'expires',
        );
      }
    }
    const long = tooLong([
      ...CORE_FIELDS.map((f) => [change.core?.[f]?.label, 'A field’s name'] as const),
      ...(change.fields ?? []).map((f) => [f.label, 'A field’s name'] as const),
    ]);
    if (long) return long;
    const core = t.core ?? coreOf(t);
    for (const f of CORE_FIELDS) {
      const rule = change.core?.[f];
      if (!rule) continue;
      if (rule.shown !== undefined) core[f].shown = rule.shown;
      if (rule.required !== undefined && f !== 'expires') core[f].required = rule.required;
      if (rule.label !== undefined) core[f].label = tidy(rule.label);
    }
    t.core = core;
    t.expiry_driver = core.expires.shown ? (t.expiry_driver ?? 'expires_on') : null;
    core.expires.required = t.expiry_driver !== null;
    t.issued_by_label = core.issued_by.label;
    for (const f of CORE_FIELDS) {
      if (f !== 'expires' && core[f].required && !core[f].shown) {
        return fail(422, 'validation_failed', 'A field has to be shown to be required.', f);
      }
    }
    if (change.fields) {
      const keys = change.fields.map((f) => f.key);
      if (new Set(keys).size !== keys.length) {
        return fail(422, 'validation_failed', 'Each field can be asked for once.', 'fields');
      }
      const fields: TypeField[] = [];
      for (const f of change.fields) {
        const had = t.fields.find((x) => x.key === f.key);
        const lib = state.attributes.find((a) => a.key === f.key);
        const kind = had?.kind ?? lib?.kind;
        if (!kind)
          return fail(422, 'validation_failed', 'That field is not in the library.', f.key);
        fields.push({
          key: f.key,
          label: tidy(f.label) ?? had?.label ?? lib?.label ?? f.key,
          kind,
          required: f.required ?? had?.required ?? false,
          ...(kind === 'choice' ? { choices: lib?.choices ?? had?.choices ?? [] } : {}),
        });
      }
      t.fields = fields;
    }
    return null;
  };

  /** Somebody's role now: the fake's own person's is `role`; a person without a sign-in, none. */
  const roleOfMember = (memberId: string): Role | null =>
    memberId === ME
      ? state.role
      : ((state.members.find((m) => m.id === memberId)?.role as Role | undefined) ?? null);
  /** Whose a session is (5.28): the fake's own person, or somebody in `signIns`. */
  const whoOf = (s: FakeSession): { memberId: string; role: Role } => ({
    memberId: s.memberId ?? ME,
    role: s.memberId === undefined ? state.role : (roleOfMember(s.memberId) ?? 'viewer'),
  });
  /** A lock or a pause in effect for somebody now (5.28): a lock past its end is over. */
  const suspensionOf = (memberId: string): MemberSuspension | null => {
    const s = state.suspensions.get(memberId);
    return s && suspensionInEffect({ suspended_at: s.since, suspended_until: s.until }) ? s : null;
  };
  /**
   * Which way a reset an owner starts for somebody goes now (5.29): none for
   * an owner (A50) or somebody locked or paused; the operator's mail when
   * there is some; otherwise a link to hand over, unless they keep anything
   * private.
   */
  const resetPathOf = (memberId: string): ResetPath | null => {
    if (roleOfMember(memberId) === 'owner' || suspensionOf(memberId) !== null) return null;
    if (state.operatorMail) return 'mail';
    return state.keepsPrivate.includes(memberId) ? 'operator' : 'handover';
  };
  /** A guest's sign-in past its end (5.34, A28): it signs nobody in, and its sessions answer nothing. */
  const guestEndOf = (memberId: string): string | null => {
    const m = state.members.find((x) => x.id === memberId);
    return m?.kind === 'guest' && guestAccessEnded(m.access_expires_at)
      ? (m.access_expires_at as string)
      : null;
  };
  /** Everybody with a sign-in: the fake's own person, and each of `members` with a role. */
  const withSignIn = () => [
    ME,
    ...state.members.filter((m) => m.id !== ME && Boolean(m.role)).map((m) => m.id),
  ];

  // ----------------------------------------------- a viewer's limits (5.33)

  /** The documents of the collections a grant gives: for Everyone, and not deleted (A17). */
  const collectionDocuments = (g: AccessGrant) =>
    new Set(
      state.collections
        .filter((c) => g.collections.includes(c.id) && !c.deleted && c.audience === 'everyone')
        .flatMap((c) => c.items.map((i) => i.document_id)),
    );
  /** The real vault's rule (0054's doc_in_grant), for one document. */
  const grantGives = (
    memberId: string | null,
    g: AccessGrant,
    d: FakeDocument,
    inCollections: Set<string>,
  ): boolean => {
    if (g.expires_at !== null && Date.parse(g.expires_at) <= Date.now()) return false;
    const visibility = d.visibility ?? 'household';
    const owner = d.owner_member_id ?? null;
    const ceiling =
      visibility === 'household' ||
      (visibility === 'adults' && g.include_adults_only) ||
      (visibility === 'private' && owner !== null && owner === memberId);
    if (!ceiling) return false;
    if (owner !== null && owner === memberId) return true;
    const limitsPeople = g.limits_people === true || g.people.length > 0;
    const limitsTypes = g.limits_types === true || g.types.length > 0;
    const byPerson =
      owner === null
        ? g.include_no_person_docs
        : limitsPeople
          ? g.people.includes(owner)
          : limitsTypes;
    if (byPerson && (!limitsTypes || g.types.includes(d.type_key ?? ''))) return true;
    return (owner !== null || g.include_no_person_docs) && inCollections.has(d.id);
  };
  /** Somebody's limits as an owner is shown them. */
  const accessView = (memberId: string): MemberAccess | null => {
    const r = state.restrictions.get(memberId);
    if (!r) return null;
    const { reconfirm_since, private_confirmed, updated_at, ...grant } = r;
    // Only collections that still grant, as the real vault shows them.
    const collections = grant.collections.filter((id) =>
      state.collections.some((c) => c.id === id && !c.deleted && c.audience === 'everyone'),
    );
    return {
      member_id: memberId,
      ...grant,
      collections,
      summary: restrictionSummary(
        {
          people: grant.people.length,
          types: grant.types.length,
          collections: collections.length,
          include_adults_only: grant.include_adults_only,
          include_no_person_docs: grant.include_no_person_docs,
          expires_at: grant.expires_at,
          limits_people: grant.limits_people,
          limits_types: grant.limits_types,
        },
        state.timezone,
      ),
      reconfirm_since,
      private_confirmed,
      updated_at,
    };
  };
  /** What a restricted viewer is told on GET /me: names they are given. */
  const myRestriction = (memberId: string): MyRestriction | null => {
    const r = state.restrictions.get(memberId);
    if (!r) return null;
    const people = state.members
      .filter((m) => r.people.includes(m.id))
      .map((m) => ({ id: m.id, display_name: m.display_name }));
    const types = state.types
      .filter((t) => r.types.includes(t.key))
      .map((t) => ({ key: t.key, label: t.short_label ?? t.label }));
    const collections = state.collections
      .filter((c) => r.collections.includes(c.id) && !c.deleted && c.audience === 'everyone')
      .map((c) => ({ id: c.id, name: c.name }));
    return {
      summary: youCanSee(
        {
          people,
          types,
          collections,
          include_no_person_docs: r.include_no_person_docs,
          expires_at: r.expires_at,
        },
        state.timezone,
        Date.now(),
        // A guest owns nothing (5.34).
        { own: state.members.find((m) => m.id === memberId)?.kind !== 'guest' },
      ),
      people,
      types,
      collections,
      include_adults_only: r.include_adults_only,
      include_no_person_docs: r.include_no_person_docs,
      expires_at: r.expires_at,
    };
  };
  /**
   * A grant as the real vault checks it (5.33): the people, kinds and
   * collections of the family, a collection for Everyone (A17), an end in
   * the future. A refusal, or the grant tidied.
   */
  /** The shape of a grant as the real vault parses it (zod): a refusal, or the grant. */
  const grantShape = (b: Record<string, unknown>): AccessGrant | ResponseLike => {
    const known = [
      'people',
      'types',
      'collections',
      'include_adults_only',
      'include_no_person_docs',
      'expires_at',
      'limits_people',
      'limits_types',
      'confirm_private',
    ];
    const bad = Object.keys(b).find((k) => !known.includes(k));
    if (bad) return fail(422, 'validation_failed', `Unrecognized key: "${bad}"`);
    for (const k of ['people', 'types', 'collections']) {
      if (b[k] !== undefined && !Array.isArray(b[k])) {
        return fail(422, 'validation_failed', 'Invalid input: expected array');
      }
    }
    const list = (v: unknown) =>
      Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))] : [];
    const flag = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
    const limitsPeople = flag(b.limits_people);
    const limitsTypes = flag(b.limits_types);
    return {
      people: list(b.people),
      types: list(b.types),
      collections: list(b.collections),
      include_adults_only: b.include_adults_only === true,
      include_no_person_docs: b.include_no_person_docs === true,
      expires_at: typeof b.expires_at === 'string' ? b.expires_at : null,
      ...(limitsPeople !== undefined ? { limits_people: limitsPeople } : {}),
      ...(limitsTypes !== undefined ? { limits_types: limitsTypes } : {}),
    };
  };
  /**
   * What a grant names, as the real vault checks it once it knows whom
   * (5.33): an end in the future, or the one it has; people, kinds and
   * collections of the family — a collection deleted since left out, one
   * for anybody narrower than Everyone refused (A17).
   */
  const checkedGrant = (
    g: AccessGrant,
    storedEnd: string | null = null,
  ): AccessGrant | ResponseLike => {
    if (
      g.expires_at !== null &&
      Date.parse(g.expires_at) <= Date.now() &&
      (storedEnd === null || Date.parse(storedEnd) !== Date.parse(g.expires_at))
    ) {
      return fail(422, 'validation_failed', 'Choose an end in the future, or none.', 'expires_at');
    }
    if (g.people.some((id) => id !== ME && !state.members.some((m) => m.id === id))) {
      return fail(422, 'validation_failed', 'Choose people from the family.', 'people');
    }
    if (g.types.some((key) => !state.types.some((t) => t.key === key))) {
      return fail(422, 'validation_failed', 'Choose kinds of document the family has.', 'types');
    }
    for (const id of g.collections) {
      const c = state.collections.find((x) => x.id === id);
      if (!c)
        return fail(422, 'validation_failed', 'Choose collections of the family.', 'collections');
      if (!c.deleted && c.audience !== 'everyone') {
        return fail(422, 'validation_failed', onlyEveryone(c.name, c.audience), 'collections');
      }
    }
    return {
      ...g,
      collections: g.collections.filter((id) =>
        state.collections.some((c) => c.id === id && !c.deleted),
      ),
    };
  };
  /** A collection deleted, or made for fewer than Everyone, leaves every grant (0055). */
  const leavesGrants = (collectionId: string) => {
    for (const r of state.restrictions.values()) {
      r.collections = r.collections.filter((c) => c !== collectionId);
    }
  };
  /** Whether a grant names people, or kinds, once written (the real vault's limitsAfter). */
  const limitsAfter = (named: string[], said: boolean | undefined, had: boolean | undefined) =>
    named.length > 0 || (said ?? had ?? false);

  const tokensFor = (s: FakeSession): Tokens => {
    const access = next('access');
    state.access.set(access, s.id);
    const who = whoOf(s);
    return {
      access_token: access,
      expires_in: 900,
      refresh_token: s.refresh,
      refresh_expires_in: 2_592_000,
      household_id: 'fake-household',
      member_id: who.memberId,
      role: who.role,
      scopes_unlocked: ['household', 'adults', 'member'],
    };
  };
  const open = (installation: string | null = null, memberId?: string): Tokens => {
    const s: FakeSession = {
      id: next('session'),
      refresh: next('refresh'),
      previous: null,
      revoked: false,
      installation,
      rotatedAt: Date.now(),
      graceUsed: false,
      ...(memberId !== undefined ? { memberId } : {}),
    };
    state.sessions.push(s);
    return tokensFor(s);
  };

  const pauseSignIns = () => {
    const now = new Date().toISOString();
    for (const id of withSignIn()) {
      const held = state.suspensions.get(id);
      const lockedNow = held?.reason === 'locked' && suspensionOf(id) !== null;
      if (roleOfMember(id) !== 'owner' && held?.reason !== 'restored' && !lockedNow) {
        state.suspensions.set(id, {
          reason: 'restored',
          since: now,
          until: null,
          note: null,
          by: null,
        });
      }
    }
    // A backup cannot know whether a lock was made longer since: kept until an owner unlocks it.
    for (const s of state.suspensions.values()) if (s.reason === 'locked') s.until = null;
    for (const s of state.sessions) {
      if (s.revoked) continue;
      s.revoked = true;
      s.endedBecause = 'revoked';
    }
  };

  /**
   * POST /invitations (5.34), refused as the real vault refuses, in its
   * order: who may invite for the role; a guest's own rules (a viewer,
   * limited, an end within a year); an adult's viewer limited, without
   * Adults only documents (A27); an owner's decision about what a viewer
   * sees asks for two-step sign-in; an address already signed in with.
   */
  const invite = (who: { memberId: string; role: Role }, b: Record<string, unknown>) => {
    const role = String(b.role) as Role;
    if (!['owner', 'adult', 'teen', 'viewer'].includes(role)) {
      return fail(422, 'validation_failed', 'Invalid option: expected one of the roles');
    }
    const capability =
      role === 'owner' || role === 'adult' ? 'member.invite_adult' : 'member.invite';
    if (!can(who.role, capability)) return fail(403, 'forbidden', refusalFor(capability));
    const kind: MemberKind = b.kind === 'guest' ? 'guest' : 'family';
    const shaped =
      b.restriction && typeof b.restriction === 'object'
        ? grantShape(b.restriction as Record<string, unknown>)
        : null;
    if (shaped && isResponse(shaped)) return shaped;
    const end = typeof b.access_expires_at === 'string' ? b.access_expires_at : null;
    if (kind === 'guest') {
      if (role !== 'viewer') {
        return fail(422, 'validation_failed', 'A guest is always a viewer.', 'role');
      }
      if (!shaped) {
        return fail(
          422,
          'validation_failed',
          'A guest is always limited to what they are given. Choose what they can see.',
          'restriction',
        );
      }
      const problem = end ? guestEndProblem(new Date(end)) : 'Choose the day their access ends.';
      if (problem) return fail(422, 'validation_failed', problem, 'access_expires_at');
    } else if (end) {
      return fail(
        422,
        'validation_failed',
        'Only a guest’s access ends on a day. Somebody of the family keeps theirs.',
        'access_expires_at',
      );
    }
    if (shaped && role !== 'viewer') {
      return fail(422, 'validation_failed', 'Only a viewer can be limited to some documents.');
    }
    if (role === 'viewer' && who.role !== 'owner') {
      if (!shaped) {
        return fail(
          403,
          'forbidden',
          'Only an owner can invite a viewer who sees every family document. Choose what they can see.',
        );
      }
      if (shaped.include_adults_only) {
        return fail(403, 'forbidden', 'Only an owner can let a viewer see Adults only documents.');
      }
    }
    // An owner's decision (A27, D6, A54): a viewer who sees every family
    // document, Adults only documents, any guest an owner invites (the 5.34
    // review), or an owner's limits replacing those already set (S533-02):
    // a passkey or a code, asked before anything else of the vault.
    const replaces =
      who.role === 'owner' &&
      shaped !== null &&
      typeof b.member_id === 'string' &&
      state.restrictions.has(b.member_id);
    const decides =
      (role === 'viewer' &&
        (!shaped || shaped.include_adults_only || (kind === 'guest' && who.role === 'owner'))) ||
      replaces;
    if (decides && !state.ownerTwoStep) {
      return fail(
        403,
        'totp_required_for_owner',
        'Turn on two-step sign-in to limit what a viewer can see.',
      );
    }
    const email = typeof b.email === 'string' ? b.email.toLowerCase() : '';
    if (email === state.email || state.signIns.some((x) => x.email.toLowerCase() === email)) {
      return fail(
        409,
        'email_in_use',
        'That email address already has a sign-in here. They can sign in with it instead.',
      );
    }
    const checked = shaped ? checkedGrant(shaped) : null;
    if (checked && isResponse(checked)) return checked;
    let member =
      typeof b.member_id === 'string' ? state.members.find((m) => m.id === b.member_id) : undefined;
    if (typeof b.member_id === 'string') {
      if (!member) return fail(404, 'not_found', 'That person is not in the family.');
      if (member.role) return fail(409, 'already_signed_in', 'That person already has a sign-in.');
      // Nobody under 13 has a sign-in of their own, by their date of birth
      // on the household's calendar (after 0.7.0).
      if (
        member.date_of_birth &&
        !oldEnoughToSignIn(member.date_of_birth, localToday(state.timezone))
      ) {
        return fail(422, 'too_young', TOO_YOUNG(member.display_name), 'member_id');
      }
      // And the role is one their age allows: a teen's from 13 to 17, any
      // but a teen's from 18 (after 0.7.0).
      const age = ageOn(member.date_of_birth ?? null, localToday(state.timezone));
      if (age !== null && !roleSuitsAge(age, role)) {
        return fail(422, 'role_not_for_age', ROLE_NOT_FOR_AGE(member.display_name, age), 'role');
      }
      if ((member.kind ?? 'family') !== kind) {
        return kind === 'guest'
          ? fail(
              409,
              'not_a_guest',
              `${member.display_name} is of the family. A guest is somebody from outside it: invite them by their name.`,
            )
          : fail(
              409,
              'guest',
              `${member.display_name} is from outside the family. Invite them as a guest.`,
            );
      }
      // A guest who has had a sign-in is given it back by an owner, never
      // invited again as the same person (the 5.34 review).
      const accepted = state.invitations.some(
        (i) => i.view.member_id === member?.id && i.view.state === 'accepted',
      );
      if (kind === 'guest' && accepted) {
        return fail(
          409,
          'had_sign_in',
          `${member.display_name} has had a sign-in here. An owner can give it back, with a new end, from People outside the family; or invite them by their name as somebody new.`,
        );
      }
      // An adult's invitation keeps an owner's limits: never Adults only ones.
      if (who.role !== 'owner' && state.restrictions.get(member.id)?.include_adults_only) {
        return fail(
          403,
          'forbidden',
          'An owner gave them Adults only documents, so only an owner can invite them.',
        );
      }
    } else {
      member = {
        id: next('member'),
        display_name: typeof b.display_name === 'string' ? b.display_name : '',
        role: null,
        is_me: false,
        kind,
        relationship: typeof b.relationship === 'string' ? b.relationship : null,
      };
      state.members.push(member);
    }
    // "Send another one", as the real vault: an invitation for the same
    // person still waiting is taken back — by its maker or an owner; anybody
    // else is told somebody else has invited them (N534W-02 b).
    const waiting = state.invitations.filter(
      (i) => i.view.member_id === member?.id && i.view.state === 'pending',
    );
    if (who.role !== 'owner' && waiting.some((i) => i.by_member !== who.memberId)) {
      return fail(
        409,
        'already_invited',
        'Somebody else has already invited this person. Ask them, or an owner, to send it again.',
      );
    }
    for (const i of waiting) i.view.state = 'revoked';
    const view: Invitation = {
      id: next('invitation'),
      member_id: member.id,
      display_name: member.display_name,
      email,
      role,
      invited_by: state.members.find((m) => m.id === who.memberId)?.display_name ?? null,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      state: 'pending',
      attempts_left: 5,
      limited: checked !== null,
      kind,
      access_expires_at: end ? new Date(end).toISOString() : null,
    };
    // The code by text too (SMS3): an owner's to ask, while texts go.
    let textTo: string | null = null;
    if (typeof b.invitee_phone === 'string') {
      if (who.role !== 'owner') {
        return fail(403, 'forbidden', 'Only an owner can text an invitation’s code.');
      }
      if (!(state.smsReady ?? true)) {
        return fail(
          409,
          'sms_not_set_up',
          'Text messages aren’t set up for this household yet. An owner can set them up in Settings, under Text messages.',
        );
      }
      textTo = parsePhone(b.invitee_phone, 'GB');
      if (!textTo) {
        return fail(
          422,
          'phone_number_invalid',
          'That doesn’t look like a mobile number. Type it with its country code, such as +44 7700 900123.',
        );
      }
    }
    const token = next('invitation-token');
    const code = 'ABCD-EFGH';
    state.invitations.push({
      view,
      token,
      code,
      restriction: checked,
      by_owner: who.role === 'owner',
      by_member: who.memberId,
    });
    if (textTo) {
      (state.texts ??= []).push({
        to: textTo,
        text: inviteCodeText(code, state.members.find((m) => m.id === who.memberId)?.display_name),
      });
      return ok(
        { invitation: view, link_token: token, code, code_texted_to: maskPhone(textTo) },
        201,
      );
    }
    return ok({ invitation: view, link_token: token, code }, 201);
  };

  /** POST /invitations/accept (5.34): the link, the code and a password of their own. */
  const acceptInvitation = (b: Record<string, unknown>, installation: string | null) => {
    const found = state.invitations.find((i) => i.token === b.token && i.view.state === 'pending');
    if (!found) {
      return fail(
        404,
        'invitation_not_valid',
        'That invitation link is not valid any more. Ask whoever invited you to send a new one.',
      );
    }
    const typed = (typeof b.code === 'string' ? b.code : '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    if (typed !== found.code.replace(/[^A-Z0-9]/g, '')) {
      return fail(401, 'invitation_code_wrong', 'That code is not right.');
    }
    const v = found.view;
    if (v.kind === 'guest' && guestAccessEnded(v.access_expires_at)) {
      return fail(
        409,
        'access_ended',
        'The access this invitation gives has already ended. Ask whoever invited you for a new one.',
      );
    }
    const email = typeof b.email === 'string' ? b.email.toLowerCase() : v.email;
    if (email === state.email || state.signIns.some((x) => x.email.toLowerCase() === email)) {
      return fail(
        409,
        'email_taken',
        'That address already has a sign-in here. Choose another one.',
      );
    }
    const member = state.members.find((m) => m.id === v.member_id);
    if (!member)
      return fail(404, 'invitation_not_valid', 'That invitation link is not valid any more.');
    // Every refusal before anything changes, as the vault's one transaction
    // undoes them all (the 5.34 review's second round, N534W-02).
    const had = state.restrictions.get(member.id);
    // An adult's keeps what an owner set, so never Adults only documents an
    // owner gave since (the 5.34 review): asked again now.
    if (had && !found.by_owner && had.include_adults_only) {
      return fail(
        409,
        'owner_needed',
        'This invitation cannot be accepted as it is. Ask an owner of the family to invite you.',
      );
    }
    member.role = v.role;
    if (v.kind === 'guest') member.access_expires_at = v.access_expires_at ?? null;
    if (found.restriction && (!had || found.by_owner)) {
      state.restrictions.set(member.id, {
        ...found.restriction,
        include_adults_only: found.by_owner && found.restriction.include_adults_only,
        limits_people:
          found.restriction.limits_people === true || found.restriction.people.length > 0,
        limits_types: found.restriction.limits_types === true || found.restriction.types.length > 0,
        reconfirm_since: null,
        private_confirmed: false,
        updated_at: new Date().toISOString(),
      });
    }
    state.signIns.push({
      member_id: member.id,
      email,
      password: typeof b.password === 'string' ? b.password : '',
    });
    v.state = 'accepted';
    return ok(open(installation, member.id), 201);
  };

  /**
   * The household mailbox set up in Settings (0.9.0, O1), as the real vault
   * answers: an owner's; refused on a port or at an address the worker
   * doesn't connect to (`mailbox_address_refused`, the O1 review M3), and
   * with the server, port or sign-in changed but no password typed again
   * (`mailbox_password_needed`, H1). Null for any other route.
   */
  /**
   * Text messages (0.9.0, SMS1), as the real vault answers: whether texts
   * can be sent, and somebody's mobile number — their own, or an owner's for
   * anybody — confirmed by a six-digit code. The fake "texts" each code into
   * `state.texts` and keeps it on the number, for a test to read.
   */
  /**
   * Where a code by text for one of somebody's own purposes goes, masked
   * (SMS3), or null when it is not theirs to give now: asked for, a
   * confirmed number, the household's texts set up; to confirm it's them,
   * an adult or a teen alone.
   */
  const textCodeTo = (memberId: string, purpose: TextCodePurpose): string | null => {
    const asked = state.textCodes?.get(memberId);
    const phone = state.phones?.get(memberId);
    if (!phone?.confirmed_at || !(state.smsReady ?? true)) return null;
    if (purpose === 'reset' ? !asked?.reset : !asked?.sign_in) return null;
    if (purpose === 'step_up' && !mayStepUpByText(roleOfMember(memberId) ?? 'viewer')) {
      return null;
    }
    return maskPhone(phone.number);
  };
  const textNotOffered = () =>
    fail(409, 'sms_code_not_offered', 'A code by text isn’t offered here.');
  /** A new code for one of somebody's purposes, texted: the one before it ends. */
  const sendTextCode = (memberId: string, purpose: TextCodePurpose) => {
    const phone = state.phones?.get(memberId) as FakePhone;
    const texts = (state.texts ??= []);
    const code = String(100000 + ((texts.length * 7919 + 4242) % 900000));
    const expires = Date.now() + PHONE_CODE_MINUTES * 60_000;
    (state.textCodesOut ??= new Map()).set(`${memberId}:${purpose}`, {
      code,
      expires,
      attempts: 0,
    });
    texts.push({ to: phone.number, text: textCodeText(purpose, code) });
    return { sent_to: maskPhone(phone.number), expires_at: new Date(expires).toISOString() };
  };
  /** A code typed back for one of somebody's purposes: null when right, else the refusal. */
  const tryTextCode = (
    memberId: string,
    purpose: TextCodePurpose,
    typed: unknown,
  ): ResponseLike | null => {
    const out = state.textCodesOut?.get(`${memberId}:${purpose}`);
    if (!out || out.expires <= Date.now()) {
      return fail(
        409,
        'sms_code_expired',
        'That code has ended. Ask for a new one, and type the newest.',
      );
    }
    if (out.attempts >= PHONE_CODE_TRIES) {
      return fail(
        409,
        'sms_code_too_many',
        `That code was typed wrong ${PHONE_CODE_TRIES} times, so it no longer works. Ask for a new one.`,
      );
    }
    out.attempts += 1;
    if ((typeof typed === 'string' ? typed : '').replace(/[\s-]/g, '') !== out.code) {
      const left = PHONE_CODE_TRIES - out.attempts;
      return left <= 0
        ? fail(
            409,
            'sms_code_too_many',
            `That code was typed wrong ${PHONE_CODE_TRIES} times, so it no longer works. Ask for a new one.`,
          )
        : fail(
            422,
            'sms_code_wrong',
            `That code isn’t right. ${left} ${left === 1 ? 'try' : 'tries'} left.`,
          );
    }
    state.textCodesOut?.delete(`${memberId}:${purpose}`);
    return null;
  };

  const phoneRoutes = (
    path: string,
    init: Parameters<FetchLike>[1],
    body: Record<string, unknown>,
    sessionOf: () => FakeSession | ResponseLike,
  ): ResponseLike | null => {
    if (path === '/api/v1/sms/status') {
      const s = sessionOf();
      if (!('id' in s)) return s;
      return ok({ ready: state.smsReady ?? true });
    }
    // Whether a reset and a sign-in ask for a code by text (SMS3): one's own.
    // The fake asks nobody to confirm it's them first, as elsewhere.
    if (path === '/api/v1/auth/text-codes') {
      const s = sessionOf();
      if (!('id' in s)) return s;
      const who = whoOf(s);
      const all = (state.textCodes ??= new Map());
      const now = all.get(who.memberId) ?? { sign_in: false, reset: false };
      const phone = state.phones?.get(who.memberId);
      const ready = state.smsReady ?? true;
      const whyNot = !ready
        ? 'Text messages aren’t set up for this household yet. An owner can set them up in Settings, under Text messages.'
        : !phone
          ? 'Add your mobile number first, and confirm it with the code we text to it.'
          : !phone.confirmed_at
            ? 'Confirm your mobile number first, with the code we texted to it.'
            : null;
      const view = (v: { sign_in: boolean; reset: boolean }): TextCodeSettings => ({
        ...v,
        phone: phone ? maskPhone(phone.number) : null,
        phone_confirmed: Boolean(phone?.confirmed_at),
        sms_ready: ready,
        can_turn_on: whyNot === null,
        why_not: whyNot,
        step_up: mayStepUpByText(who.role),
      });
      if ((init?.method ?? 'GET') !== 'PUT') return ok(view(now));
      const nextOne = {
        sign_in: typeof body.sign_in === 'boolean' ? body.sign_in : now.sign_in,
        reset: typeof body.reset === 'boolean' ? body.reset : now.reset,
      };
      const on = (nextOne.sign_in && !now.sign_in) || (nextOne.reset && !now.reset);
      if (on && whyNot) return fail(409, 'sms_code_unavailable', whyNot);
      if (nextOne.sign_in && !now.sign_in && who.role === 'owner' && !state.ownerTwoStep) {
        return fail(409, 'sms_code_needs_factor', SMS_OWNER_NEEDS_FACTOR);
      }
      all.set(who.memberId, nextOne);
      return ok(view(nextOne));
    }
    // A code texted to confirm it's them (SMS3), and one typed back.
    if (path === '/api/v1/auth/step-up/text' && init.method === 'POST') {
      const s = sessionOf();
      if (!('id' in s)) return s;
      const who = whoOf(s);
      if (!textCodeTo(who.memberId, 'step_up')) return textNotOffered();
      return ok(sendTextCode(who.memberId, 'step_up'));
    }
    if (path === '/api/v1/auth/step-up' && init.method === 'POST' && body.text_code) {
      const s = sessionOf();
      if (!('id' in s)) return s;
      const who = whoOf(s);
      if (!textCodeTo(who.memberId, 'step_up')) return textNotOffered();
      const refused = tryTextCode(who.memberId, 'step_up', body.text_code);
      if (refused) return refused;
      return ok({ verified_at: new Date().toISOString(), expires_in: 300 });
    }
    // What somebody wants to hear, and how (SMS2: by text too, each off
    // until turned on, and their quiet hours): theirs alone, kept as sent.
    if (path === '/api/v1/notifications/preferences') {
      const s = sessionOf();
      if (!('id' in s)) return s;
      const me = whoOf(s).memberId;
      const prefs = (state.preferences ??= new Map());
      const now: Preferences = prefs.get(me) ?? {
        daily_push: true,
        daily_email: false,
        weekly_email: true,
        daily_text: false,
        alerts_text: false,
        share_opened_text: false,
        quiet_from: QUIET_FROM_DEFAULT,
        quiet_to: QUIET_TO_DEFAULT,
      };
      if ((init?.method ?? 'GET') === 'PUT') {
        const next = { ...now };
        for (const k of ['daily_push', 'daily_email', 'weekly_email'] as const) {
          if (typeof body[k] === 'boolean') next[k] = body[k];
        }
        for (const k of ['daily_text', 'alerts_text', 'share_opened_text'] as const) {
          if (typeof body[k] === 'boolean') next[k] = body[k];
        }
        for (const k of ['quiet_from', 'quiet_to'] as const) {
          if (body[k] === undefined) continue;
          if (typeof body[k] !== 'string' || !CLOCK_TIME.test(body[k])) {
            return fail(422, 'validation_failed', 'Quiet hours are a time of day, such as 21:00.');
          }
          next[k] = body[k];
        }
        prefs.set(me, next);
        return ok(next);
      }
      return ok(now);
    }
    // Neutral wording (0.9.0, H2): the household's, an owner's; each
    // person's own, beside it. The fake asks no step-up.
    if (path === '/api/v1/household/neutral-wording') {
      const s = sessionOf();
      if (!('id' in s)) return s;
      if (whoOf(s).role !== 'owner') {
        return fail(
          403,
          'forbidden',
          'Only an owner can choose how notifications name documents for the family.',
        );
      }
      if ((init?.method ?? 'GET') === 'PUT') {
        if (!(NEUTRAL_WORDINGS as readonly unknown[]).includes(body.neutral_wording)) {
          return fail(422, 'validation_failed', 'Choose one of the three.');
        }
        state.neutralWording = body.neutral_wording as NeutralWording;
      }
      const view: NeutralWordingView = {
        neutral_wording: state.neutralWording ?? NEUTRAL_WORDING_DEFAULT,
      };
      return ok(view);
    }
    if (path === '/api/v1/notifications/wording') {
      const s = sessionOf();
      if (!('id' in s)) return s;
      const me = whoOf(s).memberId;
      const mine = (state.myWording ??= new Map());
      if ((init?.method ?? 'GET') === 'PUT') {
        if (!(MY_WORDINGS as readonly unknown[]).includes(body.neutral_wording)) {
          return fail(422, 'validation_failed', 'Choose one of the three.');
        }
        mine.set(me, body.neutral_wording as MyWording);
      }
      const household = state.neutralWording ?? NEUTRAL_WORDING_DEFAULT;
      const chosen = myWordingOf(mine.get(me));
      const view: MyWordingView = {
        neutral_wording: chosen,
        household,
        in_effect: rulesInEffect(household, chosen),
      };
      return ok(view);
    }
    const m = /^\/api\/v1\/members\/([^/]+)\/phone(\/confirm|\/resend)?$/.exec(path);
    if (!m) return null;
    const s = sessionOf();
    if (!('id' in s)) return s;
    const id = decodeURIComponent(m[1] as string);
    const who = whoOf(s);
    if (who.memberId !== id && who.role !== 'owner') {
      return fail(
        403,
        'forbidden',
        'Only the person themselves or an owner can see or change their mobile number.',
      );
    }
    const person = state.members.find((x) => x.id === id);
    if (!person) return fail(404, 'not_found', 'That person isn’t in the family.');
    const phones = (state.phones ??= new Map());
    const texts = (state.texts ??= []);
    const ready = state.smsReady ?? true;
    const view = (): MemberPhoneView => {
      const p = phones.get(id);
      const live =
        p && !p.confirmed_at && p.code && (p.code_expires_at ?? 0) > Date.now()
          ? new Date(p.code_expires_at as number).toISOString()
          : null;
      return {
        phone: p
          ? {
              masked: maskPhone(p.number),
              confirmed: p.confirmed_at !== null,
              confirmed_at: p.confirmed_at,
              code_expires_at: live,
              updated_at: p.updated_at,
            }
          : null,
        sms_ready: ready,
      };
    };
    const notSetUp = () =>
      fail(
        409,
        'sms_not_set_up',
        'Text messages aren’t set up for this household yet. An owner can set them up in Settings, under Text messages.',
      );
    const text = (p: FakePhone) => {
      const code = String(100000 + ((texts.length * 7919 + 4242) % 900000));
      p.code = code;
      p.code_expires_at = Date.now() + PHONE_CODE_MINUTES * 60_000;
      p.attempts = 0;
      texts.push({ to: p.number, text: phoneCodeText(code, person.display_name) });
    };
    const suffix = m[2];
    if (!suffix && init.method === 'GET') return ok(view());
    if (!suffix && init.method === 'PUT') {
      if (!ready) return notSetUp();
      const number = parsePhone(typeof body.number === 'string' ? body.number : '', 'GB');
      if (!number) {
        return fail(
          422,
          'phone_number_invalid',
          'That doesn’t look like a mobile number. Type it with its country code, such as +44 7700 900123.',
        );
      }
      const was = phones.get(id);
      if (was && was.number === number && was.confirmed_at) return ok(view());
      const p: FakePhone = {
        number,
        confirmed_at: null,
        code: null,
        code_expires_at: null,
        attempts: 0,
        updated_at: new Date().toISOString(),
      };
      phones.set(id, p);
      text(p);
      return ok(view());
    }
    if (!suffix && init.method === 'DELETE') {
      if (!phones.delete(id)) {
        return fail(404, 'phone_none', 'There is no mobile number for this person yet.');
      }
      return ok(view());
    }
    const p = phones.get(id);
    if (init.method !== 'POST' || !suffix) return fail(404, 'not_found', 'Not here.');
    if (!p) return fail(404, 'phone_none', 'There is no mobile number for this person yet.');
    if (suffix === '/resend') {
      if (!ready) return notSetUp();
      if (p.confirmed_at) return fail(409, 'phone_confirmed', 'That number is confirmed already.');
      text(p);
      return ok(view());
    }
    if (p.confirmed_at) return ok(view());
    if (p.attempts >= PHONE_CODE_TRIES) {
      return fail(
        409,
        'phone_code_too_many',
        `That code was typed wrong ${PHONE_CODE_TRIES} times, so it no longer works. Ask for a new one.`,
      );
    }
    if (!p.code || (p.code_expires_at ?? 0) <= Date.now()) {
      return fail(
        409,
        'phone_code_expired',
        'That code has ended. Ask for a new one, and type the newest.',
      );
    }
    p.attempts += 1;
    if ((typeof body.code === 'string' ? body.code : '').replace(/[\s-]/g, '') !== p.code) {
      const left = PHONE_CODE_TRIES - p.attempts;
      return left <= 0
        ? fail(
            409,
            'phone_code_too_many',
            `That code was typed wrong ${PHONE_CODE_TRIES} times, so it no longer works. Ask for a new one.`,
          )
        : fail(
            422,
            'phone_code_wrong',
            `That code isn’t right. ${left} ${left === 1 ? 'try' : 'tries'} left.`,
          );
    }
    p.confirmed_at = new Date().toISOString();
    p.code = null;
    p.code_expires_at = null;
    return ok(view());
  };

  const mailboxRoutes = (
    path: string,
    init: Parameters<FetchLike>[1],
    body: Record<string, unknown>,
    sessionOf: () => FakeSession | ResponseLike,
  ): ResponseLike | null => {
    if (path !== '/api/v1/mail-in/mailbox') return null;
    const s = sessionOf();
    if (!('id' in s)) return s;
    if (whoOf(s).role !== 'owner') {
      return fail(403, 'forbidden', 'Only an owner can set up email in.');
    }
    const view = (): MailInView => {
      const box = state.mailbox ?? null;
      const ready = box !== null && box.password === 'set';
      return {
        available: ready,
        server: {
          state: ready ? 'ready' : 'not_configured',
          address: ready && box.username.includes('@') ? box.username : null,
          folder: ready ? box.folder : null,
          after: box?.after ?? 'move',
          sender_check: ready && box.authserv_id !== null,
          filing: null,
          filing_words: null,
          poll_seconds: box?.poll_seconds ?? null,
          checked_at: null,
          words: ready
            ? 'The household mailbox is set up.'
            : 'No household mailbox is set up yet. Set one up below, or on the server.',
        },
        enabled: false,
        last_checked_at: null,
        last_error: null,
        last_added_at: null,
        unknown_senders: 0,
        unverified: 0,
        waiting: 0,
        counts: [],
        sender_warning: null,
        confirm: { send_from: false, emailed: false },
        confirm_warning: null,
        source: box ? 'settings' : 'none',
        mailbox: box
          ? {
              host: box.host,
              port: box.port,
              username: box.username,
              password: box.password,
              folder: box.folder,
              after: box.after,
              authserv_id: box.authserv_id,
              poll_seconds: box.poll_seconds,
              updated_at: box.updated_at,
            }
          : null,
      };
    };
    if (init.method === 'DELETE') {
      state.mailbox = null;
      return ok(view());
    }
    if (init.method !== 'PUT') return null;
    const host = typeof body.host === 'string' ? body.host.trim() : '';
    const port = typeof body.port === 'number' ? body.port : NaN;
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : undefined;
    if (!host || !username || !Number.isInteger(port)) {
      return fail(422, 'validation_failed', 'Type the mail server and the sign-in.');
    }
    const ports = state.mailInAllowedPorts?.length ? state.mailInAllowedPorts : [993];
    const literal = /^[0-9.]+$/.test(host) || host.includes(':');
    const inside =
      !(state.mailInAllowPrivate ?? false) &&
      (isLoopbackName(host) || (literal && isPrivateAddress(host)));
    if (!ports.includes(port) || inside) {
      return fail(422, 'mailbox_address_refused', mailInAddressRefused(ports));
    }
    const before = state.mailbox ?? null;
    const moved =
      before !== null &&
      (before.host.toLowerCase() !== host.toLowerCase() ||
        before.port !== port ||
        before.username !== username);
    if (before?.password === 'set' && moved && password === undefined) {
      return fail(
        422,
        'mailbox_password_needed',
        'Type the app password again for the new server.',
      );
    }
    const secret = password ?? before?.secret ?? null;
    state.mailbox = {
      host,
      port,
      username,
      password: secret === null ? 'not_set' : 'set',
      secret,
      folder: typeof body.folder === 'string' && body.folder.trim() ? body.folder.trim() : 'INBOX',
      after: body.after === 'delete' ? 'delete' : 'move',
      authserv_id:
        typeof body.authserv_id === 'string' && body.authserv_id.trim()
          ? body.authserv_id.trim()
          : null,
      poll_seconds: typeof body.poll_seconds === 'number' ? body.poll_seconds : 300,
      updated_at: new Date().toISOString(),
    };
    return ok(view());
  };

  /** Computers that send scans (0.8.0, D1): their routes, or null for any other. */
  /**
   * Links to documents outside the family, as far as the fake makes them
   * (0.9.0): made by whoever may share a document they can see, listed,
   * taken back, and shown again to whoever made them — as the real vault
   * answers, but with no confirming it's you first, which the fake asks
   * nowhere. Null for any other route.
   */
  const shareRoutes = (
    path: string,
    init: Parameters<FetchLike>[1],
    body: Record<string, unknown>,
    sessionOf: () => FakeSession | ResponseLike,
  ): ResponseLike | null => {
    const making = /^\/api\/v1\/documents\/([^/]+)\/share$/.exec(path);
    const stopping = /^\/api\/v1\/documents\/([^/]+)\/stop-sharing$/.exec(path);
    const one = /^\/api\/v1\/shares\/([^/]+)(\/reveal|\/email)?$/.exec(path);
    // A link's properties changed (0.9.0, LK): whoever made it, with no
    // confirming it's you, which the fake asks nowhere.
    const lkLatest = (l: FakeShare) =>
      Date.parse(l.share.created_at) + (l.share.follow_collection ? 30 : 90) * 864e5;
    // Who opened a link, when (0.9.0, H5).
    const opensOf = /^\/api\/v1\/shares\/([^/]+)\/opens$/.exec(path);
    const docOpens = /^\/api\/v1\/documents\/([^/]+)\/link-opens$/.exec(path);
    if (!making && !stopping && !one && !opensOf && !docOpens && path !== '/api/v1/shares') {
      return null;
    }
    const s = sessionOf();
    if (!('id' in s)) return s;
    const who = whoOf(s);
    const links = (state.shares ??= []);
    if ((opensOf || docOpens) && init.method === 'GET') {
      // Its maker and an owner where they see it; and the person a sensitive
      // document is theirs, whoever made the link, to it alone or with a
      // collection (its `items`) — as the vault answers. A document in the
      // Trash, or one the reader can't see, gives nothing.
      const live = (id: string) => {
        const d = state.documents.find((x) => x.id === id && !x.deleted_at);
        if (!d) return null;
        if (d.visibility === 'private' && d.owner_member_id !== who.memberId) return null;
        return d;
      };
      const gives = (l: FakeShare): string[] =>
        l.share.document_id !== null ? [l.share.document_id] : (l.items ?? []);
      const mayOpen = (l: FakeShare, docId: string | null): boolean => {
        const makerOrOwner =
          can(who.role, 'document.share') &&
          (l.made_by === who.memberId || who.role === 'owner') &&
          // A link to one document in the Trash is listed nowhere.
          (l.share.document_id === null || live(l.share.document_id) !== null);
        if (makerOrOwner && (docId === null || gives(l).includes(docId))) return true;
        return gives(l)
          .filter((id) => docId === null || id === docId)
          .some((id) => {
            const d = live(id);
            if (!d || d.owner_member_id !== who.memberId) return false;
            return sensitiveOf(
              d,
              state.types.find((t) => t.key === d.type_key),
            );
          });
      };
      const opening = (l: FakeShare): DocumentLinkOpening => ({
        share_id: l.share.id,
        recipient_label: l.share.recipient_label,
        created_by_name: l.share.created_by_name,
        mine: l.made_by === who.memberId,
        permission: l.share.permission ?? 'download',
        created_at: l.share.created_at,
        expires_at: l.share.expires_at,
        state: l.share.state,
        open_count: l.share.open_count,
        opens: [...(l.openings ?? [])].reverse(),
      });
      if (opensOf) {
        const id = decodeURIComponent(opensOf[1] as string);
        const l = links.find((x) => x.share.id === id && mayOpen(x, null));
        if (!l) return fail(404, 'not_found', 'That link is not in the vault.');
        const o = opening(l);
        return ok({
          share_id: o.share_id,
          recipient_label: o.recipient_label,
          open_count: o.open_count,
          items: o.opens,
        });
      }
      const docId = decodeURIComponent((docOpens as RegExpExecArray)[1] as string);
      if (!live(docId)) return fail(404, 'not_found', 'That document is not in the vault.');
      return ok({
        items: links
          .filter((l) => mayOpen(l, docId))
          .map(opening)
          .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)),
      });
    }
    const ended = (l: FakeShare) =>
      l.share.state === 'revoked' || l.share.state === 'expired' || l.share.state === 'locked';
    const revealable = (l: FakeShare) => l.made_by === who.memberId && !l.shown_once && !ended(l);
    const view = (l: FakeShare): Share => {
      // Where it was last emailed, and by whom: for whoever sees the link
      // (the owner's decision of 16 Nov 2026), as the vault answers.
      const last = l.emailed?.at(-1);
      return {
        ...l.share,
        revealable: revealable(l),
        // 0.9.0: emailed by the vault, with the operator's mail server alone.
        emailable: revealable(l) && l.share.state === 'active' && state.operatorMail,
        emailed_to: last ? maskEmail(last.to) : null,
        emailed_by_name: last
          ? (state.members.find((m) => m.id === l.made_by)?.display_name ?? null)
          : null,
        mine: l.made_by === who.memberId,
        changeable:
          (l.made_by === who.memberId || who.role === 'owner') &&
          (l.share.flow ?? 'v2') === 'v2' &&
          !ended(l) &&
          l.share.state !== 'used_up',
        latest_end: new Date(lkLatest(l)).toISOString(),
        show_title: l.show_title ?? null,
        version: l.share.version ?? 1,
      };
    };
    if (path === '/api/v1/shares' && init.method === 'GET') {
      if (!can(who.role, 'document.share')) return ok({ items: [] });
      return ok({ items: links.map(view) });
    }
    if (!can(who.role, 'document.share')) {
      return fail(403, 'forbidden', refusalFor('document.share'));
    }
    // Its links ended, made sensitive (0.9.0, H1a): the fake keeps no
    // collection's links, so each is its own, taken back.
    if (stopping && init.method === 'POST') {
      const id = decodeURIComponent(stopping[1] as string);
      const doc = state.documents.find((d) => d.id === id && !d.deleted_at);
      if (!doc) return fail(404, 'not_found', 'That document is not in the vault.');
      let ended = 0;
      for (const l of links) {
        if (l.share.document_id !== id || l.share.state !== 'active') continue;
        l.share = { ...l.share, state: 'revoked' };
        ended += 1;
      }
      return ok({ ended, left_out: 0, kept: 0 });
    }
    if (making && init.method === 'POST') {
      const doc = state.documents.find(
        (d) => d.id === decodeURIComponent(making[1] as string) && !d.deleted_at,
      );
      if (
        !doc ||
        !canSee(who, {
          visibility: doc.visibility ?? 'household',
          owner_member_id: doc.owner_member_id ?? null,
        })
      ) {
        return fail(404, 'not_found', 'That document is not in the vault.');
      }
      // A health record kept as it is (0.9.0, H5) has no pages to view.
      const newest = [...versionsOf(doc.id)].sort((a, b) => b.version_no - a.version_no)[0];
      if (body.permission === 'view' && newest && isRecordFormat(newest.mime)) {
        return fail(422, 'view_not_possible', viewNotPossibleWords(newest.mime));
      }
      // Sensitive, all said (0.9.0, H1a): asked first, made only once the
      // sharer says so.
      if (
        body.confirm_sensitive !== true &&
        sensitiveOf(doc, state.types.find((t) => t.key === doc.type_key) ?? null)
      ) {
        return fail(409, 'sensitive_confirm', SENSITIVE_SHARE_CONFIRM);
      }
      const token = `fake-link-${next('token')}`.padEnd(43, 'x');
      const pin = body.with_pin === true ? String(1000 + (n % 9000)) : null;
      const password = body.with_password === true ? `fake-${next('pw')}-word` : null;
      const typed = typeof body.password === 'string' ? body.password : null;
      // A code by text (SMS3): to the number typed, while texts go.
      const byText =
        body.second_factor === 'sms' ||
        (body.second_factor === undefined && typeof body.recipient_phone === 'string');
      let codePhone: string | null = null;
      if (byText) {
        if (typeof body.code_email === 'string') {
          return fail(
            422,
            'validation_failed',
            'Choose one way for the code: by email, or by text to a mobile number.',
          );
        }
        if (!(state.smsReady ?? true)) {
          return fail(
            409,
            'sms_not_set_up',
            'Text messages aren’t set up for this household yet. An owner can set them up in Settings, under Text messages.',
          );
        }
        codePhone = parsePhone(
          typeof body.recipient_phone === 'string' ? body.recipient_phone : '',
          'GB',
        );
        if (!codePhone) {
          return fail(
            422,
            'phone_number_invalid',
            'That doesn’t look like a mobile number. Type it with its country code, such as +44 7700 900123.',
          );
        }
      }
      const now = new Date();
      const share: Share = {
        id: next('share'),
        document_id: doc.id,
        document_title: doc.title,
        collection_id: null,
        collection_name: null,
        follow_collection: false,
        recipient_label: typeof body.recipient_label === 'string' ? body.recipient_label : null,
        created_by_name: state.members.find((m) => m.id === who.memberId)?.display_name ?? null,
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 7 * 864e5).toISOString(),
        has_pin: pin !== null,
        open_count: 0,
        last_opened_at: null,
        state: 'active',
        flow: 'v2',
        paused_at: null,
        paused_reason: null,
        permission: body.permission === 'view' ? 'view' : 'download',
        protection: [
          ...(pin ? (['pin'] as const) : password || typed ? (['password'] as const) : []),
          ...(codePhone ? (['code'] as const) : []),
        ],
        code_to: codePhone ? maskPhone(codePhone) : null,
        second_factor: codePhone ? 'sms' : null,
        this_device_only: body.this_device_only === true,
        summary: 'Not opened yet',
      };
      // A password the sharer typed is theirs, and never kept to show again.
      // Whether its page shows the title (H1a): as chosen, else as the document is.
      const made: FakeShare = {
        share,
        made_by: who.memberId,
        token,
        pin,
        password,
        show_title: typeof body.show_title === 'boolean' ? body.show_title : null,
      };
      links.unshift(made);
      const created: CreatedShare = {
        share: view(made),
        link_token: token,
        link_url: null,
        ...(pin ? { pin } : {}),
        ...(password ? { password } : {}),
      };
      return ok(created, 201);
    }
    const link = one
      ? links.find((l) => l.share.id === decodeURIComponent(one[1] as string))
      : null;
    if (one && one[2] === '/email' && init.method === 'POST') {
      // As the vault answers (0.9.0): no mail server, none; then the address,
      // whose it is, that it opens, the copy, and the day's count.
      if (!state.operatorMail) {
        return fail(503, 'email_link_unavailable', SHARE_LINK_EMAIL_UNAVAILABLE);
      }
      const to = typeof body.to === 'string' ? body.to.trim() : '';
      if (!isShareAddress(to)) {
        return fail(
          422,
          'validation_failed',
          'That is not an email address. Check it: name@example.com.',
        );
      }
      const words = shareLinkMessage(typeof body.message === 'string' ? body.message : null);
      if ('problem' in words) return fail(422, 'validation_failed', words.problem);
      if (!link || link.made_by !== who.memberId) {
        return fail(404, 'not_found', 'That link does not exist.');
      }
      if (ended(link) || link.share.state === 'used_up') {
        return fail(
          410,
          'share_ended',
          'That link no longer opens, so there is nothing to send. Make a new one if you need to.',
        );
      }
      if (link.share.state === 'paused') {
        return fail(
          409,
          'share_paused',
          'That link is paused just now, so it would not open for them. Once it works again, you can email it.',
        );
      }
      if (link.shown_once) {
        return fail(
          409,
          'share_not_revealable',
          'That link was made before the vault kept a copy, so the vault cannot email it. Send it yourself, or take it back and make a new one.',
        );
      }
      const dayAgo = Date.now() - 864e5;
      const today = (link.emailed ?? []).filter((e) => Date.parse(e.at) > dayAgo);
      if (today.length >= SHARE_LINK_EMAILS.perLinkPerDay) {
        return fail(
          429,
          'email_link_limit',
          `This link has been emailed ${SHARE_LINK_EMAILS.perLinkPerDay} times today, which is as many as the vault sends. Copy it and send it yourself, or try again tomorrow.`,
        );
      }
      const at = new Date().toISOString();
      (link.emailed ??= []).push({ to, message: words.message, at });
      const sent: ShareEmailed = {
        sent_to: maskEmail(to),
        sent_at: at,
        sends_left: SHARE_LINK_EMAILS.perLinkPerDay - today.length - 1,
      };
      return ok(sent);
    }
    if (one && one[2] === '/reveal' && init.method === 'POST') {
      // Anybody else's is a link there is no such of, an owner's included.
      if (!link || link.made_by !== who.memberId) {
        return fail(404, 'not_found', 'That link does not exist.');
      }
      if (ended(link)) {
        return fail(
          410,
          'share_ended',
          'That link no longer works, so there is nothing to show. Make a new one if you need to.',
        );
      }
      if (link.shown_once) {
        return fail(
          409,
          'share_not_revealable',
          'That link was made before the vault kept a copy, so it was shown only once. Take it back and make a new one if you need it again.',
        );
      }
      const shown: RevealedShare = {
        link_token: link.token,
        link_url: null,
        ...(link.pin ? { pin: link.pin } : {}),
        ...(link.password ? { password: link.password } : {}),
      };
      return ok(shown);
    }
    if (one && !one[2] && init.method === 'PATCH') {
      // Its maker's, or an owner's (16 Nov 2026) — its PIN or password its maker's alone.
      if (!link || (link.made_by !== who.memberId && who.role !== 'owner')) {
        return fail(404, 'not_found', 'That link does not exist.');
      }
      if (body.secret !== undefined && link.made_by !== who.memberId) {
        return fail(
          403,
          'share_secret_makers_only',
          'Only whoever made this link can give it a new PIN or password. Take it back and make a new one if you need to.',
        );
      }
      if (ended(link) || link.share.state === 'used_up') {
        return fail(
          410,
          'share_ended',
          'That link no longer works, so it can’t be changed. Make a new one if you need to.',
        );
      }
      const version = link.share.version ?? 1;
      const ifMatch = init.headers['if-match'];
      if (ifMatch && ifMatch.replace(/^W\//, '').replace(/"/g, '') !== String(version)) {
        return fail(
          409,
          'conflict',
          'That link was changed somewhere else since you opened it. Look at it again, then make your change.',
        );
      }
      const changes: string[] = [];
      const nowIs: Share = { ...link.share };
      if ('recipient_label' in body) {
        const label =
          typeof body.recipient_label === 'string' && body.recipient_label.trim()
            ? body.recipient_label.trim()
            : null;
        if (label !== link.share.recipient_label) {
          nowIs.recipient_label = label;
          changes.push('recipient_label');
        }
      }
      if (typeof body.expires_at === 'string' && body.expires_at !== link.share.expires_at) {
        const end = Date.parse(body.expires_at);
        if (Number.isNaN(end) || end < Date.now() + 5 * 60_000) {
          return fail(422, 'expiry_out_of_range', 'Choose a time at least 5 minutes from now.');
        }
        if (end > lkLatest(link) + 5 * 60_000) {
          return fail(
            422,
            'expiry_out_of_range',
            'A link can last 90 days at most from when it was made.',
          );
        }
        nowIs.expires_at = new Date(Math.min(end, lkLatest(link))).toISOString();
        changes.push('expires_at');
      }
      if (
        (body.permission === 'view' || body.permission === 'download') &&
        body.permission !== (link.share.permission ?? 'download')
      ) {
        nowIs.permission = body.permission;
        if (body.permission === 'view') nowIs.max_downloads = null;
        changes.push('permission');
      }
      for (const key of ['max_opens', 'max_downloads'] as const) {
        if (!(key in body)) continue;
        const v = body[key];
        const value = typeof v === 'number' ? v : null;
        if (value !== (link.share[key] ?? null)) {
          nowIs[key] = value;
          changes.push(key);
        }
      }
      if (typeof body.show_title === 'boolean' && body.show_title !== (link.show_title ?? null)) {
        link.show_title = body.show_title;
        changes.push('show_title');
      }
      let pin: string | null = null;
      let password: string | null = null;
      const secret = body.secret;
      if (secret === 'none' || secret === 'pin' || secret === 'password') {
        const had = (link.share.protection ?? []).some((p) => p === 'pin' || p === 'password');
        if (secret !== 'none' || had) {
          changes.push('secret');
          pin = secret === 'pin' ? String(1000 + (n % 9000)) : null;
          password =
            secret === 'password' && typeof body.password !== 'string'
              ? `fake-${next('pw')}-word`
              : null;
          const factor =
            secret === 'pin'
              ? (['pin'] as const)
              : secret === 'password'
                ? (['password'] as const)
                : [];
          nowIs.protection = [
            ...factor,
            ...(link.share.protection ?? []).filter((p) => p !== 'pin' && p !== 'password'),
          ];
          nowIs.has_pin = secret === 'pin';
          // As the vault keeps it: a typed password never.
          link.pin = pin;
          link.password = password;
        }
      }
      if (changes.length) nowIs.version = version + 1;
      link.share = nowIs;
      const answer: ChangedShare = {
        share: view(link),
        changed: changes,
        ...(pin ? { pin } : {}),
        ...(password ? { password } : {}),
      };
      return ok(answer);
    }
    if (one && !one[2] && init.method === 'DELETE') {
      if (!link || link.share.state === 'revoked') {
        return fail(404, 'not_found', 'That link does not exist.');
      }
      link.share = { ...link.share, state: 'revoked' };
      return empty();
    }
    return null;
  };

  const deviceRoutes = (
    path: string,
    init: Parameters<FetchLike>[1],
    body: Record<string, unknown>,
    sessionOf: () => FakeSession | ResponseLike,
  ): ResponseLike | null => {
    const devices = (state.devices ??= []);
    const memberName = (id: string) =>
      state.members.find((m) => m.id === id)?.display_name ?? 'Somebody';
    const pairings = (state.pairings ??= []);
    const keyed = /^Device ([^.\s]+)\.(\S+)$/.exec(init.headers.authorization ?? '');
    const onlyDeviceRoutes =
      (path === '/api/v1/device-uploads' && init.method === 'POST') ||
      (path === '/api/v1/devices/me' && (init.method ?? 'GET') === 'GET');
    if (/^device(\s|$)/i.test(init.headers.authorization ?? '') && !onlyDeviceRoutes) {
      return fail(401, 'device_key_not_accepted', "A computer's key can only send scans.");
    }
    if (path === '/api/v1/device-pairings' && init.method === 'POST') {
      const s = sessionOf();
      if (!('id' in s)) return s;
      const who = whoOf(s);
      if (!can(who.role, 'document.add')) return fail(403, 'forbidden', refusalFor('document.add'));
      const code = Array.from(
        { length: PAIRING_CODE_LENGTH },
        () => PAIRING_ALPHABET[Math.floor(Math.random() * PAIRING_ALPHABET.length)],
      ).join('');
      state.pairings = pairings.filter((p) => p.member_id !== who.memberId);
      const expires = Date.now() + PAIRING_MINUTES * 60_000;
      state.pairings.push({ code, member_id: who.memberId, expires_at: expires, attempts: 0 });
      const made: DevicePairingCode = {
        code: showPairingCode(code),
        expires_at: new Date(expires).toISOString(),
        vault_address: 'http://fake-vault.test',
        download_url: null,
      };
      return ok(made, 201);
    }
    if (path === '/api/v1/device-pairings' && init.method === 'DELETE') {
      const s = sessionOf();
      if (!('id' in s)) return s;
      const who = whoOf(s);
      if (!can(who.role, 'document.add')) return fail(403, 'forbidden', refusalFor('document.add'));
      state.pairings = pairings.filter((p) => p.member_id !== who.memberId);
      return empty();
    }
    if (path === '/api/v1/devices/pair' && init.method === 'POST') {
      const name = typeof body.device_name === 'string' ? deviceName(body.device_name) : null;
      if (!name) return fail(422, 'validation_failed', 'Give the computer a name.');
      const platform = body.platform as DevicePlatform;
      if (!DEVICE_PLATFORMS.includes(platform)) {
        return fail(422, 'validation_failed', 'Say what the computer runs.', 'platform');
      }
      const code = typeof body.code === 'string' ? normalisePairingCode(body.code) : null;
      const wrong = () =>
        fail(401, 'pairing_code_invalid', 'That code is not right, or it has run out.');
      const live = pairings.find(
        (p) =>
          code !== null &&
          p.code.slice(0, 4) === code.slice(0, 4) &&
          p.expires_at > Date.now() &&
          p.attempts < PAIRING_ATTEMPTS,
      );
      if (!code || !live) return wrong();
      if (live.code !== code) {
        live.attempts += 1;
        return wrong();
      }
      state.pairings = pairings.filter((p) => p !== live);
      const role = roleOfMember(live.member_id);
      if (!role || !can(role, 'document.add')) {
        return fail(403, 'cannot_add', DEVICE_REFUSALS.cannot_add);
      }
      const d: FakeDevice = {
        id: next('device'),
        key: `fakekey${Math.random().toString(36).slice(2)}`.padEnd(43, 'x').slice(0, 43),
        name,
        platform,
        member_id: live.member_id,
        added_at: new Date().toISOString(),
        last_used_at: null,
        revoked: false,
      };
      devices.push(d);
      const paired: DevicePaired = {
        device_id: d.id,
        key: d.key,
        member_name: memberName(live.member_id),
        vault_name: 'A fake family',
      };
      return ok(paired, 201);
    }
    if (onlyDeviceRoutes) {
      const d = devices.find((x) => keyed && x.id === keyed[1] && x.key === keyed[2]);
      if (!d)
        return fail(401, 'unauthenticated', 'This computer’s key is not one this vault knows.');
      if (d.revoked) return fail(401, 'device_revoked', DEVICE_REFUSALS.device_revoked);
      d.last_used_at = new Date().toISOString();
      const role = roleOfMember(d.member_id);
      const suspended = suspensionOf(d.member_id);
      const paused: DevicePausedReason | null =
        !role || !can(role, 'document.add')
          ? 'cannot_add'
          : suspended
            ? suspended.reason === 'locked'
              ? 'locked'
              : 'paused_after_restore'
            : null;
      if (path === '/api/v1/devices/me') {
        const me: DeviceMe = {
          device_id: d.id,
          device_name: d.name,
          member_name: memberName(d.member_id),
          active: paused === null,
          paused,
          limits: {
            max_upload_bytes: 104_857_600,
            batch_max_files: BATCH_MAX_FILES,
            daily_bytes: 2 * 1024 ** 3,
            day_resets_at: nextLocalMidnight(state.timezone).toISOString(),
            accepted_types: ['application/pdf', 'image/jpeg', 'image/png'],
          },
        };
        return ok(me);
      }
      if (paused === 'cannot_add') return fail(403, 'cannot_add', DEVICE_REFUSALS.cannot_add);
      if (paused === 'locked') return fail(403, 'member_locked', DEVICE_REFUSALS.member_locked);
      if (paused) return fail(403, 'member_paused', DEVICE_REFUSALS.member_paused);
      const key = init.headers['idempotency-key'];
      if (key === undefined || !UUID.test(key)) {
        return fail(422, 'validation_failed', 'Send an Idempotency-Key.', 'idempotency-key');
      }
      for (const b of state.batches.filter((x) => x.device_id === d.id)) {
        const before = b.items.find((x) => x.key === key);
        if (before?.state === 'removed') {
          return fail(409, 'already_decided', 'This file has been accepted or removed already.');
        }
        if (before) {
          const replay: DeviceUploaded = {
            item_id: before.id,
            status: before.state === 'accepted' ? 'accepted' : 'waiting',
          };
          return ok(replay, 201);
        }
      }
      const parts = partsOf(init.body, init.headers['content-type']) ?? [];
      const files = parts.filter((p) => p.value === null);
      const fields = parts.filter((p) => p.value !== null);
      const file = files[0];
      if (
        !file ||
        files.length > 1 ||
        fields.length > 1 ||
        (fields[0] !== undefined && fields[0].name !== 'relative_path')
      ) {
        return fail(422, 'validation_failed', 'Send an optional relative_path, then one file.');
      }
      const where = fields[0]?.value;
      const problem = typeof where === 'string' ? relativePathProblem(where) : null;
      if (problem) return fail(422, 'validation_failed', problem, 'relative_path');
      const type = (file.type ?? '').split(';')[0] ?? '';
      if (!/^(application\/pdf|image\/(jpeg|png|heic|heif|tiff|webp))$/.test(type)) {
        return fail(415, 'unsupported_type', 'That kind of file cannot be stored here.');
      }
      const day = localToday(state.timezone);
      let b = state.batches.find((x) => x.device_id === d.id && x.device_day === day);
      if (!b) {
        const now = new Date();
        b = {
          id: next('batch'),
          member_id: d.member_id,
          device_id: d.id,
          device_day: day,
          name: deviceBatchName(d.name, day),
          created_at: now.toISOString(),
          ends_at: new Date(now.getTime() + 30 * 864e5).toISOString(),
          defaults: {
            owner_member_id: null,
            type_key: null,
            visibility: null,
            physical_location: null,
            collection_id: null,
            tags: [],
            is_essential: false,
            sensitive: null,
          },
          items: [],
        };
        state.batches.push(b);
      }
      if (b.items.filter((x) => x.state !== 'removed').length >= BATCH_MAX_FILES) {
        return fail(422, 'batch_full', `A batch holds ${BATCH_MAX_FILES} files at most.`);
      }
      const it: FakeBatchItem = {
        id: next('item'),
        name: file.filename ?? 'file',
        content_type: type,
        byte_size: file.size ?? 0,
        sha256: standInHash(file.bytes ?? new Uint8Array()),
        arrived_at: new Date().toISOString(),
        state: 'waiting',
        document_id: null,
        key,
        ...(file.bytes ? { bytes: file.bytes } : {}),
      };
      b.items.push(it);
      const sent: DeviceUploaded = { item_id: it.id, status: 'waiting' };
      return ok(sent, 201);
    }
    if (path === '/api/v1/paired-devices' && (init.method ?? 'GET') === 'GET') {
      const s = sessionOf();
      if (!('id' in s)) return s;
      const who = whoOf(s);
      if (!can(who.role, 'document.add')) return fail(403, 'forbidden', refusalFor('document.add'));
      const items: PairedDevice[] = devices
        .filter((d) => !d.revoked && (who.role === 'owner' || d.member_id === who.memberId))
        .reverse()
        .map((d) => ({
          id: d.id,
          name: d.name,
          platform: d.platform,
          member_id: d.member_id,
          member_name: memberName(d.member_id),
          mine: d.member_id === who.memberId,
          added_at: d.added_at,
          last_used_at: d.member_id === who.memberId ? d.last_used_at : null,
        }));
      return ok({ items });
    }
    const revokeAt = /^\/api\/v1\/paired-devices\/([^/]+)$/.exec(path);
    if (revokeAt && init.method === 'DELETE') {
      const s = sessionOf();
      if (!('id' in s)) return s;
      const who = whoOf(s);
      if (!can(who.role, 'document.add')) return fail(403, 'forbidden', refusalFor('document.add'));
      const d = devices.find(
        (x) =>
          x.id === revokeAt[1] &&
          !x.revoked &&
          (who.role === 'owner' || x.member_id === who.memberId),
      );
      if (!d) return fail(404, 'not_found', 'That computer is not here.');
      d.revoked = true;
      return empty();
    }
    return null;
  };

  const fetch: FetchLike = async (url, sent) => {
    const path = url.replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0] as string;
    state.calls.push({ method: sent.method, path });
    if (state.offline) throw new TypeError('Network request failed');
    // The body as it was sent, in bytes (CL3): a stream, a Blob or an
    // ArrayBuffer read now; a platform FormData's files too.
    const init = { ...sent, body: await readBody(sent.body) };
    const body =
      typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const auth = init.headers.authorization?.replace(/^Bearer /, '');
    const session = () => {
      const id = auth ? state.access.get(auth) : undefined;
      const s = state.sessions.find((x) => x.id === id);
      if (!s) return fail(401, 'unauthenticated', 'Sign in first.');
      if (s.revoked) return ended(s.endedBecause ?? 'revoked');
      // Locked, or paused after a restore (5.28): a session a lock did not
      // end — a test's own suspension — answers nothing while it lasts.
      if (suspensionOf(whoOf(s).memberId)) return ended('suspended');
      // A guest's sign-in past its end (5.34): as the real vault, `access_ended`.
      if (guestEndOf(whoOf(s).memberId)) return ended('access_ended');
      return s;
    };
    // A computer that sends scans (0.8.0, D1), as the real vault answers: a
    // code for whoever may add, traded for a key that only uploads — and a
    // key refused on every other route, first.
    // Connected apps (0.9.0, APP1): an API key (APP6) taken by the app
    // routes alone, checked as the vault checks it; and Settings →
    // Connected apps.
    const apps = fakeAppRoutes({
      apps: (state.connectedApps ??= []),
      session: () => {
        const s = session();
        return 'id' in s ? whoOf(s) : s;
      },
      memberName: (id) => state.members.find((m) => m.id === id)?.display_name ?? 'Somebody',
      ownerTwoStep: () => state.ownerTwoStep,
      memberTwoStep: () => state.adultTwoStep !== false,
      mayAct: (id) =>
        state.members.some((m) => m.id === id && (m.role === 'owner' || m.role === 'adult')),
      kinds: () => state.types,
      // Whose Inbox a send may go to (APP5): the family by name, and an owner
      // or an adult who signs in and is neither locked nor paused.
      people: () =>
        state.members
          .filter((m) => (m.kind ?? 'family') === 'family')
          .map((m) => ({ id: m.id, name: m.display_name })),
      receives: (id) =>
        state.members.some(
          (m) =>
            m.id === id &&
            (m.kind ?? 'family') === 'family' &&
            (m.role === 'owner' || m.role === 'adult') &&
            !suspensionOf(id),
        ),
      // Any version, by its id (APP5): the exact file a send became.
      versionOf: (versionId) => {
        const v = [...state.captures.values()].find((x) => x.version_id === versionId);
        return v
          ? {
              document_id: v.document_id,
              bytes: v.bytes ?? new Uint8Array(),
              mime: v.mime,
              filename: v.filename,
            }
          : null;
      },
      // What an app reads (APP2): the fake's documents and their newest file.
      documents: () =>
        state.documents.map((doc) => {
          const v = versionsOf(doc.id).sort((x, y) => y.version_no - x.version_no)[0];
          return {
            id: doc.id,
            title: doc.title,
            type_key: doc.type_key ?? null,
            visibility: doc.visibility ?? 'household',
            sensitive: doc.sensitive ?? null,
            is_essential: doc.is_essential === true,
            deleted: !!doc.deleted_at,
            issued: doc.issued ?? null,
            expires: doc.expires ?? null,
            issued_by: doc.issued_by ?? null,
            extra: doc.extra ?? {},
            filed_on: new Date().toISOString().slice(0, 10),
            owner_member_id: doc.owner_member_id ?? null,
            household_owned: doc.household_owned === true,
            updated_at: v?.uploaded_at ?? new Date().toISOString(),
            version: v
              ? {
                  id: v.version_id,
                  bytes: v.bytes ?? new Uint8Array(),
                  mime: v.mime,
                  filename: v.filename,
                }
              : null,
          };
        }),
      // An app's delete, as the owner chose (APP3): to the Trash, as a person's would.
      trash: (id) => {
        const doc = state.documents.find((x) => x.id === id);
        if (doc) doc.deleted_at = new Date().toISOString();
      },
      // What an app did, in the activity log (APP8): the app alone when it
      // acts as itself; the person it is about, by name.
      log: (l) => {
        const actor = l.actorMemberId
          ? state.members.find((m) => m.id === l.actorMemberId)
          : undefined;
        const about = l.object ? state.members.find((m) => m.id === l.object) : undefined;
        (state.activity ??= []).push({
          id: (state.activity?.length ?? 0) + 1,
          at: new Date().toISOString(),
          action: l.action,
          actor: actor?.display_name ?? null,
          actor_member_id: actor?.id ?? null,
          actor_label: null,
          object_type: 'member',
          object_id: l.object,
          object_title: about?.display_name ?? null,
          detail: l.detail,
        });
      },
      ok: (answer, status = 200, headers = {}) => respond(status, answer, headers),
      raw: (status, bytes, headers) => {
        const lower = Object.fromEntries(
          Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
        );
        return {
          ok: status >= 200 && status < 300,
          status,
          headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
          json: async () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
          text: async () => new TextDecoder().decode(bytes),
          arrayBuffer: async () => bytes.slice().buffer,
        };
      },
      fail,
      empty,
      next,
      timezone: () => state.timezone,
    });
    const appAnswer = await apps.app(url, init, (b) => partsOf(b, init.headers['content-type']));
    if (appAnswer) return appAnswer;
    // A connected app's link, opened by its user's browser (APP3).
    const linkAnswer = await apps.links(url, init);
    if (linkAnswer) return linkAnswer;
    const familyAppAnswer = await apps.family(path, init.method ?? 'GET', body);
    if (familyAppAnswer) return familyAppAnswer;
    const deviceAnswer = deviceRoutes(path, init, body, session);
    if (deviceAnswer) return deviceAnswer;
    const mailboxAnswer = mailboxRoutes(path, init, body, session);
    if (mailboxAnswer) return mailboxAnswer;
    const phoneAnswer = phoneRoutes(path, init, body, session);
    if (phoneAnswer) return phoneAnswer;
    // The AI reader set in Settings (AIR1): an owner reads it; nobody else.
    if (path === '/api/v1/household/reading/ai-reader' && (init.method ?? 'GET') === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      if (state.role !== 'owner') {
        return fail(403, 'forbidden', 'Only an owner can change how the vault reads papers.');
      }
      return ok(state.aiReader ?? fakeAiReaderView());
    }
    // "Also send sensitive papers" (AIR3): an owner's; on only with a cloud reader saved.
    if (path === '/api/v1/household/reading/ai-reader/send-sensitive' && init.method === 'PUT') {
      const s = session();
      if (!('id' in s)) return s;
      if (state.role !== 'owner') {
        return fail(403, 'forbidden', 'Only an owner can change how the vault reads papers.');
      }
      const on = body.send_sensitive === true;
      const view = state.aiReader ?? fakeAiReaderView();
      if (on && view.reader?.runs_at !== 'cloud') {
        return fail(
          409,
          'ai_reader_not_cloud',
          'Sensitive papers are held back only from a cloud AI reader, and the household has none.',
        );
      }
      state.aiReader = { ...view, send_sensitive: on };
      return ok(state.aiReader);
    }
    // Links outside the family, and one shown again to its maker (0.9.0).
    const shareAnswer = shareRoutes(path, init, body, session);
    if (shareAnswer) return shareAnswer;

    if (path === '/api/v1/capabilities') {
      const caps: Capabilities = {
        product: 'family-document-vault',
        server_version: FAKE_SERVER_VERSION,
        api_version: 1,
        min_client_version: '0.0.1',
        edition: 'self_hosted',
        protection_mode: 'standard',
        setup_required: state.setupRequired,
        features: {
          passkeys: true,
          private_mode: false,
          email_ingest: false,
          push: false,
          share_links: true,
          bulk_import: false,
          multi_household: false,
          idempotent_capture: true,
          capture_metadata: true,
          issued_by: true,
          page_previews: true,
          offline_essentials: true,
          // As the real vault (0.5.11): the household's own kinds of document.
          custom_types: true,
          // And collections of documents (0.5.12).
          collections: true,
          // Reminders from any date (0.5.15), said on since the web's
          // editor for them shipped (0.5.16), as the vault says.
          reminder_dates: true,
          // People's photos (0.5.19).
          member_photos: true,
          // A link's options (5.18): an end at a time, to view, so many opens.
          share_options: true,
          // A collection shared outside (5.19), as the vault says.
          collection_shares: true,
          // A password and one browser only (5.20); an emailed code only
          // with the operator's mail server, which a fake has none of.
          share_second_factor: true,
          share_email_code: false,
          // A link emailed to its recipient (0.9.0): with the operator's mail server alone.
          share_link_email: state.operatorMail,
          upload_request_email: state.operatorMail,
          // A person's details, and the owner's view of a sign-in (5.25).
          member_edit: true,
          // Asking somebody to send documents, and looking before filing (5.23).
          upload_requests: true,
          // People's identity details, and who sees them (5.26).
          member_identity: true,
          // Locking a sign-in, and sign-ins paused after a restore (5.28).
          member_admin: true,
          // Signing somebody out everywhere (5.30).
          sign_out_everywhere: true,
          // What a viewer can see, limited by an owner (5.33).
          access_restrictions: true,
          // Someone outside the family (5.34).
          guests: true,
          // What the pages propose for a document's empty fields (5.37).
          detail_suggestions: true,
          // GET /documents sorted by a column, filtered and paged (R2).
          document_table: true,
          // V1 (0.9.0): several values and days, on the list (the fake has no search).
          document_filters: true,
          tag_filters: true,
          notes_apart: true,
          batches: true,
          // Each item read and levelled (I2): the fake's are read as a test says.
          batch_proposals: true,
          batch_review: true,
          batch_learning: true,
          // An item's folder, and what its names suggest (0.8.0, S2).
          folder_suggestions: true,
          // A computer that sends scans (0.8.0, D1), as the vault says.
          device_uploads: true,
          // Detail tags, the label filter; rename, merge and delete (0.9.0, T1).
          tag_details: true,
          tag_management: true,
          // The Reading check (0.9.0, R0): an owner's, numbers only.
          reading_check: true,
          // A collection from a checklist (0.9.0, C1).
          collection_checklist: true,
          // Collection managers (0.9.0).
          collection_managers: true,
          // Notes kept on their own (0.9.0, N1).
          notes: true,
          // The family's time zone (0.9.0, TZ).
          household_timezone: true,
          no_longer_needed: true,
          // Text messages (0.9.0, SMS1): GET /sms/status says whether it is set up.
          sms_texts: true,
          // A link shown again to whoever made it (0.9.0): a document's, as the fake makes them.
          share_reveal: true,
          // Notifications by text (0.9.0, SMS2): in the preferences, each off.
          sms_notifications: true,
          // The household as a document's owner, and each kind's belongs_to (0.9.0).
          household_owner: true,
          // Sensitive, per kind and per document (0.9.0, AIR2).
          sensitive_documents: true,
          // Codes by text (0.9.0, SMS3): a link's, an invitation's, one's own.
          sms_codes: true,
          // The AI reader set in Settings (0.9.0, AIR1), and the kinds it reads with.
          ai_reader_settings: true,
          ai_reader_kinds: [...AI_READER_KINDS_OFFERED],
          ai_reader_send_sensitive: true,
          // Neutral wording, the household's and each person's (0.9.0, H2).
          neutral_wording: true,
          // What Sensitive protects (0.9.0, H1a): a sensitive document's link asks first.
          sensitive_protects: true,
          // My cabinet (0.9.0, C1), its dividers and pins (C2).
          cabinets: true,
          cabinet_dividers: true,
          cabinet_pins: true,
          caregivers: true,
          // An Idempotency-Key on POST /documents (0.9.0-dev.45), as the vault keeps it.
          idempotent_create: true,
          // Health's kinds and a yearly review (0.9.0, H3).
          health_kinds: true,
          // Emergency information, a wallet card and a clinician's link (0.9.0, H4).
          emergency_info: true,
          zip_download: true,
          // Links and requests changed, requests shown again (0.9.0, LK).
          link_changes: true,
          // Where the original is, as a place in a cabinet (0.9.0, C3).
          original_place: true,
          // Health records kept as they are; who opened a link, when (0.9.0, H5).
          record_formats: true,
          share_opens: true,
          // The folder a paper came from, and a cabinet drawn from them (0.9.0, C4).
          source_folders: true,
          // Ended links and requests removed after a while (0.9.0, RQ).
          ended_sharing: true,
          // One document's activity (0.9.0, DA).
          document_activity: true,
          // Connected apps (0.9.0, APP1).
          connected_apps: true,
          connected_app_reads: true,
          connected_app_links: true,
          connected_app_keys: true,
        },
        limits: {
          max_upload_bytes: 104_857_600,
          max_members: null,
          max_storage_bytes: null,
          share_max_days: 90,
          guest_max_days: GUEST_MAX_DAYS,
          // FDV_BACKUP_RETAIN_DAYS, as the compose file gives it (0.9.0, H5).
          backup_retain_days: 30,
        },
        deprecations: [],
        branding: { display_name: 'A fake family' },
        instance_id: FAKE_INSTANCE_ID,
        apps_public: false,
      };
      return ok(caps);
    }
    if (path === '/api/v1/setup' && init.method === 'POST') {
      if (!state.setupRequired) return fail(409, 'already_set_up', 'This vault is already set up.');
      state.setupRequired = false;
      state.householdName = typeof body.household_name === 'string' ? body.household_name : null;
      state.email = String(body.email).toLowerCase();
      state.password = String(body.password);
      return ok(open(init.headers['x-fdv-installation'] ?? null), 201);
    }
    if (path === '/api/v1/auth/password' && init.method === 'POST') {
      // The fake's own person, or somebody else with a sign-in (5.28).
      const email = String(body.email).toLowerCase();
      const other =
        email === state.email
          ? undefined
          : state.signIns.find((x) => x.email.toLowerCase() === email);
      const known = email === state.email || other !== undefined;
      if (!known || body.password !== (other ? other.password : state.password)) {
        return fail(401, 'invalid_credentials', "That email and password don't match.");
      }
      // Locked, or paused after a restore: said only now the password is right.
      const held = suspensionOf(other ? other.member_id : ME);
      if (held) return membershipSuspended(held, state.timezone);
      // A guest's sign-in past its end (5.34): said only now, with the day.
      const end = other ? guestEndOf(other.member_id) : null;
      if (end) {
        // With its reason, as the real vault says it.
        return respond(403, {
          error: {
            code: 'access_ended',
            message: guestAccessEndedWords(end, state.timezone),
            reason: 'access_ended',
            retriable: false,
            request_id: 'fake',
          },
        });
      }
      // A code by text as the second step (SMS3), for somebody who asked for
      // one: texted now, as the real vault does when it is the only one.
      const signer = other ? other.member_id : ME;
      const to = textCodeTo(signer, 'sign_in');
      if (to) {
        const mfaToken = next('mfa');
        (state.mfaWaiting ??= new Map()).set(mfaToken, {
          memberId: signer,
          installation: init.headers['x-fdv-installation'] ?? null,
        });
        sendTextCode(signer, 'sign_in');
        const challenge: MfaChallenge = {
          mfa_required: true,
          mfa_token: mfaToken,
          methods: ['text'],
          text_to: to,
          text_sent: true,
        };
        return ok(challenge);
      }
      return ok(open(init.headers['x-fdv-installation'] ?? null, other?.member_id));
    }
    if (path === '/api/v1/auth/mfa/text' && init.method === 'POST') {
      const waiting = state.mfaWaiting?.get(String(body.mfa_token));
      if (!waiting)
        return fail(401, 'mfa_expired', 'That sign-in attempt has expired. Start again.');
      if (!textCodeTo(waiting.memberId, 'sign_in')) return textNotOffered();
      return ok(sendTextCode(waiting.memberId, 'sign_in'));
    }
    if (path === '/api/v1/auth/mfa' && init.method === 'POST') {
      const token = String(body.mfa_token);
      const waiting = state.mfaWaiting?.get(token);
      if (!waiting)
        return fail(401, 'mfa_expired', 'That sign-in attempt has expired. Start again.');
      const refused = tryTextCode(waiting.memberId, 'sign_in', body.code);
      if (refused) return refused;
      state.mfaWaiting?.delete(token);
      return ok(open(waiting.installation, waiting.memberId === ME ? undefined : waiting.memberId));
    }
    // A reset link the fake never makes (SMS3's code for one): not valid.
    if (path === '/api/v1/password-resets/code' && init.method === 'POST') {
      return fail(
        404,
        'reset_not_valid',
        'That link is not valid any more. Ask for a new one from the sign-in page.',
      );
    }
    if (path === '/api/v1/auth/refresh' && init.method === 'POST') {
      const presented = String(body.refresh_token);
      const current = state.sessions.find((s) => s.refresh === presented);
      const replayed = state.sessions.find((s) => s.previous === presented);
      const installation = init.headers['x-fdv-installation'] ?? null;
      // A session already ended says why.
      if (replayed?.revoked) return ended(replayed.endedBecause ?? 'revoked');
      const touched = state.sessions.find((s) => !s.revoked && s.graceTokens?.includes(presented));
      if (touched) {
        touched.revoked = true;
        touched.endedBecause = 'reused';
        return ended('reused');
      }
      if (replayed) {
        // As the real vault (0.4.11): the token just replaced, once, within
        // 30 s, from the session's own installation — an answer lost on the
        // way. The token it displaces becomes the previous one.
        const grace =
          !replayed.graceUsed &&
          replayed.installation != null &&
          replayed.installation === installation &&
          Date.now() - (replayed.rotatedAt ?? 0) <= 30_000;
        if (grace) {
          // Locked, or paused after a restore (5.28): no new token.
          if (suspensionOf(whoOf(replayed).memberId)) return ended('suspended');
          replayed.graceTokens = [
            ...(replayed.graceTokens ?? []),
            presented,
            replayed.refresh,
          ].slice(-8);
          replayed.spent = [...(replayed.spent ?? []), replayed.refresh];
          replayed.previous = replayed.refresh;
          replayed.refresh = next('refresh');
          replayed.graceUsed = true;
          replayed.rotatedAt = Date.now();
          return ok(tokensFor(replayed));
        }
        // A spent token, presented again, is theft: the whole session goes.
        replayed.revoked = true;
        replayed.endedBecause = 'reused';
        return ended('reused');
      }
      // Token families (5.30): any token a session was given, presented
      // once it has been replaced, ends it — however many refreshes ago.
      const family = current ? undefined : state.sessions.find((s) => s.spent?.includes(presented));
      if (family) {
        if (family.revoked) return ended(family.endedBecause ?? 'revoked');
        family.revoked = true;
        family.endedBecause = 'reused';
        return ended('reused');
      }
      if (!current) return ended('revoked');
      if (current.revoked) return ended(current.endedBecause ?? 'revoked');
      if (suspensionOf(whoOf(current).memberId)) return ended('suspended');
      if (guestEndOf(whoOf(current).memberId)) return ended('access_ended');
      current.spent = [...(current.spent ?? []), current.refresh];
      current.previous = current.refresh;
      current.refresh = next('refresh');
      current.rotatedAt = Date.now();
      current.graceUsed = false;
      return ok(tokensFor(current));
    }
    if (path === '/api/v1/auth/logout' && init.method === 'POST') {
      const s = session();
      if (!('id' in s)) return s;
      s.revoked = true;
      return empty();
    }
    if (path === '/api/v1/me') {
      const s = session();
      if (!('id' in s)) return s;
      const who = whoOf(s);
      return ok({
        account_id: s.memberId === undefined ? 'fake-account' : `fake-account-${s.memberId}`,
        household_id: 'fake-household',
        member_id: who.memberId,
        role: who.role,
        totp_enabled: false,
        totp_required: true,
        // 5.29: an owner made a link to hand over for this sign-in.
        reset_notice: state.resetNotices.get(who.memberId) ?? null,
        handover_since: null,
        // 5.33: what an owner has limited this viewer to.
        restriction: who.role === 'viewer' ? myRestriction(who.memberId) : null,
        // 5.34: a guest, and when their sign-in ends.
        kind: state.members.find((m) => m.id === who.memberId)?.kind ?? 'family',
        access_expires_at:
          state.members.find((m) => m.id === who.memberId)?.access_expires_at ?? null,
      });
    }
    if (path === '/api/v1/me/reset-notice' && init.method === 'DELETE') {
      const s = session();
      if (!('id' in s)) return s;
      state.resetNotices.delete(whoOf(s).memberId);
      return empty();
    }
    /**
     * Who last changed a note, as the real vault names them (5.35): on the
     * activity log's terms — never to a viewer — and by the name the
     * household knows them by.
     */
    const editorName = (memberId: string) =>
      can(state.role, 'audit.read')
        ? (state.members.find((m) => m.id === memberId)?.display_name ?? null)
        : null;
    /**
     * Whether whoever asks sees where originals are kept (5.41): owners,
     * adults and teens, as the real vault answers them; anybody else null.
     */
    const locationShown = () => {
      const s = session();
      return 'id' in s && seesLocation(whoOf(s).role);
    };
    /** A document as the real vault answers it, with its status in words (0.5.7). */
    /**
     * A replacement as the reader sees it (0.9.0): one in the vault, out of
     * the Trash, that they may see — anything else is neither named nor given.
     */
    const replacement = (id: string) => {
      const s = session();
      const who = 'id' in s ? whoOf(s) : null;
      const d = state.documents.find((x) => x.id === id && !x.deleted_at);
      if (!d || !who) return null;
      const seen =
        (d.visibility ?? 'household') === 'household' ||
        (d.visibility === 'adults' && can(who.role, 'document.see_adults')) ||
        (d.visibility === 'private' && d.owner_member_id === who.memberId);
      return seen ? { id: d.id, title: d.title } : null;
    };
    /** Whoever asks, by member: a place's folder is named to its setter alone (C3). */
    const askerMember = () => {
      const s = session();
      return 'id' in s ? whoOf(s).memberId : null;
    };
    const viewOf = (doc: FakeDocument) =>
      documentView(doc, state.types, {
        role: state.role,
        editorName,
        location: locationShown(),
        memberId: askerMember(),
        replacement,
      });
    /** As a list answers it: an Only me document's notes and details stay sealed (0.5.8). */
    const listedOf = (doc: FakeDocument) =>
      documentView(doc, state.types, {
        listed: true,
        role: state.role,
        editorName,
        location: locationShown(),
        memberId: askerMember(),
        replacement,
      });
    /**
     * GET /documents sorted by a column (R2), as the real vault answers it
     * (apps/api/src/documents/table.ts): what the caller may see, filtered,
     * sorted with blanks last and then by id, a page at a time after the
     * last row's key, with `total` and each document's `collections` — and
     * a sort or filter by location refused to whoever may not see one.
     */
    const documentTable = (
      url: string,
      who: { memberId: string; role: Role },
      sort: DocumentSort,
    ) => {
      const location = param(url, 'location');
      // And its place in a cabinet (C3), as the vault: the same household's fact.
      const placeAsked = param(url, 'original_place')?.trim();
      // And the folder it came from (C4), exactly, whatever the case.
      const folderAsked = param(url, 'source_folder')?.trim();
      if (
        (sort === 'location' ||
          sort === 'original_place' ||
          location !== undefined ||
          placeAsked !== undefined ||
          folderAsked !== undefined) &&
        !maySortByLocation(who.role)
      ) {
        return fail(
          422,
          'validation_failed',
          LOCATION_SORT_REFUSAL,
          sort === 'location' || sort === 'original_place'
            ? 'sort'
            : location !== undefined
              ? 'location'
              : placeAsked !== undefined
                ? 'original_place'
                : 'source_folder',
        );
      }
      const direction = param(url, 'direction') ?? 'asc';
      if (direction !== 'asc' && direction !== 'desc') {
        return fail(422, 'validation_failed', 'A direction is asc or desc.', 'direction');
      }
      // Several values, comma-separated, any of them (V1, features.document_filters).
      const statuses = listParam(url, 'status');
      if (statuses?.some((v) => !(STATUS_ORDER as readonly string[]).includes(v))) {
        return fail(
          422,
          'validation_failed',
          'That is not a status a document can have.',
          'status',
        );
      }
      const v1 = v1Filters(url);
      if ('refused' in v1) return v1.refused;
      const limit = Number(param(url, 'limit') ?? 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > DOCUMENT_PAGE_MAX) {
        return fail(
          422,
          'validation_failed',
          `A page is 1 to ${DOCUMENT_PAGE_MAX} documents.`,
          'limit',
        );
      }
      const low = (v: string | null | undefined) => (v && v.trim() ? v.trim().toLowerCase() : null);
      const shownCollections = state.collections
        .filter((l) => !l.deleted && canSeeCollection(who, l))
        .sort((a, b) => (low(a.name) as string).localeCompare(low(b.name) as string));
      const inTrash = param(url, 'deleted') === 'true';
      const collectionsOf = (doc: FakeDocument) =>
        doc.deleted_at
          ? []
          : shownCollections
              .filter((l) => l.items.some((i) => i.document_id === doc.id))
              .map((l) => ({ id: l.id, name: l.name }));
      const members = listParam(url, 'member_id');
      const typeKeys = listParam(url, 'type_key');
      const categories = listParam(url, 'category');
      const apart = notesAndTags(url);
      const tagLabel = param(url, 'tag_label');
      const visibilities = listParam(url, 'visibility');
      const collectionId = param(url, 'collection_id');
      const by = param(url, 'issued_by');
      const asked = param(url, 'purge_requested');
      const rows = state.documents
        .filter((d) => Boolean(d.deleted_at) === inTrash)
        .filter((d) =>
          canSee(who, {
            visibility: d.visibility ?? 'household',
            owner_member_id: d.owner_member_id ?? null,
          }),
        )
        .filter((d) => asked === undefined || Boolean(d.purge_requested_at) === (asked === 'true'))
        .filter((d) => !by || d.issued_by?.toLowerCase() === by.trim().toLowerCase())
        .filter(
          (d) =>
            members === undefined ||
            members.some((m) =>
              // Not sure yet, the household's (0.9.0), or a person's.
              m === 'none'
                ? !d.owner_member_id && d.household_owned !== true
                : m === 'household'
                  ? d.household_owned === true
                  : d.owner_member_id === m,
            ),
        )
        .filter((d) => typeKeys === undefined || typeKeys.includes(d.type_key ?? ''))
        // Its own topic, else its kind's, as the vault keeps it (C1).
        .filter(
          (d) =>
            categories === undefined ||
            categories.includes(
              listedOf(d).category ?? state.types.find((t) => t.key === d.type_key)?.category ?? '',
            ),
        )
        // Tags whatever their case (several, any of them), notes left out,
        // and a detail tag's label (0.9.0, T1).
        .filter(apart)
        // Sensitive, all said (0.9.0, AIR2).
        .filter(sensitiveAsked(url, state.types))
        .filter(
          (d) =>
            tagLabel === undefined ||
            (d.tags ?? []).some((t) => {
              const detail = tagDetail(t);
              return detail !== null && tagLabelKey(detail.label) === tagLabelKey(tagLabel);
            }),
        )
        .filter(
          (d) => visibilities === undefined || visibilities.includes(d.visibility ?? 'household'),
        )
        .filter((d) => location === undefined || low(d.physical_location) === low(location))
        // The whole path, or its leading part, whatever the case (C3).
        .filter((d) => {
          if (placeAsked === undefined) return true;
          const line = d.original_place ? placeWords(d.original_place).toLowerCase() : null;
          const want = placeAsked.toLowerCase();
          return line !== null && (line === want || line.startsWith(want + PLACE_SEPARATOR));
        })
        .filter(
          (d) =>
            folderAsked === undefined ||
            (d.source_folder ?? null)?.toLowerCase() === folderAsked.toLowerCase(),
        )
        .filter((d) => v1.within(listedOf(d)))
        .filter((d) => {
          if (collectionId === undefined) return true;
          const ids = collectionsOf(d).map((c) => c.id);
          return collectionId === 'none' ? ids.length === 0 : ids.includes(collectionId);
        })
        .map((d) => {
          const view = listedOf(d);
          const issued = view.issued?.date ?? null;
          const expires = view.expires?.date ?? null;
          const name = state.members.find((m) => m.id === d.owner_member_id)?.display_name;
          const key: Array<string | number | null> =
            sort === 'title'
              ? [low(view.title)]
              : sort === 'kind'
                ? [low(state.types.find((t) => t.key === d.type_key)?.label)]
                : sort === 'person'
                  ? [low(name)]
                  : sort === 'issued'
                    ? [issued]
                    : sort === 'expires'
                      ? [expires]
                      : sort === 'status'
                        ? [statusRank(view.status.value), expires]
                        : sort === 'visibility'
                          ? [{ household: 0, adults: 1, private: 2 }[view.visibility]]
                          : sort === 'collections'
                            ? [low(collectionsOf(d)[0]?.name)]
                            : sort === 'dated'
                              ? // Issued, else added (C1); a fake document keeps no day it was added.
                                [
                                  issued ??
                                    (view.created_at ?? new Date().toISOString()).slice(0, 10),
                                ]
                              : sort === 'original_place'
                                ? [low(d.original_place ? placeWords(d.original_place) : null)]
                                : [low(d.physical_location)];
          return { view: { ...view, collections: collectionsOf(d) }, key, id: d.id };
        })
        .filter((r) => statuses === undefined || statuses.includes(r.view.status.value));
      const sign = direction === 'desc' ? -1 : 1;
      type Keyed = { key: Array<string | number | null>; id: string };
      const compare = (a: Keyed, b: Keyed) => {
        for (let i = 0; i < a.key.length; i++) {
          const [x, y] = [a.key[i] ?? null, b.key[i] ?? null];
          if (x === y) continue;
          if (x === null) return 1;
          if (y === null) return -1;
          return (x < y ? -1 : 1) * sign;
        }
        return a.id === b.id ? 0 : (a.id < b.id ? -1 : 1) * sign;
      };
      rows.sort(compare);
      let after = rows;
      const cursor = param(url, 'cursor');
      if (cursor !== undefined) {
        let at: { s?: unknown; d?: unknown; key?: unknown; id?: unknown };
        try {
          at = JSON.parse(decodeURIComponent(cursor)) as typeof at;
        } catch {
          return fail(422, 'validation_failed', 'That page cursor is not valid.');
        }
        if (
          at.s !== sort ||
          at.d !== direction ||
          typeof at.id !== 'string' ||
          !Array.isArray(at.key)
        ) {
          return fail(422, 'validation_failed', 'That page cursor is not valid.');
        }
        const from = { key: at.key as Array<string | number | null>, id: at.id };
        after = rows.filter((r) => compare(r, from) > 0);
      }
      const page = after.slice(0, limit);
      const last = page[page.length - 1];
      const more = after.length > limit;
      return ok({
        items: page.map((r) => r.view),
        next_cursor:
          more && last
            ? encodeURIComponent(
                JSON.stringify({ s: sort, d: direction, key: last.key, id: last.id }),
              )
            : null,
        has_more: more,
        total: rows.length,
      });
    };
    /** Its note's words changed (5.35): stamped by whoever is signed in, now. Else left alone. */
    const stampNotes = (doc: FakeDocument, before: string | null, memberId: string) => {
      if ((doc.notes ?? null) === before) return;
      doc.notes_updated_at = new Date().toISOString();
      doc.notes_updated_by = memberId;
    };
    /**
     * The details sent for a document, checked as the real vault checks
     * them (0.5.7): against the type it will have, merged into what it
     * holds, null taking a key away. A refusal names the key.
     */
    const detailsFor = (typeKey: string | null | undefined, sent: unknown, held = {}) => {
      const fields = state.types.find((t) => t.key === typeKey)?.fields ?? [];
      const checked = checkExtra((sent ?? {}) as Record<string, unknown>, fields, held);
      if ('problem' in checked) {
        return fail(422, 'invalid_extra', checked.problem.message, checked.problem.key);
      }
      const merged: Record<string, unknown> = { ...held };
      for (const key of checked.remove) delete merged[key];
      return Object.assign(merged, checked.set);
    };
    /** A capture's details for a kind the fake no longer has: each by the library's field, or left out. */
    const libraryDetails = (sent: Record<string, unknown>) => {
      const kept: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(sent)) {
        const lib = state.attributes.find((a) => a.key === key);
        if (!lib) continue;
        const checked = checkExtra({ [key]: value }, [
          { key, label: lib.label, kind: lib.kind, choices: lib.choices ?? [] },
        ]);
        if ('set' in checked) Object.assign(kept, checked.set);
      }
      return kept;
    };
    // The tags on what the caller can see, and a tag renamed, merged or
    // deleted on what they may change (0.9.0, T1), as the real vault does
    // (apps/api/src/documents/tags.ts).
    if (
      path === '/api/v1/tags' ||
      path === '/api/v1/tags/rename' ||
      path === '/api/v1/tags/delete'
    ) {
      const s = session();
      if (!('id' in s)) return s;
      return answerTags(state.documents, whoOf(s), path, url, init.method, body);
    }
    // Notes kept on their own (0.9.0, N1), as the real vault lists them:
    // the caller's, newest words first, each with its preview; nobody else's
    // Only me; `q` finds within their names and words.
    if (path === '/api/v1/notes' && (init.method ?? 'GET') === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      const me = whoOf(s).memberId;
      const inTrash = param(url, 'deleted') === 'true';
      const q = noteMatchWords(param(url, 'q'));
      const items = state.documents
        .filter((d) => d.type_key === NOTE_KIND && Boolean(d.deleted_at) === inTrash)
        .filter((d) => d.visibility !== 'private' || d.owner_member_id === me)
        .filter(
          (d) => !q || noteMatchWords(d.title).includes(q) || noteMatchWords(d.notes).includes(q),
        )
        .sort((a, b) => (b.notes_updated_at ?? '').localeCompare(a.notes_updated_at ?? ''))
        .map((d) => ({
          id: d.id,
          title: d.title,
          preview: notePreview(d.notes),
          visibility: d.visibility ?? 'household',
          owner_member_id: d.owner_member_id ?? null,
          tags: d.tags ?? [],
          updated_at: d.notes_updated_at ?? new Date(0).toISOString(),
          notes_updated_at: d.notes_updated_at ?? null,
          deleted_at: d.deleted_at ?? null,
        }));
      return ok({ items, truncated: false });
    }
    // My cabinet (0.9.0, C1), as the real vault keeps it: each person's own,
    // saved to the version last read; a folder's question checked as the
    // list checks it, and what it holds the table's own answer for them
    // (`documentTable`), so it never holds what they may not see.
    const alsoInAt = /^\/api\/v1\/documents\/([^/]+)\/also-in$/.exec(path);
    if (path === '/api/v1/cabinet' || path.startsWith('/api/v1/cabinet/') || alsoInAt) {
      const s = session();
      if (!('id' in s)) return s;
      const who = whoOf(s);
      const cabinets = (state.cabinets ??= {});
      const held: CabinetView = cabinets[who.memberId] ?? {
        layout: null,
        version: 0,
        updated_at: null,
      };
      /** Every document the table gives this person for a folder's question, or its refusal. */
      const tabled = async (
        filter: Record<string, unknown>,
      ): Promise<{ items: DocumentView[]; total: number } | ResponseLike> => {
        const items: DocumentView[] = [];
        let cursor: string | null = null;
        for (;;) {
          const q = [`sort=title`, `limit=${DOCUMENT_PAGE_MAX}`];
          for (const [k, v] of Object.entries(filter)) {
            for (const one of Array.isArray(v) ? v : [v]) {
              q.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(one))}`);
            }
          }
          if (cursor) q.push(`cursor=${encodeURIComponent(cursor)}`);
          const r = documentTable(`/api/v1/documents?${q.join('&')}`, who, 'title');
          if (!r.ok) return r;
          const page = (await r.json()) as DocumentPage;
          items.push(...page.items);
          if (!page.next_cursor) return { items, total: page.total ?? items.length };
          cursor = page.next_cursor;
        }
      };
      /** The folders shown, each with where it is. */
      const shown = (layout: CabinetLayout | null) =>
        (layout?.cabinets ?? [])
          .filter((c) => !c.hidden)
          .flatMap((c) =>
            c.drawers
              .filter((d) => !d.hidden)
              .flatMap((d) =>
                d.folders
                  .filter((f) => !f.hidden)
                  .map((f) => ({ f, path: [c.name, d.name, f.name] as [string, string, string] })),
              ),
          );
      // Pins (C2): this person's, those of papers they may still open, out of the Trash.
      const allPins = (state.cabinetPins ??= {});
      const pinsOf = () => (allPins[who.memberId] ??= []);
      const readable = (id: string) => {
        const doc = state.documents.find((d) => d.id === id);
        return doc &&
          canSee(who, {
            visibility: doc.visibility ?? 'household',
            owner_member_id: doc.owner_member_id ?? null,
          })
          ? doc
          : null;
      };
      const livePins = (folderId?: string) =>
        pinsOf()
          .filter((x) => folderId === undefined || x.folder_id === folderId)
          .filter((x) => {
            const doc = readable(x.document_id);
            return doc !== null && !doc.deleted_at;
          })
          .map((x) => x.document_id);
      /** The day a paper is about, as the dated filter reads it. */
      const datedOf = (d: DocumentView) =>
        (d.issued?.date ?? d.created_at ?? new Date().toISOString()).slice(0, 10);
      const newestFirst = (a: DocumentView, b: DocumentView) =>
        datedOf(b).localeCompare(datedOf(a)) || b.id.localeCompare(a.id);
      const folderAt =
        /^\/api\/v1\/cabinet\/folders\/([^/]+)(\/documents|\/pins|\/pins\/([^/]+))?$/.exec(path);
      const method = init.method ?? 'GET';
      if (path === '/api/v1/cabinet' && method === 'GET') return ok(held);
      if (path === '/api/v1/cabinet' && method === 'PUT') {
        const layout = body.layout as CabinetLayout | undefined;
        const version = body.version;
        if (
          typeof version !== 'number' ||
          !layout ||
          !Array.isArray(layout.cabinets) ||
          layout.cabinets.some(
            (c) => !Array.isArray(c.drawers) || c.drawers.some((d) => !Array.isArray(d.folders)),
          )
        ) {
          return fail(422, 'validation_failed', 'Please check the form.');
        }
        if (JSON.stringify(layout).length > CABINET_LIMITS.layout_bytes) {
          return fail(422, 'cabinet_too_big', CABINET_TOO_BIG);
        }
        const problem = layoutProblemOf(layout);
        if (problem !== null) return fail(422, problem.code, problem.message);
        for (const { f } of shown({
          ...layout,
          cabinets: layout.cabinets.map((c) => ({
            ...c,
            hidden: false,
            drawers: c.drawers.map((d) => ({
              ...d,
              hidden: false,
              folders: d.folders.map((x) => ({ ...x, hidden: false })),
            })),
          })),
        })) {
          const refuse = (message: string) =>
            fail(422, 'validation_failed', `The folder “${f.name}”: ${message}`, `folder ${f.id}`);
          const filter = (f.filter ?? {}) as Record<string, unknown>;
          if (JSON.stringify(filter).length > CABINET_LIMITS.filter_bytes) {
            return refuse('it asks for too much at once.');
          }
          const unknown = Object.keys(filter).filter(
            (k) => !(CABINET_FILTER_KEYS as readonly string[]).includes(k),
          );
          if (unknown.length > 0) return refuse(`Unrecognized key(s): ${unknown.join(', ')}`);
          const got = await tabled(filter);
          if ('status' in got)
            return refuse(((await got.json()) as { error: { message: string } }).error.message);
        }
        // A new name holds no " › " (C3): a name kept from before may.
        const nodes = (l: CabinetLayout | null) =>
          (l?.cabinets ?? []).flatMap((c) => [c, ...c.drawers.flatMap((d) => [d, ...d.folders])]);
        const had = new Map(nodes(held.layout).map((n) => [n.id, n.name.trim()]));
        const joined = nodes(layout).find(
          (n) => n.name.trim().includes(PLACE_SEPARATOR) && had.get(n.id) !== n.name.trim(),
        );
        if (joined) {
          return fail(
            422,
            'validation_failed',
            `“${joined.name.trim()}”: ${NAME_HOLDS_SEPARATOR}`,
            `node ${joined.id}: name`,
          );
        }
        if (held.version !== version) return fail(409, 'conflict', CABINET_CHANGED);
        // Pins (C2): those of a folder merged moved with it; those of a folder gone, let go.
        const folderIds = new Set(
          layout.cabinets.flatMap((c) => c.drawers.flatMap((d) => d.folders.map((f) => f.id))),
        );
        // Only a folder the layout no longer has moves: one it keeps would be copied.
        const pins = pinsOf().map((x) => ({ ...x }));
        for (const m of (body.pins_moved as PinsMoved[] | undefined) ?? []) {
          if (folderIds.has(m.from)) continue;
          for (const x of pins.filter((y) => y.folder_id === m.from)) {
            if (!pins.some((y) => y.folder_id === m.to && y.document_id === x.document_id)) {
              pins.push({ ...x, folder_id: m.to });
            }
          }
        }
        const kept = pins.filter((x) => folderIds.has(x.folder_id));
        // The caps, as the vault counts them: only pins of papers still seen, out of the Trash.
        const live = kept.filter((x) => {
          const doc = readable(x.document_id);
          return doc !== null && !doc.deleted_at;
        });
        const perFolder = new Map<string, number>();
        for (const x of live) perFolder.set(x.folder_id, (perFolder.get(x.folder_id) ?? 0) + 1);
        if (
          Math.max(0, ...perFolder.values()) > PIN_LIMITS.folder ||
          live.length > PIN_LIMITS.total
        ) {
          return fail(422, 'cabinet_too_many_pins', TOO_MANY_PINS);
        }
        allPins[who.memberId] = kept;
        const saved: CabinetView = {
          layout,
          version: held.version + 1,
          updated_at: new Date().toISOString(),
        };
        cabinets[who.memberId] = saved;
        // Where originals are, in its folders (C3), as the vault: the names
        // follow a rename; a folder gone lets its reference go, names kept.
        // Only a shown folder is followed: a hidden one is let go (the C3 review).
        const paths = new Map(
          shown(layout).map(({ f, path }) => [
            f.id,
            path.map((n) => n.trim()) as [string, string, string],
          ]),
        );
        // Nobody who no longer sees where originals are kept writes any.
        for (const doc of seesLocation(who.role) ? state.documents : []) {
          const place = doc.original_place;
          if (!place || place.by !== who.memberId || place.folder_id === null) continue;
          // Somebody else's Only me paper is not written by them.
          if (doc.visibility === 'private' && doc.owner_member_id !== who.memberId) continue;
          const path = paths.get(place.folder_id);
          doc.original_place = path
            ? { ...place, path }
            : { path: place.path, by: null, folder_id: null };
        }
        return ok(saved);
      }
      if (path === '/api/v1/cabinet/preview' && method === 'POST') {
        const by = body.arrange_by as (typeof ARRANGE_BY)[number];
        if (!(ARRANGE_BY as readonly string[]).includes(by)) {
          return fail(422, 'validation_failed', 'That is not a way to arrange a cabinet.');
        }
        const all = await tabled({ notes: 'exclude' });
        if ('status' in all) return all;
        const groups = new Map<string, CabinetGroup>();
        for (const d of all.items) {
          const person =
            d.household_owned === true ? HOUSEHOLD_MEMBER_FILTER : (d.owner_member_id ?? 'none');
          // As the dated filter reads it: a fake document keeps no day it was added.
          const year = Number(
            (d.issued?.date ?? d.created_at ?? new Date().toISOString()).slice(0, 4),
          );
          // Its own topic, else its kind's, as the vault keeps it.
          const category =
            d.category ?? state.types.find((t) => t.key === d.type_key)?.category ?? null;
          const key = JSON.stringify([person, category, d.type_key, year]);
          const g = groups.get(key);
          if (g) g.n += 1;
          else groups.set(key, { person, category, type_key: d.type_key, year, n: 1 });
        }
        const short = shortName(state.members);
        const rank = (id: string) =>
          id === who.memberId ? 0 : id === HOUSEHOLD_MEMBER_FILTER ? 2 : id === 'none' ? 3 : 1;
        let n = 0;
        const drawn = drawCabinet(
          by,
          [...groups.values()],
          {
            person: (id) =>
              id === HOUSEHOLD_MEMBER_FILTER
                ? THE_HOUSEHOLD
                : id === 'none'
                  ? NOT_SURE_YET
                  : (short.get(id) ?? 'Someone in the family'),
            kind: (key) => state.types.find((t) => t.key === key)?.label ?? 'Another kind',
            personOrder: (a, b) => rank(a) - rank(b) || a.localeCompare(b),
          },
          () => `fake-node-${++n}`,
        );
        const drawnProblem = layoutProblemOf(drawn.layout);
        if (drawnProblem !== null) return fail(422, drawnProblem.code, drawnProblem.message);
        return ok(drawn);
      }
      // Bring your tree (0.9.0, C4): the folders the caller's own papers came
      // from, drawn into their cabinet beside what is there, not saved.
      if (path === '/api/v1/cabinet/from-folders' && method === 'GET') {
        if (!maySortByLocation(who.role)) {
          return fail(403, 'forbidden', LOCATION_SORT_REFUSAL, 'source_folder');
        }
        const all = await tabled({ notes: 'exclude' });
        if ('status' in all) return all;
        const byPath = new Map<string, { path: string; documents: number; mine: boolean }>();
        for (const d of all.items) {
          const doc = state.documents.find((x) => x.id === d.id);
          const folder = doc?.source_folder;
          if (!doc || !folder) continue;
          const key = folder.toLowerCase();
          const was = byPath.get(key) ?? { path: folder, documents: 0, mine: false };
          was.documents += 1;
          if (folder < was.path) was.path = folder;
          if (doc.filed_by === who.memberId) was.mine = true;
          byPath.set(key, was);
        }
        const folders = [...byPath.values()]
          .filter((f) => f.mine)
          .map(({ path: p, documents }) => ({ path: p, documents }))
          .sort((a, b) => compareFolders(a.path, b.path));
        // Ids of their own, never one the cabinet has already.
        const drawn = addFolderTree(held.layout, folders, () => next('fake-tree'));
        const out: CabinetFromFolders = { version: held.version, folders, ...drawn };
        return ok(out);
      }
      if (path === '/api/v1/cabinet/counts' && method === 'GET') {
        const counts: Record<string, number | null> = {};
        for (const { f } of shown(held.layout)) {
          const got = await tabled(f.filter);
          const pinned = livePins(f.id);
          counts[f.id] =
            'status' in got
              ? null
              : got.items.filter((d) => !pinned.includes(d.id)).length + pinned.length;
        }
        const pinCounts: Record<string, number> = {};
        for (const x of pinsOf()) {
          const doc = readable(x.document_id);
          if (doc && !doc.deleted_at) pinCounts[x.folder_id] = (pinCounts[x.folder_id] ?? 0) + 1;
        }
        // Folders papers came from that the cabinet has none for yet (C4).
        let fresh: { new_folders?: boolean } = {};
        if (maySortByLocation(who.role)) {
          const asked = new Set(askedFolders(held.layout).map((x) => x.toLowerCase()));
          const all = await tabled({ notes: 'exclude' });
          fresh = {
            new_folders:
              !('status' in all) &&
              all.items.some((d) => {
                const doc = state.documents.find((x) => x.id === d.id);
                return (
                  doc?.filed_by === who.memberId &&
                  !!doc.source_folder &&
                  !asked.has(doc.source_folder.toLowerCase())
                );
              }),
          };
        }
        return ok({ version: held.version, counts, pins: pinCounts, ...fresh });
      }
      if (alsoInAt && method === 'GET') {
        const id = decodeURIComponent(alsoInAt[1] as string);
        const doc = state.documents.find((d) => d.id === id);
        if (
          !doc ||
          !canSee(who, {
            visibility: doc.visibility ?? 'household',
            owner_member_id: doc.owner_member_id ?? null,
          })
        ) {
          return fail(404, 'not_found', 'That document does not exist.');
        }
        const items: Array<{
          id: string;
          name: string;
          path: [string, string, string];
          pinned?: boolean;
        }> = [];
        for (const { f, path: where } of shown(held.layout)) {
          const got = await tabled(f.filter);
          const pinned = livePins(f.id).includes(id);
          if (pinned || (!('status' in got) && got.items.some((d) => d.id === id))) {
            items.push({
              id: f.id,
              name: f.name,
              path: where,
              ...(pinned ? { pinned: true } : {}),
            });
          }
        }
        return ok({ items });
      }
      // A folder opened, a divider's papers, and pins (0.9.0, C2).
      if (folderAt) {
        const folderId = decodeURIComponent(folderAt[1] as string);
        const placed = shown(held.layout).find(({ f }) => f.id === folderId);
        if (folderAt[2] === '/pins' && method === 'POST') {
          // A shown folder of theirs: a hidden one is not taken, as the vault refuses it.
          if (!placed) return fail(404, 'not_found', 'That folder does not exist.');
          const ids = [...new Set((body.document_ids as string[] | undefined) ?? [])];
          const docs = ids.map(readable);
          if (ids.length === 0 || docs.some((d) => d === null)) {
            return fail(404, 'not_found', 'That document does not exist.');
          }
          if (docs.some((d) => d?.deleted_at)) {
            return fail(422, 'cabinet_pin_in_trash', PIN_IN_TRASH);
          }
          // Room first, from pins of papers they may no longer open, as the vault makes it.
          allPins[who.memberId] = pinsOf().filter((x) => readable(x.document_id) !== null);
          const pins = pinsOf();
          const added = ids.filter(
            (id) => !pins.some((x) => x.folder_id === folderId && x.document_id === id),
          );
          if (
            pins.filter((x) => x.folder_id === folderId).length + added.length >
              PIN_LIMITS.folder ||
            pins.length + added.length > PIN_LIMITS.total
          ) {
            return fail(422, 'cabinet_too_many_pins', TOO_MANY_PINS);
          }
          const now = new Date().toISOString();
          for (const id of added)
            pins.push({ folder_id: folderId, document_id: id, pinned_at: now });
          return ok({ pinned: ids.length });
        }
        if (folderAt[3] !== undefined && method === 'DELETE') {
          // Their own row taken away, whatever the paper: 204 for any id.
          const documentId = decodeURIComponent(folderAt[3]);
          allPins[who.memberId] = pinsOf().filter(
            (x) => !(x.folder_id === folderId && x.document_id === documentId),
          );
          return empty();
        }
        if (!placed) return fail(404, 'not_found', 'That folder does not exist.');
        const f = placed.f;
        const got = await tabled(f.filter);
        const pinnedIds = livePins(folderId);
        const rest = 'status' in got ? [] : got.items.filter((d) => !pinnedIds.includes(d.id));
        const byKey = new Map<string, DocumentView[]>();
        for (const d of rest) {
          const key = dividerKeyOf(f.dividers, datedOf(d));
          byKey.set(key, [...(byKey.get(key) ?? []), d]);
        }
        if (folderAt[2] === '/documents' && method === 'GET') {
          const q = { get: (name: string) => param(url, name) ?? null };
          const divider = q.get('divider') ?? '';
          const mode = dividerMode(f.dividers);
          const known =
            (mode === 'none' && divider === 'all') ||
            (mode === 'years' && (divider === 'other' || /^year:[1-9]\d{3}$/.test(divider))) ||
            (mode === 'ranges' &&
              (divider === 'other' ||
                rangesNewestFirst(f.dividers).some((r) => r.key === divider)));
          if ('status' in got || !known)
            return fail(404, 'not_found', 'That divider does not exist.');
          const items = [...(byKey.get(divider) ?? [])].sort(newestFirst);
          const limit = Number(q.get('limit') ?? 50);
          const start = Number(q.get('cursor') ?? 0);
          const page = items.slice(start, start + limit);
          const more = start + limit < items.length;
          return ok({
            items: page,
            total: items.length,
            has_more: more,
            next_cursor: more ? String(start + limit) : null,
          } satisfies DocumentPage);
        }
        if (method === 'GET' && folderAt[2] === undefined) {
          const everything = await tabled({});
          const pinned =
            'status' in everything ? [] : everything.items.filter((d) => pinnedIds.includes(d.id));
          const count = (key: string) => byKey.get(key)?.length ?? 0;
          const other: FolderDivider[] =
            count('other') > 0
              ? [
                  {
                    key: 'other',
                    kind: 'other',
                    name: OTHER_YEARS,
                    from: null,
                    to: null,
                    count: count('other'),
                  },
                ]
              : [];
          let dividers: FolderDivider[];
          switch (dividerMode(f.dividers)) {
            case 'none':
              dividers = [
                { key: 'all', kind: 'all', name: '', from: null, to: null, count: count('all') },
              ];
              break;
            case 'years':
              dividers = [
                ...[...byKey.keys()]
                  .filter((key) => key !== 'other')
                  .sort()
                  .reverse()
                  .map((key): FolderDivider => {
                    const y = key.slice(5);
                    return {
                      key,
                      kind: 'year',
                      name: y,
                      from: `${y}-01-01`,
                      to: `${y}-12-31`,
                      count: count(key),
                    };
                  }),
                ...other,
              ];
              break;
            case 'ranges':
              dividers = [
                ...rangesNewestFirst(f.dividers).map(({ key, range }) => ({
                  key,
                  kind: 'range' as const,
                  name: range.name,
                  from: range.from,
                  to: range.to,
                  count: count(key),
                })),
                ...other,
              ];
              break;
          }
          return ok({
            folder_id: folderId,
            version: held.version,
            total: 'status' in got ? null : pinned.length + rest.length,
            pinned: pinned.sort(newestFirst),
            // A question the list would now refuse: its pins, and no dividers, as the vault says.
            dividers: 'status' in got ? [] : dividers,
          });
        }
      }
    }
    if (path === '/api/v1/documents') {
      const s = session();
      if (!('id' in s)) return s;
      if (init.method === 'POST') {
        // An Idempotency-Key (0.9.0-dev.45), as the vault keeps it: the
        // caller's own for 24 hours; the same body again is answered with
        // what the first made, as it is now; another body is refused.
        // Its form first, before the body is read, as the vault checks it.
        const sentKey = init.headers['idempotency-key'];
        let createKey: { at: string; body: string } | null = null;
        if (sentKey !== undefined) {
          if (!/^[ -~]{1,255}$/.test(sentKey) || sentKey.trim() === '') {
            return fail(
              400,
              'invalid_idempotency_key',
              'An Idempotency-Key is 1 to 255 printable ASCII characters, sent once; a UUID is usual.',
              'idempotency-key',
            );
          }
          // Whose it is, as the vault scopes it: household, account, person, key.
          const who = whoOf(s);
          const account =
            s.memberId === undefined ? `account:${state.email ?? ''}` : `account:${s.memberId}`;
          createKey = {
            at: `fake-household|${account}|${who.memberId}|${sentKey}`,
            body: canonicalJson(body),
          };
        }
        const clock = state.now ?? Date.now;
        // A role that may not add documents is refused first, as the vault's
        // canWrite does: before any key is claimed or answered.
        if (!can(whoOf(s).role, 'document.edit')) {
          return fail(403, 'forbidden', refusalFor('document.edit'));
        }
        const type_key = (body.type_key as string | null | undefined) ?? null;
        if (type_key !== null && !state.types.some((t) => t.key === type_key)) {
          return fail(422, 'validation_failed', 'That kind of document is not on the list.');
        }
        const extra = detailsFor(type_key, body.extra);
        if (isResponse(extra)) return extra;
        const tagProblem = tagsProblem((body.tags as string[] | undefined) ?? []);
        if (tagProblem) return fail(422, 'validation_failed', tagProblem, 'tags');
        // As the real vault: the type's default, when nothing is asked for,
        // and Only me — asked for or the default — only for your own (0.5.10).
        const visibility =
          (body.visibility as Visibility | undefined) ??
          state.types.find((t) => t.key === type_key)?.default_visibility;
        if (body.household_owned === true && body.owner_member_id != null) {
          return fail(422, 'validation_failed', HOUSEHOLD_OR_PERSON, 'household_owned');
        }
        // Whose it is, as the real vault decides it (0.9.0): the household's
        // for a kind usually the household's when nobody is said.
        const whose = whoseNew(
          body,
          state.types.find((t) => t.key === type_key),
        );
        const owner = whose.owner_member_id;
        // A teen may make a paper sensitive, never not (0.9.0, AIR2).
        if (whoOf(s).role === 'teen' && body.sensitive === false) {
          return fail(403, 'forbidden', TEEN_KEEPS_SENSITIVE, 'sensitive');
        }
        if (visibility === 'private' && owner !== 'fake-member') {
          return fail(
            422,
            'validation_failed',
            body.visibility === 'private' ? PRIVATE_TO_THEM : PRIVATE_BY_DEFAULT,
            'visibility',
          );
        }
        // Only now, the body read and found good, is the key claimed: a
        // refused create keeps none (0.9.0-dev.45), as the vault's.
        if (createKey) {
          const prior = state.createKeys?.get(createKey.at);
          if (prior && clock() - prior.at < CREATE_KEY_MS) {
            if (prior.body !== createKey.body) {
              return fail(
                422,
                'idempotency_key_reused',
                'That Idempotency-Key was already used for a different request. Send a new key with a new request.',
              );
            }
            const made = state.documents.find((d) => d.id === prior.document_id);
            const replayed = { 'idempotent-replayed': 'true' };
            if (!made) {
              const gone = fail(
                404,
                'created_not_visible',
                'What this Idempotency-Key made is no longer there for you.',
              );
              return respond(gone.status, await gone.json(), replayed);
            }
            return respond(201, viewOf(made), replayed);
          }
        }
        const doc: FakeDocument = {
          id: next('document'),
          title: (body.title as string | null) ?? null,
          type_key,
          ...whose,
          ...ownSensitive(body),
          identifier: tidy(body.identifier as string | null | undefined),
          issued_by: tidy(body.issued_by as string | null | undefined),
          issued: (body.issued as DateValue | null | undefined) ?? null,
          expires: (body.expires as DateValue | null | undefined) ?? null,
          physical_location: note(body.physical_location as string | null | undefined),
          tags: tagsOf(body.tags as string[] | undefined),
          notes: note(body.notes as string | null | undefined),
          ...(visibility !== undefined ? { visibility } : {}),
          extra,
        };
        stampNotes(doc, null, whoOf(s).memberId);
        state.documents.push(doc);
        const actor = state.members.find((m) => m.id === whoOf(s).memberId);
        (state.activity ??= []).push({
          id: (state.activity?.length ?? 0) + 1,
          at: new Date().toISOString(),
          action: 'document.created',
          actor: actor?.display_name ?? null,
          actor_member_id: actor?.id ?? null,
          actor_label: null,
          object_type: 'document',
          object_id: doc.id,
          object_title: doc.title ?? null,
          // Its line says "a sensitive document" (0.9.0, H1a), as the vault's.
          ...(sensitiveOf(doc, state.types.find((t) => t.key === doc.type_key) ?? null)
            ? { object_sensitive: true }
            : {}),
          detail: {},
        });
        if (createKey) {
          (state.createKeys ??= new Map()).set(createKey.at, {
            body: createKey.body,
            document_id: doc.id,
            at: clock(),
          });
        }
        return ok(viewOf(doc), 201);
      }
      // Sorted by a column (R2): the Documents table, as the real vault pages it.
      const sort = param(url, 'sort');
      if (isDocumentSort(sort)) return documentTable(url, whoOf(s), sort);
      if (sort !== undefined && !(OLDER_DOCUMENT_SORTS as readonly string[]).includes(sort)) {
        return fail(422, 'validation_failed', 'That is not a way to sort documents.', 'sort');
      }
      // What the table adds goes with a column sort: refused with any other.
      const tableOnly = [
        ...['direction', 'collection_id', 'location', 'original_place', 'source_folder'].filter(
          (k) => param(url, k) !== undefined,
        ),
        ...(param(url, 'member_id') === 'none' ? ['member_id=none'] : []),
      ];
      if (tableOnly.length > 0) {
        return fail(
          422,
          'validation_failed',
          'That goes with a sort by a column: title, kind, person, issued, expires, status, visibility, collections or location.',
          tableOnly.join(', '),
        );
      }
      // As the real vault: ?issued_by= filters, whatever the case.
      const by = param(url, 'issued_by');
      // The Trash is its own list (5.1), and an owner's requests to remove
      // for good are asked for by themselves (5.24).
      const inTrash = param(url, 'deleted') === 'true';
      const asked = param(url, 'purge_requested');
      const items = state.documents
        .filter((d) => Boolean(d.deleted_at) === inTrash)
        .filter((d) => asked === undefined || Boolean(d.purge_requested_at) === (asked === 'true'))
        .filter((d) => !by || d.issued_by?.toLowerCase() === by.trim().toLowerCase());
      // ?status= as the real vault filters it: by the status each one says;
      // several (V1), any of them.
      const statuses = listParam(url, 'status');
      const older = v1Filters(url);
      if ('refused' in older) return older.refused;
      const several = (name: string) => {
        const v = listParam(url, name);
        return v && v.length > 1 ? v : undefined;
      };
      const members = several('member_id');
      const typeKeys = several('type_key');
      const listed = items
        .filter(notesAndTags(url))
        .filter(sensitiveAsked(url, state.types))
        .filter((d) => members === undefined || members.includes(d.owner_member_id ?? ''))
        .filter((d) => typeKeys === undefined || typeKeys.includes(d.type_key ?? ''))
        .map(listedOf)
        .filter((d) => older.within(d))
        .filter((d) => !statuses || statuses.includes(d.status.value));
      return ok({ items: listed, next_cursor: null, has_more: false });
    }
    // No longer needed, and needed again (0.9.0), as the real vault keeps it:
    // for whoever may change it, replaced by one they can see, its reminders
    // resolved as it is marked.
    const unneededAt = /^\/api\/v1\/documents\/([^/]+)\/no-longer-needed$/.exec(path);
    if (unneededAt && (init.method === 'POST' || init.method === 'DELETE')) {
      const s = session();
      if (!('id' in s)) return s;
      const who = whoOf(s);
      if (!can(who.role, 'document.edit')) {
        return fail(403, 'forbidden', refusalFor('document.edit'));
      }
      const doc = state.documents.find(
        (d) => d.id === decodeURIComponent(unneededAt[1] as string) && !d.deleted_at,
      );
      if (!doc) return fail(404, 'not_found', 'That document is not in the vault.');
      if (who.role === 'teen' && doc.owner_member_id !== who.memberId) {
        return fail(403, 'forbidden', 'You can only change your own documents.');
      }
      if (init.method === 'DELETE') {
        doc.no_longer_needed = null;
        doc.revision = (doc.revision ?? 1) + 1;
        return ok(viewOf(doc));
      }
      const asked = body as { reason?: string | null; replaced_by?: string | null };
      // Left out, kept as it is; null takes it away (the review, M1).
      const reason =
        asked.reason === undefined
          ? (doc.no_longer_needed?.reason ?? null)
          : asked.reason?.trim()
            ? asked.reason.trim()
            : null;
      if (reason !== null && [...reason].length > NO_LONGER_NEEDED_REASON_MAX) {
        return fail(
          422,
          'validation_failed',
          `Keep why to ${NO_LONGER_NEEDED_REASON_MAX} characters.`,
          'reason',
        );
      }
      const replacedBy =
        asked.replaced_by === undefined
          ? (doc.no_longer_needed?.replaced_by ?? null)
          : asked.replaced_by;
      if (replacedBy !== null && asked.replaced_by !== undefined) {
        if (!replacement(replacedBy)) {
          return fail(
            422,
            'validation_failed',
            'That document is not in the vault.',
            'replaced_by',
          );
        }
        if (replacedBy === doc.id) {
          return fail(422, 'validation_failed', 'A document cannot replace itself.', 'replaced_by');
        }
      }
      doc.no_longer_needed = {
        at: doc.no_longer_needed?.at ?? new Date().toISOString(),
        by: doc.no_longer_needed?.by ?? who.memberId,
        reason,
        replaced_by: replacedBy,
      };
      doc.revision = (doc.revision ?? 1) + 1;
      for (const r of state.reminders) {
        if (r.document_id === doc.id && ['scheduled', 'due', 'snoozed'].includes(r.status)) {
          r.status = 'resolved';
        }
      }
      return ok(viewOf(doc));
    }
    // Into the Trash, out of it, and out of the vault for good (5.1, 5.24),
    // as the real vault keeps them.
    const trashAt = /^\/api\/v1\/documents\/([^/]+)(\/restore|\/purge)?$/.exec(path);
    if (
      trashAt &&
      ((trashAt[2] === undefined && init.method === 'DELETE') ||
        (trashAt[2] !== undefined && init.method === 'POST'))
    ) {
      const s = session();
      if (!('id' in s)) return s;
      const doc = state.documents.find((d) => d.id === decodeURIComponent(trashAt[1] as string));
      if (!doc) return fail(404, 'not_found', 'That document is not in the vault.');
      if (trashAt[2] === undefined) {
        doc.deleted_at ??= new Date().toISOString();
        return empty();
      }
      if (trashAt[2] === '/restore') {
        doc.deleted_at = null;
        doc.purge_requested_at = null;
        return ok(viewOf(doc));
      }
      if (!can(state.role, 'document.purge')) {
        return fail(403, 'forbidden', refusalFor('document.purge'));
      }
      if (!doc.deleted_at) {
        return fail(
          409,
          'not_in_trash',
          'Only a document in the Trash can be removed for good. Move it to the Trash first.',
        );
      }
      // At once only what they filed: one filed by somebody else, still here,
      // is asked about first even when it is theirs (the 5.24 review, M524-1).
      const theirs = doc.filedBySomeoneElse !== true;
      if (!theirs && !doc.purge_requested_at) {
        doc.purge_requested_at = new Date().toISOString();
        return ok(listedOf(doc), 202);
      }
      const from = Date.parse(doc.purge_requested_at ?? '') + PURGE_NOTICE_HOURS * 3_600_000;
      if (!theirs && Date.now() < from) {
        return fail(
          409,
          'purge_not_yet',
          'Whoever filed it has been told, and can bring it back until then.',
          new Date(from).toISOString(),
        );
      }
      state.documents = state.documents.filter((d) => d !== doc);
      return empty();
    }
    // Where the originals of many are (0.9.0, C3), as the real vault: one
    // folder of the caller's cabinet, or none; every one theirs to see, out
    // of the Trash, else nothing changes (404); a teen's not their own left
    // as it is and named.
    if (path === '/api/v1/documents/original-place' && init.method === 'POST') {
      const s = session();
      if (!('id' in s)) return s;
      const who = whoOf(s);
      if (!can(who.role, 'document.edit')) {
        return fail(403, 'forbidden', refusalFor('document.edit'));
      }
      if (!seesLocation(who.role)) {
        return fail(403, 'forbidden', LOCATION_SORT_REFUSAL, 'original_place');
      }
      const ids = body.document_ids;
      const folderId = body.folder_id;
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.length > ORIGINAL_PLACE_MOST ||
        (folderId !== null && typeof folderId !== 'string')
      ) {
        return fail(422, 'validation_failed', 'Please check the form.');
      }
      const place = folderId === null ? null : fakePlaceOf(state, who.memberId, folderId);
      if (place === undefined) {
        return fail(422, 'validation_failed', PLACE_NOT_IN_CABINET, 'original_place');
      }
      const docs = [...new Set(ids as string[])].map((id) =>
        state.documents.find(
          (d) =>
            d.id === id &&
            !d.deleted_at &&
            canSee(who, {
              visibility: d.visibility ?? 'household',
              owner_member_id: d.owner_member_id ?? null,
            }),
        ),
      );
      if (docs.some((d) => d === undefined)) {
        return fail(404, 'not_found', 'That document is not in the vault.');
      }
      const out: OriginalPlaceBulkResult = { changed: [], unchanged: [], not_yours: [] };
      for (const d of docs as FakeDocument[]) {
        if (who.role === 'teen' && d.owner_member_id !== who.memberId) out.not_yours.push(d.id);
        else if (JSON.stringify(d.original_place ?? null) === JSON.stringify(place)) {
          out.unchanged.push(d.id);
        } else {
          d.original_place = place;
          d.revision = (d.revision ?? 1) + 1;
          out.changed.push(d.id);
        }
      }
      return ok(out);
    }
    // One document, and an edit to it: the details merged, as the real
    // vault merges them (0.5.7), so a client never wipes what it did not show.
    const one = /^\/api\/v1\/documents\/([^/]+)$/.exec(path);
    if (one && (init.method === 'GET' || init.method === 'PATCH')) {
      const s = session();
      if (!('id' in s)) return s;
      // One in the Trash is not there for this, as in the real vault (5.1).
      const doc = state.documents.find(
        (d) => d.id === decodeURIComponent(one[1] as string) && !d.deleted_at,
      );
      if (!doc) return fail(404, 'not_found', 'That document is not in the vault.');
      if (init.method === 'GET') return ok(viewOf(doc));
      // As the real vault: a viewer (a guest among them) changes nothing,
      // and a teen only their own (5.35's notes, as every edit).
      const editor = whoOf(s);
      if (!can(editor.role, 'document.edit')) {
        return fail(403, 'forbidden', refusalFor('document.edit'));
      }
      if (editor.role === 'teen' && doc.owner_member_id !== editor.memberId) {
        return fail(403, 'forbidden', 'You can only change your own documents.');
      }
      // As the real vault: an edit made to a version somebody has since
      // changed is refused, not laid over theirs.
      const ifMatch = init.headers['if-match'];
      if (ifMatch && ifMatch !== etagOf(doc)) {
        // With the document as it is now, as the real vault sends it.
        return fail(
          409,
          'conflict',
          'Someone else changed this document. Reload and try again.',
          JSON.stringify(viewOf(doc)),
        );
      }
      // A field the fake does not keep fails loudly, so a client test never
      // passes against an edit the fake quietly dropped.
      const unkept = Object.keys(body).filter((k) => !FAKE_EDITABLE.includes(k));
      if (unkept.length) {
        return fail(
          501,
          'not_implemented',
          `The fake vault does not keep ${unkept.join(', ')} on an edit.`,
        );
      }
      // Sensitive before the edit (0.9.0, H1a), to say whether it made it so.
      const wasSensitive = sensitiveOf(
        doc,
        state.types.find((t) => t.key === doc.type_key) ?? null,
      );
      const type_key =
        body.type_key !== undefined ? (body.type_key as string | null) : (doc.type_key ?? null);
      // As the real vault (0.9.0, N1): a note stays a note, and nothing becomes one.
      if (
        type_key !== (doc.type_key ?? null) &&
        (type_key === NOTE_KIND || doc.type_key === NOTE_KIND)
      ) {
        return fail(
          422,
          'note_kind_fixed',
          'A note stays a note, and a document does not become one: make a new note instead.',
          'type_key',
        );
      }
      if (type_key !== null && !state.types.some((t) => t.key === type_key)) {
        return fail(422, 'validation_failed', 'That kind of document is not on the list.');
      }
      let extra = doc.extra ?? {};
      if (body.extra !== undefined) {
        const merged = detailsFor(type_key, body.extra, extra);
        if (isResponse(merged)) return merged;
        extra = merged;
      }
      if (body.tags !== undefined) {
        const tagProblem = tagsProblem(body.tags as string[]);
        if (tagProblem) return fail(422, 'validation_failed', tagProblem, 'tags');
      }
      // Its place in a cabinet (0.9.0, C3): a shown folder of the editor's
      // own layout, or null — read before anything is changed, as the vault.
      let place: FakeDocument['original_place'] | undefined;
      if (body.original_place !== undefined) {
        if (!seesLocation(editor.role)) {
          return fail(403, 'forbidden', LOCATION_SORT_REFUSAL, 'original_place');
        }
        const asked: unknown = body.original_place;
        if (asked === null) place = null;
        else {
          const found = fakePlaceOf(
            state,
            editor.memberId,
            (asked as { folder_id?: unknown }).folder_id,
          );
          if (!found) return fail(422, 'validation_failed', PLACE_NOT_IN_CABINET, 'original_place');
          place = found;
        }
      }
      // The folder it came from (0.9.0, C4): forgotten, null alone, by
      // whoever sees where originals are kept — as the vault.
      if (body.source_folder !== undefined) {
        if (!seesLocation(editor.role)) {
          return fail(403, 'forbidden', LOCATION_SORT_REFUSAL, 'source_folder');
        }
        if (body.source_folder !== null) {
          return fail(422, 'validation_failed', 'Only null forgets it.', 'source_folder');
        }
      }
      Object.assign(doc, { type_key, extra });
      // Sensitive (0.9.0, AIR2): a teen may make a paper sensitive, never
      // less so, all said with the kind it will have — as the real vault.
      if (body.sensitive !== undefined) {
        const was = doc.sensitive ?? null;
        const to = body.sensitive as boolean | null;
        const kind = state.types.find((t) => t.key === type_key);
        if (editor.role === 'teen' && to !== was && !sensitiveOf({ sensitive: to }, kind)) {
          return fail(403, 'forbidden', TEEN_KEEPS_SENSITIVE, 'sensitive');
        }
      }
      Object.assign(doc, { type_key, extra });
      if (body.sensitive !== undefined) doc.sensitive = body.sensitive as boolean | null;
      if (place !== undefined) doc.original_place = place;
      if (body.source_folder === null) doc.source_folder = null;
      if (body.tags !== undefined) doc.tags = tagsOf(body.tags as string[]);
      if (body.title !== undefined) doc.title = (body.title as string | null) ?? null;
      // The household's, or a person's, never both (0.9.0): null alone — an
      // older client's — leaves the household's the household's.
      if (body.household_owned === true && body.owner_member_id != null) {
        return fail(422, 'validation_failed', HOUSEHOLD_OR_PERSON, 'household_owned');
      }
      if (body.household_owned === true) {
        doc.owner_member_id = null;
        doc.household_owned = true;
      } else {
        if (body.owner_member_id !== undefined) {
          doc.owner_member_id = body.owner_member_id as string | null;
        }
        if (doc.owner_member_id) doc.household_owned = false;
        else if (body.household_owned === false) doc.household_owned = false;
      }
      // Trimmed, as the vault keeps an identifier: its inner spaces are its own.
      if (body.identifier !== undefined) {
        doc.identifier = (body.identifier as string | null)?.trim() || null;
      }
      if (body.issued_by !== undefined) doc.issued_by = tidy(body.issued_by as string | null);
      if (body.issued !== undefined) doc.issued = body.issued as DateValue | null;
      if (body.expires !== undefined) doc.expires = body.expires as DateValue | null;
      if (body.notes !== undefined) {
        const before = doc.notes ?? null;
        doc.notes = note(body.notes as string | null);
        stampNotes(doc, before, editor.memberId);
      }
      doc.revision = (doc.revision ?? 1) + 1;
      // Made sensitive while its links outside the family still give it
      // (0.9.0, H1a): the edit is made, and the answer says how many.
      const nowSensitive = sensitiveOf(
        doc,
        state.types.find((t) => t.key === doc.type_key) ?? null,
      );
      const links = (state.shares ?? []).filter(
        (l) => l.share.document_id === doc.id && l.share.state === 'active',
      ).length;
      if (!wasSensitive && nowSensitive && links > 0) {
        return ok({ ...viewOf(doc), warnings: [{ code: 'sensitive_still_shared', links }] });
      }
      return ok(viewOf(doc));
    }
    // Uploads, the way the real vault treats their keys: a retry is answered
    // with what the first try made, marked as a replay; a key used for one
    // request is refused for any other, without saying what it made.
    const uploadTo = /^\/api\/v1\/documents\/([^/]+)\/versions$/.exec(path);
    if ((path === '/api/v1/capture' || uploadTo) && init.method === 'POST') {
      const s = session();
      if (!('id' in s)) return s;
      const key = init.headers['idempotency-key'];
      if (!key)
        return fail(422, 'validation_failed', 'Uploads need an Idempotency-Key header (a UUID).');
      if (!UUID.test(key)) return fail(422, 'validation_failed', 'Idempotency-Key must be a UUID.');
      const type = init.headers['content-type'] ?? '';
      if (!(init.body instanceof Uint8Array) && !/^multipart\/form-data/.test(type)) {
        // A platform FormData sets its own content type; bytes must say so.
        if (!init.body) return fail(422, 'validation_failed', 'Attach one file.');
      }
      const kind = uploadTo ? 'version' : 'capture';
      const target = uploadTo?.[1];
      // As the real vault: a document that is not there is not there,
      // whatever the key.
      if (target !== undefined && !state.documents.some((d) => d.id === target)) {
        return fail(404, 'not_found', 'That document is not in the vault.');
      }
      // As the real vault (0.9.0, N1): a note keeps no file.
      if (
        target !== undefined &&
        state.documents.some((d) => d.id === target && d.type_key === NOTE_KIND)
      ) {
        return fail(422, 'note_has_no_file', NOTE_HAS_NO_FILE);
      }
      const prior = state.captures.get(key.toLowerCase());
      if (prior) {
        if (prior.kind !== kind || (target !== undefined && prior.document_id !== target)) {
          return fail(
            409,
            'idempotency_key_reused',
            'That upload key was already used for something else.',
          );
        }
        return respond(201, answer(prior), { 'idempotent-replayed': 'true' });
      }
      const parts = partsOf(init.body, init.headers['content-type']) ?? [];
      let documentId = target;
      if (documentId === undefined) {
        // The card's details come before the file, or not at all (0.4.9).
        let metadata: CaptureMetadata = {};
        let loose: Record<string, unknown> | null = null;
        const file = parts.findIndex((p) => p.value === null);
        const meta = parts.findIndex((p) => p.name === 'metadata');
        if (meta > file && file >= 0) {
          return fail(422, 'validation_failed', 'Send the details before the file.');
        }
        if (meta >= 0) {
          try {
            metadata = JSON.parse(parts[meta]?.value ?? '') as CaptureMetadata;
          } catch {
            return fail(422, 'validation_failed', 'The details must be sent as JSON.');
          }
          if (metadata.type_key === NOTE_KIND) {
            return fail(422, 'note_has_no_file', NOTE_HAS_NO_FILE);
          }
          // As the real vault (0.5.10): a kind it does not have — deleted
          // while the phone was offline — is not a refusal. The scan is filed
          // with no kind, for as few people as it could be, and its details
          // kept where the library has the field.
          if (metadata.type_key != null && !state.types.some((t) => t.key === metadata.type_key)) {
            const { extra: sentExtra, ...rest } = metadata;
            metadata = {
              ...rest,
              type_key: null,
              visibility:
                metadata.visibility ??
                ((metadata.owner_member_id ?? null) === 'fake-member' ? 'private' : 'adults'),
            };
            loose = sentExtra ?? null;
          }
          // As the real vault: a type the household has hidden is still
          // taken, since a phone queues a scan against the list it had.
          const problem = checkCaptureMetadata(metadata, {
            me: { member_id: 'fake-member', role: 'owner' },
            members: state.members,
            types: state.types,
          });
          if (problem) {
            return fail(
              problem.status,
              problem.field === 'extra'
                ? 'invalid_extra'
                : problem.status === 403
                  ? 'forbidden'
                  : 'validation_failed',
              problem.message,
              problem.key,
            );
          }
        }
        const extra = loose ? libraryDetails(loose) : detailsFor(metadata.type_key, metadata.extra);
        if (isResponse(extra)) return extra;
        const doc: FakeDocument = {
          id: next('document'),
          title: metadata.title ?? null,
          type_key: metadata.type_key ?? null,
          ...whoseNew(
            metadata,
            state.types.find((t) => t.key === metadata.type_key),
          ),
          ...ownSensitive(metadata),
          identifier: tidy(metadata.identifier),
          issued_by: tidy(metadata.issued_by),
          issued: metadata.issued ?? null,
          expires: metadata.expires ?? null,
          physical_location: note(metadata.physical_location),
          tags: tagsOf(metadata.tags),
          notes: note(metadata.notes),
          extra,
          visibility: effectiveVisibility(
            metadata,
            state.types.find((t) => t.key === metadata.type_key),
            'owner',
          ),
        };
        stampNotes(doc, null, whoOf(s).memberId);
        state.documents.push(doc);
        documentId = doc.id;
      }
      const file = parts.find((p) => p.value === null);
      const made: FakeUpload = {
        kind,
        document_id: documentId,
        version_id: next('version'),
        version_no: versionsOf(documentId).length + 1,
        filename: file?.filename ?? 'file',
        // A health record (0.9.0, H5) as the vault keeps it: application/xml for text/xml.
        mime:
          claimedRecordFormat(file?.type ?? '', file?.filename ?? '') ??
          file?.type ??
          'application/octet-stream',
        byte_size: file?.size ?? 0,
        uploaded_at: new Date().toISOString(),
        ...(file?.bytes ? { bytes: file.bytes } : {}),
      };
      state.captures.set(key.toLowerCase(), made);
      return ok(answer(made), 201);
    }
    // A document's history (0.5.11): its versions, newest first, and who
    // added each — never to a viewer, who is not told what the family has
    // been doing (on the activity log's terms, as the real vault).
    if (uploadTo && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      const id = decodeURIComponent(uploadTo[1] as string);
      if (!state.documents.some((d) => d.id === id)) {
        return fail(404, 'not_found', 'That document is not in the vault.');
      }
      const named = can(state.role, 'audit.read');
      const me = state.members.find((m) => m.is_me);
      const items: VersionView[] = versionsOf(id)
        .sort((a, b) => b.version_no - a.version_no)
        .map((v) => {
          const drawn = state.pages.get(v.version_id);
          return {
            id: v.version_id,
            document_id: v.document_id,
            version_no: v.version_no,
            filename: v.filename,
            mime: v.mime,
            byte_size: v.byte_size,
            // Not worked out by the fake: a stand-in of the right shape.
            sha256: '0'.repeat(64),
            page_count: null,
            ocr_status: 'pending',
            uploaded_at: v.uploaded_at,
            preview_pages: isRecordFormat(v.mime)
              ? 0
              : drawn === undefined
                ? null
                : drawn === 'unsupported'
                  ? 0
                  : drawn,
            // Never opened by the vault, downloaded only (0.9.0, H5).
            ...(isRecordFormat(v.mime) ? { stored_as_is: true } : {}),
            // Added by a connected app acting as itself (APP8): the app, by name.
            uploaded_by_name: named ? (v.uploaded_by_app ?? me?.display_name ?? null) : null,
            ...(v.uploaded_by_app ? { uploaded_by_app: true } : {}),
          };
        });
      return ok({ items });
    }
    if (path === '/api/v1/issuers' && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      // As the real vault: one entry per issuer whatever the case, in its
      // most used spelling; ?q= is a prefix; ?type_key= keeps only those
      // used for that type; most used first, then alphabetically.
      const q = param(url, 'q')?.trim().toLowerCase();
      const type = param(url, 'type_key');
      const byKey = new Map<
        string,
        { count: number; types: Set<string>; spellings: Map<string, number> }
      >();
      for (const d of state.documents) {
        if (!d.issued_by) continue;
        const k = d.issued_by.toLowerCase();
        const c = byKey.get(k) ?? { count: 0, types: new Set(), spellings: new Map() };
        c.count += 1;
        if (d.type_key) c.types.add(d.type_key);
        c.spellings.set(d.issued_by, (c.spellings.get(d.issued_by) ?? 0) + 1);
        byKey.set(k, c);
      }
      const items = [...byKey.entries()]
        .filter(([k, c]) => (!q || k.startsWith(q)) && (!type || c.types.has(type)))
        .map(([, c]) => ({
          issued_by: [...c.spellings.entries()].sort(
            (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
          )[0]?.[0] as string,
          count: c.count,
        }))
        .sort((a, b) => b.count - a.count || (a.issued_by < b.issued_by ? -1 : 1));
      return ok({ items });
    }
    const suggestFor = /^\/api\/v1\/documents\/([^/]+)\/issuer-suggestions$/.exec(path);
    if (suggestFor && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      const id = decodeURIComponent(suggestFor[1] as string);
      if (!state.documents.some((d) => d.id === id)) {
        return fail(404, 'not_found', 'That document is not in the vault.');
      }
      return ok(state.issuerSuggestions.get(id) ?? { state: 'unavailable', items: [] });
    }
    // What the pages propose (5.37), refused as the vault refuses an edit:
    // a viewer (a guest among them) whatever the id, a teen for another's;
    // an Only me document is there for its owner alone.
    const proposalFor = /^\/api\/v1\/documents\/([^/]+)\/suggestions$/.exec(path);
    if (proposalFor && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      const editor = whoOf(s);
      if (!can(editor.role, 'document.edit')) {
        return fail(403, 'forbidden', refusalFor('document.edit'));
      }
      const id = decodeURIComponent(proposalFor[1] as string);
      const doc = state.documents.find((d) => d.id === id && !d.deleted_at);
      if (!doc || (doc.visibility === 'private' && doc.owner_member_id !== editor.memberId)) {
        return fail(404, 'not_found', 'That document is not in the vault.');
      }
      if (editor.role === 'teen' && doc.owner_member_id !== editor.memberId) {
        return fail(403, 'forbidden', 'You can only change your own documents.');
      }
      const given = state.detailSuggestions.get(id);
      if (!given || given.state !== 'ready') {
        return ok({ state: given?.state ?? 'unavailable', version_id: null, proposal: {} });
      }
      // A field the document has a value for is never offered.
      const has: Record<keyof DetailSuggestions['proposal'], boolean> = {
        type_key: !!doc.type_key,
        owner_member_id: !!doc.owner_member_id,
        issued: !!doc.issued,
        expires: !!doc.expires,
        identifier: !!doc.identifier?.trim(),
        issued_by: !!doc.issued_by?.trim(),
      };
      const proposal = Object.fromEntries(
        Object.entries(given.proposal).filter(([k]) => !has[k as keyof typeof has]),
      );
      // What a renewal changes (0.9.0): for the fields it has, as the vault gives it.
      const renewal = given.renewal
        ? Object.fromEntries(
            Object.entries(given.renewal).filter(([k]) => has[k as keyof typeof has]),
          )
        : undefined;
      return ok({
        state: 'ready',
        version_id: given.version_id,
        proposal,
        ...(renewal ? { renewal } : {}),
      });
    }
    // A new version's details made its own (0.9.0), and taken back: for
    // whoever may change it, on the document as last seen (If-Match), while
    // `version_id` is its newest after the first — as the vault refuses.
    const renewalOf = /^\/api\/v1\/documents\/([^/]+)\/renewal(\/undo)?$/.exec(path);
    if (renewalOf && init.method === 'POST') {
      const s = session();
      if (!('id' in s)) return s;
      const editor = whoOf(s);
      if (!can(editor.role, 'document.edit')) {
        return fail(403, 'forbidden', refusalFor('document.edit'));
      }
      const id = decodeURIComponent(renewalOf[1] as string);
      const doc = state.documents.find((d) => d.id === id && !d.deleted_at);
      if (!doc || (doc.visibility === 'private' && doc.owner_member_id !== editor.memberId)) {
        return fail(404, 'not_found', 'That document is not in the vault.');
      }
      if (editor.role === 'teen' && doc.owner_member_id !== editor.memberId) {
        return fail(403, 'forbidden', 'You can only change your own documents.');
      }
      const newest = [...state.captures.values()]
        .filter((c) => c.document_id === doc.id)
        .sort((a, b) => b.version_no - a.version_no)[0];
      const kept = renewals.get(doc.id);
      if (renewalOf[2]) {
        if (!kept || kept.versionId !== body.version_id || kept.by !== editor.memberId) {
          return fail(409, 'renewal_not_undoable', 'This can no longer be undone.');
        }
        if (kept.revision !== (doc.revision ?? 1)) {
          return fail(409, 'renewal_kept', 'This document was changed since.');
        }
        Object.assign(doc, kept.before);
        doc.revision = (doc.revision ?? 1) + 1;
        renewals.delete(doc.id);
        return ok(viewOf(doc));
      }
      if (!init.headers['if-match']) {
        return fail(428, 'precondition_required', 'Send If-Match.');
      }
      if (init.headers['if-match'] !== etagOf(doc)) {
        return fail(409, 'conflict', 'Someone else changed this document. Reload and try again.');
      }
      if (!newest || newest.version_no < 2 || newest.version_id !== body.version_id) {
        return fail(409, 'version_changed', 'This document has another newest version now.');
      }
      if (kept?.versionId === newest.version_id) {
        return fail(409, 'renewal_undo_open', 'These details were used just now. Undo that first.');
      }
      const fields = (['issued', 'expires', 'identifier', 'issued_by'] as const).filter(
        (f) => body[f] !== undefined,
      );
      const before = Object.fromEntries(fields.map((f) => [f, doc[f] ?? null]));
      Object.assign(doc, Object.fromEntries(fields.map((f) => [f, body[f] ?? null])));
      doc.revision = (doc.revision ?? 1) + 1;
      renewals.set(doc.id, {
        versionId: newest.version_id,
        by: editor.memberId,
        before,
        revision: doc.revision,
      });
      const view = viewOf(doc);
      return respond(
        200,
        { document: view, undo_until: new Date(Date.now() + 5 * 60_000).toISOString() },
        { etag: view.etag },
      );
    }
    const uploadKey = /^\/api\/v1\/uploads\/([^/]+)$/.exec(path);
    if (uploadKey && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      const made = state.captures.get(decodeURIComponent(uploadKey[1] as string).toLowerCase());
      if (!made) return fail(404, 'not_found', 'That upload is not known here.');
      return ok({ state: 'done', document_id: made.document_id, version_id: made.version_id });
    }
    // A version's file (CL3), as the real route gives it: the exact bytes
    // uploaded, an attachment, under the type a browser never renders for a
    // record. Ranges and the step-up of an Essential are not modelled.
    const contentOf = /^\/api\/v1\/versions\/([^/]+)\/content$/.exec(path);
    if (contentOf && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      const id = decodeURIComponent(contentOf[1] as string);
      const v = [...state.captures.values()].find((c) => c.version_id === id);
      if (!v || !state.documents.some((d) => d.id === v.document_id)) {
        return fail(404, 'not_found', 'That file is not in the vault.');
      }
      const bytes = v.bytes ?? new Uint8Array();
      return attachment(bytes, {
        'accept-ranges': 'bytes',
        'content-type': deliveredType(v.mime),
        'content-disposition': attachmentDisposition(recordFileName(v.filename, v.mime)),
        'content-length': String(bytes.length),
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, no-store',
      });
    }
    // A page as the vault drew it (0.4.12): not found for a version it never
    // made, still being drawn until a test says otherwise, then a JPEG.
    const pageOf = /^\/api\/v1\/versions\/([^/]+)\/pages\/([^/]+)$/.exec(path);
    if (pageOf && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      const version = pageOf[1] as string;
      const n = Number(pageOf[2]);
      // As the real route: a page is a whole number from 1.
      if (!/^\d+$/.test(pageOf[2] as string) || n < 1) {
        return fail(422, 'validation_failed', 'That is not a page number.');
      }
      const made = [...state.captures.values()].some((c) => c.version_id === version);
      if (!made && !state.pages.has(version)) {
        return fail(404, 'not_found', 'That page does not exist.');
      }
      const drawn = state.pages.get(version);
      if (drawn === 'unsupported') {
        return fail(
          404,
          'no_preview',
          "There's no preview for this kind of file. You can save a copy to open it.",
        );
      }
      if (n > PREVIEW_MAX_PAGES || (typeof drawn === 'number' && n > drawn)) {
        return fail(
          404,
          'no_preview',
          "There's no preview of this page. You can save a copy to open it.",
        );
      }
      if (drawn === undefined) {
        return respond(
          404,
          {
            error: {
              code: 'preview_pending',
              message: 'The preview is being made. Try again in a moment.',
              retriable: true,
              request_id: 'fake',
            },
          },
          { 'retry-after': '3' },
        );
      }
      return picture(FAKE_PAGE);
    }
    // Essentials a phone may keep (0.4.13), as the real vault answers them.
    if (path.startsWith('/api/v1/offline/')) {
      const s = session();
      if (!('id' in s)) return s;
      const o = state.offlineEssentials;
      // The grant is the session's, as the real vault keeps it; lapsed is none.
      const grant =
        s.offlineGrant && Date.parse(s.offlineGrant.expires_at) > Date.now()
          ? s.offlineGrant
          : null;
      const visible = (i: OfflineItem) => !i.private || grant?.include_private === true;
      if (path === '/api/v1/offline/grant' && init.method === 'POST') {
        // As the real vault: an app installation (the session's) first, then the password.
        if (!s.installation) {
          return fail(422, 'validation_failed', 'Only the app keeps documents on a phone.');
        }
        if (body.password !== state.password)
          return fail(401, 'invalid_credentials', "That password isn't right.");
        const now = Date.now();
        s.offlineGrant = {
          granted_at: new Date(now).toISOString(),
          expires_at: new Date(now + 30 * 86_400_000).toISOString(),
          include_private: body.include_private === true,
        };
        return ok(s.offlineGrant);
      }
      if (path === '/api/v1/offline/grant' && init.method === 'DELETE') {
        s.offlineGrant = null;
        return empty();
      }
      if (path === '/api/v1/offline/essentials' && init.method === 'GET') {
        // No grant in force: keep nothing.
        return ok({
          items: grant ? o.items.filter(visible) : [],
          grant,
          max_offline_days: FAKE_OFFLINE_MAX_DAYS,
          server_time: new Date().toISOString(),
          truncated: false,
        });
      }
      const pageOf = /^\/api\/v1\/offline\/pages\/([^/]+)\/(\d+)$/.exec(path);
      if (pageOf && init.method === 'GET') {
        const item = o.items.find((i) => i.version.id === pageOf[1] && visible(i));
        if (!item) return fail(404, 'not_found', 'That page does not exist.');
        if (!grant) {
          return fail(
            403,
            'offline_grant_required',
            'Please confirm it is you to keep Essentials on this phone.',
          );
        }
        const drawn = item.version.preview_pages;
        if (drawn === null) {
          return respond(
            404,
            {
              error: {
                code: 'preview_pending',
                message: 'The preview is being made. Try again in a moment.',
                retriable: true,
                request_id: 'fake',
              },
            },
            { 'retry-after': '3' },
          );
        }
        if (Number(pageOf[2]) > drawn) {
          return fail(
            404,
            'no_preview',
            "There's no preview of this page. You can save a copy to open it.",
          );
        }
        return picture(FAKE_PAGE);
      }
      if (path === '/api/v1/offline/opens' && init.method === 'POST') {
        const events = (body.events as Array<{ id: string; version_id: string }> | undefined) ?? [];
        if (events.length > 200) return fail(422, 'validation_failed', 'At most 200 at a time.');
        const result = { accepted: 0, duplicates: 0, dropped: 0 };
        for (const e of events) {
          if (!o.items.some((i) => i.version.id === e.version_id)) result.dropped += 1;
          else if (o.received.has(e.id)) result.duplicates += 1;
          else {
            o.received.add(e.id);
            result.accepted += 1;
          }
        }
        return ok(result);
      }
    }
    if (path === '/api/v1/document-types' && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      // As the real vault (0.5.6): a hidden type stays while a document uses
      // it — app 0.2.0 looks its documents' types up in this list — and
      // ?all=true lists every one.
      const all = param(url, 'all') === 'true';
      const inUse = (key: string) => state.documents.some((d) => d.type_key === key);
      return ok({
        // The kind of a note (0.9.0, N1) only where a note uses it, all or not.
        items: state.types
          .filter((t) => all || !t.hidden || inUse(t.key))
          .filter((t) => t.key !== NOTE_KIND || inUse(t.key))
          .map(typeAnswer),
      });
    }
    if (path === '/api/v1/document-attributes' && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      return ok({ items: state.attributes });
    }
    // Kinds of document, managed (0.5.10), as the real vault manages them.
    // The fake signs in as an owner, who may do all of it.
    if (path === '/api/v1/document-attributes' && init.method === 'POST') {
      const s = session();
      if (!('id' in s)) return s;
      const long = tooLong([
        [body.label, 'The name'],
        ...((body.choices as string[] | null | undefined) ?? []).map(
          (c) => [c, 'An answer'] as const,
        ),
      ]);
      if (long) return long;
      const label = tidy(body.label as string | undefined);
      if (!label) return fail(422, 'validation_failed', 'Give the field a name.', 'label');
      // A name the library has, a built-in's included, in any case (0.5.15).
      const same = state.attributes.find((a) => a.label.toLowerCase() === label.toLowerCase());
      if (same) return fail(422, 'validation_failed', libraryHasName(same.label), 'label');
      const kind = body.kind as DocumentAttributeView['kind'];
      const answers = [
        ...new Set(((body.choices as string[] | null | undefined) ?? []).map(tidy)),
      ].filter((c): c is string => c !== null);
      if (kind === 'choice' && answers.length === 0) {
        return fail(422, 'validation_failed', 'Give a choice at least one answer.', 'choices');
      }
      if (kind !== 'choice' && answers.length > 0) {
        return fail(
          422,
          'validation_failed',
          'Only a choice has answers to choose from.',
          'choices',
        );
      }
      const made: DocumentAttributeView = {
        key: ownKey(),
        label,
        kind,
        choices: kind === 'choice' ? answers : null,
        builtin: false,
      };
      state.attributes.push(made);
      return ok(made, 201);
    }
    if (path === '/api/v1/document-types' && init.method === 'POST') {
      const s = session();
      if (!('id' in s)) return s;
      const long = tooLong([
        [body.label, 'The name'],
        [body.short_label, 'The short name'],
        [body.issuer_noun, 'The word after who issued it'],
      ]);
      if (long) return long;
      const label = tidy(body.label as string | undefined);
      if (!label) {
        return fail(422, 'validation_failed', 'Give the kind of document a name.', 'label');
      }
      const category = (body.category as string | undefined) ?? 'other';
      if (!(category in CATEGORY_LABELS)) {
        return fail(
          422,
          'validation_failed',
          'Choose one of the categories the vault has.',
          'category',
        );
      }
      // As the real vault: the household's own is archived, never hidden.
      if (body.hidden !== undefined) {
        return fail(
          422,
          'validation_failed',
          'A kind of document of your own is archived, not hidden.',
          'hidden',
        );
      }
      const sent = (body.core ?? {}) as TypeChange['core'];
      const expires = sent?.expires?.shown === true;
      const t: DocumentTypeView = {
        key: ownKey(),
        label,
        category,
        fields: [],
        expiry_driver: expires ? 'expires_on' : null,
        // What it reminds from is worked out below, on the kind as made.
        reminder_leads: [],
        remind_from: null,
        usually_essential: (body.usually_essential as boolean | undefined) ?? false,
        default_visibility: (body.default_visibility as Visibility | undefined) ?? 'household',
        // Whom its documents usually belong to (0.9.0): a person's, unless it says.
        belongs_to: (body.belongs_to as BelongsTo | undefined) ?? 'person',
        // A kind the household makes starts sensitive (0.9.0, AIR2).
        sensitive_default: (body.sensitive_default as boolean | undefined) ?? true,
        issued_by_label: null,
        builtin: false,
        hidden: false,
        core: coreOf({ expiry_driver: expires ? 'expires_on' : null }),
        short_label: tidy(body.short_label as string | null | undefined),
        issuer_noun: tidy(body.issuer_noun as string | null | undefined),
      };
      const problem =
        changeType(t, { core: sent, fields: body.fields as TypeChange['fields'] }) ??
        remind(null, t, body);
      if (problem) return problem;
      state.types.push(t);
      return ok(typeAnswer(t), 201);
    }
    const typeAt = /^\/api\/v1\/document-types\/([^/]+)(\/archive|\/restore|\/impact)?$/.exec(path);
    if (typeAt) {
      const s = session();
      if (!('id' in s)) return s;
      const t = state.types.find((x) => x.key === decodeURIComponent(typeAt[1] as string));
      if (!t) return fail(404, 'not_found', 'That kind of document is not on the list.');
      const action = typeAt[2];
      const used = state.documents.filter((d) => d.type_key === t.key);
      if (action === undefined && init.method === 'PATCH') {
        // As the real vault: a change made to a kind somebody has since
        // changed is refused, not laid over theirs.
        const ifMatch = init.headers['if-match'];
        if (ifMatch && ifMatch !== typeTag(t)) {
          // The kind as it now is, to reload from.
          return fail(
            409,
            'conflict',
            'Someone else changed this kind of document. Reload and try again.',
            JSON.stringify(typeAnswer(t)),
          );
        }
        const named = ['label', 'category', 'short_label', 'issuer_noun'].some(
          (k) => body[k] !== undefined,
        );
        if (t.builtin && named) {
          return fail(
            422,
            'validation_failed',
            'A built-in kind of document keeps its name and category. Add a kind of your own to call it something else.',
          );
        }
        if (!t.builtin && body.hidden !== undefined) {
          return fail(
            422,
            'validation_failed',
            'A kind of document of your own is archived, not hidden.',
            'hidden',
          );
        }
        if (body.category !== undefined && !((body.category as string) in CATEGORY_LABELS)) {
          return fail(
            422,
            'validation_failed',
            'Choose one of the categories the vault has.',
            'category',
          );
        }
        const long = tooLong([
          [body.label, 'The name'],
          [body.short_label, 'The short name'],
          [body.issuer_noun, 'The word after who issued it'],
        ]);
        if (long) return long;
        const next: DocumentTypeView = JSON.parse(JSON.stringify(t)) as DocumentTypeView;
        if (body.label !== undefined) {
          const label = tidy(body.label as string);
          if (!label) {
            return fail(422, 'validation_failed', 'Give the kind of document a name.', 'label');
          }
          next.label = label;
        }
        if (body.category !== undefined) next.category = body.category as string;
        if (body.short_label !== undefined)
          next.short_label = tidy(body.short_label as string | null);
        if (body.issuer_noun !== undefined)
          next.issuer_noun = tidy(body.issuer_noun as string | null);
        if (body.default_visibility !== undefined) {
          next.default_visibility = body.default_visibility as Visibility;
        }
        if (body.usually_essential !== undefined) {
          next.usually_essential = body.usually_essential as boolean;
        }
        if (body.belongs_to !== undefined) next.belongs_to = body.belongs_to as BelongsTo;
        if (body.sensitive_default !== undefined) {
          next.sensitive_default = body.sensitive_default as boolean;
        }
        if (body.hidden !== undefined) next.hidden = body.hidden as boolean;
        // Its fields and Expires, then what it reminds from on the kind as
        // it will be — Expires switched on with no lead times: 30 days, as
        // a new kind (0.5.15: `nextReminder`, as the vault).
        const problem =
          changeType(next, {
            core: body.core as TypeChange['core'],
            fields: body.fields as TypeChange['fields'],
          }) ?? remind(t, next, body);
        if (problem) return problem;
        Object.assign(t, next);
        bump(t);
        return ok(typeAnswer(t));
      }
      if (action === undefined && init.method === 'DELETE') {
        if (t.builtin) {
          return fail(
            422,
            'validation_failed',
            "A built-in kind of document can't be deleted. Hide it instead.",
          );
        }
        if (used.length > 0) return fail(409, 'type_in_use', TYPE_IN_USE);
        state.types.splice(state.types.indexOf(t), 1);
        // Out of every restriction that named it, as the real vault's rows
        // go with it (0054): limits_types stays as it was, so limits that
        // named only it give nothing by kind (R532-01, the 5.33 review).
        for (const r of state.restrictions.values()) {
          r.types = r.types.filter((k) => k !== t.key);
        }
        return empty();
      }
      if ((action === '/archive' || action === '/restore') && init.method === 'POST') {
        const hidden = action === '/archive';
        if (t.hidden !== hidden) {
          t.hidden = hidden;
          bump(t);
        }
        return ok(typeAnswer(t));
      }
      if (action === '/impact' && init.method === 'GET') {
        const count = (has: (d: FakeDocument) => boolean) => {
          const n = used.filter(has).length;
          return { with_value: n, without_value: used.length - n };
        };
        const given = (v: unknown) =>
          v !== undefined &&
          v !== null &&
          !(typeof v === 'string' && v.trim() === '') &&
          !(Array.isArray(v) && v.length === 0);
        // Its reminders not dealt with yet, and by the date each is about (0.5.15).
        const open = state.reminders.filter(
          (r) =>
            r.kind === 'derived' &&
            ['scheduled', 'due', 'snoozed'].includes(r.status) &&
            used.some((d) => d.id === r.document_id),
        );
        const bySource: Record<string, number> = {};
        for (const r of open) {
          const source = r.source ?? 'expires';
          bySource[source] = (bySource[source] ?? 0) + 1;
        }
        const impact: DocumentTypeImpact = {
          key: t.key,
          documents: used.length,
          in_trash: 0,
          core: Object.fromEntries(
            CORE_FIELDS.map((f) => [f, count((d) => given((d as Record<string, unknown>)[f]))]),
          ) as DocumentTypeImpact['core'],
          fields: [
            ...t.fields.map((f) => ({
              key: f.key,
              label: f.label,
              ...count((d) => given(d.extra?.[f.key])),
            })),
            // Then every other field one of them keeps a value for, as the
            // vault counts them (a field the kind dropped: 5.12).
            ...[
              ...new Set(
                used.flatMap((d) => Object.keys(d.extra ?? {}).filter((k) => given(d.extra?.[k]))),
              ),
            ]
              .filter((k) => !t.fields.some((f) => f.key === k))
              .sort()
              .map((key) => ({ key, label: null, ...count((d) => given(d.extra?.[key])) })),
          ],
          reminders: open.length,
          reminders_by_source: bySource,
          unseen: UNSEEN_DOCUMENTS,
        };
        return ok(impact);
      }
    }
    // Several documents as one ZIP (0.9.0, DL), as the real vault makes it:
    // what the one person may see — a file each, stored, the stand-in bytes
    // of its newest version's name; a note as its words, a Markdown file —
    // and the index. The fake asks no step-up for a sensitive one.
    // A ticket (DL review): the same, kept once for GET /downloads/{ticket}.
    const zipCollection = /^\/api\/v1\/collections\/([^/]+)\/download(\/ticket)?$/.exec(path);
    const zipTicket = /^\/api\/v1\/downloads\/([^/]+)$/.exec(path);
    if (zipTicket && init.method === 'GET') {
      const kept = zipTickets.get(decodeURIComponent(zipTicket[1] as string));
      zipTickets.delete(decodeURIComponent(zipTicket[1] as string));
      return (
        kept ??
        fail(
          404,
          'download_ticket_gone',
          'This download has expired. Go back and press Download again.',
        )
      );
    }
    const asTicket = path === '/api/v1/documents/download/ticket' || Boolean(zipCollection?.[2]);
    if (
      (path === '/api/v1/documents/download' ||
        path === '/api/v1/documents/download/ticket' ||
        zipCollection) &&
      init.method === 'POST'
    ) {
      const s = session();
      if (!('id' in s)) return s;
      const me = { role: state.role, memberId: 'fake-member' };
      const sees = (d: FakeDocument) =>
        canSee(me, {
          visibility: d.visibility ?? 'household',
          owner_member_id: d.owner_member_id ?? null,
        });
      let ids: string[];
      let zipName = 'Family documents';
      if (zipCollection) {
        const l = state.collections.find(
          (x) => x.id === decodeURIComponent(zipCollection[1] as string),
        );
        if (!l || l.deleted || !canSeeCollection(me, l)) {
          return fail(404, 'not_found', 'That collection does not exist.');
        }
        zipName = l.name;
        ids = l.items.map((i) => i.document_id);
      } else {
        const asked = body.document_ids;
        if (!Array.isArray(asked) || asked.length === 0 || asked.length > 1000) {
          return fail(
            422,
            'validation_failed',
            'Choose the documents to download.',
            'document_ids',
          );
        }
        ids = [...new Set(asked.map(String))];
      }
      const docs = ids
        .map((id) => state.documents.find((d) => d.id === id))
        .filter((d): d is FakeDocument => d !== undefined && sees(d))
        .filter((d) => !zipCollection || !d.deleted_at);
      if (docs.length === 0) {
        return zipCollection
          ? fail(422, 'nothing_to_zip', 'None of these has a file you can download.')
          : fail(404, 'not_found', 'Those documents do not exist.');
      }
      const named = zipNames();
      const enc = new TextEncoder();
      const files: Array<{ name: string; bytes: Uint8Array }> = [];
      const rows: string[] = ['Title,Kind,Person,Issued,Expires,File in this ZIP,Note'];
      for (const d of docs) {
        const newest = versionsOf(d.id).sort((a, b) => b.version_no - a.version_no)[0];
        let file: string | null = null;
        if (d.type_key === NOTE_KIND) {
          file = named(safeFileName(d.title ?? 'Note'), '.md');
          files.push({
            name: file,
            bytes: enc.encode(noteMarkdown(d.title ?? null, d.notes ?? '')),
          });
        } else if (newest) {
          file = named(safeFileName(d.title ?? 'Untitled'), safeExtension(newest.filename));
          files.push({ name: file, bytes: enc.encode(newest.filename) });
        }
        rows.push(
          [
            d.title ?? 'Untitled',
            d.type_key === NOTE_KIND ? 'Note' : d.type_key,
            null,
            null,
            null,
            file,
            file ? null : ZIP_LEFT_OUT.no_file,
          ]
            .map(csvCell)
            .join(','),
        );
      }
      if (files.length === 0) {
        return fail(422, 'nothing_to_zip', 'None of these has a file you can download.');
      }
      if (files.length > ZIP_MAX_DOCUMENTS) {
        return fail(
          422,
          'zip_too_large',
          zipTooLarge(state.role === 'owner' || state.role === 'adult'),
        );
      }
      const index = `<!doctype html><title>${zipName}</title><p>${files.length} files</p>`;
      const bytes = storedZip([
        { name: 'index.html', bytes: enc.encode(index) },
        { name: 'index.csv', bytes: enc.encode(`${rows.join('\n')}\n`) },
        ...files,
      ]);
      const today = new Date((state.now ?? Date.now)()).toISOString().slice(0, 10);
      const zipped = attachment(bytes, {
        'content-type': 'application/zip',
        'content-disposition': attachmentDisposition(
          zipFileName(zipCollection ? zipName : null, today),
        ),
        'cache-control': 'private, no-store',
      });
      if (!asTicket) return zipped;
      const ticket = `fake-ticket-${++zipTicketCount}-0123456789abcdef`;
      zipTickets.set(ticket, zipped);
      return ok(
        {
          url: `/api/v1/downloads/${ticket}`,
          expires_at: new Date((state.now ?? Date.now)() + 60_000).toISOString(),
        },
        201,
      );
    }
    // Collections of documents (0.5.12), as the real vault keeps them: a collection
    // exists only for its maker and whoever is in its audience (a viewer is
    // in none); each reader is given the documents in it they can see,
    // counted as they see them; only its maker changes it, while they are
    // in its audience, or a manager they chose (0.9.0), as `my_powers`
    // says; its maker deletes it whatever their role; an owner deletes one
    // nobody may change any more.
    const me = { role: state.role, memberId: 'fake-member' };
    const collectionAt = /^\/api\/v1\/collections\/([^/]+)(\/items(?:\/([^/]+))?)?$/.exec(path);
    const checklistAt = /^\/api\/v1\/collections\/([^/]+)\/checklist(\/add)?$/.exec(path);
    const managersAt = /^\/api\/v1\/collections\/([^/]+)\/managers(?:\/([^/]+))?$/.exec(path);
    const docCollections = /^\/api\/v1\/documents\/([^/]+)\/collections$/.exec(path);
    if (
      path === '/api/v1/collections' ||
      collectionAt ||
      docCollections ||
      checklistAt ||
      managersAt
    ) {
      const s = session();
      if (!('id' in s)) return s;
      const shown = (l: FakeCollection) => !l.deleted && canSeeCollection(me, l);
      const onIt = (l: FakeCollection) =>
        l.items
          .map((i) => ({ ...i, doc: state.documents.find((d) => d.id === i.document_id) }))
          .filter(
            (i): i is typeof i & { doc: FakeDocument } =>
              i.doc !== undefined &&
              canSee(me, {
                visibility: i.doc.visibility ?? 'household',
                owner_member_id: i.doc.owner_member_id ?? null,
              }),
          );
      const collectionTag = (l: FakeCollection) => `"${l.id}.${l.revision}"`;
      const collectionView = (l: FakeCollection): CollectionView => ({
        id: l.id,
        name: l.name,
        description: l.description,
        audience: l.audience,
        owner_member_id: l.owner_member_id,
        mine: l.owner_member_id === me.memberId,
        item_count: onIt(l).length,
        created_at: l.created_at,
        updated_at: l.updated_at,
        etag: collectionTag(l),
        // The fake shares nothing outside the family (5.19): no link works for any.
        shared_outside: null,
        my_powers: powersOf(l),
        managers: family() ? managersOf(l) : null,
      });
      /** A collection and a page of what is in it: its first, unless asked. */
      const detail = (
        l: FakeCollection,
        from = 0,
        limit = COLLECTION_ITEMS_PAGE,
      ): CollectionDetail => {
        const all = onIt(l);
        const shown = all.slice(from, from + limit);
        const more = from + limit < all.length;
        const last = shown[shown.length - 1];
        return {
          ...collectionView(l),
          items: shown.map((i) => ({
            document: listedOf(i.doc),
            added_at: i.added_at,
            hint:
              powersOf(l).maker || powersOf(l).manager
                ? collectionItemHint(l.audience, {
                    visibility: i.doc.visibility ?? 'household',
                    owner_member_id: i.doc.owner_member_id ?? null,
                  })
                : null,
          })),
          next_cursor: more && last ? `after.${last.document_id}` : null,
          has_more: more,
        };
      };
      /**
       * The page GET /collections/{id} asks for: 50 unless `limit` says (200 at
       * most), after the document `cursor` names — one the reader is given
       * in it, or the cursor is not valid.
       */
      const paged = (l: FakeCollection): CollectionDetail | ResponseLike => {
        const asked = param(url, 'limit');
        const limit = asked === undefined ? COLLECTION_ITEMS_PAGE : Number(asked);
        if (!Number.isInteger(limit) || limit < 1 || limit > COLLECTION_ITEMS_PAGE_MAX) {
          return fail(422, 'validation_failed', 'That page size is not valid.');
        }
        const cursor = param(url, 'cursor');
        if (cursor === undefined) return detail(l, 0, limit);
        const after = /^after\.(.+)$/.exec(cursor)?.[1];
        const at = onIt(l).findIndex((i) => i.document_id === after);
        if (at < 0) return fail(422, 'validation_failed', 'That page cursor is not valid.');
        return detail(l, at + 1, limit);
      };
      /**
       * Whose role now, of the member who made a collection: the fake's own,
       * or one of `state.members`.
       */
      const roleOf = (memberId: string): Role | undefined =>
        memberId === me.memberId
          ? state.role
          : (state.members.find((m) => m.id === memberId)?.role as Role | undefined);
      /** Of the family, who may manage a collection and see its managers (0.9.0). */
      const family = () => ['owner', 'adult', 'teen'].includes(state.role);
      /** Whether somebody may manage `l` as it is for `audience`: of the family, signed in, in it. */
      const mayManage = (memberId: string, audience: CollectionAudience) => {
        const person = state.members.find((m) => m.id === memberId);
        const role = roleOf(memberId);
        return (
          (person?.kind ?? 'family') === 'family' &&
          role !== undefined &&
          role !== null &&
          audience !== 'only_me' &&
          inCollectionAudience(role, audience)
        );
      };
      /** Its managers, as the family who see it are told. */
      const managersOf = (l: FakeCollection) =>
        (l.managers ?? [])
          .map((m) => ({
            ...m,
            display_name: state.members.find((x) => x.id === m.member_id)?.display_name ?? '',
          }))
          .sort((a, b) => a.display_name.localeCompare(b.display_name));
      /** Its maker may no longer change it: no sign-in, or outside its audience. */
      const makerStranded = (l: FakeCollection) => {
        const role = roleOf(l.owner_member_id);
        return role === undefined || role === null || !inCollectionAudience(role, l.audience);
      };
      /** Nobody may delete it any more: its maker may not change it, and no manager may delete it. */
      const stranded = (l: FakeCollection) =>
        makerStranded(l) &&
        !(l.managers ?? []).some((m) => m.may_delete && mayManage(m.member_id, l.audience));
      /** What the one person may do with a collection now (0.9.0), as the real vault says. */
      const powersOf = (l: FakeCollection): CollectionPowers => {
        const maker = l.owner_member_id === me.memberId;
        const inIt = inCollectionAudience(state.role, l.audience);
        const own = (l.managers ?? []).find((m) => m.member_id === me.memberId);
        const manager = !maker && own !== undefined && family() && inIt && l.audience !== 'only_me';
        const makerNow = maker && inIt;
        const owner = !maker && state.role === 'owner';
        const chooses = makerNow || (manager && own.may_choose_managers);
        return {
          maker,
          manager,
          edit: makerNow || manager,
          change_audience: makerNow || (manager && own.may_change_audience),
          delete: maker || (manager && own.may_delete) || (owner && stranded(l)),
          choose_managers: chooses,
          remove_managers: chooses || (owner && makerStranded(l)),
        };
      };
      // By name, whatever the case; made first, first (a stable sort).
      const byName = (a: FakeCollection, b: FakeCollection) => {
        const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()];
        return x < y ? -1 : x > y ? 1 : 0;
      };
      const manage = () =>
        can(state.role, 'collection.manage')
          ? null
          : fail(403, 'forbidden', refusalFor('collection.manage'));
      /** The name, words and audience asked for, as the real vault takes them; or a refusal. */
      const fields = (
        l: Pick<FakeCollection, 'name' | 'description' | 'audience'>,
      ): ResponseLike | Pick<FakeCollection, 'name' | 'description' | 'audience'> => {
        const out = { ...l };
        if (body.name !== undefined) {
          const name = tidy(body.name as string);
          if (!name) return fail(422, 'validation_failed', 'Give the collection a name.', 'name');
          if (name.length > COLLECTION_NAME_MAX) {
            return fail(
              422,
              'validation_failed',
              `A collection’s name is too long: ${COLLECTION_NAME_MAX} characters at most.`,
              'name',
            );
          }
          out.name = name;
        }
        if (body.description !== undefined) {
          const words = (body.description as string | null)?.trim() || null;
          if ((words?.length ?? 0) > COLLECTION_DESCRIPTION_MAX) {
            return fail(
              422,
              'validation_failed',
              `What a collection is for is too long: ${COLLECTION_DESCRIPTION_MAX} characters at most.`,
              'description',
            );
          }
          out.description = words;
        }
        if (body.audience !== undefined) {
          const audience = body.audience as CollectionAudience;
          if (!COLLECTION_AUDIENCES.includes(audience)) {
            return fail(422, 'validation_failed', 'Say who the collection is for.', 'audience');
          }
          if (!inCollectionAudience(state.role, audience)) {
            return fail(403, 'forbidden', 'Only an adult can make a collection for the adults.');
          }
          out.audience = audience;
        }
        return out;
      };

      if (path === '/api/v1/collections' && init.method === 'GET') {
        return ok({ items: state.collections.filter(shown).sort(byName).map(collectionView) });
      }
      // A collection from a checklist (0.9.0, C1), as the real vault reads
      // and matches it (@fdv/shared's own rules), against the documents the
      // one person the fake signs in as may see.
      if (checklistAt) {
        const found = state.collections.find(
          (x) => x.id === decodeURIComponent(checklistAt[1] as string),
        );
        const l = found && shown(found) ? found : undefined;
        if (!['owner', 'adult', 'teen'].includes(state.role)) {
          return fail(403, 'forbidden', 'A collection’s checklist is for the family who see it.');
        }
        const changing = init.method !== 'GET';
        const refused = changing ? manage() : null;
        if (refused) return refused;
        if (!l) return fail(404, 'not_found', 'That collection does not exist.');
        // Its maker, or a manager (0.9.0).
        const mine = powersOf(l).edit;
        if (changing && !mine) {
          return fail(
            403,
            'forbidden',
            'Only the person who made this collection, or someone they chose to manage it, can fill it from a checklist.',
          );
        }
        const ctx: ChecklistContext = {
          types: state.types.map((t) => ({
            key: t.key,
            label: t.label,
            short_label: t.short_label ?? null,
            hidden: t.hidden ?? false,
          })),
          people: state.members
            .filter((m) => m.kind !== 'guest')
            .filter((m) => state.role !== 'teen' || m.id === me.memberId)
            .map((m) => ({ id: m.id, name: m.display_name })),
          me: me.memberId,
          today: new Date().toISOString().slice(0, 10),
        };
        const answer = (items: ChecklistItem[], savedAt: string | null, leftOut = 0) => {
          const docs: ChecklistDoc[] = state.documents
            .filter((d) => !d.deleted_at)
            .filter((d) =>
              canSee(me, {
                visibility: d.visibility ?? 'household',
                owner_member_id: d.owner_member_id ?? null,
              }),
            )
            .map((d) => ({
              id: d.id,
              title: d.title,
              type_key: d.type_key ?? null,
              owner_member_id: d.owner_member_id ?? null,
              visibility: d.visibility ?? 'household',
              issued: d.issued ?? null,
              expires: d.expires ?? null,
              created_at: (d as { created_at?: string }).created_at ?? '2026-01-01T00:00:00.000Z',
              tax_year:
                d.visibility !== 'private' && d.extra?.tax_year != null
                  ? String(d.extra.tax_year as string | number)
                  : null,
              in_collection: l.items.some((i) => i.document_id === d.id),
            }));
          // Every document the one person may see, of any kind: a line is
          // looked for by its title in them too (0.9.0).
          const checked = checkChecklist(
            items.map((i) => itemAgain(i, ctx)),
            docs,
            {
              today: ctx.today,
              audience: l.audience,
              people: ctx.people,
              types: ctx.types,
            },
          );
          const ticked = new Set(
            checked.flatMap((i) => i.matches.filter((m) => m.ticked).map((m) => m.document_id)),
          );
          const out: CollectionChecklist = {
            saved_at: savedAt,
            items: checked,
            missing: checklistMissing(checked),
            to_add: ticked.size,
            left_out: leftOut,
            mine,
          };
          return out;
        };
        if (!checklistAt[2] && init.method === 'GET') {
          // Kept with no lines is none, as the vault answers (0.9.0-dev.39).
          const kept = l.checklist;
          return ok(kept?.items.length ? answer(kept.items, kept.saved_at) : answer([], null));
        }
        if (!checklistAt[2] && init.method === 'POST') {
          if (typeof body.text === 'string') {
            if (body.text.length > CHECKLIST_TEXT_MAX) {
              return fail(422, 'validation_failed', 'That list is too long to read.', 'text');
            }
            const read = readChecklist(body.text, ctx);
            return ok(answer(read.items, null, read.left_out));
          }
          return ok(answer((body.items as ChecklistItem[] | undefined) ?? [], null));
        }
        if (!checklistAt[2] && init.method === 'PUT') {
          const items = ((body.items as ChecklistItem[] | undefined) ?? []).map((i) =>
            savedItem(itemAgain(i, ctx)),
          );
          l.checklist = { items, saved_at: new Date().toISOString() };
          // Cleared (an empty list) is none: no saved_at (0.9.0-dev.39).
          return ok(answer(items, items.length ? l.checklist.saved_at : null));
        }
        if (checklistAt[2] && init.method === 'POST') {
          const asked = [...new Set((body.document_ids as string[] | undefined) ?? [])];
          const added: string[] = [];
          const skipped: ChecklistAdded['skipped'] = [];
          for (const id of asked) {
            const d = state.documents.find((x) => x.id === id && !x.deleted_at);
            const seen =
              d !== undefined &&
              canSee(me, {
                visibility: d.visibility ?? 'household',
                owner_member_id: d.owner_member_id ?? null,
              });
            if (!seen) skipped.push({ document_id: id, why: 'not_found' });
            else if (l.items.some((i) => i.document_id === id)) {
              skipped.push({ document_id: id, why: 'in_collection' });
            } else {
              l.items.push({ document_id: id, added_at: new Date().toISOString() });
              added.push(id);
            }
          }
          const result: ChecklistAdded = { added, skipped, warnings: [], collection: detail(l) };
          return ok(result);
        }
      }
      if (path === '/api/v1/collections' && init.method === 'POST') {
        const refused = manage();
        if (refused) return refused;
        if (body.name === undefined) {
          return fail(422, 'validation_failed', 'Give the collection a name.', 'name');
        }
        if (body.audience === undefined) {
          return fail(422, 'validation_failed', 'Say who the collection is for.', 'audience');
        }
        const asked = fields({ name: '', description: null, audience: 'only_me' });
        if (isResponse(asked)) return asked;
        const at = new Date().toISOString();
        const l: FakeCollection = {
          id: next('collection'),
          ...asked,
          owner_member_id: me.memberId,
          created_at: at,
          updated_at: at,
          revision: 1,
          deleted: false,
          items: [],
        };
        state.collections.push(l);
        return respond(201, detail(l), { etag: collectionTag(l) });
      }
      if (docCollections && init.method === 'GET') {
        const doc = state.documents.find(
          (d) => d.id === decodeURIComponent(docCollections[1] as string),
        );
        if (!doc) return fail(404, 'not_found', 'That document is not in the vault.');
        const on = state.collections.filter(
          (l) => shown(l) && l.items.some((i) => i.document_id === doc.id),
        );
        return ok({ items: on.sort(byName).map(collectionView) });
      }
      /** Whether the one person may see a document, out of the Trash. */
      const seesDoc = (id: string) => {
        const d = state.documents.find((x) => x.id === id && !x.deleted_at);
        return (
          d !== undefined &&
          canSee(me, {
            visibility: d.visibility ?? 'household',
            owner_member_id: d.owner_member_id ?? null,
          })
        );
      };
      const notYours = () =>
        fail(
          403,
          'forbidden',
          'Only the person who made this collection, or someone they chose to manage it, can change it.',
        );
      const noLongerYours = () =>
        fail(
          403,
          'forbidden',
          'This collection is for people you are no longer one of. You can still delete it, but not change it.',
        );
      /** A refusal of `power`, as the real vault words it, or null when the one person has it. */
      const refusedFor = (
        l: FakeCollection,
        power: 'edit' | 'audience' | 'delete' | 'managers',
      ): ResponseLike | null => {
        const powers = powersOf(l);
        const has =
          power === 'edit'
            ? powers.edit
            : power === 'audience'
              ? powers.change_audience
              : power === 'delete'
                ? powers.delete
                : powers.choose_managers;
        if (has) return null;
        if (powers.maker) return noLongerYours();
        if (power === 'managers') {
          return fail(
            403,
            'forbidden',
            'Only the person who made this collection, or a manager they let, can choose who manages it.',
          );
        }
        if (powers.manager && power === 'audience') {
          return fail(
            403,
            'forbidden',
            'You manage this collection, but only the person who made it, or a manager they let, can change who it’s for.',
          );
        }
        if (powers.manager && power === 'delete') {
          return fail(
            403,
            'forbidden',
            'You manage this collection, but only the person who made it, or a manager they let, can delete it.',
          );
        }
        return notYours();
      };
      if (collectionAt) {
        const found = state.collections.find(
          (x) => x.id === decodeURIComponent(collectionAt[1] as string),
        );
        const l = found && shown(found) ? found : undefined;
        const mine = l !== undefined && l.owner_member_id === me.memberId;
        // Its maker deletes it whatever their role now; anybody else needs
        // collection.manage, and then a manager its maker let, or an owner
        // one nobody may change any more.
        if (!collectionAt[2] && init.method === 'DELETE') {
          const refused = mine ? null : manage();
          if (refused) return refused;
          if (!l) return fail(404, 'not_found', 'That collection does not exist.');
          const no = refusedFor(l, 'delete');
          if (no) return no;
          l.deleted = true;
          leavesGrants(l.id);
          return empty();
        }
        const changing = init.method !== 'GET';
        const refused = changing ? manage() : null;
        if (refused) return refused;
        if (!l) return fail(404, 'not_found', 'That collection does not exist.');
        if (!collectionAt[2] && init.method === 'GET') {
          const page = paged(l);
          return isResponse(page) ? page : respond(200, page, { etag: collectionTag(l) });
        }
        if (changing) {
          const no = refusedFor(l, 'edit');
          if (no) return no;
        }
        if (!collectionAt[2] && init.method === 'PATCH') {
          const ifMatch = init.headers['if-match'];
          if (ifMatch && ifMatch !== collectionTag(l)) {
            return fail(
              409,
              'conflict',
              'This collection was changed since you opened it. Reload and try again.',
              JSON.stringify(detail(l)),
            );
          }
          if (body.audience !== undefined && body.audience !== l.audience) {
            const no = refusedFor(l, 'audience');
            if (no) return no;
            if (body.audience === 'only_me' && !mine) {
              return fail(
                403,
                'forbidden',
                'Only the person who made this collection can make it Only me.',
              );
            }
            // Never leaving its maker outside their own collection.
            const makerRole = roleOf(l.owner_member_id);
            if (
              !mine &&
              (!makerRole || !inCollectionAudience(makerRole, body.audience as CollectionAudience))
            ) {
              const name = state.members.find((m) => m.id === l.owner_member_id)?.display_name;
              return fail(
                422,
                'validation_failed',
                `That would leave ${name ?? 'the person who made it'} unable to see their own collection.`,
                'audience',
              );
            }
          }
          const asked = fields(l);
          if (isResponse(asked)) return asked;
          if (
            asked.name !== l.name ||
            asked.description !== l.description ||
            asked.audience !== l.audience
          ) {
            const wasEveryone = l.audience === 'everyone';
            Object.assign(l, asked, { updated_at: new Date().toISOString() });
            l.revision += 1;
            // Made for fewer than Everyone, it leaves every grant (0055).
            if (wasEveryone && l.audience !== 'everyone') leavesGrants(l.id);
            // Made for fewer people, its managers outside it go (0095).
            if (l.managers) {
              l.managers = l.managers.filter((m) => mayManage(m.member_id, l.audience));
            }
          }
          return respond(200, detail(l), { etag: collectionTag(l) });
        }
        if (collectionAt[2] && !collectionAt[3] && init.method === 'POST') {
          const ids = [...new Set((body.document_ids as string[] | undefined) ?? [])];
          if (ids.length === 0) {
            return fail(422, 'validation_failed', 'Choose a document to put in the collection.');
          }
          // Each one the one person can see, or none is put in.
          if (!ids.every(seesDoc)) {
            return fail(404, 'not_found', 'That document is not in the vault.');
          }
          for (const id of ids) {
            if (l.items.some((i) => i.document_id === id)) continue;
            l.items.push({ document_id: id, added_at: new Date().toISOString() });
          }
          return respond(200, detail(l), { etag: collectionTag(l) });
        }
        if (collectionAt[3] && init.method === 'DELETE') {
          const id = decodeURIComponent(collectionAt[3]);
          // One they cannot see is not there, whatever is in it.
          if (!seesDoc(id)) return fail(404, 'not_found', 'That document is not in the vault.');
          const at = l.items.findIndex((i) => i.document_id === id);
          if (at < 0) return fail(404, 'not_found', 'That document is not in this collection.');
          l.items.splice(at, 1);
          return empty();
        }
      }
      // Who manages a collection besides its maker (0.9.0), as the real vault
      // keeps them: the family who see it read them; its maker, or a manager
      // who may choose managers, changes them, giving only what they may do.
      if (managersAt) {
        if (!family()) {
          return fail(403, 'forbidden', 'A collection’s managers are for the family who see it.');
        }
        const found = state.collections.find(
          (x) => x.id === decodeURIComponent(managersAt[1] as string),
        );
        const l = found && shown(found) ? found : undefined;
        if (!l) return fail(404, 'not_found', 'That collection does not exist.');
        const answer = (): CollectionManagers => {
          const powers = powersOf(l);
          const managing = new Set((l.managers ?? []).map((m) => m.member_id));
          return {
            items: managersOf(l),
            eligible: powers.choose_managers
              ? state.members
                  .filter(
                    (m) =>
                      m.id !== l.owner_member_id &&
                      !managing.has(m.id) &&
                      mayManage(m.id, l.audience),
                  )
                  .map((m) => ({ member_id: m.id, display_name: m.display_name }))
                  .sort((a, b) => a.display_name.localeCompare(b.display_name))
              : [],
            my_powers: powers,
          };
        };
        if (init.method === 'GET' && !managersAt[2]) return ok(answer());
        // Taking one away is also an owner's while its maker may not change it.
        const removing = init.method === 'DELETE' && managersAt[2] !== undefined;
        const refused =
          manage() ?? (removing && powersOf(l).remove_managers ? null : refusedFor(l, 'managers'));
        if (refused) return refused;
        const powers = powersOf(l);
        const switches = ['may_change_audience', 'may_delete', 'may_choose_managers'] as const;
        const powerOf = {
          may_change_audience: powers.change_audience,
          may_delete: powers.delete,
          may_choose_managers: powers.choose_managers,
        };
        const onlyWhatYouMay = () =>
          fail(403, 'forbidden', 'You can only let a manager do what you can do yourself.');
        const theMaker = () =>
          fail(
            422,
            'validation_failed',
            'The person who made this collection can already do everything with it, and can’t be taken away.',
            'member_id',
          );
        if (init.method === 'POST' && !managersAt[2]) {
          const memberId = body.member_id as string | undefined;
          if (!memberId) {
            return fail(422, 'validation_failed', 'Choose who will manage it.', 'member_id');
          }
          if (memberId === l.owner_member_id) return theMaker();
          const person = state.members.find((m) => m.id === memberId);
          if (!person || !mayManage(memberId, l.audience)) {
            return fail(
              422,
              'validation_failed',
              `${person?.display_name ?? 'That person'} can’t manage this collection: only someone in the family with a sign-in who can already see it can.`,
              'member_id',
            );
          }
          if ((l.managers ?? []).some((m) => m.member_id === memberId)) {
            return fail(409, 'conflict', `${person.display_name} already manages this collection.`);
          }
          const asked = Object.fromEntries(switches.map((s) => [s, body[s] === true])) as Record<
            (typeof switches)[number],
            boolean
          >;
          if (!powers.maker && switches.some((s) => asked[s] && !powerOf[s])) {
            return onlyWhatYouMay();
          }
          l.managers = [
            ...(l.managers ?? []),
            { member_id: memberId, ...asked, added_at: new Date().toISOString() },
          ];
          return respond(201, answer());
        }
        const memberId = decodeURIComponent(managersAt[2] ?? '');
        if (memberId === l.owner_member_id) return theMaker();
        const at = (l.managers ?? []).findIndex((m) => m.member_id === memberId);
        if (at < 0) return fail(404, 'not_found', 'That person doesn’t manage this collection.');
        const was = (l.managers ?? [])[at] as NonNullable<FakeCollection['managers']>[number];
        if (init.method === 'PATCH') {
          const now = { ...was };
          for (const s of switches) if (typeof body[s] === 'boolean') now[s] = body[s];
          if (!powers.maker && switches.some((s) => now[s] && !was[s] && !powerOf[s])) {
            return onlyWhatYouMay();
          }
          (l.managers ?? []).splice(at, 1, now);
          return ok(answer());
        }
        if (init.method === 'DELETE') {
          (l.managers ?? []).splice(at, 1);
          return empty();
        }
      }
    }
    // What came in through a request, looked at before it is filed (0.5.23):
    // the reviewer's side. A teen or a viewer is told there is nothing here.
    const incomingAt =
      /^\/api\/v1\/incoming(?:\/([^/]+)\/(pages\/(\d+)|content|accept|reject))?$/.exec(path);
    if (incomingAt) {
      const s = session();
      if (!('id' in s)) return s;
      const notHere = () => fail(404, 'not_found', 'That file is not waiting for you.');
      if (!can(state.role, 'upload_request.create')) return notHere();
      const [, id, what, n] = incomingAt;
      if (!id && init.method === 'GET') {
        return ok({
          items: state.incoming
            .filter((f) => !f.decided)
            .map(({ bytes: _bytes, decided: _decided, ...view }) => view),
        });
      }
      const f = state.incoming.find((x) => x.id === decodeURIComponent(id ?? ''));
      if (!f) return notHere();
      const decided = () =>
        fail(409, 'already_decided', 'Somebody has filed or refused this file already.');
      const notReady = () =>
        respond(409, {
          error: {
            code: 'incoming_not_ready',
            message: 'This file is still being got ready to look at. Try again in a minute.',
            retriable: true,
            request_id: 'fake',
          },
        });
      if (what?.startsWith('pages/') && init.method === 'GET') {
        if (f.decided) return decided();
        if (f.preview_state === 'pending') {
          return fail(404, 'preview_pending', 'The preview is being made. Try again in a moment.');
        }
        if (f.preview_state !== 'ready' || Number(n) > (f.preview_pages ?? 0)) {
          return fail(404, 'no_preview', "There's no preview of this page.");
        }
        return picture(FAKE_PAGE);
      }
      if (what === 'content' && init.method === 'GET') {
        if (f.decided) return decided();
        if (f.scan_state === 'pending') return notReady();
        return attachment(f.bytes, {
          'content-type': f.content_type,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(incomingFileName(f.name, f.content_type))}`,
          'x-content-type-options': 'nosniff',
          ...(f.scan_state === 'clean' ? {} : { 'x-fdv-scan': 'unscanned' }),
        });
      }
      if (what === 'reject' && init.method === 'POST') {
        if (f.decided) return decided();
        f.decided = 'rejected';
        return empty();
      }
      if (what === 'accept' && init.method === 'POST') {
        if (f.decided) return decided();
        const into = typeof body.into_document_id === 'string' ? body.into_document_id : null;
        const fields = [
          'owner_member_id',
          'household_owned',
          'sensitive',
          'type_key',
          'title',
          'visibility',
        ];
        if (into && fields.some((k) => body[k] !== undefined)) {
          return fail(
            422,
            'validation_failed',
            'Add it to a document, or make a new one with these details: not both.',
          );
        }
        if (f.scan_state === 'pending') return notReady();
        let documentId: string;
        if (into) {
          if (!state.documents.some((d) => d.id === into)) {
            return fail(404, 'not_found', 'That document is not in the vault.');
          }
          documentId = into;
        } else {
          const metadata: CaptureMetadata = {
            ...(body.owner_member_id !== undefined
              ? { owner_member_id: body.owner_member_id as string | null }
              : {}),
            ...(body.household_owned !== undefined
              ? { household_owned: body.household_owned as boolean }
              : {}),
            ...(body.sensitive !== undefined
              ? { sensitive: body.sensitive as boolean | null }
              : {}),
            ...(body.type_key !== undefined ? { type_key: body.type_key as string | null } : {}),
            ...(body.title !== undefined ? { title: (body.title as string | null) || null } : {}),
            ...(body.visibility !== undefined ? { visibility: body.visibility as Visibility } : {}),
          };
          const problem = checkCaptureMetadata(metadata, {
            me: { member_id: 'fake-member', role: state.role },
            members: state.members,
            types: state.types,
          });
          // Refused as the vault refuses it, naming the detail: a kind the
          // household does not have included (not filed with no kind, as a
          // phone's queued capture is: this is chosen now, from the list).
          if (problem) {
            return fail(
              problem.status,
              problem.status === 403 ? 'forbidden' : 'validation_failed',
              problem.message,
              problem.key ?? problem.field,
            );
          }
          const doc: FakeDocument = {
            id: next('document'),
            title: metadata.title ?? null,
            type_key: metadata.type_key ?? null,
            ...whoseNew(
              metadata,
              state.types.find((t) => t.key === metadata.type_key),
            ),
            ...ownSensitive(metadata),
            visibility: effectiveVisibility(
              metadata,
              state.types.find((t) => t.key === metadata.type_key),
              state.role,
            ),
          };
          state.documents.push(doc);
          documentId = doc.id;
        }
        const made: FakeUpload = {
          kind: into ? 'version' : 'capture',
          document_id: documentId,
          version_id: next('version'),
          version_no: versionsOf(documentId).length + 1,
          filename: incomingFileName(f.name, f.content_type),
          mime: f.content_type,
          byte_size: f.bytes.length,
          uploaded_at: new Date().toISOString(),
          bytes: f.bytes,
        };
        // Kept as an upload is, under a key nobody will send.
        state.captures.set(next('incoming-upload'), made);
        f.decided = 'accepted';
        return ok({ document_id: documentId, version_id: made.version_id }, 201);
      }
    }
    // How many of the caller's own items wait, every batch together: theirs alone.
    if (path === '/api/v1/batches/counts' && (init.method ?? 'GET') === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      const who = whoOf(s);
      if (!can(who.role, 'document.add')) {
        return fail(403, 'forbidden', refusalFor('document.add'));
      }
      const waiting = state.batches
        .filter((b) => b.member_id === who.memberId)
        .reduce((n, b) => n + b.items.filter((it) => it.state === 'waiting').length, 0);
      return ok({ waiting });
    }
    // The Reading check (0.9.0, R0): an owner's, every route.
    if (path === '/api/v1/reading-checks' || path.startsWith('/api/v1/reading-checks/')) {
      const s = session();
      if (!('id' in s)) return s;
      const who = whoOf(s);
      if (who.role !== 'owner')
        return fail(403, 'forbidden', 'Only an owner can run the Reading check.');
      const checks = (state.readingChecks ??= []);
      const seesDoc = (d: FakeDocument) =>
        !d.deleted_at &&
        canSee(
          { role: who.role, memberId: who.memberId },
          {
            visibility: d.visibility ?? 'household',
            owner_member_id: d.owner_member_id ?? null,
          },
        );
      /** Documents filed through review the caller can see: an accepted item's, newest first. */
      const filed = () =>
        state.batches
          .flatMap((b) => b.items)
          .filter((it) => it.state === 'accepted' && it.document_id)
          .reverse()
          .flatMap((it) => {
            const d = state.documents.find((x) => x.id === it.document_id);
            return d && seesDoc(d) ? [{ d, it }] : [];
          });
      const shown = (c: FakeReadingCheck): ReadingCheckView => ({
        ...c.view,
        mine: c.member_id === who.memberId,
      });
      /** Read as the fake reads: what each item's pages proposed, Ready when it is all there. */
      const run = (c: FakeReadingCheck) => {
        const docs = filed().slice(0, c.view.n);
        const rows: ReadingRow[] = docs.map(({ d, it }) => {
          const p = it.proposal ?? null;
          const kind = p?.type_key?.value ?? null;
          const person = p?.owner_member_id?.value ?? null;
          return {
            document_id: d.id,
            only_me: d.visibility === 'private',
            mode: 'text',
            truth: {
              kind: d.type_key ?? null,
              person: d.owner_member_id ?? null,
              issued: d.issued?.date ?? null,
              expires: d.expires?.date ?? null,
              number: d.identifier ?? null,
              issuer: d.issued_by ?? null,
            },
            seen: {
              level: !p ? null : kind && person ? 'ready' : kind ? 'check' : 'unrecognised',
              duplicate: false,
              failure: p ? null : 'not_read',
              kind,
              person,
              issued: p?.issued?.value.date ?? null,
              expires: p?.expires?.value.date ?? null,
              number: p?.identifier?.value ?? null,
              issuer: p?.issued_by?.value ?? null,
            },
          };
        });
        const expiring = (k: string) =>
          state.types.some((t) => t.key === k && t.expiry_driver !== null);
        const scored = scoreReading(rows, expiring);
        const summary: ReadingCheckSummary = {
          chosen: rows.length,
          read: rows.length,
          skipped: 0,
          edited: 0,
          partly_confirmed: 0,
          without_rules: scored.result,
          with_rules: scored.result,
        };
        if (!numbersOnly(summary)) throw new Error('a check’s summary must be numbers only');
        const now = new Date().toISOString();
        c.view = {
          ...c.view,
          state: 'done',
          started_at: now,
          finished_at: now,
          progress: { total: rows.length, done: rows.length },
          reader: { server_version: FAKE_SERVER_VERSION, rules: '000000000000' },
          summary,
        };
        c.misses = scored.misses;
        c.misses_until = new Date(Date.now() + READING_MISSES_KEEP_DAYS * 86_400_000).toISOString();
      };
      const tick = () => {
        for (const c of checks) {
          if (c.view.state === 'waiting' && c.asked++ > 0) run(c);
        }
      };
      if (path === '/api/v1/reading-checks') {
        if (init.method === 'POST') {
          const n = body.n === undefined ? READING_CHECK_N.default : body.n;
          if (
            typeof n !== 'number' ||
            !Number.isInteger(n) ||
            n < READING_CHECK_N.min ||
            n > READING_CHECK_N.max
          ) {
            return fail(422, 'validation_failed', 'Read from 10 to 500 documents.');
          }
          if (checks.some((c) => c.view.state === 'waiting' || c.view.state === 'running')) {
            return fail(
              409,
              'reading_check_running',
              'A Reading check is already running for your household. Wait for it to finish, or cancel it.',
            );
          }
          const me = state.members.find((m) => m.id === who.memberId);
          const c: FakeReadingCheck = {
            view: {
              id: next('check'),
              state: 'waiting',
              failure: null,
              n,
              include_edited: body.include_edited !== false,
              requested_by: { member_id: who.memberId, name: me?.display_name ?? null },
              mine: true,
              created_at: new Date().toISOString(),
              started_at: null,
              finished_at: null,
              progress: { total: 0, done: 0 },
              reader: { server_version: null, rules: null },
              summary: null,
            },
            member_id: who.memberId,
            misses: null,
            misses_until: null,
            asked: 0,
          };
          checks.unshift(c);
          return ok(shown(c), 202);
        }
        tick();
        // The caller's own; the others' only as there, whose and when (R0 review).
        const out: ReadingChecksList = {
          items: checks.filter((c) => c.member_id === who.memberId).map(shown),
          others: checks
            .filter((c) => c.member_id !== who.memberId)
            .map((c) => ({ state: c.view.state, requested_by: c.view.requested_by })),
          filed: filed().length,
        };
        return ok(out);
      }
      const at = /^\/api\/v1\/reading-checks\/([^/]+)(\/cancel)?$/.exec(path);
      // Another owner's check is not there for the caller.
      const c = at
        ? checks.find(
            (x) =>
              x.view.id === decodeURIComponent(at[1] as string) && x.member_id === who.memberId,
          )
        : undefined;
      if (!at || !c) return fail(404, 'not_found', 'That check is not here.');
      if (at[2] && init.method === 'POST') {
        if (c.view.state !== 'waiting' && c.view.state !== 'running') {
          return fail(409, 'reading_check_not_running', 'That check has already finished.');
        }
        c.view = { ...c.view, state: 'cancelled', finished_at: new Date().toISOString() };
        return ok(shown(c));
      }
      if (init.method === 'DELETE') {
        state.readingChecks = checks.filter((x) => x !== c);
        return empty();
      }
      tick();
      const mine = c.member_id === who.memberId && c.misses !== null;
      const seen = new Map(state.documents.filter(seesDoc).map((d) => [d.id, d]));
      const out: ReadingCheckDetail = {
        ...shown(c),
        misses: mine
          ? (c.misses ?? []).flatMap((m) => {
              const d = seen.get(m.document_id);
              return d ? [{ ...m, title: d.title, type_key: d.type_key ?? null }] : [];
            })
          : null,
        misses_until: mine ? c.misses_until : null,
      };
      return ok(out);
    }
    // What the vault learned from the caller's corrections (I4): theirs alone.
    if (path === '/api/v1/batches/learned') {
      const s = session();
      if (!('id' in s)) return s;
      const who = whoOf(s);
      if (!can(who.role, 'document.add')) {
        return fail(403, 'forbidden', refusalFor('document.add'));
      }
      if (init.method === 'DELETE') {
        delete state.learned[who.memberId];
        // What the rules said on an item already read is let go: read again (I4-7).
        for (const b of state.batches.filter((x) => x.member_id === who.memberId)) {
          for (const it of b.items) {
            const said =
              (Object.values(it.proposal ?? {}) as Array<Proposed<unknown>>).some(isLearned) ||
              Object.keys(it.learned_clash ?? {}).length > 0;
            if (it.state === 'waiting' && it.reading === 'read' && said) {
              it.reading = 'waiting';
              it.proposal = null;
              it.learned_clash = null;
              it.paper = null;
            }
          }
        }
        return empty();
      }
      const mine = state.learned[who.memberId] ?? { rules: [], outcomes: [] };
      const counted = mine.outcomes.slice(0, LEARNING_WINDOW);
      const out: BatchLearning = {
        counted: counted.length,
        unchanged: counted.filter((o) => o.unchanged).length,
        window: LEARNING_WINDOW,
        rules: [...mine.rules]
          .sort(
            (a, b) =>
              a.issuer_key.localeCompare(b.issuer_key) ||
              (a.field === b.field ? 0 : a.field === 'type_key' ? -1 : 1) ||
              b.confirmed - a.confirmed,
          )
          .map((r) => ({
            id: r.id,
            issuer: r.issuer_key,
            field: r.field,
            value: r.value,
            label:
              r.field === 'type_key'
                ? (state.types.find((t) => t.key === r.value)?.label ?? null)
                : (state.members.find((m) => m.id === r.value)?.display_name ?? null),
            confirmed: r.confirmed,
            contradicted: r.contradicted,
            sure: ruleTrusted(r, mine.rules),
            last_used: r.last_used,
          })),
        rules_max: LEARNED_RULES_MAX,
        // The layouts of senders' papers (R1), newest first.
        shapes: [...(mine.shapes ?? [])]
          .sort(
            (a, b) => b.last_used.localeCompare(a.last_used) || a.issuer.localeCompare(b.issuer),
          )
          .map((sh) => ({
            id: sh.id,
            issuer: sh.issuer,
            words: sh.words.length,
            lessons: sh.lessons.map((l) => ({
              field: l.field,
              value: l.value,
              label:
                l.field === 'type_key'
                  ? (state.types.find((t) => t.key === l.value)?.label ?? null)
                  : l.field === 'owner_member_id'
                    ? (state.members.find((m) => m.id === l.value)?.display_name ?? null)
                    : l.value,
              confirmed: l.confirmed,
              contradicted: l.contradicted,
              sure: lessonTrusted(l, sh),
            })),
            last_used: sh.last_used,
          })),
        shapes_max: SHAPES_MAX,
      };
      return ok(out);
    }
    // Many documents at once (Phase 6, I1): a batch and its items are their
    // uploader's alone (404 for anybody else's); a viewer or a guest is
    // refused, as adding is.
    const batchAt =
      /^\/api\/v1\/batches(?:\/([^/]+)(?:(\/items(?:\/([^/]+)(?:\/(accept)|\/pages\/(\d+))?)?)|\/(accept-ready)(\/undo)?)?)?$/.exec(
        path,
      );
    if (batchAt) {
      const s = session();
      if (!('id' in s)) return s;
      const who = whoOf(s);
      if (!can(who.role, 'document.add')) {
        return fail(403, 'forbidden', refusalFor('document.add'));
      }
      const [, rawId, items, rawItem, accept, page, acceptReady, undo] = batchAt;
      const asked = /[?&]with=([^&]*)/.exec(url);
      const id = rawId ? decodeURIComponent(rawId) : undefined;
      const itemId = rawItem ? decodeURIComponent(rawItem) : undefined;
      const mine = state.batches.filter((b) => b.member_id === who.memberId);
      // The kinds as the uploader's card is given them: a hidden one only
      // while a document uses it (the I3 review, W-I3-10).
      const cardTypes = state.types.filter(
        (t) => !t.hidden || state.documents.some((d) => d.type_key === t.key && !d.deleted_at),
      );
      const reader = { role: who.role, memberId: who.memberId };
      /** Each item's duplicate: a document the caller can see, or an earlier item of theirs. */
      const duplicateOf = (b: FakeBatch, it: FakeBatchItem): BatchDuplicate | null => {
        if (it.state !== 'waiting') return null;
        for (const [docId, hash] of filedFrom) {
          const d = state.documents.find((x) => x.id === docId && !x.deleted_at);
          if (
            hash === it.sha256 &&
            d &&
            canSee(reader, {
              visibility: d.visibility ?? 'household',
              owner_member_id: d.owner_member_id ?? null,
            })
          ) {
            return { of: 'document', document_id: d.id, title: d.title };
          }
        }
        const earlier = mine
          .flatMap((o) => o.items.map((x) => ({ batch: o, x })))
          .filter(
            ({ x }) =>
              x.state === 'waiting' &&
              x.sha256 === it.sha256 &&
              x.id !== it.id &&
              x.arrived_at <= it.arrived_at &&
              (x.arrived_at < it.arrived_at || x.id < it.id),
          )
          .sort((a, c) => (a.batch.id === b.id ? -1 : c.batch.id === b.id ? 1 : 0));
        const first = earlier[0];
        return first
          ? {
              of: 'item',
              batch_id: first.batch.id,
              batch_name: first.batch.name,
              batch_created_at: first.batch.created_at,
              item_id: first.x.id,
              same_batch: first.batch.id === b.id,
            }
          : null;
      };
      const itemView = (b: FakeBatch, it: FakeBatchItem): BatchItemView => {
        const itemState = it.state === 'accepted' ? 'accepted' : 'waiting';
        const reading = it.reading ?? 'waiting';
        const failure = reading === 'failed' ? (it.read_failure ?? 'unreadable') : null;
        const duplicate = duplicateOf(b, it);
        const people = state.members
          .filter((m) => (m.kind ?? 'family') === 'family')
          .map((m) => ({ id: m.id, name: m.display_name }));
        // What its folder suggests to its uploader now (S2): the kinds, the
        // family (a teen themselves alone) and the tags they can see.
        const folder =
          it.folder && itemState === 'waiting'
            ? suggestFromFolder(it.folder, {
                types: cardTypes,
                people,
                choosable: (id) => who.role !== 'teen' || id === who.memberId,
                // Each tag with the widest a document it is on is seen, as the vault gives it.
                tags: state.documents
                  .filter(
                    (d) =>
                      !d.deleted_at &&
                      canSee(reader, {
                        visibility: d.visibility ?? 'household',
                        owner_member_id: d.owner_member_id ?? null,
                      }),
                  )
                  .flatMap((d) =>
                    (d.tags ?? []).map((t) => ({
                      value: t,
                      visibility: d.visibility ?? 'household',
                    })),
                  ),
                household: state.householdName ?? null,
              })
            : null;
        // Levelled as the vault levels it (I2): the pages, the defaults and the kinds now.
        const levelled = levelItem({
          state: itemState,
          reading,
          failure,
          proposal: reading === 'read' ? (it.proposal ?? null) : null,
          learnedClash: reading === 'read' ? (it.learned_clash ?? null) : null,
          duplicate,
          folder,
          defaults: b.defaults,
          types: cardTypes,
          people,
          role: who.role,
          me: who.memberId,
        });
        return {
          id: it.id,
          batch_id: b.id,
          name: it.name,
          content_type: it.content_type,
          byte_size: it.byte_size,
          sha256: it.sha256,
          arrived_at: it.arrived_at,
          state: itemState,
          reading,
          read_failure: failure,
          // Accepted, its pages went with its bytes (the I1 review).
          preview_state: it.state === 'accepted' ? 'none' : 'unsupported',
          preview_pages: null,
          duplicate,
          document_id: it.state === 'accepted' ? it.document_id : null,
          level: levelled.level,
          tags: levelled.tags,
          proposals: levelled.proposals,
          clashes: levelled.clashes,
          folder: it.folder ?? null,
        };
      };
      const batchView = (b: FakeBatch, withItems: boolean, withLevels = false) => {
        const kept = b.items.filter((x) => x.state !== 'removed').map((x) => itemView(b, x));
        // Each level counted, asked for (I3): the waiting items as they are levelled now.
        const levels: BatchLevelCounts = {
          ready: 0,
          check: 0,
          unrecognised: 0,
          problem: 0,
          unread: 0,
        };
        for (const x of kept) if (x.state === 'waiting') levels[x.level ?? 'unread'] += 1;
        return {
          id: b.id,
          name: b.name,
          created_at: b.created_at,
          ends_at: b.ends_at,
          defaults: {
            ...b.defaults,
            physical_location: seesLocation(who.role) ? b.defaults.physical_location : null,
          },
          counts: {
            items: kept.length,
            waiting: kept.filter((x) => x.state === 'waiting').length,
            accepted: kept.filter((x) => x.state === 'accepted').length,
            removed: b.items.filter((x) => x.state === 'removed').length,
            duplicates: kept.filter((x) => x.state === 'waiting' && x.duplicate).length,
          },
          ...(withLevels ? { levels } : {}),
          ...(withItems ? { items: kept } : {}),
        };
      };
      /** The defaults sent, checked as the real vault checks them; a refusal, or what to keep. */
      const defaultsOf = (
        sent: Partial<BatchDefaults>,
        current: BatchDefaults,
      ): BatchDefaults | ResponseLike => {
        const d = { ...current, ...sent };
        if (sent.owner_member_id) {
          if (who.role === 'teen' && sent.owner_member_id !== who.memberId) {
            return fail(403, 'forbidden', 'You can only add documents that belong to you.');
          }
          if (!state.members.some((m) => m.id === sent.owner_member_id)) {
            return fail(
              422,
              'validation_failed',
              'That person is not in the family.',
              'owner_member_id',
            );
          }
        }
        if (sent.type_key && !state.types.some((t) => t.key === sent.type_key)) {
          return fail(
            422,
            'validation_failed',
            'That kind of document is not on the list.',
            'type_key',
          );
        }
        if (sent.visibility === 'adults' && !can(who.role, 'document.see_adults')) {
          return fail(403, 'forbidden', 'Only an adult can make a document adults-only.');
        }
        // Sensitive (0.9.0, AIR2): never "no" from a teen.
        if (who.role === 'teen' && sent.sensitive === false) {
          return fail(403, 'forbidden', TEEN_KEEPS_SENSITIVE, 'sensitive');
        }
        // A batch made Only me is the uploader's own (the I1 review).
        if (d.visibility === 'private') {
          if (d.owner_member_id !== null && d.owner_member_id !== who.memberId) {
            return fail(422, 'validation_failed', PRIVATE_TO_THEM, 'visibility');
          }
          d.owner_member_id = who.memberId;
        }
        if (sent.collection_id) {
          const c = state.collections.find((x) => x.id === sent.collection_id && !x.deleted);
          if (!c) return fail(404, 'not_found', 'That collection does not exist.');
          if (c.owner_member_id !== who.memberId) {
            return fail(
              403,
              'forbidden',
              'Only the person who made this collection can change it.',
            );
          }
        }
        return {
          ...d,
          physical_location: d.physical_location?.trim() || null,
          tags: tagsOf(d.tags),
        };
      };
      if (!id && !items && init.method === 'POST') {
        const blank: BatchDefaults = {
          owner_member_id: null,
          type_key: null,
          visibility: null,
          physical_location: null,
          collection_id: null,
          tags: [],
          is_essential: false,
          sensitive: null,
        };
        const defaults = defaultsOf(body.defaults ?? {}, blank);
        if (isResponse(defaults)) return defaults;
        const now = new Date();
        const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
        if (name.length > 120)
          return fail(422, 'validation_failed', 'A batch’s name is too long.', 'name');
        const b: FakeBatch = {
          id: next('batch'),
          member_id: who.memberId,
          name: name || null,
          created_at: now.toISOString(),
          ends_at: new Date(now.getTime() + 30 * 864e5).toISOString(),
          defaults,
          items: [],
        };
        state.batches.push(b);
        return ok(batchView(b, true), 201);
      }
      if (!id && init.method === 'GET') {
        const levels = asked ? decodeURIComponent(asked[1] ?? '') : null;
        if (levels !== null && levels !== 'levels') {
          return fail(422, 'validation_failed', 'with: only levels.', 'with');
        }
        return ok({
          items: [...mine].reverse().map((b) => batchView(b, false, levels === 'levels')),
        });
      }
      const b = mine.find((x) => x.id === id);
      if (!b) return fail(404, 'not_found', 'That batch is not here.');
      // Accept all Ready (I3): the items Ready now, each as its untouched card
      // would file it; and taken back while it may be.
      if (acceptReady && !undo && init.method === 'POST') {
        const named = Array.isArray(body.item_ids) ? (body.item_ids as string[]) : null;
        if (named && named.length > ACCEPT_READY_MAX) {
          return fail(422, 'validation_failed', 'Too many at once.', 'item_ids');
        }
        const readyNow = b.items.filter(
          (x) => x.state === 'waiting' && itemView(b, x).level === 'ready',
        );
        const ids = named ?? readyNow.slice(0, ACCEPT_READY_MAX).map((x) => x.id);
        const out: BatchAcceptReadyResult = {
          accepted: [],
          skipped: [],
          failed: [],
          undo_until: null,
          more: !named && readyNow.length > ACCEPT_READY_MAX,
        };
        const until = new Date(Date.now() + ACCEPT_UNDO_MINUTES * 60_000).toISOString();
        const family = state.members
          .filter((m) => (m.kind ?? 'family') === 'family')
          .map((m) => ({ id: m.id, display_name: m.display_name }));
        for (const itemId of [...new Set(ids)]) {
          const x = b.items.find((y) => y.id === itemId);
          if (!x) {
            out.skipped.push({ item_id: itemId, reason: 'not_found' });
            continue;
          }
          if (x.state !== 'waiting') {
            out.skipped.push({ item_id: itemId, reason: 'decided' });
            continue;
          }
          const view = itemView(b, x);
          if (view.level !== 'ready' || !view.proposals) {
            out.skipped.push({ item_id: itemId, reason: 'not_ready', level: view.level ?? null });
            continue;
          }
          const card = untouchedAccept({
            proposals: view.proposals,
            defaults: b.defaults,
            types: cardTypes,
            people: family,
            role: who.role,
            me: who.memberId,
          });
          const res = fileOne(b, x, card, who, {
            read: view.reading === 'read',
            proposals: view.proposals,
            paper: view.reading === 'read' ? (x.paper ?? null) : null,
            reviewed: false,
            level: view.level ?? null,
          });
          const answer = (await res.json()) as {
            document_id?: string;
            version_id?: string;
            error?: { code: string; message: string };
          };
          if (res.status !== 201 || !answer.document_id) {
            out.failed.push({
              item_id: itemId,
              code: answer.error?.code ?? 'not_accepted',
              message: answer.error?.message ?? 'It could not be accepted just then.',
            });
            continue;
          }
          x.undo_until = until;
          out.accepted.push({
            item_id: itemId,
            document_id: answer.document_id,
            version_id: answer.version_id as string,
          });
        }
        out.undo_until = out.accepted.length > 0 ? until : null;
        return ok(out);
      }
      if (acceptReady && undo && init.method === 'POST') {
        const ids = Array.isArray(body.item_ids) ? [...new Set(body.item_ids as string[])] : [];
        if (ids.length === 0) return fail(422, 'validation_failed', 'Name the files.', 'item_ids');
        const out: BatchUndoResult = { restored: [], kept: [] };
        for (const itemId of ids) {
          const x = b.items.find((y) => y.id === itemId);
          const keep = (reason: UndoKept, message: string) =>
            out.kept.push({ item_id: itemId, reason, message });
          if (!x) {
            keep('not_found', 'That file is not in this batch.');
            continue;
          }
          if (x.state !== 'accepted' || !x.undo_until) {
            keep('not_undoable', 'It was not filed by Accept all Ready.');
            continue;
          }
          if (new Date(x.undo_until).getTime() <= Date.now()) {
            keep('too_late', 'It is too late to take it back.');
            continue;
          }
          const docAt = state.documents.findIndex((d) => d.id === x.document_id);
          const filed = state.documents[docAt];
          if (!filed || filed.deleted_at) {
            keep('changed', 'Somebody has changed it since.');
            continue;
          }
          // Gone for good, and its item waiting to be read again.
          state.documents.splice(docAt, 1);
          filedFrom.delete(filed.id);
          for (const c of state.collections) {
            c.items = c.items.filter((i) => i.document_id !== filed.id);
          }
          x.state = 'waiting';
          x.document_id = null;
          x.reading = 'waiting';
          delete x.undo_until;
          unlearn(who.memberId, x.id);
          out.restored.push(itemId);
        }
        return ok(out);
      }
      if (!items) {
        if (init.method === 'GET') return ok(batchView(b, true));
        if (init.method === 'PATCH') {
          const defaults = defaultsOf(body.defaults ?? {}, b.defaults);
          if (isResponse(defaults)) return defaults;
          b.defaults = defaults;
          if (body.name !== undefined) {
            b.name = typeof body.name === 'string' ? body.name.trim() || null : null;
          }
          return ok(batchView(b, true));
        }
        if (init.method === 'DELETE') {
          state.batches = state.batches.filter((x) => x.id !== b.id);
          return empty();
        }
      }
      if (items && !itemId && init.method === 'POST') {
        // Sent again with the key of one that arrived: that item, a replay.
        const key = init.headers['idempotency-key'];
        if (key !== undefined && !UUID.test(key)) {
          return fail(422, 'validation_failed', 'Idempotency-Key must be a UUID.');
        }
        const before = key ? b.items.find((x) => x.key === key) : undefined;
        if (before?.state === 'removed') {
          return fail(409, 'already_decided', 'This file has been accepted or removed already.');
        }
        if (before) return ok(itemView(b, before), 201);
        const taken = b.items.filter((x) => x.state !== 'removed').length;
        if (taken >= BATCH_MAX_FILES) {
          return fail(422, 'batch_full', `A batch holds ${BATCH_MAX_FILES} files at most.`);
        }
        const parts = partsOf(init.body, init.headers['content-type']) ?? [];
        const files = parts.filter((p) => p.value === null);
        const file = files[0];
        // Where it was under the folder chosen (S2): one field, before the file.
        const fields = parts.filter((p) => p.value !== null);
        const path = fields[0];
        if (
          !file ||
          files.length > 1 ||
          fields.length > 1 ||
          (path && (path.name !== 'relative_path' || parts[0] !== path))
        ) {
          return fail(
            422,
            'validation_failed',
            'Send one file, named file, and nothing else but a relative_path before it.',
          );
        }
        if (path && new TextEncoder().encode(path.value ?? '').length > RELATIVE_PATH_MAX) {
          return fail(
            422,
            'validation_failed',
            `A relative_path is ${RELATIVE_PATH_MAX} bytes at most.`,
          );
        }
        const type = (file.type ?? '').split(';')[0] ?? '';
        if (!/^(application\/pdf|image\/(jpeg|png|heic|heif|tiff|webp))$/.test(type)) {
          return fail(415, 'unsupported_type', 'That kind of file cannot be stored here.');
        }
        const folder = itemFolder(path?.value ?? null, { fileName: file.filename ?? null });
        const it: FakeBatchItem = {
          id: next('item'),
          name: file.filename ?? 'file',
          content_type: type,
          byte_size: file.size ?? 0,
          sha256: standInHash(file.bytes ?? new Uint8Array()),
          arrived_at: new Date().toISOString(),
          state: 'waiting',
          document_id: null,
          ...(key ? { key } : {}),
          ...(folder ? { folder } : {}),
          ...(file.bytes ? { bytes: file.bytes } : {}),
        };
        b.items.push(it);
        return ok(itemView(b, it), 201);
      }
      const it = b.items.find((x) => x.id === itemId && x.state !== 'removed');
      const decided = () =>
        fail(409, 'already_decided', 'This file has been accepted or removed already.');
      if (!it) {
        return b.items.some((x) => x.id === itemId)
          ? decided()
          : fail(404, 'not_found', 'That file is not waiting in this batch.');
      }
      if (page && init.method === 'GET') {
        if (it.state !== 'waiting') return decided();
        return fail(404, 'no_preview', "There's no preview of this page.");
      }
      if (!accept && init.method === 'DELETE') {
        if (it.state !== 'waiting') return decided();
        it.state = 'removed';
        return empty();
      }
      if (accept && init.method === 'POST') {
        if (it.state !== 'waiting') return decided();
        // What its card started from: what the accept is compared with (I4).
        const view = itemView(b, it);
        return fileOne(b, it, body, who, {
          read: view.reading === 'read',
          proposals: view.proposals ?? null,
          paper: view.reading === 'read' ? (it.paper ?? null) : null,
          reviewed: true,
          level: view.level ?? null,
        });
      }
    }
    // Many documents at once, filed (I1): one item, as its accept sends it.
    // Accept all Ready files each of its items so too (I3).
    function fileOne(
      b: FakeBatch,
      it: FakeBatchItem,
      sent: BatchAcceptInput,
      who: { role: Role; memberId: string },
      learn: {
        read: boolean;
        proposals: ItemProposals | null;
        paper?: PaperReading | null;
        /** Looked at and accepted: never Accept all Ready (R1, W2). */
        reviewed?: boolean;
        level?: string | null;
      },
    ): ResponseLike {
      {
        const { collection_id: sentCollection, ...rest } = sent;
        // What is not sent takes the batch's default (Q4).
        const metadata: CaptureMetadata = { ...rest };
        const d = b.defaults;
        if (metadata.owner_member_id === undefined && d.owner_member_id !== null)
          metadata.owner_member_id = d.owner_member_id;
        if (metadata.owner_member_id === undefined && d.visibility === 'private')
          metadata.owner_member_id = who.memberId;
        if (metadata.type_key === undefined && d.type_key !== null) metadata.type_key = d.type_key;
        if (metadata.physical_location === undefined && d.physical_location !== null)
          metadata.physical_location = d.physical_location;
        if (metadata.tags === undefined && d.tags.length > 0) metadata.tags = d.tags;
        if (metadata.is_essential === undefined && d.is_essential) metadata.is_essential = true;
        // Sensitive, where the accept left it unsaid (0.9.0, AIR2).
        if (metadata.sensitive === undefined && d.sensitive != null) {
          metadata.sensitive = d.sensitive;
        }
        if (who.role === 'teen' && metadata.owner_member_id == null)
          metadata.owner_member_id = who.memberId;
        const kind = state.types.find((t) => t.key === metadata.type_key);
        if (metadata.type_key && !kind) {
          return fail(
            422,
            'validation_failed',
            'That kind of document is not on the list.',
            'type_key',
          );
        }
        if (metadata.visibility === undefined) {
          metadata.visibility = batchVisibility({
            chosen: d.visibility,
            type: kind ?? null,
            role: who.role,
            owner: metadata.owner_member_id ?? null,
            me: who.memberId,
          });
        }
        const problem = checkCaptureMetadata(metadata, {
          me: { member_id: who.memberId, role: who.role },
          members: state.members,
          types: state.types,
        });
        if (problem) {
          return fail(
            problem.status,
            problem.field === 'extra'
              ? 'invalid_extra'
              : problem.status === 403
                ? 'forbidden'
                : 'validation_failed',
            problem.message,
            problem.key ?? problem.field,
          );
        }
        const collectionId = sentCollection !== undefined ? sentCollection : d.collection_id;
        const collection = collectionId
          ? state.collections.find((c) => c.id === collectionId && !c.deleted)
          : null;
        if (collectionId && !collection)
          return fail(404, 'not_found', 'That collection does not exist.');
        if (collection && collection.owner_member_id !== who.memberId) {
          return fail(403, 'forbidden', 'Only the person who made this collection can change it.');
        }
        const extra = detailsFor(metadata.type_key, metadata.extra);
        if (isResponse(extra)) return extra;
        const doc: FakeDocument = {
          id: next('document'),
          title: metadata.title ?? null,
          type_key: metadata.type_key ?? null,
          ...whoseNew(
            metadata,
            state.types.find((t) => t.key === metadata.type_key),
          ),
          ...ownSensitive(metadata),
          identifier: tidy(metadata.identifier),
          issued_by: tidy(metadata.issued_by),
          issued: metadata.issued ?? null,
          expires: metadata.expires ?? null,
          physical_location: note(metadata.physical_location),
          is_essential: metadata.is_essential ?? false,
          tags: tagsOf(metadata.tags),
          notes: note(metadata.notes),
          extra,
          visibility: metadata.visibility,
          // The folder it came from (0.9.0, C4), kept as the vault keeps it.
          source_folder: seesLocation(who.role) ? (it.folder ?? null) : null,
          filed_by: who.memberId,
        };
        stampNotes(doc, null, who.memberId);
        state.documents.push(doc);
        const made: FakeUpload = {
          kind: 'capture',
          document_id: doc.id,
          version_id: next('version'),
          version_no: 1,
          filename: it.name,
          mime: it.content_type,
          byte_size: it.byte_size,
          uploaded_at: new Date().toISOString(),
          ...(it.bytes ? { bytes: it.bytes } : {}),
        };
        state.captures.set(next('batch-upload'), made);
        collection?.items.push({ document_id: doc.id, added_at: new Date().toISOString() });
        filedFrom.set(doc.id, it.sha256);
        it.state = 'accepted';
        it.document_id = doc.id;
        learnFrom(who, it.id, learn, metadata, kind ?? null);
        return ok({ document_id: doc.id, version_id: made.version_id }, 201);
      }
    }
    /**
     * What an accept teaches (I4), as the vault teaches it: the uploader's
     * own rules, and — for an item that was read — whether it needed no
     * change, with what it taught for an Undo to take back.
     */
    function learnFrom(
      who: { role: Role; memberId: string },
      itemId: string,
      learn: {
        read: boolean;
        proposals: ItemProposals | null;
        paper?: PaperReading | null;
        /** Looked at and accepted: never Accept all Ready (R1, W2). */
        reviewed?: boolean;
        level?: string | null;
      },
      filed: CaptureMetadata,
      kind: DocumentTypeView | null,
    ): void {
      const mine = (state.learned[who.memberId] ??= { rules: [], outcomes: [] });
      const today = new Date().toISOString().slice(0, 10);
      const taught = teach(
        mine.rules,
        learningOf({ proposals: learn.proposals, filed, role: who.role }),
        { newId: () => next('rule'), today },
      );
      mine.rules = taught.rules;
      if (!learn.read) return;
      // And the sender's layout (R1), from the page's reading sealed with its
      // proposal: only from a reviewed accept, vouched for by a correction or
      // an item at Check (W2). The fake keeps no numbers' hashes (W1).
      const unchanged = correctionsOf({ proposals: learn.proposals, filed, kind }).length === 0;
      const lesson = kind
        ? shapeLessonOf({
            reviewed: learn.reviewed === true,
            vouched: !unchanged || (!!learn.level && learn.level !== 'ready'),
            card: learn.proposals,
            paper: learn.paper ?? null,
            filed,
            issuer: lessonIssuer(filed.issued_by, learn.proposals),
            role: who.role,
            keeps: {
              issued: kind.core?.issued?.shown !== false,
              expires: kind.expiry_driver !== null && kind.core?.expires?.shown !== false,
              identifier: kind.core?.identifier?.shown !== false,
            },
          })
        : null;
      const shaped = lesson
        ? teachShape(mine.shapes ?? [], lesson, { newId: () => next('shape'), today })
        : null;
      if (shaped) mine.shapes = shaped.shapes;
      const now = Date.now();
      mine.outcomes = [
        {
          item_id: itemId,
          unchanged,
          confirmed: taught.confirmed,
          contradicted: taught.contradicted,
          removed: taught.removed,
          ...(shaped ? { shape: shaped.taught } : {}),
          accepted_at: now,
        },
        ...mine.outcomes.filter((o) => o.item_id !== itemId),
      ].filter(
        // The newest kept, and any whose Undo is still open (I4-2).
        (o, i) => i < LEARNING_OUTCOMES_KEPT || o.accepted_at >= now - ACCEPT_UNDO_MINUTES * 60_000,
      );
    }
    /** An accept taken back by Undo: what it taught taken back, and not counted (I4). */
    function unlearn(memberId: string, itemId: string): void {
      const mine = state.learned[memberId];
      const o = mine?.outcomes.find((x) => x.item_id === itemId);
      if (!mine || !o) return;
      mine.outcomes = mine.outcomes.filter((x) => x !== o);
      // What it taught a sender's layout (R1), taken back exactly.
      if (o.shape) mine.shapes = unteachShape(mine.shapes ?? [], o.shape);
      // What it removed, put back as it was (I4-3).
      for (const r of o.removed) {
        if (!mine.rules.some((x) => x.id === r.id)) mine.rules.push({ ...r });
      }
      for (const r of mine.rules) {
        if (o.confirmed.includes(r.id)) r.confirmed = Math.max(0, r.confirmed - 1);
        if (o.contradicted.includes(r.id)) r.contradicted = Math.max(0, r.contradicted - 1);
      }
      mine.rules = mine.rules.filter(
        (r) =>
          !(o.confirmed.includes(r.id) || o.contradicted.includes(r.id)) ||
          (r.confirmed > 0 && r.contradicted <= r.confirmed),
      );
    }
    // Asking somebody to send documents (0.5.21): the family's side. A teen
    // or a viewer is told there is nothing here, as the vault tells them.
    const uploadAt = /^\/api\/v1\/upload-requests(?:\/([^/]+)(\/resume|\/reveal|\/email)?)?$/.exec(
      path,
    );
    if (uploadAt) {
      const s = session();
      if (!('id' in s)) return s;
      if (!can(state.role, 'upload_request.create')) {
        return fail(404, 'not_found', 'That page does not exist.');
      }
      const [, id, after] = uploadAt;
      const resume = after === '/resume';
      // Shown again and changed by whoever asked (0.9.0, LK), as the vault does.
      const copies = (state.uploadRequestCopies ??= {});
      const live = (r: UploadRequestView) => r.state === 'active' || r.state === 'paused';
      const lk = (r: UploadRequestView): UploadRequestView => ({
        ...r,
        revealable: r.mine && live(r) && copies[r.id] !== undefined,
        changeable: (r.mine || state.role === 'owner') && live(r),
        emailable:
          r.mine && r.state === 'active' && copies[r.id] !== undefined && state.operatorMail,
        emailed_to: r.emailed_to ?? null,
        emailed_by_name: r.emailed_by_name ?? null,
        latest_end: new Date(Date.parse(r.created_at) + 90 * 864e5).toISOString(),
        version: r.version ?? 1,
      });
      if (!id && init.method === 'GET') {
        return ok({ items: state.uploadRequests.map(lk), email_code_available: false });
      }
      if (!id && init.method === 'POST') {
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title) return fail(422, 'validation_failed', 'Give the request a title.');
        const end = new Date(typeof body.expires_at === 'string' ? body.expires_at : NaN);
        const now = Date.now();
        if (Number.isNaN(end.getTime()) || end.getTime() < now + 5 * 60_000) {
          return fail(422, 'expiry_out_of_range', 'Choose a time at least 5 minutes from now.');
        }
        if (end.getTime() > now + 90 * 864e5 + 5 * 60_000) {
          return fail(422, 'expiry_out_of_range', 'A request can last 90 days at most.');
        }
        if (body.email_code === true) {
          return fail(
            422,
            'email_code_unavailable',
            'This vault cannot send email codes: whoever runs it has not given it a mail server.',
          );
        }
        const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
        const made: UploadRequestView = {
          id: next('upload-request'),
          title,
          message: text(body.message),
          items: (Array.isArray(body.items) ? (body.items as string[]) : []).map((label) => ({
            id: next('item'),
            label,
          })),
          recipient_label: text(body.recipient_label),
          recipient_email: text(body.recipient_email),
          requested_by_name: state.members.find((m) => m.is_me)?.display_name ?? null,
          mine: true,
          created_at: new Date(now).toISOString(),
          expires_at: end.toISOString(),
          protection: body.with_password || body.password ? ['password'] : [],
          max_visits: typeof body.max_visits === 'number' ? body.max_visits : null,
          visits_used: 0,
          max_files: typeof body.max_files === 'number' ? body.max_files : 10,
          files_used: 0,
          max_total_bytes:
            typeof body.max_total_bytes === 'number' ? body.max_total_bytes : 200 * 1024 * 1024,
          bytes_used: 0,
          accept_types: body.accept_types === 'office' ? 'office' : 'standard',
          review_by: body.review_by === 'adults' ? 'adults' : 'me',
          suggested_member_id: text(body.suggested_member_id),
          suggested_type_key: text(body.suggested_type_key),
          close_after_submit: body.close_after_submit === true,
          state: 'active',
          paused_reason: null,
          closed_reason: null,
          files_received: 0,
        };
        state.uploadRequests.unshift(made);
        const token = next('drop-token');
        const password = body.with_password ? 'abcd-efgh-jkmn' : null;
        copies[made.id] = { token, password };
        return ok(
          {
            request: lk(made),
            link_token: token,
            link_url: null,
            ...(password ? { password } : {}),
          },
          201,
        );
      }
      const r = state.uploadRequests.find((x) => x.id === id);
      if (!r) return fail(404, 'not_found', 'That request does not exist.');
      if (!after && init.method === 'DELETE') {
        Object.assign(r, { state: 'revoked', recipient_email: null });
        delete copies[r.id];
        return empty();
      }
      if (after === '/email' && init.method === 'POST') {
        // As the vault answers (16 Nov 2026): no mail server, none; then the
        // address, whose it is, that it opens, and the copy.
        if (!state.operatorMail) {
          return fail(503, 'email_link_unavailable', SHARE_LINK_EMAIL_UNAVAILABLE);
        }
        const to = typeof body.to === 'string' ? body.to.trim() : '';
        if (!isShareAddress(to)) {
          return fail(
            422,
            'validation_failed',
            'That is not an email address. Check it: name@example.com.',
          );
        }
        if (!r.mine) return fail(404, 'not_found', 'That request does not exist.');
        if (r.state !== 'active') {
          return fail(
            410,
            'request_ended',
            'That request no longer opens, so there is nothing to send. Make a new one if you need to.',
          );
        }
        if (!copies[r.id]) {
          return fail(
            409,
            'request_not_revealable',
            'That request was made before the vault kept a copy, so the vault cannot email it. Send it yourself, or take it back and make a new one.',
          );
        }
        r.emailed_to = maskEmail(to);
        r.emailed_by_name =
          state.members.find((m) => m.id === whoOf(s).memberId)?.display_name ?? null;
        const sent: ShareEmailed = {
          sent_to: maskEmail(to),
          sent_at: new Date().toISOString(),
          sends_left: SHARE_LINK_EMAILS.perLinkPerDay - 1,
        };
        return ok(sent);
      }
      if ((after === '/reveal' && init.method === 'POST') || (!after && init.method === 'PATCH')) {
        // Shown again by whoever asked; changed by them or an owner (16 Nov 2026).
        if (!r.mine && !(!after && state.role === 'owner')) {
          return fail(404, 'not_found', 'That request does not exist.');
        }
        if (!live(r)) {
          return fail(
            410,
            'request_ended',
            after
              ? 'That request no longer works, so there is nothing to show. Make a new one if you need to.'
              : 'That request no longer works, so it can’t be changed. Make a new one if you need to.',
          );
        }
      }
      if (after === '/reveal' && init.method === 'POST') {
        const copy = copies[r.id];
        if (!copy) {
          return fail(
            409,
            'request_not_revealable',
            'That request was made before the vault kept a copy, so it was shown only once. Take it back and make a new one if you need it again.',
          );
        }
        const shown: RevealedUploadRequest = {
          link_token: copy.token,
          link_url: null,
          ...(copy.password ? { password: copy.password } : {}),
        };
        return ok(shown);
      }
      if (!after && init.method === 'PATCH') {
        const version = r.version ?? 1;
        const ifMatch = init.headers['if-match'];
        if (ifMatch && ifMatch.replace(/^W\//, '').replace(/"/g, '') !== String(version)) {
          return fail(
            409,
            'conflict',
            'That request was changed somewhere else since you opened it. Look at it again, then make your change.',
          );
        }
        for (const key of ['items', 'review_by', 'email_code', 'this_device_only']) {
          if (key in body) return fail(422, 'validation_failed', `Unrecognized key: "${key}"`);
        }
        if (body.secret !== undefined && !r.mine) {
          return fail(
            403,
            'request_secret_makers_only',
            'Only whoever asked can give this request a new password. Take it back and make a new one if you need to.',
          );
        }
        const changes: string[] = [];
        if (typeof body.title === 'string' && body.title.trim() !== r.title) {
          if (!body.title.trim())
            return fail(422, 'validation_failed', 'Give the request a title.');
          r.title = body.title.trim();
          changes.push('title');
        }
        if ('message' in body) {
          const message =
            typeof body.message === 'string' && body.message.trim() ? body.message.trim() : null;
          if (message !== r.message) {
            r.message = message;
            changes.push('message');
          }
        }
        if ('recipient_label' in body) {
          const label =
            typeof body.recipient_label === 'string' && body.recipient_label.trim()
              ? body.recipient_label.trim()
              : null;
          if (label !== r.recipient_label) {
            r.recipient_label = label;
            changes.push('recipient_label');
          }
        }
        if (typeof body.expires_at === 'string' && body.expires_at !== r.expires_at) {
          const end = Date.parse(body.expires_at);
          const latest = Date.parse(r.created_at) + 90 * 864e5;
          if (Number.isNaN(end) || end < Date.now() + 5 * 60_000) {
            return fail(422, 'expiry_out_of_range', 'Choose a time at least 5 minutes from now.');
          }
          if (end > latest + 5 * 60_000) {
            return fail(
              422,
              'expiry_out_of_range',
              'A request can last 90 days at most from when it was made.',
            );
          }
          r.expires_at = new Date(Math.min(end, latest)).toISOString();
          changes.push('expires_at');
        }
        if ('max_visits' in body) {
          const v = typeof body.max_visits === 'number' ? body.max_visits : null;
          if (v !== null && v < r.visits_used) {
            return fail(422, 'validation_failed', 'That is fewer visits than were used already.');
          }
          if (v !== r.max_visits) {
            r.max_visits = v;
            changes.push('max_visits');
          }
        }
        if (typeof body.max_files === 'number' && body.max_files !== r.max_files) {
          r.max_files = body.max_files;
          changes.push('max_files');
        }
        if (
          typeof body.max_total_bytes === 'number' &&
          body.max_total_bytes !== r.max_total_bytes
        ) {
          r.max_total_bytes = body.max_total_bytes;
          changes.push('max_total_bytes');
        }
        if (
          (body.accept_types === 'standard' || body.accept_types === 'office') &&
          body.accept_types !== r.accept_types
        ) {
          r.accept_types = body.accept_types;
          changes.push('accept_types');
        }
        if (
          typeof body.close_after_submit === 'boolean' &&
          body.close_after_submit !== r.close_after_submit
        ) {
          r.close_after_submit = body.close_after_submit;
          changes.push('close_after_submit');
        }
        let password: string | null = null;
        const had = r.protection.includes('password');
        if (body.secret === 'password' || (body.secret === 'none' && had)) {
          changes.push('secret');
          password =
            body.secret === 'password' && typeof body.password !== 'string'
              ? `fake-${next('pw')}-word`
              : null;
          r.protection = [
            ...(body.secret === 'password' ? (['password'] as const) : []),
            ...r.protection.filter((p) => p !== 'password'),
          ];
          const copy = copies[r.id];
          if (copy) copy.password = password;
        }
        if (changes.length) r.version = version + 1;
        const answer: ChangedUploadRequest = {
          request: lk(r),
          changed: changes,
          ...(password ? { password } : {}),
        };
        return ok(answer);
      }
      if (resume && init.method === 'POST') {
        if (!can(state.role, 'restore.review')) {
          return fail(403, 'forbidden', refusalFor('restore.review'));
        }
        if (r.state !== 'paused')
          return fail(404, 'not_found', 'That paused request does not exist.');
        Object.assign(r, { state: 'active', paused_reason: null });
        return ok(lk(r));
      }
    }
    // The activity log (R4): what the fake keeps of it, newest first, each
    // line about a document only to whoever may see the document.
    if (path === '/api/v1/audit' && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      const who = whoOf(s);
      if (!can(who.role, 'audit.read')) return fail(403, 'forbidden', refusalFor('audit.read'));
      const events = [...(state.activity ?? [])].reverse().filter((e) => {
        // A line about a person (a connected app's, APP8): to the owners,
        // and to the person it is about, as the real vault's audience.
        if (e.object_type === 'member') {
          return who.role === 'owner' || (e.object_id !== null && e.object_id === who.memberId);
        }
        const doc = state.documents.find((d) => d.id === e.object_id);
        return (
          doc !== undefined &&
          canSee(who, {
            visibility: doc.visibility ?? 'household',
            owner_member_id: doc.owner_member_id ?? null,
          })
        );
      });
      return ok({ items: describeEvents(events), next: null });
    }
    // One document's activity (0.9.0, DA): its lines alone, to whoever reads
    // the log and may see it — one in the Trash too, as the vault answers.
    const activityOf = /^\/api\/v1\/documents\/([^/]+)\/activity$/.exec(path);
    if (activityOf && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      const who = whoOf(s);
      if (!can(who.role, 'audit.read')) return fail(403, 'forbidden', refusalFor('audit.read'));
      const id = decodeURIComponent(activityOf[1] as string);
      const doc = state.documents.find((d) => d.id === id);
      if (
        !doc ||
        !canSee(who, {
          visibility: doc.visibility ?? 'household',
          owner_member_id: doc.owner_member_id ?? null,
        })
      ) {
        return fail(404, 'not_found', 'That document does not exist.');
      }
      const events = [...(state.activity ?? [])]
        .reverse()
        .filter((e) => e.object_type === 'document' && e.object_id === id);
      return ok({ items: describeEvents(events), next: null });
    }
    // Somebody of the family with no sign-in (POST /members), by whoever may
    // add people: a name, and a date of birth that has come, or none.
    if (path === '/api/v1/members' && init.method === 'POST') {
      const s = session();
      if (!('id' in s)) return s;
      if (!can(whoOf(s).role, 'member.add')) {
        return fail(403, 'forbidden', refusalFor('member.add'));
      }
      const name = typeof body.display_name === 'string' ? body.display_name.trim() : '';
      if (!name || name.length > 120) {
        return fail(422, 'validation_failed', 'Give them a name.', 'display_name');
      }
      const dob = typeof body.date_of_birth === 'string' ? body.date_of_birth : null;
      if (dob !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || dob > localToday('UTC'))) {
        return fail(
          422,
          'validation_failed',
          'That date of birth is not a day that has been yet.',
          'date_of_birth',
        );
      }
      const m: FakeVaultState['members'][number] = {
        id: next('member'),
        display_name: name,
        role: null,
        is_me: false,
        kind: 'family',
        date_of_birth: dob,
        relationship:
          typeof body.relationship === 'string' ? body.relationship.trim() || null : null,
      };
      state.members.push(m);
      return ok(memberAnswer(m), 201);
    }
    if (path === '/api/v1/members' && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      // The worker, as far as the fake has one: a photo on its way is made
      // by the time anybody asks again.
      for (const [memberId, photoId] of state.photosOnTheirWay) {
        const m = state.members.find((x) => x.id === memberId);
        if (m) Object.assign(m, { photo: { id: photoId }, photo_status: null });
      }
      state.photosOnTheirWay.clear();
      // The family (5.34): a guest only to themselves. An owner's
      // `?kind=guest`: the guests alone.
      const me = whoOf(s);
      if (param(url, 'kind') === 'guest') {
        if (me.role !== 'owner') {
          return fail(403, 'forbidden', 'Only an owner sees the people outside the family.');
        }
        return ok({
          items: state.members.filter((m) => m.kind === 'guest').map(memberAnswer),
        });
      }
      return ok({
        items: state.members
          .filter((m) => m.kind !== 'guest' || m.id === me.memberId)
          .map(memberAnswer),
      });
    }
    // Invitations (5.34): the rules the real vault keeps for a guest, and
    // for an owner's decision about what a viewer sees.
    if (path === '/api/v1/invitations' && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      if (!can(whoOf(s).role, 'member.invite')) {
        return fail(403, 'forbidden', refusalFor('member.invite'));
      }
      return ok({ items: state.invitations.map((i) => i.view) });
    }
    if (path === '/api/v1/invitations' && init.method === 'POST') {
      const s = session();
      if (!('id' in s)) return s;
      return invite(whoOf(s), body);
    }
    // Taken back before it is accepted, by whoever may invite (SHR-02).
    const revokeAt = /^\/api\/v1\/invitations\/([^/]+)$/.exec(path);
    if (revokeAt && init.method === 'DELETE') {
      const s = session();
      if (!('id' in s)) return s;
      if (!can(whoOf(s).role, 'member.invite')) {
        return fail(403, 'forbidden', refusalFor('member.invite'));
      }
      const found = state.invitations.find(
        (i) => i.view.id === revokeAt[1] && i.view.state === 'pending',
      );
      if (!found) return fail(404, 'not_found', 'That invitation does not exist.');
      found.view.state = 'revoked';
      return empty();
    }
    if (path === '/api/v1/invitations/accept' && init.method === 'POST') {
      return acceptInvitation(body, init.headers['x-fdv-installation'] ?? null);
    }
    // A guest's sign-in renewed (5.34, A28), refused in the real vault's order.
    const renewAt = /^\/api\/v1\/members\/([^/]+)\/renew$/.exec(path);
    if (renewAt && init.method === 'POST') {
      const s = session();
      if (!('id' in s)) return s;
      if (!can(whoOf(s).role, 'role.change')) {
        return fail(403, 'forbidden', refusalFor('role.change'));
      }
      const keys = Object.keys(body);
      if (
        typeof body.access_expires_at !== 'string' ||
        keys.some((k) => k !== 'access_expires_at')
      ) {
        return fail(422, 'validation_failed', 'Say when their access ends.', 'access_expires_at');
      }
      if (!state.ownerTwoStep) {
        return fail(
          403,
          'totp_required_for_owner',
          "Turn on two-step sign-in to renew a guest's sign-in.",
        );
      }
      const problem = guestEndProblem(new Date(body.access_expires_at));
      if (problem) return fail(422, 'validation_failed', problem, 'access_expires_at');
      const m = state.members.find((x) => x.id === decodeURIComponent(renewAt[1] as string));
      if (!m || !m.role) return fail(404, 'not_found', 'They have no sign-in to renew.');
      if (m.kind !== 'guest') {
        return fail(
          409,
          'not_a_guest',
          `${m.display_name} is of the family: their sign-in has no end to renew.`,
        );
      }
      m.access_expires_at = new Date(body.access_expires_at).toISOString();
      return ok({ member_id: m.id, access_expires_at: m.access_expires_at });
    }
    // A change of role (5.34's rule only, beside a plain change): a guest is
    // a viewer and nothing else.
    const roleAt = /^\/api\/v1\/members\/([^/]+)\/role$/.exec(path);
    if (roleAt && init.method === 'POST') {
      const s = session();
      if (!('id' in s)) return s;
      if (!can(whoOf(s).role, 'role.change')) {
        return fail(403, 'forbidden', refusalFor('role.change'));
      }
      const m = state.members.find((x) => x.id === decodeURIComponent(roleAt[1] as string));
      if (!m || !m.role) return fail(404, 'not_found', 'That sign-in does not exist.');
      const to = String(body.role) as Role;
      if (m.role === to) {
        return ok({
          applied: false,
          role: to,
          message: `${m.display_name} is already that.`,
          effects: [],
        });
      }
      if (m.kind === 'guest') return fail(409, 'guest', GUEST_ONLY_VIEWER(m.display_name));
      m.role = to;
      return ok({
        applied: true,
        role: to,
        message: `${m.display_name}'s role changed.`,
        effects: [],
      });
    }
    // A person's photo (0.5.19), as the vault takes one: the crop first, then
    // the picture, and nothing else; a photo, by what it says it is.
    const photoAt = /^\/api\/v1\/members\/([^/]+)\/photo(?:\/([^/]+))?$/.exec(path);
    if (photoAt) {
      const s = session();
      if (!('id' in s)) return s;
      const m = state.members.find((x) => x.id === decodeURIComponent(photoAt[1] as string));
      if (photoAt[2] !== undefined) {
        if (init.method !== 'GET') return fail(404, 'not_found', 'Not here.');
        return m?.photo && m.photo.id === decodeURIComponent(photoAt[2])
          ? picture(FAKE_PAGE)
          : fail(404, 'no_photo', 'There is no photo here.');
      }
      if (!m) return fail(404, 'not_found', 'That person is not in the family.');
      if (init.method === 'DELETE') {
        Object.assign(m, { photo: null, photo_status: null });
        state.photosOnTheirWay.delete(m.id);
        return empty();
      }
      if (init.method !== 'PUT') return fail(404, 'not_found', 'Not here.');
      if (state.role === 'viewer') return fail(403, 'forbidden', refusalFor('member.photo'));
      const parts = partsOf(init.body, init.headers['content-type']) ?? [];
      const order = parts.map((p) => (p.value === null ? `file:${p.name}` : p.name)).join(',');
      if (order !== 'file:file' && order !== 'crop,file:file') {
        return fail(422, 'validation_failed', 'Send the crop first, then the photo.');
      }
      const file = parts[parts.length - 1] as Part;
      if (!PHOTO_TYPES.includes(file.type ?? '')) {
        return fail(415, 'unsupported_type', 'Choose a photo: JPEG, PNG, WebP or HEIC.');
      }
      if ((file.size ?? 0) > PHOTO_MAX_BYTES) {
        return fail(413, 'too_large', 'That photo is too big. Choose one of 20 MB or less.');
      }
      state.photosOnTheirWay.set(m.id, next('photo'));
      m.photo_status = 'processing';
      return ok(memberAnswer(m), 202);
    }
    // A person's details (5.25), changed as the caller saw them: If-Match on
    // their version, and an older one is a conflict, with them as they are.
    // People's identity details (5.26), as the real vault answers them.
    /**
     * The audience in effect: a widening whose 72 hours are up reads from
     * then, whichever request asks first (the 5.26 review).
     */
    const effectiveAudience = (): IdentityAudience => {
      const pending = state.identityPending;
      if (pending && Date.parse(pending.notice_until) <= Date.now()) {
        state.identityAudience = pending.to;
        state.identityPending = null;
      }
      return state.identityAudience;
    };
    /** What takes a passkey or a code, refused to whoever has neither, in its own words. */
    const needsTwoStep = (why: string) =>
      fail(
        403,
        state.role === 'owner' ? 'totp_required_for_owner' : 'two_step_required',
        `Turn on two-step sign-in ${why}.`,
      );
    // The family's time zone (0.9.0, TZ), as the real vault answers it:
    // every role reads it, an owner chooses it or clears it back to the
    // server's default (null), and a name nobody knows is refused.
    if (path === '/api/v1/household/timezone') {
      const s = session();
      if (!('id' in s)) return s;
      const view = (): FamilyTimeZone => ({
        timezone: state.timezone,
        timezone_source: state.timezoneSource,
        server_timezone: state.serverTimezone,
        can_change: can(state.role, 'household.timezone'),
      });
      if (init.method === 'GET') return ok(view());
      if (init.method !== 'PUT') return fail(404, 'not_found', 'Not here.');
      if (!can(state.role, 'household.timezone')) {
        return fail(403, 'forbidden', refusalFor('household.timezone'));
      }
      const to = (body as { timezone?: unknown }).timezone;
      if (to === null) {
        state.timezone = state.serverTimezone;
        state.timezoneSource = 'server_default';
        return ok(view());
      }
      const canon = canonicalZone(to);
      if (!canon) {
        return fail(
          422,
          'validation_failed',
          'That time zone is not recognised. Choose one from the list, such as Europe/London.',
        );
      }
      state.timezone = canon;
      state.timezoneSource = 'household';
      return ok(view());
    }
    // How long ended links and requests are kept (0.9.0, RQ), as the real
    // vault answers it: every role reads it, an owner chooses 30, 90 or 365
    // days or never (null), anything else refused.
    if (path === '/api/v1/household/ended-sharing') {
      const s = session();
      if (!('id' in s)) return s;
      const view = (): EndedSharing => ({
        remove_after_days: state.endedSharingDays,
        can_change: can(state.role, 'household.ended_sharing'),
      });
      if (init.method === 'GET') return ok(view());
      if (init.method !== 'PUT') return fail(404, 'not_found', 'Not here.');
      if (!can(state.role, 'household.ended_sharing')) {
        return fail(403, 'forbidden', refusalFor('household.ended_sharing'));
      }
      const to = (body as { remove_after_days?: unknown }).remove_after_days;
      if (to !== null && to !== 30 && to !== 90 && to !== 365) {
        return fail(422, 'validation_failed', 'Choose 30, 90 or 365 days, or never.');
      }
      state.endedSharingDays = to;
      return ok(view());
    }
    if (path === '/api/v1/household/identity-audience') {
      const s = session();
      if (!('id' in s)) return s;
      effectiveAudience();
      const view = (): IdentityAudienceView => ({
        audience: state.identityAudience,
        pending: state.identityPending,
        can_change: can(state.role, 'identity.audience'),
      });
      if (init.method === 'GET') return ok(view());
      if (init.method !== 'PUT') return fail(404, 'not_found', 'Not here.');
      if (!can(state.role, 'identity.audience')) {
        return fail(403, 'forbidden', refusalFor('identity.audience'));
      }
      const to = (body as { audience?: string }).audience as IdentityAudience;
      if (!IDENTITY_AUDIENCES.includes(to)) {
        return fail(422, 'validation_failed', 'Choose who can see identity details.');
      }
      if (!state.ownerTwoStep) return needsTwoStep('to change who can see identity details');
      if (identityAudienceRank(to) <= identityAudienceRank(state.identityAudience)) {
        state.identityAudience = to;
        state.identityPending = null;
      } else if (state.identityPending?.to !== to) {
        // Everybody with a sign-in is told: anybody who cannot sign in holds
        // it back — switched off, and since 5.28 locked or paused, any role.
        const off = state.members
          .filter((m) => state.signInsOff.includes(m.id) || suspensionOf(m.id) !== null)
          .sort((a, b) =>
            a.display_name < b.display_name ? -1 : a.display_name > b.display_name ? 1 : 0,
          );
        if (off.length > 0) {
          return fail(
            409,
            'member_cannot_be_told',
            `${off.map((m) => m.display_name).join(', ')} cannot sign in just now, so could not be told, or mark anything Only me first. Let more people see identity details once everybody can sign in.`,
          );
        }
        const now = Date.now();
        state.identityPending = {
          to,
          requested_at: new Date(now).toISOString(),
          notice_until: new Date(now + IDENTITY_NOTICE_HOURS * 3_600_000).toISOString(),
        };
      }
      return ok(view());
    }
    // Locking a sign-in (5.28, A50–A52), and turning on again one a restore
    // paused (A55), as the real vault answers them, to whoever asks by their
    // session. Refused in its order: who may (403), what was sent (422), the
    // owner power (A54) as the account card asks it, then the person.
    const lockAt = /^\/api\/v1\/members\/([^/]+)\/(lock|resume)$/.exec(path);
    if (lockAt && (init.method === 'POST' || (lockAt[2] === 'lock' && init.method === 'DELETE'))) {
      const s = session();
      if (!('id' in s)) return s;
      const me = whoOf(s);
      const resuming = lockAt[2] === 'resume';
      const locking = !resuming && init.method === 'POST';
      const capability = resuming ? 'restore.review' : 'member.suspend';
      if (!can(me.role, capability)) return fail(403, 'forbidden', refusalFor(capability));
      const asked = locking ? lockOf(body) : { until: null, note: null };
      if (typeof asked === 'string') return fail(422, 'validation_failed', asked);
      if (!state.ownerTwoStep) {
        return fail(
          403,
          'totp_required_for_owner',
          "Turn on two-step sign-in to manage other people's sign-ins.",
        );
      }
      const id = decodeURIComponent(lockAt[1] as string);
      const m = state.members.find((x) => x.id === id);
      const role = roleOfMember(id);
      if (!m || !role) return fail(404, 'not_found', 'They have no sign-in to lock.');
      const held = suspensionOf(id);
      if (resuming) {
        if (state.suspensions.get(id)?.reason !== 'restored') {
          return fail(
            409,
            'not_paused',
            `${m.display_name}'s sign-in is not waiting after a restore.`,
          );
        }
        state.suspensions.delete(id);
        return empty();
      }
      if (!locking) {
        // Never locked, past its end, or paused after a restore (resumed, not unlocked).
        if (held?.reason !== 'locked') {
          return fail(409, 'not_locked', `${m.display_name}'s sign-in is not locked.`);
        }
        state.suspensions.delete(id);
        return empty();
      }
      if (id === me.memberId) {
        return fail(422, 'validation_failed', 'You cannot lock your own sign-in.');
      }
      if (role === 'owner') {
        return fail(
          409,
          'owner_notice_required',
          `${m.display_name} is an owner, and one owner's sign-in is never locked by another. Ask for their role to be changed first — that takes seven days, and they are told about it.`,
        );
      }
      if (held?.reason === 'locked') {
        return fail(
          409,
          'already_locked',
          `${m.display_name}'s sign-in is locked already. Unlock it first to lock it differently.`,
        );
      }
      const now = Date.now();
      if (asked.until !== null && Date.parse(asked.until) <= now) {
        return fail(422, 'validation_failed', 'Choose a time in the future to unlock.');
      }
      if (asked.until !== null && Date.parse(asked.until) > now + LOCK_MAX_DAYS * 86_400_000) {
        return fail(
          422,
          'validation_failed',
          'A lock can end by itself within a year at most. Leave the end out to keep it until you unlock it.',
        );
      }
      // Somebody paused after a restore may be locked: the lock takes the pause's place.
      const suspension: MemberSuspension = {
        reason: 'locked',
        since: new Date(now).toISOString(),
        until: asked.until,
        note: asked.note,
        by: state.members.find((x) => x.id === me.memberId)?.display_name ?? 'An owner',
      };
      state.suspensions.set(id, suspension);
      // Their sessions end, and say why. The fake keeps no links of anybody
      // but its own person, so `end_links` has nothing to end.
      for (const x of state.sessions) {
        if (x.revoked || whoOf(x).memberId !== id) continue;
        x.revoked = true;
        x.endedBecause = 'suspended';
      }
      // A wider audience for identity details still waiting is withdrawn:
      // they could neither be told nor mark anything Only me (5.26).
      effectiveAudience();
      state.identityPending = null;
      return ok({ member_id: id, suspension: { ...suspension } });
    }
    // A password reset an owner starts (5.29, D5), as the real vault answers
    // it: who may (403), what was sent (422), the owner power (A54) as the
    // account card asks it, then the person (404, 422, 409). Never a link
    // but in `handover`, shown this once.
    const resetAt = /^\/api\/v1\/members\/([^/]+)\/password-reset$/.exec(path);
    if (resetAt && init.method === 'POST') {
      const s = session();
      if (!('id' in s)) return s;
      const me = whoOf(s);
      if (!can(me.role, 'member.reset_password')) {
        return fail(403, 'forbidden', refusalFor('member.reset_password'));
      }
      const b = body ?? {};
      if (
        Object.keys(b).some((k) => k !== 'stop_now') ||
        (b.stop_now !== undefined && typeof b.stop_now !== 'boolean')
      ) {
        return fail(422, 'validation_failed', 'Please check the form.');
      }
      if (!state.ownerTwoStep) {
        return fail(
          403,
          'totp_required_for_owner',
          "Turn on two-step sign-in to manage other people's sign-ins.",
        );
      }
      const id = decodeURIComponent(resetAt[1] as string);
      const m = state.members.find((x) => x.id === id);
      const role = roleOfMember(id);
      if (!m || !role) return fail(404, 'not_found', 'They have no sign-in to reset.');
      if (id === me.memberId) {
        return fail(
          422,
          'validation_failed',
          'You cannot reset your own password here. Change it in Settings → Your account, or use “Forgotten your password?” on the sign-in page.',
        );
      }
      if (role === 'owner') {
        return fail(
          409,
          'owner_notice_required',
          `${m.display_name} is an owner, and one owner's password is never reset by another. Ask for their role to be changed first — that takes seven days, and they are told about it.`,
        );
      }
      const held = suspensionOf(id);
      if (held) {
        return fail(
          409,
          'locked',
          held.reason === 'restored'
            ? `${m.display_name}'s sign-in is waiting after a restore. Turn it back on first, then reset their password.`
            : `${m.display_name}'s sign-in is locked. Unlock it first, then reset their password.`,
        );
      }
      const how = resetPathOf(id) as ResetPath;
      const stopNow = b.stop_now === true;
      // No link can reach them on the operator's path: no stop either (5.29 review).
      if (stopNow && how === 'operator') {
        return fail(
          409,
          'stop_now_unavailable',
          `${m.display_name}'s password can't be stopped from here: no link to set a new one can reach them on this vault. Lock their sign-in to keep them out, and ask whoever runs the server for a reset.`,
        );
      }
      if (stopNow) {
        // Their password stops now (A48): nobody is given one.
        const theirs = state.signIns.find((x) => x.member_id === id);
        if (theirs) theirs.password = '';
        for (const x of state.sessions) {
          if (x.revoked || whoOf(x).memberId !== id) continue;
          x.revoked = true;
          x.endedBecause = 'revoked';
        }
      }
      const by = state.members.find((x) => x.id === me.memberId)?.display_name ?? null;
      const now = Date.now();
      if (how === 'handover') {
        state.resetNotices.set(id, { by, at: new Date(now).toISOString() });
      }
      state.resetsStarted.push({ member_id: id, path: how, stop_now: stopNow });
      const theirEmail =
        state.signIns.find((x) => x.member_id === id)?.email ?? `${id}@example.test`;
      return ok({
        member_id: id,
        path: how,
        stop_now: stopNow,
        ...(how !== 'operator'
          ? { expires_at: new Date(now + RESET_LINK_MINUTES * 60_000).toISOString() }
          : {}),
        ...(how === 'handover'
          ? { link: `http://vault.test/reset#${'h'.repeat(40)}${String(++n).padStart(3, '0')}` }
          : {}),
        ...(how === 'operator' ? { command: resetCommand(theirEmail) } : {}),
      });
    }
    // Signing somebody out everywhere (5.30, A53), as the real vault answers
    // it: who may (403), the owner power (A54), then the person (404). Their
    // sessions end (`revoked`) — oneself, every one but the one asking — and
    // their sign-in stays as it is.
    const outAt = /^\/api\/v1\/members\/([^/]+)\/sessions$/.exec(path);
    if (outAt && init.method === 'DELETE') {
      const s = session();
      if (!('id' in s)) return s;
      const me = whoOf(s);
      if (!can(me.role, 'member.sign_out')) {
        return fail(403, 'forbidden', refusalFor('member.sign_out'));
      }
      if (!state.ownerTwoStep) {
        return fail(
          403,
          'totp_required_for_owner',
          "Turn on two-step sign-in to manage other people's sign-ins.",
        );
      }
      const id = decodeURIComponent(outAt[1] as string);
      if (!roleOfMember(id) || (id !== ME && !state.members.some((x) => x.id === id))) {
        return fail(404, 'not_found', 'They have no sign-in to sign out.');
      }
      let ended = 0;
      for (const x of state.sessions) {
        if (x.revoked || x.id === s.id || whoOf(x).memberId !== id) continue;
        x.revoked = true;
        x.endedBecause = 'revoked';
        ended += 1;
      }
      // Their devices go with their sessions.
      const card = id === me.memberId ? undefined : state.memberAccounts.get(id);
      if (card) card.devices = [];
      return ok({ member_id: id, sessions_ended: ended });
    }
    // After a restore (5.16): what it paused that the caller may decide
    // about, as the real vault lists it. The fake keeps no links; requests
    // to send documents (5.21) as the vault lists them; and the sign-ins it
    // paused (5.28), an owner's alone to turn back on.
    if (path === '/api/v1/after-restore' && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      const me = whoOf(s);
      const owner = can(me.role, 'restore.review');
      const signIns: PausedSignIn[] = owner
        ? withSignIn()
            .flatMap((id) => {
              const paused = state.suspensions.get(id);
              const role = roleOfMember(id);
              if (paused?.reason !== 'restored' || !role) return [];
              const name = state.members.find((x) => x.id === id)?.display_name ?? '';
              return [{ member_id: id, display_name: name, role, paused_at: paused.since }];
            })
            .sort((a, b) =>
              a.display_name !== b.display_name
                ? a.display_name < b.display_name
                  ? -1
                  : 1
                : a.member_id < b.member_id
                  ? -1
                  : 1,
            )
        : [];
      return ok({
        links: [],
        upload_requests: can(me.role, 'upload_request.create')
          ? state.uploadRequests.filter(
              (r) => r.state === 'paused' && r.paused_reason === 'restored' && (owner || r.mine),
            )
          : [],
        sign_ins: signIns,
      });
    }
    // What a viewer can see (5.33), as the real vault answers: who may (403),
    // what is sent (422), the owner power (A54), then whom (404, 409).
    // What a viewer can see (5.33), refused in the real vault's order (the
    // 5.33 review, L533-06). A PUT: anybody but an owner 403; a body of the
    // wrong shape 422; no two-step sign-in 403; nobody of the family 404;
    // anybody but a viewer 409 not_a_viewer; what the grant names 422;
    // somebody who keeps Only me documents 409 confirm_private.
    const accessAt = /^\/api\/v1\/members\/([^/]+)\/access(\/preview)?$/.exec(path);
    if (accessAt || path === '/api/v1/access/preview') {
      const s = session();
      if (!('id' in s)) return s;
      const me = whoOf(s);
      const id = accessAt ? decodeURIComponent(accessAt[1] as string) : null;
      const known = (x: string) => x === ME || state.members.some((m) => m.id === x);
      const nameOf = (x: string) => state.members.find((m) => m.id === x)?.display_name ?? 'They';
      const notAViewer = (x: string) => {
        const role = roleOfMember(x);
        return role && role !== 'viewer'
          ? fail(
              409,
              'not_a_viewer',
              `Only a viewer can be limited to some documents. ${nameOf(x)} is not a viewer.`,
            )
          : null;
      };
      if (!accessAt || accessAt[2] !== undefined) {
        if (init.method !== 'GET') return fail(404, 'not_found', 'Not here.');
        const flag = (k: string) => {
          const v = param(url, k);
          return v === 'true' ? true : v === 'false' ? false : undefined;
        };
        const shaped = grantShape({
          ...Object.fromEntries(
            ['people', 'types', 'collections'].map((k) => [
              k,
              (param(url, k) ?? '').split(',').filter(Boolean),
            ]),
          ),
          include_adults_only: param(url, 'include_adults_only') === 'true',
          include_no_person_docs: param(url, 'include_no_person_docs') === 'true',
          ...(param(url, 'expires_at') ? { expires_at: param(url, 'expires_at') } : {}),
          ...(flag('limits_people') !== undefined ? { limits_people: flag('limits_people') } : {}),
          ...(flag('limits_types') !== undefined ? { limits_types: flag('limits_types') } : {}),
        });
        if (isResponse(shaped)) return shaped;
        if (me.role !== 'owner') {
          if (!can(me.role, 'member.invite')) {
            return fail(403, 'forbidden', 'Only an owner can limit what someone can see.');
          }
          if (shaped.include_adults_only) {
            return fail(
              403,
              'forbidden',
              'Only an owner can let a viewer see Adults only documents.',
            );
          }
        }
        if (id !== null && !known(id))
          return fail(404, 'not_found', 'That person is not in the family.');
        const refused = id !== null ? notAViewer(id) : null;
        if (refused) return refused;
        const had = id !== null ? state.restrictions.get(id) : undefined;
        const asked = checkedGrant(shaped, had?.expires_at ?? null);
        if (isResponse(asked)) return asked;
        const counting: AccessGrant = {
          ...asked,
          limits_people: limitsAfter(asked.people, asked.limits_people, had?.limits_people),
          limits_types: limitsAfter(asked.types, asked.limits_types, had?.limits_types),
        };
        const inCollections = collectionDocuments(counting);
        const counted: AccessPreview = {
          documents: state.documents.filter(
            (d) =>
              !d.deleted_at &&
              (d.visibility ?? 'household') !== 'private' &&
              grantGives(id, counting, d, inCollections),
          ).length,
          // To an owner with two-step sign-in, as the real vault tells one
          // who just gave a passkey or a code.
          ...(id !== null && me.role === 'owner' && state.ownerTwoStep
            ? { keeps_private: state.keepsPrivate.includes(id) }
            : {}),
        };
        return ok(counted);
      }
      if (init.method !== 'PUT' && init.method !== 'DELETE') {
        return fail(404, 'not_found', 'Not here.');
      }
      if (!can(me.role, 'role.change')) return fail(403, 'forbidden', refusalFor('role.change'));
      const shaped = init.method === 'PUT' ? grantShape(body) : null;
      if (shaped && isResponse(shaped)) return shaped;
      if (!state.ownerTwoStep) {
        return fail(
          403,
          'totp_required_for_owner',
          'Turn on two-step sign-in to limit what a viewer can see.',
        );
      }
      const theirs = id as string;
      if (!known(theirs)) return fail(404, 'not_found', 'That person is not in the family.');
      if (init.method === 'DELETE') {
        // A guest is always limited (5.34).
        if (state.members.find((m) => m.id === theirs)?.kind === 'guest') {
          return fail(409, 'guest_always_limited', GUEST_ALWAYS_LIMITED);
        }
        state.restrictions.delete(theirs);
        return empty();
      }
      const refused = notAViewer(theirs);
      if (refused) return refused;
      const was = state.restrictions.get(theirs);
      const asked = checkedGrant(shaped as AccessGrant, was?.expires_at ?? null);
      if (isResponse(asked)) return asked;
      const keeps = state.keepsPrivate.includes(theirs);
      if (keeps && !was?.private_confirmed && body.confirm_private !== true) {
        return fail(
          409,
          'confirm_private',
          `${nameOf(theirs)} keeps documents only they can see. Limited, they still see those, and nothing else of the family’s that you do not give them. Confirm to go ahead: they will be told.`,
        );
      }
      state.restrictions.set(theirs, {
        ...asked,
        // An empty list keeps what it says now, unless the owner says otherwise.
        limits_people: limitsAfter(asked.people, asked.limits_people, was?.limits_people),
        limits_types: limitsAfter(asked.types, asked.limits_types, was?.limits_types),
        reconfirm_since: null,
        private_confirmed: keeps || (was?.private_confirmed ?? false),
        updated_at: new Date().toISOString(),
      });
      return ok(accessView(theirs));
    }
    const identityAt = /^\/api\/v1\/members\/([^/]+)\/identity(\/reveal)?$/.exec(path);
    if (identityAt) {
      const s = session();
      if (!('id' in s)) return s;
      const id = decodeURIComponent(identityAt[1] as string);
      const me = { role: state.role, memberId: 'fake-member' };
      const self = id === me.memberId;
      if (!state.members.some((m) => m.id === id)) {
        return fail(404, 'not_found', 'That page does not exist.');
      }
      const audience = effectiveAudience();
      if (!canSeeIdentity(me, { id }, audience)) {
        return fail(404, 'not_found', 'That page does not exist.');
      }
      const record = state.identities.get(id) ?? {};
      state.identities.set(id, record);
      const partView = (part: IdentityPart): IdentityPartView => {
        const kept = record[part];
        const masked = maskIdentity(kept?.fields ?? {});
        return {
          fields: masked.fields,
          masked: masked.masked,
          filled: identityFilled(kept?.fields ?? {}),
          version: kept?.version ?? 0,
          updated_at: kept?.updated_at ?? null,
        };
      };
      const view = () => ({
        member_id: id,
        audience,
        can_edit: {
          shared: canEditIdentity(me, { id }, 'shared'),
          only_me: canEditIdentity(me, { id }, 'only_me'),
        },
        versions: {
          shared: record.shared?.version ?? 0,
          only_me: self ? (record.only_me?.version ?? 0) : null,
        },
        shared: partView('shared'),
        only_me: self ? partView('only_me') : null,
      });
      if (identityAt[2] !== undefined) {
        if (init.method !== 'POST') return fail(404, 'not_found', 'Not here.');
        const b = body as { part?: IdentityPart; keys?: string[] };
        const part = b.part ?? 'shared';
        if (part === 'only_me' && !self) return fail(404, 'not_found', 'That page does not exist.');
        // Somebody else's numbers take a passkey or a code, whoever asks.
        if (!self && !state.ownerTwoStep) {
          return needsTwoStep("to see another person's identity numbers");
        }
        return ok({ part, values: revealIdentity(record[part]?.fields ?? {}, b.keys ?? []) });
      }
      if (init.method === 'GET') return ok(view());
      if (init.method !== 'PUT') return fail(404, 'not_found', 'Not here.');
      const b = body as { part?: IdentityPart; version?: number; fields?: IdentityFields };
      const part = b.part;
      if (part !== 'shared' && part !== 'only_me') {
        return fail(422, 'validation_failed', 'Say which part.');
      }
      if (part === 'only_me' && !self) return fail(404, 'not_found', 'That page does not exist.');
      if (!canEditIdentity(me, { id }, part)) return fail(403, 'forbidden', IDENTITY_EDIT_REFUSAL);
      // Another person's, an owner's to write, is an owner power (5.41).
      if (!self && !state.ownerTwoStep) {
        return needsTwoStep("to change another person's identity details");
      }
      const kept = record[part];
      const version = kept?.version ?? 0;
      if (b.version !== version) {
        return fail(
          409,
          'conflict',
          'Someone else changed these details. Reload and try again.',
          JSON.stringify({ part, version }),
        );
      }
      const next = mergeIdentityWrite(kept?.fields ?? {}, b.fields ?? {}, () => true);
      if (identityChanges(kept?.fields ?? {}, next).length > 0) {
        if (identityTooLong(next)) return fail(422, 'validation_failed', IDENTITY_TOO_LONG);
        record[part] = { fields: next, version: version + 1, updated_at: new Date().toISOString() };
      }
      return ok(view());
    }
    const memberAt = /^\/api\/v1\/members\/([^/]+)(\/account)?$/.exec(path);
    if (memberAt) {
      const s = session();
      if (!('id' in s)) return s;
      const m = state.members.find((x) => x.id === decodeURIComponent(memberAt[1] as string));
      if (memberAt[2] !== undefined) {
        if (init.method !== 'GET' || whoOf(s).role !== 'owner') {
          return fail(404, 'not_found', 'That page does not exist.');
        }
        if (!state.ownerTwoStep) {
          return fail(
            403,
            'totp_required_for_owner',
            "Turn on two-step sign-in to manage other people's sign-ins.",
          );
        }
        // The card a test gave them, or one for somebody in `signIns` (5.28).
        const theirs = m ? state.signIns.find((x) => x.member_id === m.id) : undefined;
        const card =
          (m ? state.memberAccounts.get(m.id) : undefined) ??
          (m && theirs
            ? {
                member_id: m.id,
                role: m.role as Role,
                email: theirs.email,
                two_step: false,
                passkeys: 0,
                last_signed_in_at: null,
                devices: [],
                // Of the family, or a guest, and a guest's end (5.34).
                kind: m.kind ?? 'family',
                access_expires_at: m.access_expires_at ?? null,
              }
            : undefined);
        if (!card || !m) return fail(404, 'not_found', 'They have no sign-in to show.');
        // A lock, or a pause after a restore (5.28): one past its end is over.
        return ok({
          ...card,
          suspension: suspensionOf(m.id),
          max_offline_days: FAKE_OFFLINE_MAX_DAYS,
          // Which way a reset an owner starts would go (5.29).
          reset_path: resetPathOf(m.id),
          // A viewer's limits (5.33).
          access: card.role === 'viewer' ? accessView(m.id) : null,
        });
      }
      // A guest who never signed in, removed by an owner (the 5.34 review).
      if (init.method === 'DELETE') {
        if (whoOf(s).role !== 'owner') return fail(403, 'forbidden', refusalFor('member.remove'));
        if (!m) return fail(404, 'not_found', 'That person is not here.');
        if (m.kind !== 'guest') {
          return fail(409, 'not_a_guest', `${m.display_name} is of the family, and stays in it.`);
        }
        const accepted = state.invitations.some(
          (i) => i.view.member_id === m.id && i.view.state === 'accepted',
        );
        if (m.role || accepted) {
          return fail(
            409,
            'had_sign_in',
            `${m.display_name} has had a sign-in here. Take it away instead; an owner can give it back.`,
          );
        }
        state.members = state.members.filter((x) => x.id !== m.id);
        state.invitations = state.invitations.filter((i) => i.view.member_id !== m.id);
        state.restrictions.delete(m.id);
        return empty();
      }
      if (init.method !== 'PATCH') return fail(404, 'not_found', 'Not here.');
      if (!m) return fail(404, 'not_found', 'That person is not in the family.');
      if (state.role === 'viewer') return fail(403, 'forbidden', refusalFor('member.edit'));
      const b = body as {
        display_name?: string;
        date_of_birth?: string | null;
        relationship?: string | null;
        is_deceased?: boolean;
      };
      const passing = b.is_deceased !== undefined && b.is_deceased !== (m.is_deceased ?? false);
      if (passing && state.role !== 'owner') return fail(403, 'forbidden', DECEASED_REFUSAL);
      // A child's date of birth is an owner's to change or clear (INV-6).
      if (
        b.date_of_birth !== undefined &&
        (b.date_of_birth ?? null) !== (m.date_of_birth ?? null) &&
        whoOf(s).role !== 'owner' &&
        childBirthday(
          { date_of_birth: m.date_of_birth ?? null, has_account: Boolean(m.role) },
          localToday(state.timezone),
        )
      ) {
        return fail(403, 'child_birthday_owners', CHILD_BIRTHDAY_REFUSAL, 'date_of_birth');
      }
      const version = m.version ?? 1;
      const ifMatch = init.headers['if-match'];
      if (ifMatch !== undefined && ifMatch !== `"${version}"`) {
        return fail(
          409,
          'conflict',
          'Someone else changed these details. Reload and try again.',
          JSON.stringify(memberAnswer(m)),
        );
      }
      if (passing && b.is_deceased === true && m.role) {
        return fail(409, 'signed_in', DECEASED_SIGNED_IN(m.display_name));
      }
      const next = {
        display_name: b.display_name?.trim() ?? m.display_name,
        date_of_birth: b.date_of_birth !== undefined ? b.date_of_birth : (m.date_of_birth ?? null),
        relationship:
          b.relationship !== undefined ? b.relationship?.trim() || null : (m.relationship ?? null),
        is_deceased: b.is_deceased ?? m.is_deceased ?? false,
      };
      const moved =
        next.display_name !== m.display_name ||
        next.date_of_birth !== (m.date_of_birth ?? null) ||
        next.relationship !== (m.relationship ?? null) ||
        next.is_deceased !== (m.is_deceased ?? false);
      if (moved) Object.assign(m, next, { version: version + 1 });
      return respond(200, memberAnswer(m), { etag: `"${m.version ?? 1}"` });
    }
    // A person's emergency information (0.9.0, H4), as the real vault answers it.
    const emergencyAt =
      /^\/api\/v1\/members\/([^/]+)\/emergency(?:\/(audience|links))?(?:\/([^/]+))?$/.exec(path);
    if (emergencyAt) {
      const s = session();
      if (!('id' in s)) return s;
      const who = whoOf(s);
      const person = decodeURIComponent(emergencyAt[1] as string);
      const part = emergencyAt[2] ?? null;
      const linkId = emergencyAt[3] ? decodeURIComponent(emergencyAt[3]) : null;
      const m = state.members.find((x) => x.id === person);
      const nobody = () => fail(404, 'not_found', 'That page does not exist.');
      if (!m || (m.kind ?? 'family') !== 'family') return nobody();
      const self = person === who.memberId;
      if (!self && who.role === 'viewer') return nobody();
      const pages = (state.emergency ??= []);
      const kept = pages.find((x) => x.member === person);
      const caregiver =
        (who.role === 'owner' || who.role === 'adult') &&
        !self &&
        (state.caregivers ?? []).some(
          (g) => !g.revoked && g.confirmed && g.person === person && g.caregiver === who.memberId,
        );
      const page: FakeEmergency = kept ?? {
        member: person,
        fields: {},
        audience: EMERGENCY_DEFAULT_AUDIENCE,
        chosen: [],
        version: 0,
        updated_at: '',
      };
      const me = { role: who.role, memberId: who.memberId };
      if (!canSeeEmergency(me, { ...page, member_id: person }, caregiver)) return nobody();
      // Nothing written yet: the person's and the owners' alone to be told of.
      if (!kept && !self && who.role !== 'owner') return nobody();
      const personRole = roleOfMember(person);
      const chooses = choosesEmergency(
        me,
        person,
        personRole === 'owner' || personRole === 'adult',
      );
      const nameOf = (id: string) => state.members.find((x) => x.id === id)?.display_name ?? '';
      const viewOf = (p: FakeEmergency): EmergencyView => {
        const documents: Record<EmergencyDocumentKind, EmergencyDocumentRef[]> = {
          advance_directive: [],
          healthcare_proxy: [],
          insurance_card: [],
        };
        for (const d of state.documents) {
          if (d.owner_member_id !== person || d.deleted_at) continue;
          const kind = d.type_key as EmergencyDocumentKind;
          if (!(EMERGENCY_DOCUMENT_KINDS as readonly string[]).includes(kind)) continue;
          const sees =
            caregiver ||
            canSee(who, {
              visibility: d.visibility ?? 'household',
              owner_member_id: d.owner_member_id ?? null,
            });
          if (sees) documents[kind].push({ id: d.id, title: d.title ?? '' });
        }
        const inAudience =
          self ||
          who.role === 'owner' ||
          (who.role === 'adult' && p.audience !== 'owners_and_self') ||
          (who.role === 'teen' && p.audience === 'family') ||
          p.chosen.includes(who.memberId);
        return {
          member_id: person,
          fields: p.fields,
          date_of_birth: m.date_of_birth ?? null,
          audience: p.audience,
          chosen:
            chooses || self ? p.chosen.map((id) => ({ member_id: id, name: nameOf(id) })) : [],
          documents,
          version: p.version,
          updated_at: p.updated_at || null,
          can_edit: canEditEmergency(me, person),
          can_choose: chooses,
          can_see_links: self || who.role === 'owner',
          caregiver: caregiver && !inAudience,
          ...(chooses
            ? {
                candidates: state.members
                  .filter((x) => x.id !== person && (x.kind ?? 'family') === 'family')
                  .filter((x) => x.role === 'adult' || x.role === 'teen')
                  .map((x) => ({
                    member_id: x.id,
                    name: x.display_name,
                    role: x.role as 'adult' | 'teen',
                  })),
              }
            : {}),
        };
      };
      const tag = (p: FakeEmergency) => ({ etag: `"${p.version}"`, 'cache-control': 'no-store' });
      const stamp = () => new Date((state.now ?? Date.now)()).toISOString();
      const write = (p: FakeEmergency) => {
        if (kept) Object.assign(kept, p);
        else pages.push(p);
        return respond(200, viewOf(p), tag(p));
      };
      if (part === null && init.method === 'GET') return respond(200, viewOf(page), tag(page));
      if (part === null && init.method === 'PUT') {
        if (!canEditEmergency(me, person)) {
          return fail(
            403,
            'forbidden',
            'Only the person themselves, or an owner, can change their emergency information.',
          );
        }
        const said = init.headers['if-match'];
        if (said && said.replace(/^W\//, '').replace(/^"(.*)"$/, '$1') !== String(page.version)) {
          return fail(
            409,
            'conflict',
            'Someone else changed this emergency information. Reload and try again.',
          );
        }
        const fields = (body.fields ?? {}) as EmergencyFields;
        if (kept && JSON.stringify(fields) === JSON.stringify(page.fields)) {
          return respond(200, viewOf(page), tag(page));
        }
        return write({ ...page, fields, version: page.version + 1, updated_at: stamp() });
      }
      if (part === 'audience' && init.method === 'PUT') {
        if (!chooses) {
          return fail(
            403,
            'forbidden',
            'Only the person chooses who sees their emergency information — or an owner, for a child or somebody without their own sign-in.',
          );
        }
        const audience = body.audience as EmergencyAudience;
        const chosen = Array.isArray(body.chosen_member_ids)
          ? (body.chosen_member_ids as string[])
          : [];
        const mayBe = (id: string) => {
          const r = roleOfMember(id);
          return id !== person && (r === 'adult' || r === 'teen');
        };
        if (chosen.some((id) => !mayBe(id))) {
          return fail(
            422,
            'validation_failed',
            'Choose people of the family who sign in as an adult or a teen.',
          );
        }
        return write({ ...page, audience, chosen, version: page.version + 1, updated_at: stamp() });
      }
      if (part === 'links') {
        if (!self && who.role !== 'owner' && init.method !== 'POST') return nobody();
        const links = (state.emergencyLinks ??= []);
        const clock = () => (state.now ?? Date.now)();
        const listOf = (): EmergencyLink[] =>
          links
            .filter((l) => l.member === person)
            .map((l): EmergencyLink => {
              const ended = l.revoked
                ? ('revoked' as const)
                : Date.parse(l.expires_at) <= clock()
                  ? ('expired' as const)
                  : ('active' as const);
              return {
                id: l.id,
                document_id: null,
                document_title: null,
                recipient_label: l.recipient_label,
                created_by_name: nameOf(l.created_by) || null,
                created_at: l.created_at,
                expires_at: l.expires_at,
                has_pin: l.pin !== null,
                open_count: l.openings.length,
                last_opened_at: l.openings[0]?.at ?? null,
                state: ended,
                flow: 'v2',
                permission: 'view',
                protection: l.pin !== null ? ['pin'] : [],
                summary: l.recipient_label ? `Shared with ${l.recipient_label}` : 'Shared by link',
                emergency_fields: l.fields,
                openings: l.openings,
              };
            })
            .reverse();
        if (linkId === null && init.method === 'GET') return ok({ items: listOf() });
        if (linkId === null && init.method === 'POST') {
          if (!chooses) {
            return fail(
              403,
              'forbidden',
              'Only the person can share their emergency information outside the family — or an owner, for a child or somebody without their own sign-in.',
            );
          }
          if (!kept) {
            return fail(
              409,
              'emergency_empty',
              'There is no emergency information here yet, so there is nothing to share. Add it first.',
            );
          }
          const asked = Array.isArray(body.fields) ? (body.fields as string[]) : [];
          const fields = EMERGENCY_FIELD_KEYS.filter((k) => asked.includes(k));
          if (fields.length === 0) {
            return fail(
              422,
              'validation_failed',
              'Tick at least one part of the page to show.',
              'fields',
            );
          }
          const hours =
            typeof body.expires_in_hours === 'number'
              ? body.expires_in_hours
              : EMERGENCY_LINK_DEFAULT_HOURS;
          if (hours < 1 || hours > EMERGENCY_LINK_MAX_HOURS) {
            return fail(
              422,
              'expiry_out_of_range',
              `A link to emergency information lasts ${EMERGENCY_LINK_MAX_HOURS} hours at most.`,
            );
          }
          const now = clock();
          const link: FakeEmergencyLink = {
            id: next('emergency-link'),
            member: person,
            fields,
            token: next('emergency-token'),
            pin: body.with_pin === true ? '4321' : null,
            recipient_label: typeof body.recipient_label === 'string' ? body.recipient_label : null,
            created_by: who.memberId,
            created_at: new Date(now).toISOString(),
            expires_at: new Date(now + hours * 3_600_000).toISOString(),
            revoked: false,
            openings: [],
          };
          links.push(link);
          const share = listOf().find((l) => l.id === link.id) as EmergencyLink;
          return ok(
            {
              share,
              link_token: link.token,
              link_url: null,
              ...(link.pin ? { pin: link.pin } : {}),
            },
            201,
          );
        }
        if (linkId !== null && init.method === 'DELETE') {
          const l = links.find((x) => x.id === linkId && x.member === person && !x.revoked);
          if (!l) return fail(404, 'not_found', 'That link does not exist.');
          l.revoked = true;
          return empty();
        }
      }
      return fail(405, 'method_not_allowed', 'Not here.');
    }
    // Caregivers and turning 18 (0.9.0, H1b), as the real vault answers them.
    const careAt =
      /^\/api\/v1\/members\/([^/]+)\/(caregivers|caregiver-views|grown-up-answer)(?:\/([^/]+)\/(keep|revoke))?$/.exec(
        path,
      );
    if (path === '/api/v1/caregivers' || path === '/api/v1/grown-up/questions' || careAt) {
      const s = session();
      if (!('id' in s)) return s;
      const who = whoOf(s);
      const grants = (state.caregivers ??= []);
      const nameOf = (id: string) => state.members.find((m) => m.id === id)?.display_name ?? '';
      /** Somebody who answers for their own papers: an owner, an adult or a teen, signed in. */
      const answersForSelf = (id: string) => {
        const r = roleOfMember(id);
        return r === 'owner' || r === 'adult' || r === 'teen';
      };
      const viewOfGrant = (g: FakeCaregiver): CaregiverGrantView => {
        const self = g.person === who.memberId;
        const forThem = who.role === 'owner' && !self && !answersForSelf(g.person);
        return {
          id: g.id,
          person_member_id: g.person,
          person_name: nameOf(g.person),
          caregiver_member_id: g.caregiver,
          caregiver_name: nameOf(g.caregiver),
          granted_at: g.granted_at,
          granted_by_name: nameOf(g.granted_by) || null,
          confirmed: g.confirmed,
          may_revoke: self || forThem,
          may_keep: self && !g.confirmed,
          may_give_up: g.caregiver === who.memberId,
        };
      };
      const live = grants.filter((g) => !g.revoked);
      if (path === '/api/v1/caregivers' && init.method === 'GET') {
        return ok({
          about_me: live.filter((g) => g.person === who.memberId).map(viewOfGrant),
          for_others: live.filter((g) => g.caregiver === who.memberId).map(viewOfGrant),
        });
      }
      if (path === '/api/v1/grown-up/questions' && init.method === 'GET') {
        const today = localToday(state.timezone);
        const items: GrownUpQuestionView[] = [];
        for (const q of state.grownUp ?? []) {
          if (q.answer !== null || q.papers === 0) continue;
          const r = roleOfMember(q.member_id);
          const self = r === 'owner' || r === 'adult';
          const name = nameOf(q.member_id);
          if (q.member_id === who.memberId && self) {
            items.push({
              member_id: q.member_id,
              display_name: name,
              turned_on: q.turned_on,
              papers: q.papers,
              asks: 'self',
              title: GROWN_UP_QUESTION,
              label: GROWN_UP_EXPLAINED,
            });
          } else if (q.member_id !== who.memberId && !self && who.role === 'owner') {
            // No sign-in at all: in person; a teen's still: their role first.
            items.push({
              member_id: q.member_id,
              display_name: name,
              turned_on: q.turned_on,
              papers: q.papers,
              asks: r ? 'role_first' : 'in_person',
              ...(r ? roleFirstWords(name) : turnedEighteenWords(name, q.turned_on, today)),
            });
          }
        }
        return ok({ items });
      }
      if (careAt) {
        const person = decodeURIComponent(careAt[1] as string);
        const what = careAt[2];
        const other = careAt[3] ? decodeURIComponent(careAt[3]) : null;
        const m = state.members.find((x) => x.id === person);
        if (what === 'grown-up-answer' && init.method === 'POST') {
          const q = (state.grownUp ?? []).find((x) => x.member_id === person);
          if (!q || !m)
            return fail(404, 'not_found', 'There is no question waiting for that person.');
          if (q.answer !== null) return fail(409, 'already_answered', GROWN_UP_ANSWERED);
          const r = roleOfMember(person);
          const self = r === 'owner' || r === 'adult';
          const answer = body.answer;
          if (answer !== 'keep' && answer !== 'only_me') {
            return fail(422, 'validation_failed', 'Choose keep or only_me.', 'answer');
          }
          if (person === who.memberId) {
            if (!self)
              return fail(404, 'not_found', 'There is no question waiting for that person.');
          } else {
            if (who.role !== 'owner') {
              return fail(404, 'not_found', 'There is no question waiting for that person.');
            }
            // An owner answers only for somebody with no sign-in at all.
            if (r) return fail(403, 'ask_them_themselves', GROWN_UP_THEIRS_TO_ANSWER);
            if (answer === 'only_me') return fail(403, 'only_the_person', GROWN_UP_ONLY_ME_THEIRS);
          }
          let made = 0;
          if (answer === 'only_me') {
            for (const d of state.documents) {
              if (
                d.owner_member_id === person &&
                (d.visibility ?? 'household') !== 'private' &&
                d.type_key !== 'note' &&
                state.types.find((t) => t.key === d.type_key)?.category === 'medical'
              ) {
                d.visibility = 'private';
                made++;
              }
            }
          }
          q.answer = answer;
          return ok({ answer, made_private: made });
        }
        if (!m) return fail(404, 'not_found', 'That person does not exist.');
        if (what === 'caregiver-views' && init.method === 'GET') {
          const own = person === who.memberId;
          if (!own && who.role !== 'owner') {
            return fail(
              403,
              'forbidden',
              'Only the person themselves and the owners can see who looked at their papers.',
            );
          }
          const items = (state.caregiverLooks ?? [])
            .filter((l) => l.person === person)
            .map((l) => {
              // An owner is told who looked, never which Only me paper.
              if (!own) {
                return {
                  caregiver_name: nameOf(l.caregiver),
                  document_id: null,
                  title: null,
                  sensitive: false,
                  only_me: true,
                  action: l.action,
                  at: l.at,
                };
              }
              const d = state.documents.find((x) => x.id === l.document_id);
              const sensitive =
                d !== undefined &&
                sensitiveOf(d, state.types.find((t) => t.key === d.type_key) ?? null);
              return {
                caregiver_name: nameOf(l.caregiver),
                document_id: d ? d.id : null,
                title: d && !sensitive ? (d.title ?? null) : null,
                sensitive,
                action: l.action,
                at: l.at,
              };
            })
            .reverse();
          return ok({ items });
        }
        const self = person === who.memberId;
        const forThem = who.role === 'owner' && !self && !answersForSelf(person);
        const mayAdd =
          (m.kind ?? 'family') === 'family' &&
          !m.is_deceased &&
          (self ? mayNameOwnCaregiver(who.role) : forThem);
        const theirs = live.filter((g) => g.person === person);
        if (what === 'caregivers' && other === null && init.method === 'GET') {
          if (!self && who.role !== 'owner' && !theirs.some((g) => g.caregiver === who.memberId)) {
            return fail(
              403,
              'forbidden',
              'Only the person themselves and the owners can see who their caregivers are.',
            );
          }
          const named = new Set(theirs.map((g) => g.caregiver));
          const candidates = mayAdd
            ? state.members
                .filter(
                  (x) =>
                    (x.kind ?? 'family') === 'family' &&
                    x.id !== person &&
                    !named.has(x.id) &&
                    mayGiveCare(roleOfMember(x.id)) &&
                    suspensionOf(x.id) === null,
                )
                .map((x) => ({ member_id: x.id, display_name: x.display_name }))
            : [];
          return ok({ items: theirs.map(viewOfGrant), may_add: mayAdd, candidates });
        }
        if (what === 'caregivers' && other === null && init.method === 'POST') {
          if (!mayAdd) {
            return fail(
              403,
              'forbidden',
              'Only the person themselves, or an owner for somebody without a sign-in, can change who their caregivers are.',
            );
          }
          const carer =
            typeof body.caregiver_member_id === 'string' ? body.caregiver_member_id : '';
          if (carer === person) {
            return fail(422, 'validation_failed', 'Somebody can’t be their own caregiver.');
          }
          const c = state.members.find((x) => x.id === carer);
          if (
            !c ||
            (c.kind ?? 'family') !== 'family' ||
            !mayGiveCare(roleOfMember(carer)) ||
            suspensionOf(carer) !== null
          ) {
            return fail(
              422,
              'caregiver_not_eligible',
              'A caregiver must be somebody in the family who signs in as an owner or an adult, and isn’t locked out.',
            );
          }
          let g = theirs.find((x) => x.caregiver === carer);
          if (!g) {
            g = {
              id: next('caregiver'),
              person,
              caregiver: carer,
              granted_by: who.memberId,
              granted_at: new Date().toISOString(),
              confirmed: self,
              revoked: false,
            };
            grants.push(g);
          } else if (self) {
            g.confirmed = true;
          }
          return ok(viewOfGrant(g), 201);
        }
        const g = other ? theirs.find((x) => x.caregiver === other) : undefined;
        if (careAt[4] === 'keep' && init.method === 'POST') {
          if (!self)
            return fail(403, 'forbidden', 'Only the person themselves can keep a caregiver.');
          if (!g) return fail(404, 'not_found', 'That caregiver does not exist.');
          g.confirmed = true;
          return ok(viewOfGrant(g));
        }
        if (careAt[4] === 'revoke' && init.method === 'POST') {
          if (!g) return fail(404, 'not_found', 'That caregiver does not exist.');
          if (!self && g.caregiver !== who.memberId && !forThem) {
            return fail(
              403,
              'forbidden',
              'Only the person themselves, or an owner for somebody without a sign-in, can change who their caregivers are.',
            );
          }
          g.revoked = true;
          return empty();
        }
      }
    }
    // Somebody turned 13 (after 0.7.0): the owners' reminders, as the real
    // vault answers them — while the person may still be invited.
    if (path === '/api/v1/reminders/people' || path.startsWith('/api/v1/reminders/people/')) {
      const s = session();
      if (!('id' in s)) return s;
      if (whoOf(s).role !== 'owner') {
        return fail(403, 'forbidden', 'Only an owner is reminded when somebody turns 13.');
      }
      const open = state.personReminders.filter((r) => {
        if (r.dismissed) return false;
        const m = state.members.find((x) => x.id === r.member_id);
        return (
          m !== undefined &&
          !m.role &&
          !m.is_deceased &&
          !state.invitations.some((i) => i.view.member_id === m.id && i.view.state === 'pending')
        );
      });
      const dismissAt = /^\/api\/v1\/reminders\/people\/([^/]+)\/dismiss$/.exec(path);
      if (dismissAt && init.method === 'POST') {
        const r = state.personReminders.find((x) => x.id === dismissAt[1] && !x.dismissed);
        if (!r) return fail(404, 'not_found', 'That reminder does not exist.');
        r.dismissed = true;
        return empty();
      }
      if (path === '/api/v1/reminders/people' && init.method === 'GET') {
        const today = localToday(state.timezone);
        const items: PersonReminderView[] = open.map((r) => {
          const name = state.members.find((x) => x.id === r.member_id)?.display_name ?? '';
          return {
            id: r.id,
            kind: 'turned_13',
            member_id: r.member_id,
            display_name: name,
            fire_at: r.fire_at,
            ...turnedThirteenWords(name, r.fire_at, today),
          };
        });
        return ok({ items });
      }
    }
    if (path === '/api/v1/reminders' && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      // Nothing reminds of a document no longer needed (0.9.0).
      const unneeded = new Set(state.documents.filter((d) => d.no_longer_needed).map((d) => d.id));
      // One document's (0.9.0, H3).
      const only = param(url, 'document_id') ?? null;
      return ok({
        items: state.reminders.filter(
          (r) => !unneeded.has(r.document_id) && (only === null || r.document_id === only),
        ),
      });
    }
    // A reminder somebody sets themselves, and removing it, as the real
    // vault answers (reminders/routes.ts): on a document they can see.
    if (path === '/api/v1/reminders' && init.method === 'POST') {
      const s = session();
      if (!('id' in s)) return s;
      const who = whoOf(s);
      if (!can(who.role, 'reminder.manage'))
        return fail(403, 'forbidden', refusalFor('reminder.manage'));
      const b = body as {
        document_id?: unknown;
        fire_at?: unknown;
        note?: unknown;
        recurrence?: unknown;
        review?: unknown;
      };
      const review = b.review === true;
      if (typeof b.fire_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.fire_at)) {
        return fail(422, 'validation_failed', 'Invalid date', 'fire_at');
      }
      if (
        b.note !== undefined &&
        b.note !== null &&
        (typeof b.note !== 'string' || b.note.length > 500)
      ) {
        return fail(422, 'validation_failed', 'At most 500 characters.', 'note');
      }
      if (typeof b.recurrence === 'string' && !parseRecurrence(b.recurrence)) {
        return fail(
          422,
          'validation_failed',
          'Repeat can be monthly, quarterly, annual, or every:Nm.',
        );
      }
      const doc = state.documents.find((d) => d.id === b.document_id && !d.deleted_at);
      if (!doc) return fail(404, 'not_found', 'That document is not in the vault.');
      if (doc.no_longer_needed) {
        return fail(
          409,
          'no_longer_needed',
          'This document is no longer needed, so nothing reminds of it. Mark it needed again to be reminded.',
        );
      }
      // A yearly review (0.9.0, H3): on the kinds it is for, one open a
      // document — asked again, the one there is.
      if (review) {
        if (typeof b.recurrence === 'string' && b.recurrence !== 'annual') {
          return fail(
            422,
            'validation_failed',
            'A yearly review repeats every year.',
            'recurrence',
          );
        }
        if (!yearlyReviewOffered({ key: doc.type_key })) {
          return fail(
            422,
            'validation_failed',
            'A yearly review is for an advance directive, a healthcare proxy or a HIPAA authorization.',
            'review',
          );
        }
        const on = state.reminders.find(
          (r) =>
            r.document_id === doc.id &&
            r.review === true &&
            ['scheduled', 'due', 'snoozed'].includes(r.status),
        );
        if (on) return ok(on, 201);
      }
      const today = new Date().toISOString().slice(0, 10);
      const status = b.fire_at <= today ? 'due' : 'scheduled';
      const made: ReminderView = {
        id: next('reminder'),
        document_id: doc.id,
        document_title: doc.title,
        kind: 'manual',
        fire_at: b.fire_at,
        lead_days: null,
        note: review ? REVIEW_NOTE : typeof b.note === 'string' ? b.note : null,
        recurrence: review ? 'annual' : typeof b.recurrence === 'string' ? b.recurrence : null,
        review,
        status,
        snoozed_until: null,
        label: reminderLabel(b.fire_at, today, status, null),
        source: null,
        about: null,
      };
      state.reminders.push(made);
      return ok(made, 201);
    }
    const reminderAt = /^\/api\/v1\/reminders\/([^/]+)$/.exec(path);
    if (reminderAt && init.method === 'DELETE') {
      const s = session();
      if (!('id' in s)) return s;
      if (!can(whoOf(s).role, 'reminder.manage'))
        return fail(403, 'forbidden', refusalFor('reminder.manage'));
      const id = decodeURIComponent(reminderAt[1] as string);
      const at = state.reminders.findIndex((r) => r.id === id && r.kind === 'manual');
      if (at < 0)
        return fail(
          404,
          'not_found',
          'Only a reminder somebody set by hand can be removed, never one made from a date.',
        );
      state.reminders.splice(at, 1);
      return empty();
    }
    return fail(404, 'not_found', `The fake vault has no ${init.method} ${path}.`);
  };

  const fileAppIntake = (
    appId: string,
    externalId: string,
    documentId: string,
    asVersion = false,
  ) => {
    const app = state.connectedApps?.find((a) => a.id === appId);
    const sent = app?.intake.get(externalId);
    if (!app || !sent) throw new Error('no such send of that app');
    const newest = versionsOf(documentId).sort((x, y) => y.version_no - x.version_no)[0];
    // An app acting as itself is who added the file (APP8): no person.
    if (newest && sent.as_itself === true) newest.uploaded_by_app = app.name;
    sent.state = 'filed';
    sent.document_id = documentId;
    sent.version_id = newest?.version_id ?? null;
    sent.filed_at = new Date().toISOString();
    sent.made_document = !asVersion;
  };

  const readAppFile = async (
    appId: string,
    externalId: string,
    proposal: DetailProposal,
  ): Promise<'filed' | 'waiting'> => {
    const app = state.connectedApps?.find((a) => a.id === appId);
    const sent = app?.intake.get(externalId);
    if (!app || !sent) throw new Error('no such send of that app');
    if (sent.state !== 'waiting' || sent.auto_file_held || !sent.file) return 'waiting';
    if (!fakeAppFilesAutomatically(app)) return 'waiting';
    // As whoever's Inbox it is in (APP5): the app's person, or the person
    // it was sent to.
    const inbox = sent.inbox_member_id ?? app.member_id;
    const member = state.members.find((m) => m.id === inbox);
    const role: Role | null =
      member?.role === 'owner' || member?.role === 'adult' ? member.role : null;
    if (!role || !inbox) return 'waiting';
    // The same file as a document here already: a duplicate.
    const hex = async (b: Uint8Array) => {
      const own = new Uint8Array(b.length);
      own.set(b);
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', own)), (x) =>
        x.toString(16).padStart(2, '0'),
      ).join('');
    };
    let duplicate: { of: 'document'; document_id: string; title: string | null } | null = null;
    for (const c of state.captures.values()) {
      const doc = state.documents.find((x) => x.id === c.document_id && !x.deleted_at);
      if (doc && c.bytes && (await hex(c.bytes)) === sent.sha256) {
        duplicate = { of: 'document', document_id: doc.id, title: doc.title };
        break;
      }
    }
    const people = state.members
      .filter((m) => (m.kind ?? 'family') === 'family')
      .map((m) => ({ id: m.id, name: m.display_name }));
    const defaults: BatchDefaults = {
      owner_member_id: null,
      type_key: null,
      visibility: app.default_visibility,
      physical_location: null,
      collection_id: null,
      tags: [],
      is_essential: false,
    };
    const input = {
      state: 'waiting' as const,
      reading: 'read' as const,
      failure: null,
      proposal,
      duplicate,
      defaults,
      types: state.types,
      people,
      role,
      me: inbox,
      app: { name: app.name, allowed_kinds: app.allowed_kinds, hints: sent.hints ?? {} },
    };
    const levelled = levelItem(input);
    if (!levelled.proposals || !appFilesItself(input, levelled)) return 'waiting';
    const card = untouchedAccept({
      proposals: levelled.proposals,
      defaults,
      types: state.types,
      people: people.map((p) => ({ id: p.id, display_name: p.name })),
      role,
      me: inbox,
    });
    const kind = state.types.find((t) => t.key === card.type_key);
    const doc: FakeDocument = {
      id: next('document'),
      title: card.title ?? null,
      type_key: card.type_key ?? null,
      ...whoseNew(card, kind),
      ...ownSensitive(card),
      identifier: tidy(card.identifier),
      issued_by: tidy(card.issued_by),
      issued: card.issued ?? null,
      expires: card.expires ?? null,
      physical_location: null,
      is_essential: false,
      tags: [],
      notes: null,
      extra: { ...card.extra },
      visibility: card.visibility ?? 'household',
      filed_by: inbox,
    };
    state.documents.push(doc);
    const version: FakeUpload = {
      kind: 'capture',
      document_id: doc.id,
      version_id: next('version'),
      version_no: 1,
      filename: sent.file.filename,
      mime: sent.file.mime,
      byte_size: sent.file.bytes.length,
      uploaded_at: new Date().toISOString(),
      bytes: sent.file.bytes,
      // An app acting as itself is who added the file (APP8): no person.
      ...(sent.as_itself === true ? { uploaded_by_app: app.name } : {}),
    };
    state.captures.set(next('app-file'), version);
    sent.state = 'filed';
    sent.document_id = doc.id;
    sent.version_id = version.version_id;
    sent.filed_at = new Date().toISOString();
    sent.made_document = true;
    delete sent.hints;
    delete sent.file;
    return 'filed';
  };

  const expireAppKey = (clientId: string) => {
    if (!fakeExpireAppKey(state.connectedApps ?? [], clientId)) {
      throw new Error('no such key of any app');
    }
  };

  return { fetch, state, pauseSignIns, fileAppIntake, readAppFile, expireAppKey };
}

/**
 * The version the fake says it is: the release this package is, so that an
 * app that checks the vault's version (the desktop uploader does) works
 * against it. apps/api/src/fake-version.test.ts holds it to the repository's
 * version, so it moves with each release.
 */
export const FAKE_SERVER_VERSION = '0.9.0';

/**
 * A moment as the real vault takes one for a lock's end: ISO, with its
 * seconds and its offset (5.28; zod's datetime({ offset: true })). One
 * without seconds is refused there, and so here (the 5.28 review, R528-5).
 */
const ISO_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * POST /members/{id}/lock's body as the real vault reads it (5.28): nothing
 * it does not know; an end at a moment with its offset, or none; a note
 * trimmed, 500 characters at most, and an empty one none. What is wrong,
 * in words; or what was asked, the end as the vault writes it.
 */
function lockOf(
  body: Record<string, unknown>,
): string | { until: string | null; note: string | null } {
  const { until, end_links: endLinks, note } = body;
  if (
    until !== undefined &&
    until !== null &&
    (typeof until !== 'string' || !ISO_MOMENT.test(until) || Number.isNaN(Date.parse(until)))
  ) {
    return 'Invalid ISO datetime';
  }
  if (endLinks !== undefined && typeof endLinks !== 'boolean') {
    return 'Invalid input: expected boolean';
  }
  if (note !== undefined && note !== null && typeof note !== 'string') {
    return 'Invalid input: expected string';
  }
  const words = typeof note === 'string' ? note.trim() : '';
  if (words.length > LOCK_NOTE_MAX) return `A note can be ${LOCK_NOTE_MAX} characters at most.`;
  const unknown = Object.keys(body).find((k) => !['until', 'end_links', 'note'].includes(k));
  if (unknown !== undefined) return `Unrecognized key: "${unknown}"`;
  return {
    until: typeof until === 'string' ? new Date(until).toISOString() : null,
    note: words || null,
  };
}

/** A change to a kind's fields, as POST and PATCH /document-types send it (0.5.10). */
interface TypeChange {
  core?: Partial<Record<CoreField, Partial<CoreFieldRule>>> | undefined;
  fields?: Array<{ key: string; label?: string; required?: boolean }> | undefined;
}

/** A household's own key, as the real vault makes one: 'h_' and ten base32 characters. */
function ownKey(): string {
  const base32 = 'abcdefghijklmnopqrstuvwxyz234567';
  let key = 'h_';
  for (let i = 0; i < 10; i++) key += base32[Math.floor(Math.random() * 32)];
  return key;
}

/** Lead times as the real vault keeps them: each once, furthest first. */
function leadsOf(leads: number[]): number[] {
  return [...new Set(leads)].sort((a, b) => b - a);
}

/**
 * The first name, of those sent, longer than the real vault keeps one
 * (TYPE_LABEL_MAX, once tidied), refused in its words; or null.
 */
function tooLong(names: ReadonlyArray<readonly [unknown, string]>): ResponseLike | null {
  for (const [value, what] of names) {
    if (typeof value === 'string' && (tidy(value)?.length ?? 0) > TYPE_LABEL_MAX) {
      return fail(
        422,
        'validation_failed',
        `${what} is too long: ${TYPE_LABEL_MAX} characters at most.`,
      );
    }
  }
  return null;
}

/**
 * Whose a new document is, as the real vault decides it (0.9.0): a person
 * sent is theirs; the household sent, or nobody said for a kind usually the
 * household's, the household's; nobody otherwise, Not sure yet.
 */
function whoseNew(
  sent: Pick<CaptureMetadata, 'owner_member_id' | 'household_owned'>,
  kind: Pick<DocumentTypeView, 'belongs_to'> | undefined,
): { owner_member_id: string | null; household_owned: boolean } {
  const owner = sent.household_owned === true ? null : (sent.owner_member_id ?? null);
  return {
    owner_member_id: owner,
    household_owned: owner === null && (sent.household_owned ?? belongsTo(kind) === 'household'),
  };
}

/** A new document's Sensitive, as sent (0.9.0, AIR2): left out, as its kind says. */
function ownSensitive(sent: Pick<CaptureMetadata, 'sensitive'>): { sensitive: boolean | null } {
  return { sensitive: sent.sensitive ?? null };
}

/** An issuer as the real vault keeps it: spaces tidied, and blank is nothing. */
function tidy(value: string | null | undefined): string | null {
  return value?.trim().split(/\s+/).join(' ') || null;
}

/** Notes as the real vault keeps them: trimmed, and blank is nothing. */
function note(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

/**
 * GET /tags, POST /tags/rename and POST /tags/delete (0.9.0, T1), as the
 * real vault answers them: of the documents the caller can see out of the
 * Trash, and changing only those they may change.
 */
function answerTags(
  documents: FakeDocument[],
  who: { memberId: string; role: Role },
  path: string,
  url: string,
  method: string,
  body: Record<string, unknown>,
): ResponseLike {
  const seen = documents.filter(
    (d) =>
      !d.deleted_at &&
      canSee(who, {
        visibility: d.visibility ?? 'household',
        owner_member_id: d.owner_member_id ?? null,
      }),
  );
  const mayChange = (d: FakeDocument) =>
    can(who.role, 'document.edit') && (who.role !== 'teen' || d.owner_member_id === who.memberId);
  const carrying = (key: string) =>
    seen.filter((d) => (d.tags ?? []).some((t) => tagKey(t) === key));
  // A rename or a delete reaches the Trash too, as the Trash list shows it (the T1 review, M2).
  const seenAll = documents.filter((d) =>
    canSee(who, {
      visibility: d.visibility ?? 'household',
      owner_member_id: d.owner_member_id ?? null,
    }),
  );
  if (path === '/api/v1/tags') {
    if (method !== 'GET') return fail(404, 'not_found', 'Not found.');
    const q = (param(url, 'q') ?? '').replace(/\s+/g, ' ').replace(/^ /, '').toLowerCase();
    const limit = Number(param(url, 'limit') ?? 50);
    const byKey = new Map<
      string,
      { spellings: Map<string, number>; ids: Set<string>; mine: Set<string> }
    >();
    for (const d of seen) {
      for (const t of d.tags ?? []) {
        const key = tagKey(t);
        if (!key.startsWith(q)) continue;
        const g = byKey.get(key) ?? { spellings: new Map(), ids: new Set(), mine: new Set() };
        g.spellings.set(t, (g.spellings.get(t) ?? 0) + 1);
        g.ids.add(d.id);
        if (mayChange(d)) g.mine.add(d.id);
        byKey.set(key, g);
      }
    }
    const items = [...byKey.values()].map((g) => {
      const tag =
        [...g.spellings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
      const detail = tagDetail(tag);
      return {
        tag,
        count: g.ids.size,
        label: detail ? detail.label.toLowerCase() : null,
        value: detail ? detail.value : null,
        changeable: g.mine.size,
      };
    });
    return ok({
      items: items.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)).slice(0, limit),
    });
  }
  if (method !== 'POST') return fail(404, 'not_found', 'Not found.');
  if (!can(who.role, 'document.edit')) return fail(403, 'forbidden', refusalFor('document.edit'));
  const renaming = path === '/api/v1/tags/rename';
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const from = tagKey(text(renaming ? body.from : body.tag));
  if (!from) {
    return fail(422, 'validation_failed', `Say which tag to ${renaming ? 'rename' : 'delete'}.`);
  }
  const to = renaming ? normaliseTag(text(body.to)) : '';
  if (renaming && !to) return fail(422, 'validation_failed', 'Say what to rename it to.');
  const problem = renaming ? tagsProblem([to]) : null;
  if (problem) return fail(422, 'validation_failed', problem, 'to');
  const toKey = to.toLowerCase();
  const merged = renaming && toKey !== from && carrying(toKey).length > 0;
  if (merged && body.merge !== true) {
    return fail(
      409,
      'tag_exists',
      `“${to}” is a tag already. Renaming “${normaliseTag(text(body.from))}” to it merges the two.`,
    );
  }
  let changed = 0;
  let kept = 0;
  let inTrash = 0;
  for (const d of seenAll.filter((x) => (x.tags ?? []).some((t) => tagKey(t) === from))) {
    if (!mayChange(d)) {
      kept += 1;
      continue;
    }
    const before = d.tags ?? [];
    const after = renaming
      ? normaliseTags(before.map((t) => (tagKey(t) === from ? to : t)))
      : before.filter((t) => tagKey(t) !== from);
    if (after.length === before.length && after.every((t, i) => t === before[i])) continue;
    d.tags = after;
    d.revision = (d.revision ?? 1) + 1;
    changed += 1;
    if (d.deleted_at) inTrash += 1;
  }
  return ok({ changed, kept, merged, in_trash: inTrash });
}

/**
 * Tags as the real vault keeps them (0.9.0, T1): tidied, a plain tag in
 * lower case and a detail tag's value as written, each once whatever its
 * case; fifty at most (the vault refuses more, `tagsProblem`).
 */
function tagsOf(tags: ReadonlyArray<string> | null | undefined): string[] {
  return normaliseTags(tags ?? []).slice(0, 50);
}

/** One query parameter, decoded; the client's library has no URLSearchParams. */
/** A filter's values, comma-separated (V1): one, several, or none asked for. */
function listParam(url: string, name: string): string[] | undefined {
  const raw = param(url, name);
  if (raw === undefined) return undefined;
  const v = [
    ...new Set(
      raw
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x !== ''),
    ),
  ];
  return v.length > 0 ? v : undefined;
}

/**
 * The days a document was added, issued or expires within (V1), both ends
 * included, as the real vault reads them; one without that date is in no
 * range. A day that is not one, or the wrong way round, is refused.
 */
function v1Filters(url: string):
  | {
      within: (d: {
        created_at: string;
        issued: { date: string } | null;
        expires: { date: string } | null;
      }) => boolean;
    }
  | { refused: ReturnType<typeof fail> } {
  const ranges: Array<
    [
      string,
      (d: {
        created_at: string;
        issued: { date: string } | null;
        expires: { date: string } | null;
      }) => string | null,
    ]
  > = [
    ['added', (d) => d.created_at.slice(0, 10)],
    ['issued', (d) => d.issued?.date ?? null],
    ['expires', (d) => d.expires?.date ?? null],
    // The date it is about: issued, else added (0.9.0, C1).
    // A fake document keeps no day it was added: today, then.
    ['dated', (d) => d.issued?.date ?? (d.created_at ?? new Date().toISOString()).slice(0, 10)],
  ];
  const asked: Array<{ from?: string; to?: string; of: (typeof ranges)[number][1] }> = [];
  for (const [name, of] of ranges) {
    const from = param(url, `${name}_from`);
    const to = param(url, `${name}_to`);
    for (const [k, v] of [
      [`${name}_from`, from],
      [`${name}_to`, to],
    ] as const) {
      if (
        v !== undefined &&
        !(/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)))
      ) {
        return {
          refused: fail(422, 'validation_failed', 'A date is a day, written as 2026-11-10.', k),
        };
      }
    }
    if (from && to && from > to) {
      return {
        refused: fail(422, 'validation_failed', 'The first day is after the last.', `${name}_from`),
      };
    }
    if (from || to) asked.push({ ...(from ? { from } : {}), ...(to ? { to } : {}), of });
  }
  return {
    within: (d) =>
      asked.every((r) => {
        const day = r.of(d);
        return day !== null && (!r.from || day >= r.from) && (!r.to || day <= r.to);
      }),
  };
}

/** Each value of a field given once for each (`tag=a&tag=b`), decoded. */
function params(url: string, name: string): string[] {
  return [...url.matchAll(new RegExp(`[?&]${name}=([^&]*)`, 'g'))].map((m) =>
    decodeURIComponent((m[1] ?? '').split('+').join(' ')),
  );
}

/**
 * Tags and notes as the real vault filters them (the owner's tidy-up of 11
 * Nov 2026): any of the tags asked for, whatever their case; and with
 * `notes=exclude`, no note.
 */
function notesAndTags(url: string): (d: FakeDocument) => boolean {
  const tags = params(url, 'tag')
    .map((t) => t.trim())
    .filter((t) => t !== '')
    .map(tagKey);
  const noNotes = param(url, 'notes') === 'exclude';
  return (d) =>
    (!noNotes || d.type_key !== NOTE_KIND) &&
    (tags.length === 0 || (d.tags ?? []).some((t) => tags.includes(tagKey(t))));
}

/**
 * Sensitive as the real vault filters it (0.9.0, AIR2): `sensitive=yes`,
 * `no`, or both — each document all said, by `sensitiveOf`.
 */
function sensitiveAsked(
  url: string,
  types: ReadonlyArray<DocumentTypeView>,
): (d: FakeDocument) => boolean {
  const asked = new Set(listParam(url, 'sensitive') ?? []);
  if (asked.size !== 1) return () => true;
  const want = asked.has('yes');
  return (d) =>
    sensitiveOf(
      d,
      types.find((t) => t.key === d.type_key),
    ) === want;
}

function param(url: string, name: string): string | undefined {
  const raw = new RegExp(`[?&]${name}=([^&]*)`).exec(url)?.[1];
  return raw === undefined ? undefined : decodeURIComponent(raw.split('+').join(' '));
}

/** A capture's answer, or a new version's: the shape each endpoint returns. */
function answer(made: FakeUpload) {
  return made.kind === 'capture'
    ? { document_id: made.document_id, version_id: made.version_id, job_id: null, state: 'stored' }
    : {
        id: made.version_id,
        document_id: made.document_id,
        // What the file was (CL3): its size the bytes kept, exactly.
        version_no: made.version_no,
        filename: made.filename,
        mime: made.mime,
        byte_size: made.byte_size,
      };
}

/**
 * A shown folder of somebody's own layout, as a place in a cabinet is set
 * from (0.9.0, C3): its names and whose it is; undefined when it is not one
 * of theirs, or hidden.
 */
function fakePlaceOf(
  state: FakeVaultState,
  memberId: string,
  folderId: unknown,
): NonNullable<FakeDocument['original_place']> | undefined {
  const layout = state.cabinets?.[memberId]?.layout;
  for (const c of layout?.cabinets ?? []) {
    for (const d of c.drawers) {
      for (const f of d.folders) {
        if (f.id === folderId && !c.hidden && !d.hidden && !f.hidden) {
          return { path: [c.name, d.name, f.name], by: memberId, folder_id: f.id };
        }
      }
    }
  }
  return undefined;
}

/**
 * A document as the real vault answers it: the fields the fake keeps, its
 * notes and details, and its status — worked out as the vault works it
 * out, so a type's missing required field reads "Needs a passport number"
 * (0.5.7). In a list, an Only me document's notes and details stay sealed:
 * null and empty, with `has_notes` (0.5.8).
 */
function documentView(
  doc: FakeDocument,
  types: ReadonlyArray<DocumentTypeView>,
  opts: {
    listed?: boolean;
    role?: string;
    /** Who changed a note, by member id, as the reader may be told them (5.35). */
    editorName?: (memberId: string) => string | null;
    /** Whether the reader sees where the original is kept (5.41): null unless they do. */
    location?: boolean;
    /** The reader's member id: a place in a cabinet names its folder to its setter alone (C3). */
    memberId?: string | null;
    /** A replacement as the reader sees it (0.9.0): its id and title, or null when they may not. */
    replacement?: (documentId: string) => { id: string; title: string | null } | null;
  } = {},
): DocumentView {
  const type = types.find((t) => t.key === doc.type_key);
  const expires = doc.expires ?? null;
  const sealed = opts.listed === true && doc.visibility === 'private';
  return {
    id: doc.id,
    title: doc.title,
    type_key: doc.type_key ?? null,
    owner_member_id: doc.owner_member_id ?? null,
    household_owned: doc.household_owned === true,
    // Its own choice, and all said with its kind's default (0.9.0, AIR2).
    sensitive: doc.sensitive ?? null,
    sensitive_effective: sensitiveOf(doc, type),
    identifier: doc.identifier ?? null,
    issued_by: doc.issued_by ?? null,
    issued: doc.issued ?? null,
    expires,
    physical_location: opts.location === true ? (doc.physical_location ?? null) : null,
    // Its place in a cabinet (C3): on the same terms; its folder's id to its setter alone.
    original_place:
      opts.location === true && doc.original_place
        ? {
            path: doc.original_place.path,
            folder_id:
              doc.original_place.by !== null && doc.original_place.by === opts.memberId
                ? doc.original_place.folder_id
                : null,
          }
        : null,
    // The folder it came from (C4): on the same terms as the location.
    source_folder: opts.location === true ? (doc.source_folder ?? null) : null,
    is_essential: doc.is_essential ?? false,
    tags: doc.tags ?? [],
    visibility: doc.visibility ?? 'household',
    notes: sealed ? null : (doc.notes ?? null),
    has_notes: (doc.notes ?? null) !== null,
    // When its note's words last changed, and who changed them (5.35).
    notes_updated_at: doc.notes_updated_at ?? null,
    notes_updated_by_name: doc.notes_updated_by
      ? (opts.editorName?.(doc.notes_updated_by) ?? null)
      : null,
    extra: sealed ? {} : (doc.extra ?? {}),
    // The fake's one signed-in person files every document it holds, unless
    // a test says somebody else did (5.24).
    filed_by_me: doc.filedBySomeoneElse !== true,
    deleted_at: doc.deleted_at ?? null,
    // As the real vault (5.24): an owner's request, and from when it may go.
    purge_requested_at: doc.purge_requested_at ?? null,
    purge_allowed_from: doc.purge_requested_at
      ? new Date(Date.parse(doc.purge_requested_at) + PURGE_NOTICE_HOURS * 3_600_000).toISOString()
      : null,
    // Whether an owner may remove it at once: one they filed (5.24).
    purge_at_once:
      Boolean(doc.deleted_at) && opts.role === 'owner' && doc.filedBySomeoneElse !== true,
    file_removed: false,
    // No longer needed (0.9.0), as the real vault says it: an Only me one's
    // reason sealed in a list, and a replacement the reader may not see
    // neither named nor given by id.
    no_longer_needed: doc.no_longer_needed
      ? {
          at: doc.no_longer_needed.at,
          by_name: doc.no_longer_needed.by
            ? (opts.editorName?.(doc.no_longer_needed.by) ?? null)
            : null,
          reason: sealed ? null : doc.no_longer_needed.reason,
          has_reason: doc.no_longer_needed.reason !== null,
          replaced_by: doc.no_longer_needed.replaced_by
            ? (opts.replacement?.(doc.no_longer_needed.replaced_by) ?? { id: null, title: null })
            : null,
        }
      : null,
    etag: etagOf(doc),
    status: deriveStatus(
      {
        type: type ?? null,
        owner_member_id: doc.owner_member_id ?? null,
        household_owned: doc.household_owned === true,
        expires,
        no_longer_needed: Boolean(doc.no_longer_needed),
        // Never, to whoever may not see where the original is kept, that a
        // document needs it (5.41) — and so never in the table's sort or
        // filter by status either, which are this (R2).
        missing: missingFields(type, { ...doc, expires }).filter(
          (m) => opts.location !== false || m.key !== 'physical_location',
        ),
      },
      new Date().toISOString().slice(0, 10),
    ),
  } as DocumentView;
}

/** A person as GET /members answers one: their photo's three fields always said (0.5.19). */
function memberAnswer(m: FakeVaultState['members'][number]) {
  return {
    ...m,
    // Of the family, or a guest, and a guest's end (5.34).
    kind: m.kind ?? 'family',
    access_expires_at: m.access_expires_at ?? null,
    date_of_birth: m.date_of_birth ?? null,
    relationship: m.relationship ?? null,
    is_deceased: m.is_deceased ?? false,
    photo: m.photo ?? null,
    photo_status: m.photo_status ?? null,
    can_change_photo: m.can_change_photo ?? m.role !== 'viewer',
    // Their details (5.25): a version, and whether they may be changed.
    version: m.version ?? 1,
    can_edit: m.can_edit ?? m.role !== 'viewer',
  };
}

/** How long a POST /documents Idempotency-Key answers (0.9.0-dev.45). */
const CREATE_KEY_MS = 24 * 60 * 60 * 1000;

/** JSON with every object's keys in order, as the vault fingerprints a body. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** A note keeps no file (0.9.0, N1), in the real vault's words. */
const NOTE_HAS_NO_FILE =
  'A note keeps no file. Add the file as a document of its own, and link them if you like.';

/** A refusal the fake has already made, rather than a value to use. */
const isResponse = (v: unknown): v is ResponseLike =>
  typeof v === 'object' && v !== null && 'status' in v && 'ok' in v && 'json' in v;

function respond(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ResponseLike {
  const text = body === undefined ? '' : JSON.stringify(body);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status < 400,
    status,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
  };
}

const ok = (body: unknown, status = 200) => respond(status, body);
/** A JPEG's first and last markers: enough to be one, for a client under test. */
const FAKE_PAGE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
function picture(bytes: Uint8Array): ResponseLike {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name) =>
        ({ 'content-type': 'image/jpeg', 'cache-control': 'private, no-store' })[
          name.toLowerCase()
        ] ?? null,
    },
    json: async () => {
      throw new SyntaxError('A picture is not JSON.');
    },
    text: async () => String.fromCharCode(...bytes),
    arrayBuffer: async () => bytes.slice().buffer,
  };
}
/** A file as an attachment, with the headers given (0.5.23's copy of a file sent in). */
function attachment(bytes: Uint8Array, headers: Record<string, string>): ResponseLike {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    json: async () => {
      throw new SyntaxError('A file is not JSON.');
    },
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.slice().buffer,
  };
}
const empty = () => respond(204, undefined);
const fail = (status: number, code: string, message: string, detail?: string) =>
  respond(status, {
    error: {
      code,
      message,
      ...(detail !== undefined ? { detail } : {}),
      retriable: false,
      request_id: 'fake',
    },
  });
/**
 * A session that has ended, and why, as the real vault says it (0.4.11):
 * since 5.28 `suspended`, its person's sign-in locked or paused.
 */
const ended = (
  reason: 'expired' | 'revoked' | 'reused' | 'removed' | 'malformed' | 'suspended' | 'access_ended',
) =>
  respond(401, {
    error: {
      code: 'session_ended',
      message: 'Please sign in again.',
      reason,
      retriable: false,
      request_id: 'fake',
    },
  });
/**
 * A sign-in refused for a lock or a pause after a restore (5.28), as the
 * real vault says it once the password is right: to the person, so until
 * when, on the household's clock.
 */
const membershipSuspended = (s: MemberSuspension, timezone: string) =>
  respond(403, {
    error: {
      code: 'membership_suspended',
      message:
        s.reason === 'restored'
          ? 'The vault was restored from a backup, and your sign-in waits for an owner to turn it back on. Ask one of them.'
          : s.until
            ? `An owner has locked your sign-in until ${shareEndWords(new Date(s.until), timezone)} (${timezone}). Ask one of them if you need to get in sooner.`
            : 'An owner has locked your sign-in. Ask one of them if you need to get in.',
      retriable: false,
      request_id: 'fake',
      reason: s.reason,
    },
  });
