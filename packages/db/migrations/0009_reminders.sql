-- Reminders (REM-02..08, REM-12, REM-13; data model section 4).
--
-- Derived reminders come from the type template and are regenerated when
-- a document's dates change; manual ones are never touched. A reminder
-- fires on the household's local calendar date, so fire_at is a date, not
-- a timestamp: a passport does not expire at midnight UTC.

create table reminder (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references household(id) on delete cascade,
  document_id     uuid not null references document(id) on delete cascade,
  kind            text not null check (kind in ('derived', 'manual')),
  fire_at         date not null,
  lead_days       int,                              -- derived: days before expiry
  note            text,                             -- manual: what to do
  recurrence      text,                             -- 'monthly' | 'quarterly' | 'annual' | 'every:Nm'
  channel         text[] not null default '{push,email}',
  status          text not null default 'scheduled'
                    check (status in ('scheduled', 'due', 'snoozed', 'acknowledged', 'resolved')),
  snoozed_until   date,
  acknowledged_by uuid references account(id),
  acknowledged_at timestamptz,
  created_by      uuid references account(id),
  created_at      timestamptz not null default now()
);
create index reminder_household_status_idx on reminder (household_id, status, fire_at);
create index reminder_document_idx on reminder (household_id, document_id);

-- The idempotency guard for delivery: a worker that runs twice inserts
-- once. Also what implements the catch-up rule — every reminder whose
-- fire_at has passed with no row here is collected into one notification.
create table reminder_delivery (
  reminder_id  uuid not null references reminder(id) on delete cascade,
  household_id uuid not null references household(id) on delete cascade,
  fire_date    date not null,
  channel      text not null,
  delivered_at timestamptz not null default now(),
  primary key (reminder_id, fire_date, channel)
);

-- One digest per household per local day, whatever the channel count.
create table notification_digest (
  household_id  uuid not null references household(id) on delete cascade,
  local_date    date not null,
  kind          text not null default 'daily',   -- 'daily' | 'catch_up'
  item_count    int not null,
  channels      text[] not null default '{}',
  sent_at       timestamptz not null default now(),
  primary key (household_id, local_date, kind)
);

alter table reminder enable row level security;
create policy reminder_tenant on reminder
  using (household_id = app_household()) with check (household_id = app_household());
alter table reminder_delivery enable row level security;
create policy reminder_delivery_tenant on reminder_delivery
  using (household_id = app_household()) with check (household_id = app_household());
alter table notification_digest enable row level security;
create policy notification_digest_tenant on notification_digest
  using (household_id = app_household()) with check (household_id = app_household());

grant select, insert, update, delete on reminder, reminder_delivery, notification_digest to fdv_app;

-- Where the household is, so "9am local" and "today" mean the right thing.
alter table household add column timezone text not null default 'UTC';
