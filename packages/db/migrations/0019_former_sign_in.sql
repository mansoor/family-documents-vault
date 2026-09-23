-- Giving a removed sign-in back to the same person.
--
-- A member's scope key — the one that opens their *Only me* documents —
-- carries a second wrap made from their own password. Taking their sign-in
-- away (3.2b) leaves that wrap in place, deliberately: the person and
-- their documents stay. Until 0.4.2 the way back was an invitation, which
-- is a way in for whoever holds the link and the code — and the person
-- who makes an invitation holds both. Accepting it gave that account the
-- removed person's member key, and so their private documents.
--
-- So a member who has had a sign-in cannot be invited again. Their own
-- account is remembered here instead, and an owner can give the sign-in
-- back to that account, which the person signs in to with the password
-- only they know.
alter table member
  add column former_account_id uuid references account(id) on delete set null;

-- Everybody whose sign-in was taken away before this migration arrived by
-- invitation (an owner's cannot be removed), so the invitation they
-- accepted names the account to give back.
update member m
   set former_account_id = (
         select i.accepted_by
           from invitation i
          where i.member_id = m.id
            and i.accepted_by is not null
          order by i.accepted_at desc
          limit 1)
 where not exists (select 1 from account_household ah where ah.member_id = m.id)
   and exists (select 1 from invitation i where i.member_id = m.id and i.accepted_by is not null);
