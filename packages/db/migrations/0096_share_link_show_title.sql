-- What Sensitive protects (0.9.0, H1a of plan-health): a link's page shows
-- a sensitive document's title only if its sharer chose to.
--
--   share_link.show_title   The sharer's choice, as the link was made:
--                           true shows the title on the page the
--                           recipient opens, false says "A document". Null
--                           — every link made before today, and one made
--                           with nothing said — is as each document is now
--                           (linkShowsTitle, @fdv/shared): a sensitive
--                           one's title is not shown, any other's is, as
--                           before. Worked out as the page is read, so a
--                           document made sensitive since is covered too.
--                           Set as the link is made, never after: a link's
--                           own writes (0088's share_link_link_writes) do
--                           not name it.
--
--   share_link_untitled()   For the link asking (app_live_share), which of
--                           the documents it gives now (app_link_documents)
--                           have their titles left out of its page. Whether
--                           a document is sensitive needs its kind's
--                           default as its household has it — a household's
--                           own setting (0031), which a link is given no
--                           row of — so this reads it for the link's own
--                           documents alone, and says only which. Its rule
--                           mirrors sensitiveOf (as sensitiveSql in the
--                           API does): the document's own choice; else its
--                           kind's, the household's setting before the
--                           release's; else, no kind, yes. Nobody else
--                           asking is told anything.
--
-- A migration is nobody's edit: no audit event is written, and no link's
-- row changes but for the new column, null.

alter table share_link add column show_title boolean;

create function share_link_untitled() returns setof uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
$$ select d.id
     from share_link s
     join document d on d.household_id = s.household_id
    where s.id = app_live_share()
      and d.id in (select app_link_documents())
      and case
            when s.show_title is not null then not s.show_title
            else coalesce(
                   d.sensitive,
                   (select coalesce(ts.sensitive_default, t.sensitive_default)
                      from document_type t
                      left join document_type_setting ts
                        on t.household_id is null
                       and ts.type_key = t.key
                       and ts.household_id = d.household_id
                     where t.key = d.type_key
                       and (t.household_id is null or t.household_id = d.household_id)
                     limit 1),
                   true)
          end $$;
revoke execute on function share_link_untitled() from public;
grant execute on function share_link_untitled() to fdv_app;
