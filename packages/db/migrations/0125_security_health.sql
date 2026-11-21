-- Settings → Security & health (0.9.0-dev.78).
--
-- The card reads a household's activity log by what happened: the last
-- backup the worker made, its last check of the log, the day's failed
-- sign-ins. An index by household, action and line lets each be found by
-- its newest line, and the day's counted from a bound, without reading the
-- household's whole log.
--
-- What the server does — its backups, their copy off-site, the restore
-- drill — is the installation's own household's to see: the first one set
-- up, the one the sign-in screen is named after (vault_display_name). On a
-- server with more than one, the others' cards leave those lines out, so
-- the API asks whether the household it is acting in is that one. A
-- definer function, as vault_display_name is: the application role sees no
-- household but its own. It answers only yes or no, of the caller's own.

create index audit_event_action_idx on audit_event (household_id, action, id);

create function app_is_installation_household() returns boolean
  language sql stable security definer set search_path = pg_catalog, public, pg_temp as
  $$ select coalesce(app_household() = (select id from household
                                          where deleted_at is null
                                          order by created_at, id limit 1), false) $$;

revoke execute on function app_is_installation_household() from public;
grant execute on function app_is_installation_household() to fdv_app;
