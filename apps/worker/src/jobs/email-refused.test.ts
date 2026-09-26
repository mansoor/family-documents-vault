import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { deriveKey } from '@fdv/crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendAlert } from './alerts.js';
import { createNotifier, recipientRefused } from './notify.js';
import { deliver } from './reminders.js';

/**
 * One refused address is that address's problem.
 *
 * Each person's digest is its own message now, so a mail server turning
 * down one mistyped invitation address arrives as an error on that send.
 * It used to mark the household's mail server as failed, which silently
 * stopped everybody else's email — digests and security alerts alike.
 */

/** Just enough SMTP to accept some recipients and refuse others. */
async function fakeSmtp(refuse: (address: string) => boolean) {
  const delivered: string[] = [];
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    let inData = false;
    let rcpts: string[] = [];
    const say = (line: string) => sock.write(`${line}\r\n`);
    say('220 fake ESMTP');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            delivered.push(...rcpts);
            rcpts = [];
            say('250 queued');
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'RCPT') {
          const address = /<([^>]*)>/.exec(line)?.[1] ?? '';
          if (refuse(address)) say('550 5.1.1 no such user here');
          else {
            rcpts.push(address);
            say('250 ok');
          }
        } else if (verb === 'DATA') {
          inData = true;
          say('354 go ahead');
        } else if (verb === 'QUIT') {
          say('221 bye');
          sock.end();
        } else say('250 ok');
      }
    });
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as net.AddressInfo).port;
  return { port, delivered, close: () => new Promise((res) => server.close(res)) };
}

describe('telling a refused address from a broken server', () => {
  it('recognises the error nodemailer gives for a refused recipient', () => {
    const refused = Object.assign(new Error("Can't send mail - all recipients were rejected"), {
      code: 'EENVELOPE',
      command: 'RCPT TO',
      rejected: ['bad@example.test'],
    });
    expect(recipientRefused(refused)).toBe(true);
    for (const code of ['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ETLS']) {
      expect(recipientRefused(Object.assign(new Error(code), { code })), code).toBe(false);
    }
    expect(recipientRefused(null)).toBe(false);
  });
});

describe.skipIf(!testAdminUrl())('a refused address does not stop the family’s email', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  const hh = randomUUID();
  // In joined order: the refused one sits between two good ones.
  const people = [
    ['owner', 'first@example.test'],
    ['teen', 'bad-typo@example.test'],
    ['adult', 'third@example.test'],
  ] as const;

  beforeAll(async () => {
    smtp = await fakeSmtp((a) => a.startsWith('bad'));
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    await admin.query("insert into household (id, name, timezone) values ($1, 'Refused', 'UTC')", [
      hh,
    ]);
    let owner = '';
    for (const [n, [role, email]] of people.entries()) {
      const m = await admin.query<{ id: string }>(
        'insert into member (household_id, display_name) values ($1, $2) returning id',
        [hh, role],
      );
      const a = await admin.query<{ id: string }>(
        'insert into account (email) values ($1) returning id',
        [email],
      );
      if (role === 'owner') owner = m.rows[0]?.id as string;
      await admin.query(
        `insert into account_household (account_id, household_id, member_id, role, joined_at)
         values ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval)`,
        [a.rows[0]?.id, hh, m.rows[0]?.id, role, String(n)],
      );
      await withSystem(db, hh, (trx) =>
        trx
          .insertInto('notification_preference')
          .values({ account_id: a.rows[0]?.id as string, household_id: hh, daily_email: true })
          .execute(),
      );
    }
    await withSystem(db, hh, async (trx) => {
      const d = await trx
        .insertInto('document')
        .values({ household_id: hh, title: 'Council tax', owner_member_id: owner })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('reminder')
        .values({
          household_id: hh,
          document_id: d.id,
          kind: 'manual',
          fire_at: '2026-09-22',
          status: 'due',
        })
        .execute();
      await trx
        .insertInto('smtp_settings')
        .values({
          household_id: hh,
          host: '127.0.0.1',
          port: smtp.port,
          secure: false,
          from_email: 'vault@example.test',
          status: 'ok',
        })
        .execute();
    });
  }, 60_000);
  afterAll(async () => {
    await db.destroy();
    await admin.end();
    await tdb.drop();
    await smtp.close();
  });

  it('everyone else is still sent their digest, and the server stays marked working', async () => {
    const logs: Array<[string, string, Record<string, unknown> | undefined]> = [];
    const notifier = createNotifier({
      app: db,
      vapid: null,
      smtpKey: deriveKey('email-refused-test-master-secret-32-bytes', 'smtp-credentials'),
      baseUrl: 'x',
      log: (level, msg, extra) => logs.push([level, msg, extra]),
    });
    await deliver({
      admin,
      app: db,
      notifier,
      log: () => undefined,
      now: () => new Date('2026-09-22T09:10:00Z'),
      digestHour: 9,
    });
    expect(smtp.delivered.sort()).toEqual(['first@example.test', 'third@example.test']);
    const status = await withSystem(db, hh, (trx) =>
      trx.selectFrom('smtp_settings').select('status').executeTakeFirstOrThrow(),
    );
    expect(status.status).toBe('ok');
    // Whoever reads the log can tell which person to fix.
    const refused = logs.find(([, msg]) => msg === 'email address refused');
    expect(refused?.[2]?.account_id).toBeTruthy();
  });
});

describe.skipIf(!testAdminUrl())('a reset link goes only by the operator’s mail server', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let household: Awaited<ReturnType<typeof fakeSmtp>>;
  let operator: Awaited<ReturnType<typeof fakeSmtp>>;
  const hh = randomUUID();
  let account = '';

  beforeAll(async () => {
    household = await fakeSmtp(() => false);
    operator = await fakeSmtp(() => false);
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    await admin.query("insert into household (id, name, timezone) values ($1, 'Mail', 'UTC')", [
      hh,
    ]);
    const m = await admin.query<{ id: string }>(
      "insert into member (household_id, display_name) values ($1, 'Sam') returning id",
      [hh],
    );
    const a = await admin.query<{ id: string }>(
      "insert into account (email) values ('sam-reset@example.test') returning id",
    );
    account = a.rows[0]?.id as string;
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'adult')",
      [account, hh, m.rows[0]?.id],
    );
    await withSystem(db, hh, (trx) =>
      trx
        .insertInto('smtp_settings')
        .values({
          household_id: hh,
          host: '127.0.0.1',
          port: household.port,
          secure: false,
          from_email: 'vault@example.test',
          status: 'ok',
        })
        .execute(),
    );
  }, 60_000);
  afterAll(async () => {
    await db.destroy();
    await admin.end();
    await tdb.drop();
    await household.close();
    await operator.close();
  });

  const reset = {
    household_id: hh,
    account_ids: [] as string[],
    subject: 'Setting a new password for your vault',
    body: 'b',
    url: 'https://vault.example.test/reset/abc',
    url_label: 'Set a new password',
    email_only: true,
    via: 'operator' as const,
  };
  const deps = (withOperator: boolean) => ({
    app: db,
    vapid: null,
    smtpKey: deriveKey('email-refused-test-master-secret-32-bytes', 'smtp-credentials'),
    baseUrl: 'x',
    log: () => undefined,
    operatorMail: withOperator
      ? { url: `smtp://127.0.0.1:${operator.port}`, from: 'Vault <vault@operator.test>' }
      : null,
  });

  it('through the operator’s server, and never through the household’s', async () => {
    const channels = await sendAlert(deps(true), { ...reset, account_ids: [account] });
    expect(channels).toEqual(['email']);
    expect(operator.delivered).toEqual(['sam-reset@example.test']);
    expect(household.delivered).toEqual([]);
  });

  it('with no operator server it is not sent at all, rather than the household’s', async () => {
    const channels = await sendAlert(deps(false), { ...reset, account_ids: [account] });
    expect(channels).toEqual([]);
    expect(household.delivered).toEqual([]);
  });
});
