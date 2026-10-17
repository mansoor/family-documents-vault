-- Tags you can use (0.9.0, T1): detail tags, and tags compared whatever
-- their case.
--
-- A detail tag is a tag with a label: "locker: 12", "policy holder: Ahmed".
-- The first ': ' splits the label from the value, both trimmed, and both
-- must be there (@fdv/shared tags.ts holds the same rule, and says it). It
-- is kept as every tag is — in `document.tags`, in plain text, indexed by
-- search_tsv for whoever may see its document, an Only me one's for its
-- owner alone — so nothing here makes a copy of anything, sealed or not:
-- these are functions of `tags`, and indexes on them.
--
-- * fdv_tag_keys(tags): each tag as it is compared — spaces tidied, a
--   detail tag as 'label: value', all in lower case. The Documents filter
--   by a tag, and the list of tags, match by it: "Agent: Sam Lee" is
--   "agent: sam lee". A plain tag was kept in lower case already, so a
--   filter by one finds what it always found.
-- * fdv_tag_labels(tags): the labels of its detail tags, in lower case:
--   "every document with a locker".
--
-- Each is written with nothing but the built-ins, and calls no function of
-- ours: a restore makes these indexes with an empty search_path.
--
-- A migration is nobody's edit: no document's updated_at moves, and no
-- audit event is written.

create function fdv_tag_keys(tags text[]) returns text[]
  language sql immutable parallel safe as $$
  select coalesce(array_agg(distinct
           case when p > 1 and btrim(substr(s, 1, p - 1)) <> '' and btrim(substr(s, p + 2)) <> ''
                then lower(btrim(substr(s, 1, p - 1))) || ': ' || lower(btrim(substr(s, p + 2)))
                else lower(s) end), '{}'::text[])
    from (select s, strpos(s, ': ') as p
            from (select btrim(regexp_replace(t, '\s+', ' ', 'g')) as s
                    from unnest(tags) as t) as tidied
           where s <> '') as split $$;

create function fdv_tag_labels(tags text[]) returns text[]
  language sql immutable parallel safe as $$
  select coalesce(array_agg(distinct lower(btrim(substr(s, 1, p - 1)))), '{}'::text[])
    from (select s, strpos(s, ': ') as p
            from (select btrim(regexp_replace(t, '\s+', ' ', 'g')) as s
                    from unnest(tags) as t) as tidied) as split
   where p > 1 and btrim(substr(s, 1, p - 1)) <> '' and btrim(substr(s, p + 2)) <> '' $$;

create index document_tag_keys_idx on document using gin (fdv_tag_keys(tags));
create index document_tag_labels_idx on document using gin (fdv_tag_labels(tags));
