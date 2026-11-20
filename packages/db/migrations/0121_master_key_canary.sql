-- Which master key the vault was last opened with (0.9.0-dev.74).
--
-- The compose file's API runs on the application role alone, which cannot
-- see every household's keys, so it cannot check the master key itself.
-- Whatever can and does — the one-shot migrate service, or a worker or API
-- given the owning role — records an HMAC of the key here, under a key
-- derived for this alone (@fdv/crypto, key-canary.ts), and the API refuses
-- to start on a key whose HMAC differs. One row. Not tenant data: the
-- installation's, as watch_dir is, so no row-level security; read by the
-- application role, written by the owning role alone.
create table master_key_canary (
  singleton  boolean primary key default true
               constraint master_key_canary_singleton check (singleton),
  mac        bytea not null
               constraint master_key_canary_mac check (octet_length(mac) = 32),
  written_at timestamptz not null default now()
);
grant select on master_key_canary to fdv_app;
revoke insert, update, delete on master_key_canary from fdv_app;
