-- Tags you can use (0.9.0, T1): detail tags, and tags compared whatever
-- their case.
--
-- A detail tag is a tag with a label: "locker: 12", "policy holder: Ahmed".
-- The first ': ' splits the label from the value, both trimmed, and both
-- must be there (@fdv/shared tags.ts holds the same rule, and says it). It
-- is kept as every tag is — in `document.tags`, in plain text, indexed by
-- search_tsv for whoever may see its document, an Only me one's for its
-- owner alone. Nothing here holds anything that is not in `tags` already:
-- the two columns below are worked out from it, by the database, and are
-- never written by anybody.
--
-- * tag_keys: each tag as it is compared, in the order of `tags` — spaces
--   tidied (every space JavaScript's \s knows, the no-break ones too), a
--   detail tag as 'label: value', all in lower case — a final "ς" as "σ",
--   and no dot above ("İ" is "i"), so that a word in capitals and the same
--   word put in lower case by JavaScript, as a plain tag or a label is
--   kept, are one. Whatever is compared with them is keyed here too
--   (fdv_tag_key), never by JavaScript, whose lower case is not the
--   database's: the Documents filter by a tag, the list of tags, and a
--   rename or a delete.
-- * tag_labels: the labels of its detail tags, in lower case, each once:
--   "every document with a locker".
--
-- They are stored, not indexed: under row-level security a filter on them
-- is not one an index may be used for (`@>` is not leakproof), so a filter
-- reads each row the household's rules give the caller and tests a short
-- array that is already there — nothing is worked out per row as it is
-- read. They are worked out as a row is written, in PL/pgSQL: a third of
-- what the same in SQL costs (which, unable to be inlined, ran its plan
-- for every row: 4 s more for 20,000 rows written, now about 1 s).
--
-- The functions call nothing but the built-ins: a restore computes these
-- columns, as it loads each row, with an empty search_path.
--
-- A migration is nobody's edit: no document's updated_at moves, and no
-- audit event is written.

create function fdv_tag_keys(tags text[]) returns text[]
  language plpgsql immutable parallel safe as $$
declare
  keys text[] := '{}';
  t text;
  s text;
  p integer;
begin
  if tags is null then
    return keys;
  end if;
  foreach t in array tags loop
    s := btrim(regexp_replace(coalesce(t, ''),
           '[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'));
    p := strpos(s, ': ');
    if p > 1 and btrim(substr(s, 1, p - 1)) <> '' and btrim(substr(s, p + 2)) <> '' then
      keys := keys || (replace(replace(lower(btrim(substr(s, 1, p - 1))), chr(962), chr(963)), chr(775), '')
                        || ': ' || replace(replace(lower(btrim(substr(s, p + 2))), chr(962), chr(963)), chr(775), ''));
    else
      keys := keys || replace(replace(lower(s), chr(962), chr(963)), chr(775), '');
    end if;
  end loop;
  return keys;
end $$;

create function fdv_tag_labels(tags text[]) returns text[]
  language plpgsql immutable parallel safe as $$
declare
  labels text[] := '{}';
  t text;
  s text;
  p integer;
  label text;
begin
  if tags is null then
    return labels;
  end if;
  foreach t in array tags loop
    s := btrim(regexp_replace(coalesce(t, ''),
           '[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'));
    p := strpos(s, ': ');
    if p > 1 and btrim(substr(s, 1, p - 1)) <> '' and btrim(substr(s, p + 2)) <> '' then
      label := replace(replace(lower(btrim(substr(s, 1, p - 1))), chr(962), chr(963)), chr(775), '');
      if not (label = any(labels)) then
        labels := labels || label;
      end if;
    end if;
  end loop;
  return labels;
end $$;

-- One tag as it is compared, and one label: what a filter, a rename or a
-- delete is asked about, keyed as the columns key what they hold.
create function fdv_tag_key(tag text) returns text
  language sql immutable parallel safe as $$
  select (public.fdv_tag_keys(array[tag]))[1] $$;

create function fdv_tag_label_key(label text) returns text
  language sql immutable parallel safe as $$
  select replace(replace(lower(btrim(regexp_replace(regexp_replace(label, ':[\s\u00a0]*$', ''),
                 '[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+',
                 ' ', 'g'))), chr(962), chr(963)), chr(775), '') $$;

alter table document add column tag_keys text[]
  generated always as (fdv_tag_keys(tags)) stored;
alter table document add column tag_labels text[]
  generated always as (fdv_tag_labels(tags)) stored;
