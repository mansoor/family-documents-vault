-- What a request's password is (iteration 5.22's review).
--
-- A password the vault makes up for a request is read out over the phone
-- and typed unseen, as a share link's is (5.20): "abcd-efgh-jkmn" typed as
-- "ABCD EFGH JKMN" is the same password. So it is kept, as a share link's
-- is (0043), as the Argon2 hash of its canonical form — lower case, with
-- no dashes or spaces — and checked in that form. A password the requester
-- typed is theirs, and is checked exactly as typed.
--
--   secret_kind   'generated'  made up by the vault, hashed canonical;
--                 'password'   typed by the requester, hashed as typed;
--                 null         no password, or one made before this
--                              migration — checked as typed, as it was
--                              hashed, whatever made it.
--
-- A column and its constraints, and nothing else: 0044's rules for each
-- kind of caller stand as they are. An upload link may change none of a
-- request's columns but its counters (upload_request_upload_writes, which
-- compares the whole row), so it cannot change this one either.

alter table upload_request
  add column secret_kind text
    constraint upload_request_secret_kind check (secret_kind in ('password', 'generated')),
  -- A kind of password only where there is one.
  add constraint upload_request_secret_kind_hashed
    check (secret_kind is null or secret_hash is not null);
