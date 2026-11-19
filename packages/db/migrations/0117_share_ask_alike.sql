-- Sharing and Ask for documents alike (0.9.0-dev.69; the owner's feedback
-- of 18 Nov 2026).
--
-- 1. A PIN for a request. A share link has offered four digits the vault
--    makes up, or a password, since 0.5.0; a request offered a password
--    alone. Now it may ask for a PIN instead — never both — under the same
--    rules: made up by the vault, kept as its Argon2 hash in secret_hash
--    (checked as typed), shown once as it is made and kept in the request's
--    sealed copy to be shown again, and every wrong one uses up one of the
--    request's ten tries (A23), reserved before it is checked. 0103's rules
--    for who may change it stand as they are: a PIN is a secret_kind like
--    the others.
--
-- 2. A link or a request texted to whoever it is for, by the vault, through
--    the household's own text messages (0084), as one has been emailed
--    since 0094 and 0103. Each text is one row of share_link_email or
--    upload_request_email, as each email is, with `way` saying which: the
--    rows are what the day's sends are counted by — 3 a link or a request
--    and 20 a person in a day, by email and by text each, links and
--    requests together — and what Sharing says of where it went, masked
--    (•••• •••123), never the number. A text SMS Gate did not take is kept
--    as `sms_not_sent`: counted, as a code that was not sent is, and never
--    said to be where the link went.
--    Those rows' rules (0094, 0103, 0108) cover a text as they cover an
--    email: written as its sender, read by its sender, by whoever sees its
--    link or request, and by the vault. Each text is also one row of
--    sms_message, counted against the household's monthly cap: two new
--    kinds of it.

-- ----------------------------------------------------------- 1. the PIN

alter table upload_request drop constraint upload_request_secret_kind;
alter table upload_request
  add constraint upload_request_secret_kind
    check (secret_kind in ('pin', 'password', 'generated'));

-- And a sender's session says it was opened with one.
alter table upload_session drop constraint upload_session_verified_by;
alter table upload_session
  add constraint upload_session_verified_by
    check (verified_by <@ array['pin', 'password', 'email_code', 'this_device']::text[]);

-- ------------------------------------------------------- 2. the texts

alter table share_link_email
  add column way text not null default 'email'
    constraint share_link_email_way check (way in ('email', 'sms', 'sms_not_sent'));
alter table upload_request_email
  add column way text not null default 'email'
    constraint upload_request_email_way check (way in ('email', 'sms', 'sms_not_sent'));

alter table sms_message drop constraint sms_message_kind;
alter table sms_message add constraint sms_message_kind
  check (kind in ('test', 'phone_code', 'phone_changed', 'reminders', 'alert', 'share_opened',
                  'share_code', 'invite_code', 'reset_code', 'sign_in_code', 'step_up_code',
                  'share_link', 'request_link'));
