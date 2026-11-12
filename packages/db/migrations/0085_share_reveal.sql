-- A share link shown again, to whoever made it (0.9.0; the owner's decision
-- of 11 Nov 2026).
--
-- Until now a link was shown once: the vault kept only the SHA-256 of its
-- secret (0016), and the PIN or the password it made up only as an argon2
-- hash (0043). It still keeps those, and checks a link by them alone. Now
-- it also keeps a sealed copy of what it handed over as the link was made:
-- the link's secret, and the PIN or the password the vault made up, if it
-- made one (a password the sharer typed is theirs, and is never kept).
--
--   link_copy_sealed  AES-256-GCM under deriveKey(master, 'share-link-copies'),
--                     the household and the link bound in (MASTER_SEALED):
--                     moved by rotate-master-key, and by a restore of a
--                     backup made under an older key, as the other sealed
--                     secrets are. Opened by the API alone, for the account
--                     that made the link, after it has confirmed it's them
--                     (POST /shares/{id}/reveal), while the link still
--                     works or is only paused or used up.
--
-- A link made before this has none, and stays shown-once. A link taken back
-- forgets its copy in the statement that takes it back, whoever takes it
-- back; one that has ended otherwise is refused by the API, and its copy
-- opens for nobody.

alter table share_link
  add column link_copy_sealed bytea
    -- 12 bytes of IV, 16 of tag, and a few hundred of the link and its PIN
    -- or password, as JSON: nothing near the upper bound.
    constraint share_link_copy_length check (octet_length(link_copy_sealed) between 29 and 4096);

-- A copy is kept as a link is made, or not at all: nobody in a household —
-- the family, a link, the vault's own jobs — puts one on a link afterwards
-- or changes it. Only the owning role, outside any household (app_actor()
-- is then null), moves it onto another master key. Taken back, a link
-- forgets it, whoever asks.
create function share_link_copy_kept() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.revoked_at is not null then
    new.link_copy_sealed := null;
    return new;
  end if;
  if new.link_copy_sealed is distinct from old.link_copy_sealed and app_actor() is not null then
    raise exception 'a link keeps the copy it was made with'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger share_link_copy_kept before update on share_link
  for each row execute function share_link_copy_kept();
