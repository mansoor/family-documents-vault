import { sql } from 'kysely';
import type { Db } from './client.js';
import { householdZone } from './zone.js';

/**
 * A cloud AI reader's month (0.9.0, AIR3, decision 10): the papers sent to
 * a cloud reader this calendar month on the household's own clock — its
 * time zone, else the server's (FDV_TIMEZONE) — but those it was never sent
 * (resting, the address refused); and whether the owners were told it is
 * at 80% yet. What the cap is held to, in the worker, and what Settings
 * shows. Asked inside the household's scope, as the vault or an owner.
 */
export interface AiReaderMonthCount {
  /** The first day of the month, YYYY-MM-DD, on the household's calendar. */
  month: string;
  sent: number;
  warned: boolean;
}

export async function aiReaderMonthCount(trx: Db): Promise<AiReaderMonthCount> {
  const hh = await trx.selectFrom('household').select('timezone').executeTakeFirst();
  const zone = householdZone(hh?.timezone);
  const r = await sql<{ month: string; sent: number; warned: boolean }>`
    with m as (select date_trunc('month', now() at time zone ${zone}) as local_start)
    select to_char(m.local_start, 'YYYY-MM-DD') as month,
           (select count(*)::int from ai_reader_send s
             where s.runs_at = 'cloud'
               and s.outcome is distinct from 'not_sent'
               and s.sent_at >= (m.local_start at time zone ${zone})) as sent,
           exists (select 1 from ai_reader_cap_warning w
                    where w.month = m.local_start::date) as warned
      from m`.execute(trx);
  const row = r.rows[0];
  return { month: row?.month ?? '', sent: row?.sent ?? 0, warned: row?.warned === true };
}
