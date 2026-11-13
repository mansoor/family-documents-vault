-- Whether a push address is somebody else's, asked before it is registered
-- (0.9.0; CI on PostgreSQL 16.16, 12 Nov 2026).
--
-- Registering an address is an upsert on its endpoint whose DO UPDATE has
-- a WHERE: only one's own row (E541-02). Up to PostgreSQL 16.15 a row the
-- WHERE left alone was never checked against the table's rules, so an
-- address somebody else holds came back as no row: 409 device_taken. From
-- 16.16 (and the same minor releases of 17 and 18) the conflicting row is
-- checked against the UPDATE rules first, WHERE or no WHERE, and a row the
-- caller's rules hide raises "new row violates row-level security policy
-- (USING expression)". A restricted viewer or a guest sees only their own
-- devices (device_restricted, 0054): somebody else's address became a
-- server error for them. An address of one's own account but another
-- household fails device_tenant the same way, on any release.
--
-- So the API asks first, here, with the vault's rights (a limited caller's
-- rules cannot see the row it asks about), and never sends the upsert a
-- row it may not touch. In one step, in this order:
--
--   1. Holds the address for the rest of the transaction: every
--      registration of it asks here first, so two at once go one after the
--      other, and the answer still holds when the upsert runs.
--   2. Frees it if it is somebody else's whose sign-in has ended (0060's
--      device_release_stale, C-01).
--   3. Says whether it is still held by anybody but the caller, in the
--      caller's household.
--
-- A yes or no is all it says: never whose, nor whether that sign-in is
-- live, nor which household. The 409 has always said as much; an address
-- is a long random URL, never guessed.

create function device_endpoint_held(p_endpoint text) returns boolean
  language plpgsql volatile security definer
  set search_path = pg_catalog, public, pg_temp as
$$
begin
  -- Only somebody signed in, in a household, asks. Anybody else is told
  -- it is held: the safe answer.
  if app_account() is null or app_household() is null then
    return true;
  end if;
  perform pg_advisory_xact_lock(hashtext('device_endpoint'), hashtext(p_endpoint));
  perform device_release_stale(p_endpoint);
  return exists (
    select 1 from device d
     where d.endpoint = p_endpoint
       and (d.account_id is distinct from app_account()
            or d.household_id is distinct from app_household()));
end
$$;

revoke all on function device_endpoint_held(text) from public;
grant execute on function device_endpoint_held(text) to fdv_app;
