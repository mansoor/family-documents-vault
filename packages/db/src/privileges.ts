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
