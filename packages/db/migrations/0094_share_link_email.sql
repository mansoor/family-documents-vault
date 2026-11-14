-- A share link emailed to its recipient (0.9.0; the owner's decision of 13
-- Nov 2026).
--
-- Family and friends asked to send a link to its recipient from the app,
-- the PIN or password told separately by phone or text. The vault emails
-- the link itself, through the operator's mail server alone (FDV_SMTP_URL,
-- A21), never a household's; never with the PIN, the password or a code,
-- and never with what the link is to. Only the account that made the link
-- sends it, as it is made or later (after confirming it's them), from the
-- sealed copy 0084 keeps.
--
--   share_link_email   one row an email sent: which link, who sent it, when,
--                      whether a short message of the sharer's went with it
--                      (never the message), and where it went — masked as
--                      the list and the activity log show it
--                      (j•••@e•••.com), never the address. The rows are
--                      what the sends are counted by: 3 a link and 20 an
--                      account in a day. A sender's own, and the vault's;
--                      written once, never changed. A link removed for good
--                      (a purge, or its document's) leaves its rows with no
--                      link, so its sender's count for the day stands.

create table share_link_email (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references household(id) on delete cascade,
  -- Null once its link is removed for good: the row stays, to be counted.
  share_id     uuid,
  -- Only a link of 5.16's kind (`v2`) has a sealed copy to email.
  flow         text not null default 'v2' constraint share_link_email_v2_only check (flow = 'v2'),
  sent_by      uuid not null references account(id) on delete cascade,
  to_masked    text not null
                 constraint share_link_email_masked
                 check (char_length(to_masked) between 3 and 40 and position('•' in to_masked) > 0),
  with_message boolean not null default false,
  sent_at      timestamptz not null default now(),
  foreign key (share_id, household_id, flow)
    references share_link (id, household_id, flow) on delete set null (share_id)
);
create index share_link_email_share_idx on share_link_email (share_id, sent_at);
create index share_link_email_sender_idx on share_link_email (sent_by, sent_at);

alter table share_link_email enable row level security;
create policy share_link_email_tenant on share_link_email
  using (household_id = app_household()) with check (household_id = app_household());

-- A rule for each kind of caller (0030's): whoever sent it reads it, and
-- the vault every row. Nobody else — an owner, another adult, a link, a
-- signed-out page — is given one.
create policy share_link_email_actor on share_link_email as restrictive
  using (case app_actor()
           when 'system' then true
           when 'account' then sent_by = app_account()
           else false
         end);

-- Written as themselves, by the account that made the link, while it has
-- not been taken back: nobody emails anybody else's link, and nobody signed
-- in writes a row with no link. The vault's own writes are its own.
create policy share_link_email_actor_insert on share_link_email as restrictive for insert
  with check (case app_actor()
                when 'system' then true
                when 'account' then
                  sent_by = app_account()
                  and exists (select 1 from share_link l
                               where l.id = share_link_email.share_id
                                 and l.household_id = share_link_email.household_id
                                 and l.created_by = app_account()
                                 and l.revoked_at is null)
                else false
              end);

-- Once sent, a row is what it was: nobody changes one — only its link's
-- removal, by its foreign key, lets go of the link — and only the vault
-- (or its household's or sender's removal) removes one.
create policy share_link_email_actor_update on share_link_email as restrictive for update
  using (false) with check (false);
create policy share_link_email_actor_delete on share_link_email as restrictive for delete
  using (app_actor() = 'system');
