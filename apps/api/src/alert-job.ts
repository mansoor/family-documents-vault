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
}

export function alertJob(a: AlertRequest): Record<string, unknown> {
  return {
    household_id: a.householdId,
    account_ids: a.accountIds,
    subject: a.subject,
    body: a.body,
    ...(a.url ? { url: a.url, url_label: a.urlLabel } : {}),
    ...(a.emailOnly ? { email_only: true } : {}),
    ...(a.operatorMail ? { via: 'operator' } : {}),
  };
}
