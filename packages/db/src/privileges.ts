import type pg from 'pg';

/**
 * Everything the application role may do, in one place.
 *
 * The migrations grant these piece by piece, and default privileges fill in
 * the rest as tables appear. A database loaded from the nightly backup has
 * none of it — the dump is taken without privileges, so it loads anywhere —
 * and nothing re-runs the migrations on a database that already has them.
 * Until 0.4.5 that left a restored vault unable to read itself.
 *
 * So this states the whole set, and `migrateUp` applies it every time it
 * runs: a restored database is put right the first time the vault starts on
 * it, whichever release made the backup. A test holds it equal to what the
 * migrations produce on a fresh database — adding nothing, removing
 * nothing — so a migration that withholds a privilege must say so here too.
 *
 * Every name is schema-qualified: a restored dump leaves the session's
 * search_path empty. The objects later migrations added are guarded, so the
 * script also runs on a database restored from an older release, before
 * the migrations that bring it up to date.
 */
export const APP_PRIVILEGES = `
grant usage on schema public to fdv_app;
revoke all on all tables in schema public from fdv_app;
revoke all on all sequences in schema public from fdv_app;
grant select, insert, update, delete on all tables in schema public to fdv_app;
grant usage, select on all sequences in schema public to fdv_app;
alter default privileges in schema public grant select, insert, update, delete on tables to fdv_app;
alter default privileges in schema public grant usage, select on sequences to fdv_app;

-- The audit log is append-only (a trigger refuses too), and the
-- installation's identifier is read-only.
revoke update, delete on public.audit_event from fdv_app;
do $$
begin
  if to_regclass('public.instance') is not null then
    revoke insert, update, delete on public.instance from fdv_app;
  end if;
  if to_regprocedure('public.invitation_household(bytea)') is not null then
    grant execute on function public.invitation_household(bytea) to fdv_app;
  end if;
  if to_regprocedure('public.share_link_household(bytea)') is not null then
    grant execute on function public.share_link_household(bytea) to fdv_app;
  end if;
  -- A link's rule (0030) asks it which document the link may see.
  if to_regprocedure('public.app_shared_document()') is not null then
    grant execute on function public.app_shared_document() to fdv_app;
    grant execute on function public.app_shared_version() to fdv_app;
  end if;
  -- Which link a session cookie belongs to, before the link is known (0037).
  if to_regprocedure('public.share_session_find(bytea)') is not null then
    grant execute on function public.share_session_find(bytea) to fdv_app;
  end if;
  -- A link's rules since 0042 ask them what it reaches now: its share while
  -- live, its documents and their files, its collection and its sharer. And
  -- the activity log's next line is chained through its last hash, which a
  -- link may not read the log for.
  if to_regprocedure('public.app_live_share()') is not null then
    grant execute on function public.app_live_share() to fdv_app;
    grant execute on function public.app_link_documents() to fdv_app;
    grant execute on function public.app_link_versions() to fdv_app;
    grant execute on function public.app_link_collection() to fdv_app;
    grant execute on function public.app_link_sharer() to fdv_app;
    grant execute on function public.audit_chain_head(uuid) to fdv_app;
    -- And what a link's own lines in the activity log may say (5.19 review).
    grant execute on function public.app_link_label() to fdv_app;
    grant execute on function public.app_link_may_name(text, uuid) to fdv_app;
    grant execute on function public.app_link_locked() to fdv_app;
    -- What a link's lines may be and say, one place each (the third review).
    grant execute on function public.app_link_audit_actions() to fdv_app;
    grant execute on function public.app_link_line_keys(text) to fdv_app;
  end if;
  -- The migrations' own record, and the suggestion rules every household
  -- shares, are the vault's: the application only reads them.
  if to_regclass('public.schema_migration') is not null then
    revoke insert, update, delete on public.schema_migration from fdv_app;
  end if;
  if to_regclass('public.suggestion_rule') is not null then
    revoke insert, update, delete on public.suggestion_rule from fdv_app;
  end if;
  -- A household's types as they are in effect (0031) are read, never
  -- written: a type is changed where it is kept.
  if to_regclass('public.effective_document_type') is not null then
    revoke insert, update, delete on public.effective_document_type from fdv_app;
  end if;
  -- A collection is marked deleted, never removed (0036; named so by 0039):
  -- its lines in the activity log find their audience through it.
  if to_regclass('public.doc_collection') is not null then
    revoke delete on public.doc_collection from fdv_app;
  end if;
  -- Who may change a collection asks it whether nobody may any more (0036).
  if to_regprocedure('public.doc_collection_stranded(uuid, text)') is not null then
    grant execute on function public.doc_collection_stranded(uuid, text) to fdv_app;
  end if;
  -- Asking someone to send documents (0044): which request a token names
  -- and which session a cookie, before either is known; an upload link's
  -- own request while it can be used, which its rules ask; and the
  -- household's files waiting for review, counted for its cap.
  if to_regprocedure('public.upload_request_find(bytea)') is not null then
    grant execute on function public.upload_request_find(bytea) to fdv_app;
    grant execute on function public.upload_session_find(bytea) to fdv_app;
    grant execute on function public.app_live_upload_request() to fdv_app;
    grant execute on function public.incoming_room(uuid) to fdv_app;
    -- Requests whose requester can no longer ask, closed by whoever changed them (A39).
    grant execute on function public.upload_requests_close_lost() to fdv_app;
    -- What an upload link reaches of the household's other tables (A74):
    -- who asked, the one key, the vaults; and what its own lines in the
    -- activity log may say.
    grant execute on function public.app_upload_requester() to fdv_app;
    grant execute on function public.app_upload_scope_key() to fdv_app;
    grant execute on function public.app_upload_vaults() to fdv_app;
    grant execute on function public.app_upload_label() to fdv_app;
    grant execute on function public.app_upload_locked() to fdv_app;
    grant execute on function public.app_upload_audit_actions() to fdv_app;
    grant execute on function public.app_upload_line_keys(text) to fdv_app;
  end if;
  -- What a document removed for good leaves behind (0045) is written once,
  -- by the owner removing it, and never changed or removed after.
  if to_regclass('public.document_tombstone') is not null then
    revoke update, delete on public.document_tombstone from fdv_app;
  end if;
  -- Identity details (0050): a part is never removed but with its person,
  -- nor a notice but with its household; and every caller's rule reads the
  -- household's audience in effect now through the one function.
  if to_regclass('public.member_identity') is not null then
    revoke delete on public.member_identity from fdv_app;
    revoke delete on public.notice_request from fdv_app;
    grant execute on function public.identity_audience_now() to fdv_app;
  end if;
  -- A lock that ends a person's links for good ends their requests too
  -- (0051), with the owner's rights: a review-by-me request is its
  -- requester's alone.
  if to_regprocedure('public.upload_requests_end_for_lock(uuid)') is not null then
    grant execute on function public.upload_requests_end_for_lock(uuid) to fdv_app;
  end if;
  -- A reset an owner starts (0052): whether somebody keeps anything
  -- private, asked by an owner and as a hand-over link is spent; and the
  -- exports every reset ends, by the page that spends it.
  if to_regprocedure('public.member_holds_private(uuid)') is not null then
    grant execute on function public.member_holds_private(uuid) to fdv_app;
    grant execute on function public.password_reset_expire_exports(uuid) to fdv_app;
    -- And the share links made as somebody since a hand-over link was spent,
    -- ended by their next change of the password or reset (5.29).
    grant execute on function public.handover_links_end(uuid) to fdv_app;
  end if;
end $$;

-- The job queue. pg-boss creates its tables later, as the owner; the
-- default privileges cover those, and these cover a restored copy.
grant usage on schema pgboss to fdv_app;
grant select, insert, update, delete on all tables in schema pgboss to fdv_app;
grant usage, select on all sequences in schema pgboss to fdv_app;
grant execute on all functions in schema pgboss to fdv_app;
alter default privileges in schema pgboss grant select, insert, update, delete on tables to fdv_app;
alter default privileges in schema pgboss grant usage, select on sequences to fdv_app;
alter default privileges in schema pgboss grant execute on functions to fdv_app;
`;

/** Applies {@link APP_PRIVILEGES} in one transaction, as the owning role. */
export async function applyPrivileges(client: pg.ClientBase): Promise<void> {
  await client.query('begin');
  try {
    await client.query(APP_PRIVILEGES);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw new Error(
      `could not apply the application role's privileges: ${(err as Error).message}`,
      {
        cause: err,
      },
    );
  }
}
