-- Notifications by text (0.9.0, SMS2): the day's reminders, the alerts and
-- a link opened, by text, as each person asks.
--
-- Each is off until the person turns it on, and a text only ever goes to
-- their own confirmed number (member_phone, 0084), while the household's
-- SMS Gate is set up and a test passed (sms_ready()). A text never names a
-- document: the day's reminders are a count, an alert its headline, a link
-- opened whom it was shared for.
--
--   notification_preference  gains, per person, `daily_text`, `alerts_text`
--                            and `share_opened_text`, and their quiet hours
--                            on the family's clock, 21:00 to 08:00 until
--                            they choose (they may run past midnight; the
--                            same time for both is none). A text that falls
--                            in them waits until they end, unless it is
--                            about their own sign-in.
--   sms_message              a text's kind may also be `reminders`, `alert`
--                            or `share_opened`: counted against the same
--                            monthly cap, written by the vault alone.
--   share_link               `opened_texted_at`: when its maker was last
--                            told it was opened (by text, or by email when
--                            the text could not go), so they are told at most
--                            once an hour. The vault's to write; a link
--                            itself may still change only its counts (0030).

alter table notification_preference
  add column daily_text        boolean not null default false,
  add column alerts_text       boolean not null default false,
  add column share_opened_text boolean not null default false,
  add column quiet_from        time not null default '21:00',
  add column quiet_to          time not null default '08:00';

alter table sms_message drop constraint sms_message_kind;
alter table sms_message add constraint sms_message_kind
  check (kind in ('test', 'phone_code', 'phone_changed', 'reminders', 'alert', 'share_opened'));

alter table share_link add column opened_texted_at timestamptz;
