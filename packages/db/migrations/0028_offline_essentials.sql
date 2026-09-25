-- Essentials a phone may keep (iteration 4.9).
--
-- A phone keeps the household's Essentials for when there is no
-- connection — a passport at a border, a policy at a roadside. Keeping them
-- needs the person's password again, once: an offline grant on the
-- session, for at most 30 days and never past the session's own end. The
-- grant goes with the session: signing out, a revoked or reused session, a
-- removed person, or a password changed elsewhere (which ends the other
-- sessions) all end it too. It never relaxes the step-up the ordinary
-- routes ask for.
--
-- * session.offline_granted_at / offline_expires_at: when the grant was
--   made and when it lapses; null when there is none.
-- * session.offline_include_private: the person's own Only me Essentials
--   are in their set too (they chose it on the phone).
-- * client_event_receipt: every event a phone reports (an Essential opened
--   offline) has its own id; one already received is not recorded twice,
--   however often the phone sends it. Keyed by the account that sent it:
--   one person's ids can never block, or tell anything about, another's.
-- * offline_fill: the vault's own record that a session's phone has kept a
--   version (written once, with the first page it fetches). Nothing a phone
--   sends can reach it.

alter table session add column offline_granted_at timestamptz;
alter table session add column offline_expires_at timestamptz;
alter table session add column offline_include_private boolean not null default false;

create table client_event_receipt (
  household_id uuid not null references household(id) on delete cascade,
  account_id   uuid not null references account(id) on delete cascade,
  event_id     uuid not null,
  received_at  timestamptz not null default now(),
  primary key (household_id, account_id, event_id)
);

create table offline_fill (
  household_id uuid not null references household(id) on delete cascade,
  session_id   uuid not null references session(id) on delete cascade,
  version_id   uuid not null references document_version(id) on delete cascade,
  filled_at    timestamptz not null default now(),
  primary key (session_id, version_id)
);

alter table client_event_receipt enable row level security;
create policy client_event_receipt_tenant on client_event_receipt
  using (household_id = app_household()) with check (household_id = app_household());
alter table offline_fill enable row level security;
create policy offline_fill_tenant on offline_fill
  using (household_id = app_household()) with check (household_id = app_household());

grant select, insert, update, delete on client_event_receipt, offline_fill to fdv_app;
