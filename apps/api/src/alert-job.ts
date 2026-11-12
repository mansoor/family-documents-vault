import { alertLinkBinding, sealBytes } from '@fdv/crypto';
import type { AlertTextKind } from '@fdv/shared';

/**
 * What the API asks the worker to send as an alert (`alert.send`).
 *
 * The worker's `Alert` in apps/worker/src/jobs/alerts.ts is the other half
 * of this shape. There is one mapping, used by the server and by the test
 * harness alike, because in 0.4.1 they were two copies that disagreed: the
 * harness forwarded the link and the "email only" flag, production dropped
 * both, so every test passed while real password-reset emails went out
 * with no link in them and "your password was changed" was pushed to lock
 * screens.
 */
export interface AlertRequest {
  householdId: string;
  accountIds: string[];
  subject: string;
  body: string;
  /** Where the button goes, when somewhere better than the front page. */
  url?: string;
  urlLabel?: string;
  /** Never to a lock screen: links that open an account, news about passwords. */
  emailOnly?: boolean;
  /**
   * Only by the operator's mail server (FDV_SMTP_URL), never the household's:
   * an owner can point the household's anywhere and read what goes through.
   */
  operatorMail?: boolean;
  /**
   * What a phone is told (4.13), as a word and nothing more. Without one,
   * the alert is not pushed to phones at all.
   */
  pushType?: 'new_device' | 'owner_change';
  /**
   * About the recipients' own sign-in (5.28): their lock, and its end. It
   * reaches them even while their sign-in is locked or paused, as nothing
   * else does.
   */
  ownSignIn?: boolean;
  /**
   * What it says by text (0.9.0, SMS2), to whoever of them asked for alerts
   * by text: a headline chosen as a word (ALERT_TEXTS), never its subject,
   * which may name people. One about their own sign-in goes in their quiet
   * hours too. Without one, an alert's text says only that there is news in
   * their email, after their quiet hours. One by the operator's mail server
   * alone is never texted.
   */
  text?: AlertTextKind;
}

/**
 * The job. Its link, when it has one, is sealed (F529-11) under `key`
 * (ALERT_LINK_KEY_PURPOSE): the only links an alert carries are password
 * resets', and the queue's table, which the application role reads and
 * every backup keeps, must hold none that works. The worker opens it.
 */
export function alertJob(key: Buffer, a: AlertRequest): Record<string, unknown> {
  return {
    household_id: a.householdId,
    account_ids: a.accountIds,
    subject: a.subject,
    body: a.body,
    ...(a.url
      ? {
          sealed_url: sealBytes(
            key,
            Buffer.from(a.url, 'utf8'),
            alertLinkBinding(a.householdId),
          ).toString('base64'),
          url_label: a.urlLabel,
        }
      : {}),
    ...(a.emailOnly ? { email_only: true } : {}),
    ...(a.operatorMail ? { via: 'operator' } : {}),
    ...(a.pushType ? { push_type: a.pushType } : {}),
    ...(a.ownSignIn ? { own_sign_in: true } : {}),
    ...(a.text ? { text_kind: a.text } : {}),
  };
}
