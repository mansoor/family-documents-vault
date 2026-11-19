-- Text messages through Twilio as well as SMS Gate (0.9.0-dev.71).
--
-- The household's texts went only through SMS Gate for Android, a phone the
-- family owns. An owner may now choose Twilio instead: a paid service on the
-- internet, signed in to with the account's SID and Auth Token, sending from
-- one of the account's numbers or through one of its Messaging Services.
-- One provider at a time, said by `provider`; another (Vonage, MessageBird,
-- Plivo) would be a new value here and new columns of its own.
--
--   provider                 'sms_gate' (every row before this) or 'twilio'.
--   mode, base_url, username SMS Gate's, as before: required for SMS Gate,
--                            and null for Twilio, SMS Gate's password with
--                            them; and every twilio_* column null for SMS
--                            Gate. One provider's settings at a time.
--   twilio_account_sid       AC and 32 hex digits.
--   twilio_from              the number texts come from (E.164), or
--   twilio_messaging_service_sid  the Messaging Service that sends them (MG
--                            and 32 hex digits): exactly one of the two.
--   twilio_token_encrypted   the Auth Token, sealed exactly as SMS Gate's
--                            password is — AES-256-GCM under
--                            deriveKey(master, 'sms-credentials'), with the
--                            household and the Account SID bound in — never
--                            returned by the API, never in an export, and
--                            moved by rotate-master-key and by a restore of a
--                            backup made under an older key (MASTER_SEALED,
--                            twilioTokens).
--
-- Whether a test passed is still the vault's word alone, and anything that
-- reaches the provider — which provider, its sign-in, its sender, its secret
-- — waits for a test of its own: sms_settings_account_writes says so of the
-- Twilio columns too. sms_ready() asks for the chosen provider's secret.

alter table sms_settings
  add column provider text not null default 'sms_gate'
    constraint sms_settings_provider check (provider in ('sms_gate', 'twilio')),
  add column twilio_account_sid text
    constraint sms_settings_twilio_account_sid check (twilio_account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  add column twilio_from text
    constraint sms_settings_twilio_from check (twilio_from ~ '^\+[1-9][0-9]{6,14}$'),
  add column twilio_messaging_service_sid text
    constraint sms_settings_twilio_messaging_service_sid
    check (twilio_messaging_service_sid ~ '^MG[0-9a-fA-F]{32}$'),
  add column twilio_token_encrypted bytea
    constraint sms_settings_twilio_token check (octet_length(twilio_token_encrypted) between 29 and 4096);

alter table sms_settings
  alter column mode drop not null,
  alter column base_url drop not null,
  alter column username drop not null;

-- One provider at a time: what the chosen one needs is there, and nothing of
-- the other's is kept. SMS Gate has its mode, address and sign-in (its
-- password may still be to come, as before) and no Twilio column; Twilio
-- has its Account SID and one sender, a number or a Messaging Service, and
-- none of SMS Gate's — its password least of all.
alter table sms_settings
  add constraint sms_settings_sms_gate check (
    provider <> 'sms_gate'
    or (mode is not null and base_url is not null and username is not null
        and twilio_account_sid is null and twilio_from is null
        and twilio_messaging_service_sid is null and twilio_token_encrypted is null)),
  add constraint sms_settings_twilio check (
    provider <> 'twilio'
    or (twilio_account_sid is not null
        and (twilio_from is null) <> (twilio_messaging_service_sid is null)
        and mode is null and base_url is null and username is null
        and password_encrypted is null));

create or replace function sms_settings_account_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() is distinct from 'account' then
    return new;
  end if;
  if new.updated_by is distinct from app_account() then
    raise exception 'an owner sets up text messages as themselves'
      using errcode = 'insufficient_privilege';
  end if;
  if (tg_op = 'INSERT'
      or (new.status, new.last_verified_at, new.last_error)
         is distinct from (old.status, old.last_verified_at, old.last_error))
     and (new.status <> 'untested' or new.last_verified_at is not null
          or new.last_error is not null) then
    raise exception 'whether a test text went is the vault''s to say'
      using errcode = 'insufficient_privilege';
  end if;
  -- A new provider, address, sign-in, sender, password or token waits for a
  -- test of its own: nothing is sent through a provider nobody has tried.
  if tg_op = 'UPDATE' and new.status <> 'untested'
     and (new.provider, new.mode, new.base_url, new.username, new.password_encrypted,
          new.twilio_account_sid, new.twilio_from, new.twilio_messaging_service_sid,
          new.twilio_token_encrypted)
         is distinct from
         (old.provider, old.mode, old.base_url, old.username, old.password_encrypted,
          old.twilio_account_sid, old.twilio_from, old.twilio_messaging_service_sid,
          old.twilio_token_encrypted) then
    raise exception 'a new address, sign-in or password waits for a test of its own'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

-- Whether the household can send texts now: set up, with the chosen
-- provider's secret, and a test passed.
create or replace function sms_ready() returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select app_actor() in ('account', 'system')
            and exists (select 1 from sms_settings s
                         where s.household_id = app_household()
                           and s.status = 'ok'
                           and case s.provider
                                 when 'twilio' then s.twilio_token_encrypted is not null
                                 else s.password_encrypted is not null
                               end) $$;
revoke execute on function sms_ready() from public;
grant execute on function sms_ready() to fdv_app;
