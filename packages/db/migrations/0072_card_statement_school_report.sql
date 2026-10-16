-- Two kinds of their own (0.8.0, S5, the owner's decision of 16 Oct 2026):
-- a credit card statement and a school report.
--
-- The Smart exit's measurement found both filed under the nearest kind the
-- vault had, and read as neither: a card statement is not a bank's (it has
-- a credit limit, a minimum payment and a date it is due, where a bank's has
-- a sort code and an opening and closing balance), and a school report is
-- not a diploma. Each is now a built-in, as the others are:
--
--   credit_card_statement  Financial, kept for adults, like a bank
--                          statement. It has a payment due date, which it
--                          reminds from as a bill does (7 days and a day
--                          before), so its card's expiry is "Payment due".
--   school_report          Education, seen by the household, like a
--                          diploma. It does not expire.
--
-- Their fields are the library's own (0031): the card's last four digits
-- and an amount; a school report's year. Nothing else changes: no document
-- is moved to either kind — a household moves its own, if it wants to — and
-- a household's settings on other kinds stay as they are.
--
-- A migration is nobody's edit: no audit event is written.

insert into document_type
  (key, label, category, fields, expiry_driver, reminder_leads, usually_essential,
   default_visibility, sort_order, issued_by_label, short_label, issuer_noun, remind_from, core)
values
  ('credit_card_statement', 'Credit card statement', 'financial',
   '[{"key":"account_last4","label":"Card (last 4)","kind":"text","required":false},
     {"key":"amount","label":"Amount","kind":"text","required":false}]',
   'expires_on', '{7,1}', false, 'adults', 62, 'Card issuer', 'Credit card statement', 'statement',
   'expires',
   fdv_type_core('{"expires":{"label":"Payment due"}}', '{}', 'Card issuer', true)),
  ('school_report', 'School report', 'education',
   '[{"key":"year","label":"Year","kind":"year","required":false}]',
   null, '{}', false, 'household', 81, 'School', 'School report', null,
   null,
   fdv_type_core('{}', '{}', 'School', false));
