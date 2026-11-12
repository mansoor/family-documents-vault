/**
 * What the API asks the worker to text (0.9.0, SMS2): `sms.text`, the
 * worker's JOBS.smsText. Today one thing alone: a link was opened, for its
 * maker to hear of if they asked (`share_opened_text`). The worker reads who
 * made it, whom it was for and what they want, and keeps to their quiet
 * hours and to once an hour a link; nothing of the document is on the queue.
 *
 * The worker's `TextJob` in apps/worker/src/jobs/texts.ts is the other half
 * of this shape.
 */
export const SMS_TEXT_JOB = 'sms.text';

export function shareOpenedJob(householdId: string, shareId: string): Record<string, unknown> {
  return { kind: 'share_opened', household_id: householdId, share_id: shareId };
}
