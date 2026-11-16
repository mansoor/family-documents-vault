-- Where a link or a request was emailed, for the family who see it (0.9.0,
-- DA; the owner's decision of 16 Nov 2026).
--
-- 0094 and 0103 gave the masked address a link or a request was emailed to
-- (j•••@e•••.com) to its sender alone. The owner's word: "in family set up
-- to find if a requested document was already shared or its still waiting
-- for someone to share". The activity log already says it to the family;
-- Sharing says it too now. So a row is read by whoever is given the link or
-- the request it is about — share_link's and upload_request's own rules
-- decide who that is — as well as by its sender, and by the vault.
--
-- A row whose link or request was removed for good (its id null) is its
-- sender's alone, as before: the day's counts stand. What is written is
-- unchanged: the rule's check is 0094's and 0103's word for word, and the
-- insert, update and delete rules are left as they are.

drop policy share_link_email_actor on share_link_email;
create policy share_link_email_actor on share_link_email as restrictive
  using (case app_actor()
           when 'system' then true
           when 'account' then sent_by = app_account()
                               or exists (select 1 from share_link l
                                           where l.id = share_link_email.share_id)
           else false
         end)
  with check (case app_actor()
                when 'system' then true
                when 'account' then sent_by = app_account()
                else false
              end);

drop policy upload_request_email_actor on upload_request_email;
create policy upload_request_email_actor on upload_request_email as restrictive
  using (case app_actor()
           when 'system' then true
           when 'account' then sent_by = app_account()
                               or exists (select 1 from upload_request r
                                           where r.id = upload_request_email.request_id)
           else false
         end)
  with check (case app_actor()
                when 'system' then true
                when 'account' then sent_by = app_account()
                else false
              end);
