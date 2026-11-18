-- A connected app's allow-list takes host names as well as addresses and
-- networks (0.9.0-dev.64, APP7).
--
-- An owner may write a name (feeds.example.com) where they wrote an address
-- or a network. The names are kept beside the addresses, in a column of
-- their own, so ip_allow stays cidr[]: the vault checks a request's address
-- against the networks, or against the A and AAAA addresses each name points
-- to as the request comes (looked up with a short timeout and cached for a
-- few minutes by the API; never a reverse lookup). A name that cannot be
-- looked up lets nothing in.
--
-- The vault writes each name as it keeps it: lower case, an international
-- name in punycode, no trailing dot. Ten entries at most, all told, as
-- before; five of them names at most, each looked up as requests come.

-- Each name as the vault writes it: labels of letters, digits and hyphens,
-- 1 to 63, a hyphen at neither end; two labels at least; 253 at most; a
-- letter in the last label (never an address). The names are checked joined
-- by spaces, and no name holds a space (its count is the array's), so one
-- element is always one name.
alter table connected_app
  add column ip_allow_names text[] not null default '{}'
    constraint connected_app_ip_allow_names check (
      cardinality(ip_allow_names) <= 5
      and cardinality(ip_allow) + cardinality(ip_allow_names) <= 10
      and cardinality(ip_allow_names)
          = coalesce(cardinality(string_to_array(array_to_string(ip_allow_names, ' '), ' ')), 0)
      and array_to_string(ip_allow_names, ' ')
          ~ ('^((?=[^ ]{1,253}( |$))([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+'
             '(?=[a-z0-9-]*[a-z])[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
             '( (?=[^ ]{1,253}( |$))([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+'
             '(?=[a-z0-9-]*[a-z])[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*)?$'));

-- What a client ID's request is checked against: its names too.
drop function connected_app_find(text);
create function connected_app_find(p_client_id text)
  returns table (household_id uuid, app_id uuid, key_id uuid, secret_hash bytea,
                 permissions text[], expires_at timestamptz, key_revoked boolean,
                 revoked boolean, paused_reason text, approval text, ip_allow text[],
                 ip_allow_names text[])
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select a.household_id, a.id, k.id, k.secret_hash, k.permissions, k.expires_at,
            k.revoked_at is not null,
            a.revoked_at is not null, a.paused_reason, a.approval, a.ip_allow::text[],
            a.ip_allow_names
       from connected_app_key k
       join connected_app a on a.id = k.app_id
      where k.client_id = p_client_id $$;
revoke execute on function connected_app_find(text) from public;
grant execute on function connected_app_find(text) to fdv_app;
