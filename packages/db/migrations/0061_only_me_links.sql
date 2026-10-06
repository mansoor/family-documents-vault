-- Only me documents and links outside the family (iteration 5.41; the
-- owner's decision of 6 Oct 2026).
--
-- A household rule, managed by the owners: "Only me documents can be shared
-- outside the family". On unless an owner turns it off (and on for a vault
-- restored from a backup made before this). On, as before: the owner of an
-- Only me document alone makes a link to it. Off: no link serves an Only me
-- document — a document's link to one, or a collection's link that ticked
-- one — whoever made it. The API pauses those that are live as it is turned
-- off (paused_reason only_me_not_shared) and turns them back on as it is
-- turned on again. The two functions below are 0054's, each with that one
-- check added, so that a pause missed serves nothing either;
-- ShareService.live() asks the same.
--
-- Who changes it: an owner signed in (an owner power, A54, the API), the
-- vault itself, or the owning role (a restore) — household_only_me_rule.

alter table household add column only_me_shareable boolean not null default true;

alter table share_link drop constraint share_link_paused_reason,
  add constraint share_link_paused_reason
    check (paused_reason in ('restored', 'only_me_not_shared'));

create function household_only_me_rule() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.only_me_shareable is distinct from old.only_me_shareable
     and app_actor() is not null and app_actor() <> 'system'
     and (app_actor() <> 'account' or app_role() is distinct from 'owner') then
    raise exception 'only an owner changes whether Only me documents are shared outside the family'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger household_only_me_rule before update on household
  for each row execute function household_only_me_rule();

-- Whether this household lets its Only me documents out: on, unless an
-- owner turned it off.
create function app_only_me_shareable() returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select coalesce((select h.only_me_shareable from household h
                       where h.id = app_household()), true) $$;
grant execute on function app_only_me_shareable() to fdv_app;

-- 0054's document for a link: an Only me one only while the household lets
-- them out.
create or replace function app_shared_document() returns uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select s.document_id
       from share_link s
       join document d on d.id = s.document_id
       join account_household maker
         on maker.account_id = s.created_by and maker.household_id = s.household_id
      where s.id = app_share()
        and s.household_id = app_household()
        and s.revoked_at is null
        and s.paused_at is null
        and s.expires_at > now()
        and s.attempts < 10
        and d.deleted_at is null
        and not suspension_in_effect(maker.suspended_at, maker.suspended_until)
        and case d.visibility
              when 'household' then true
              when 'adults' then maker.role in ('owner', 'adult')
              when 'private' then d.owner_member_id = maker.member_id and app_only_me_shareable()
              else false
            end
        and maker_lends(maker.member_id, d.id, d.visibility, d.owner_member_id, d.type_key) $$;

-- 0054's documents of a link: a collection's Only me one too, only while
-- the household lets them out.
create or replace function app_link_documents() returns setof uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select s.document_id
       from share_link s
      where s.id = app_live_share()
        and s.document_id is not null
     union
     select d.id
       from share_link s
       join doc_collection c on c.id = s.collection_id and c.household_id = s.household_id
       join account_household maker
         on maker.account_id = s.created_by and maker.household_id = s.household_id
       join share_link_item t on t.share_id = s.id and t.kind in ('ticked', 'followed')
       join doc_collection_item i on i.collection_id = c.id and i.document_id = t.document_id
       join document d on d.id = t.document_id and d.household_id = s.household_id
      where s.id = app_live_share()
        and d.deleted_at is null
        and case d.visibility
              when 'household' then true
              when 'adults' then maker.role in ('owner', 'adult')
              when 'private' then coalesce(d.owner_member_id = maker.member_id, false)
                                  and app_only_me_shareable()
              else false
            end
        and coalesce((select v.file_removed_at is null
                         from document_version v
                        where v.document_id = d.id
                        order by v.version_no desc
                        limit 1), false)
        and (t.kind = 'ticked'
             or (collection_audience_sees(c.audience, d.visibility::text)
                 and collection_audience_sees(s.follow_audience, d.visibility::text)))
        and maker_lends(maker.member_id, d.id, d.visibility, d.owner_member_id, d.type_key) $$;
