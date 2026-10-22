-- A collection from a checklist (0.9.0, C1, the owner's request of 18 Oct
-- 2026): a list a family is asked for — "Documents for Mansoor / W2 for
-- 2025 and 2024 / Last 3 pay statements …" — read, matched against what
-- the reader can see, and kept on the collection, each line with what it
-- was understood to ask for. Two kinds the owner's example needs come
-- with it.
--
-- ------------------------------------------------------------- the kinds
--
--   pay_statement         Financial, kept for adults, like a bank statement:
--                         a payslip, a pay stub, an earnings statement. It
--                         does not expire. Its issuer is the employer.
--   investment_statement  Financial, kept for adults: a brokerage's, a
--                         fund's, a retirement account's statement — a kind
--                         of its own, apart from a bank's, as the owner chose
--                         for credit-card statements (0072). It does not
--                         expire.
--
-- So the bank's own kind is now called what it is, "Bank statement": its
-- label said "Bank / investment statement" while it was both. Its key, its
-- fields and every document of it stay as they are, and a household's
-- settings on it too; its ETag moves with its label, so a phone loads it
-- again. No document is moved to either new kind — a household moves its
-- own, if it wants to — and their fields are the library's own (0031).
--
-- ------------------------------------------------------- the checklist
--
-- One a collection, kept as the items its maker saved: each line as
-- written, the heading it was under, and what it asks for (a kind, a
-- person or nobody in particular, how many, of which years) — JSON the API
-- writes and reads, never shown to anybody it does not show the
-- collection to. A collection's name and words are kept in plain text
-- (0036), so its checklist is too, under the collection's own rules:
--
--   * of its household, and of a collection the reader is given: an Only
--     me collection's is its maker's alone, as the collection is
--     (doc_collection_only_me, read through the collection);
--   * to somebody signed in who is of the family — an owner, an adult or a
--     teen — and to the vault itself; never to a viewer or a guest, a
--     share link, an upload link, a signed-out page or a caller who says
--     nothing. It names people and what the household is applying for;
--   * written only by the collection's maker (A18), or the vault.
--
-- Deleting the collection keeps the row, as the collection's row is kept;
-- a household removed takes both.
--
-- A migration is nobody's edit: no audit event is written.

insert into document_type
  (key, label, category, fields, expiry_driver, reminder_leads, usually_essential,
   default_visibility, sort_order, issued_by_label, short_label, issuer_noun, remind_from, core)
values
  ('investment_statement', 'Investment statement', 'financial',
   '[{"key":"institution","label":"Institution","kind":"text","required":false},
     {"key":"account_last4","label":"Account (last 4)","kind":"text","required":false},
     {"key":"period","label":"Period","kind":"text","required":false}]',
   null, '{}', false, 'adults', 63, 'Institution', 'Investment statement', 'statement',
   null,
   fdv_type_core('{}', '{}', 'Institution', false)),
  ('pay_statement', 'Pay statement / payslip', 'financial',
   '[{"key":"period","label":"Period","kind":"text","required":false},
     {"key":"amount","label":"Amount","kind":"text","required":false}]',
   null, '{}', false, 'adults', 64, 'Employer', 'Pay statement', 'pay statement',
   null,
   fdv_type_core('{}', '{}', 'Employer', false));

update document_type
   set label = 'Bank statement', updated_at = now()
 where key = 'bank_statement' and household_id is null;

-- A household that already keeps a kind of its own by one of these names
-- ("Payslip", "Pay statement", "Investment statement") goes on using it:
-- the new built-in is hidden for that household, as if it had hidden it in
-- Kinds of document, where it can show it again. Its own kind, and every
-- document of it, are untouched (the C1 review).
insert into document_type_setting (household_id, type_key, hidden)
select distinct t.household_id, k.key, true
  from document_type t
  join (values
          ('pay_statement',
           array['pay statement', 'pay statements', 'payslip', 'payslips', 'pay slip', 'pay slips',
                 'pay stub', 'pay stubs', 'paystub', 'paystubs', 'pay statement / payslip',
                 'earnings statement', 'earnings statements', 'salary slip', 'salary slips']),
          ('investment_statement',
           array['investment statement', 'investment statements', 'investments',
                 'brokerage statement', 'brokerage statements', 'portfolio statement',
                 'portfolio statements'])
       ) as k(key, names)
    on lower(btrim(t.label)) = any(k.names)
       or lower(btrim(coalesce(t.short_label, ''))) = any(k.names)
 where t.household_id is not null
   and t.archived_at is null
   and t.deleted_at is null
on conflict (household_id, type_key) do update set hidden = true;

create table collection_checklist (
  collection_id uuid primary key,
  household_id  uuid not null references household(id) on delete cascade,
  -- At most 100 items, each as @fdv/shared checklist.ts keeps one.
  items         jsonb not null default '[]'
                check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 100),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references account(id) on delete set null,
  foreign key (collection_id, household_id)
    references doc_collection (id, household_id) on delete cascade
);

alter table collection_checklist enable row level security;

create policy collection_checklist_tenant on collection_checklist
  using (household_id = app_household()) with check (household_id = app_household());

-- The family signed in, and the vault; nobody else. Each role is named, so
-- a role added later sees none until it is taught here.
create policy collection_checklist_actor on collection_checklist as restrictive
  using (case app_actor()
           when 'account' then case app_role()
                                 when 'owner' then true
                                 when 'adult' then true
                                 when 'teen' then true
                                 else false
                               end
           when 'system' then true
           else false
         end);

-- A collection the caller is not given has no checklist for them either:
-- doc_collection's own rules (Only me among them) decide.
create policy collection_checklist_collection on collection_checklist as restrictive
  using (exists (select 1 from doc_collection l where l.id = collection_checklist.collection_id));

-- Written by its collection's maker alone, or by the vault (A18).
create policy collection_checklist_maker_insert on collection_checklist as restrictive
  for insert
  with check (coalesce(app_actor() = 'system', false)
              or exists (select 1 from doc_collection l
                          where l.id = collection_checklist.collection_id
                            and l.owner_member_id = app_member()));
create policy collection_checklist_maker_update on collection_checklist as restrictive
  for update
  using (coalesce(app_actor() = 'system', false)
         or exists (select 1 from doc_collection l
                     where l.id = collection_checklist.collection_id
                       and l.owner_member_id = app_member()));
create policy collection_checklist_maker_delete on collection_checklist as restrictive
  for delete
  using (coalesce(app_actor() = 'system', false)
         or exists (select 1 from doc_collection l
                     where l.id = collection_checklist.collection_id
                       and l.owner_member_id = app_member()));

grant select, insert, update, delete on collection_checklist to fdv_app;
