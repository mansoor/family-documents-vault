// The Smart exit's third held-out set (0.9.0, the R1 review): written after
// the shape's word list was frozen (packages/shared/src/shape-words.ts,
// SHA-256 4c1490d3…), with new layouts and new issuers — none of them in
// smart-corpus-papers.mjs or smart-corpus-papers-2.mjs — and its SHA-256
// recorded before the vault read any of it (docs/smart-exit.md). The same
// household. Two of the family bank with the same bank, and the youngest has
// a junior account there, each statement addressed only by a title and the
// surname, as banks do: the case a learned person must not get wrong.
// Everything invented, as in the other sets. `smartCorpus({ corpus: 'third' })`
// makes them.
import { Page } from './smart-corpus-render.mjs';
import { addDays, addMonths, addYears, fmt, money } from './smart-corpus-papers.mjs';

/** The third set's templates, by name. */
export const PAPERS_3 = {};

function paper(name, kind, scanned, make) {
  PAPERS_3[name] = { name, kind, set: 'held-out', scanned, make };
}

const full = (p) => `${p.first} ${p.surname}`;
const titled = (p) => `${p.title} ${p.surname}`.toUpperCase();
const address = (h) => [h.street, h.town, h.postcode];

// ---- the bank three of them share

paper('thornbury-statement', 'bank_statement', 0.3, (r, h, p, o) => {
  const issued = o.issued;
  const from = addDays(addMonths(issued, -1), 1);
  const pg = new Page({ size: 9.5 });
  pg.row(
    [
      [56, 'THORNBURY BANK'],
      [360, o.junior ? 'Junior Saver statement' : 'Everyday Account statement'],
    ],
    { size: 13, bold: true },
  );
  pg.gap();
  const rows = [
    [titled(p), 'Statement date', fmt(issued, 'short')],
    [address(h)[0], 'Account no.', o.account],
    [address(h)[1], 'Sort code', '40-17-62'],
    [address(h)[2], '', ''],
  ];
  for (const [left, label, value] of rows) {
    pg.row([
      [56, left],
      [330, label],
      [430, value],
    ]);
  }
  pg.gap();
  pg.line(`Statement covers ${fmt(from, 'short')} to ${fmt(issued, 'short')}`);
  pg.row(
    [
      [56, 'Date'],
      [120, 'Details'],
      [360, 'Out'],
      [420, 'In'],
      [480, 'Balance'],
    ],
    { bold: true },
  );
  let balance = r.int(200, 4000);
  for (let i = 0; i < r.int(3, 7); i += 1) {
    const out = r.int(5, 300);
    balance -= out;
    pg.row([
      [56, fmt(addDays(from, i * 4), 'short').slice(0, 6)],
      [120, r.pick(['CARD PURCHASE', 'DIRECT DEBIT', 'TRANSFER OUT', 'CASH MACHINE'])],
      [360, `${out}.00`],
      [480, `${balance}.00`],
    ]);
  }
  pg.row([
    [56, 'Balance carried forward'],
    [480, `£${balance}.00`],
  ]);
  pg.foot();
  return {
    truth: { issued, expires: null, number: o.account, issuer: 'Thornbury Bank' },
    pages: [pg],
  };
});

// ---- cards and bills

paper('halcyon-card', 'credit_card_statement', 0.25, (r, h, p, o) => {
  const issued = o.issued;
  const due = addDays(issued, 21);
  const pg = new Page({ size: 10 });
  pg.line('Halcyon Card', { size: 15, bold: true });
  pg.line('Your monthly statement');
  pg.gap();
  pg.line([full(p), ...address(h)]);
  pg.gap();
  pg.row([
    [56, 'Statement closing date'],
    [260, fmt(issued, 'long')],
  ]);
  pg.row([
    [56, 'Credit limit'],
    [260, `£${r.pick(['2,500', '4,000', '6,000'])}`],
  ]);
  pg.row([
    [56, 'New balance'],
    [260, `£${money(r, 40, 1800)}`],
  ]);
  pg.row([
    [56, 'Minimum to pay'],
    [260, `£${money(r, 5, 60)}`],
  ]);
  pg.row([
    [56, 'Pay by'],
    [260, fmt(due, 'long')],
  ]);
  pg.foot();
  return {
    truth: { issued, expires: due, number: null, issuer: 'Halcyon Card' },
    pages: [pg],
  };
});

paper('voltwise-bill', 'utility_bill', 0.35, (r, h, p, o) => {
  const issued = o.issued;
  const due = addDays(issued, 14);
  const account = `VW-${r.digits(7)}`;
  const pg = new Page({ size: 10 });
  pg.row(
    [
      [56, 'Voltwise Energy'],
      [380, 'Electricity bill'],
    ],
    { size: 14, bold: true },
  );
  pg.gap();
  pg.line([full(p), ...address(h)]);
  pg.gap();
  pg.row([
    [56, 'Customer number'],
    [230, o.account ?? account],
  ]);
  pg.row([
    [56, 'Bill issued'],
    [230, fmt(issued, 'dashed')],
  ]);
  pg.row([
    [56, 'Units used'],
    [230, `${r.int(400, 1200)} kWh`],
  ]);
  pg.row([
    [56, 'Total charges'],
    [230, `£${money(r, 120, 420)}`],
  ]);
  pg.line(`Amount due on ${fmt(due, 'dashed')}`);
  pg.foot();
  return {
    truth: { issued, expires: due, number: o.account ?? account, issuer: 'Voltwise Energy' },
    pages: [pg],
  };
});

paper('skyline-invoice', 'utility_bill', 0.2, (r, h, p, o) => {
  const issued = o.issued;
  const collected = addDays(issued, 10);
  const pg = new Page({ size: 10 });
  pg.line('Skyline Fibre', { size: 15, bold: true });
  pg.line('Broadband invoice');
  pg.gap();
  pg.line([full(p), ...address(h)]);
  pg.gap();
  pg.row([
    [56, 'Invoice date'],
    [200, fmt(issued, 'slash')],
    [330, 'Customer ID'],
    [430, o.account],
  ]);
  pg.row([
    [56, 'Monthly package'],
    [200, `£${money(r, 25, 60)}`],
  ]);
  pg.line(`We will take this from your bank on ${fmt(collected, 'slash')}.`);
  pg.row([
    [56, 'Collected on'],
    [200, fmt(collected, 'slash')],
  ]);
  pg.foot();
  return {
    truth: { issued, expires: collected, number: o.account, issuer: 'Skyline Fibre' },
    pages: [pg],
  };
});

paper('riverbend-water', 'utility_bill', 0.45, (r, h, p, o) => {
  const issued = o.issued;
  const due = addDays(issued, 28);
  const pg = new Page({ size: 10.5 });
  pg.line('RIVERBEND WATER', { size: 15, bold: true });
  pg.line('Your water and sewerage charges');
  pg.gap();
  pg.line([titled(p), ...address(h)]);
  pg.gap();
  pg.row([
    [56, 'Reference'],
    [220, o.account],
  ]);
  pg.row([
    [56, 'Date of bill'],
    [220, fmt(issued, 'long')],
  ]);
  pg.row([
    [56, 'Charges for six months'],
    [220, `£${money(r, 150, 320)}`],
  ]);
  pg.row([
    [56, 'Please pay by'],
    [220, fmt(due, 'long')],
  ]);
  pg.foot();
  return {
    truth: { issued, expires: due, number: o.account, issuer: 'Riverbend Water' },
    pages: [pg],
  };
});

paper('brackenford-council-tax', 'utility_bill', 0.4, (r, h, p, o) => {
  const issued = o.issued;
  const first = addDays(issued, 30);
  const pg = new Page({ size: 10 });
  pg.line('Brackenford District Council', { size: 14, bold: true });
  pg.line('Council Tax demand notice');
  pg.gap();
  pg.line([full(p), ...address(h)]);
  pg.gap();
  pg.row([
    [56, 'Account reference'],
    [240, o.account],
  ]);
  pg.row([
    [56, 'Date of demand'],
    [240, fmt(issued, 'long')],
  ]);
  pg.row([
    [56, 'Band'],
    [240, 'D'],
  ]);
  pg.row([
    [56, 'First payment date'],
    [240, fmt(first, 'long')],
  ]);
  pg.foot();
  return {
    truth: { issued, expires: first, number: o.account, issuer: 'Brackenford District Council' },
    pages: [pg],
  };
});

// ---- insurance

paper('copperfield-motor', 'insurance_policy', 0.3, (r, h, p, o) => {
  const issued = o.issued;
  const ends = addDays(addYears(issued, 1), -1);
  const pg = new Page({ size: 10 });
  pg.line('Copperfield Motor', { size: 15, bold: true });
  pg.line('Your car insurance');
  pg.gap();
  pg.row([
    [56, 'Policy reference'],
    [230, o.policy],
  ]);
  pg.row([
    [56, 'Policyholder'],
    [230, full(p)],
  ]);
  pg.row([
    [56, 'Car'],
    [230, o.plate],
  ]);
  pg.row([
    [56, 'Cover starts'],
    [230, fmt(issued, 'long')],
  ]);
  pg.row([
    [56, 'Cover ends'],
    [230, fmt(ends, 'long')],
  ]);
  pg.row([
    [56, 'Annual premium'],
    [230, `£${money(r, 300, 800)}`],
  ]);
  pg.foot();
  return {
    truth: { issued, expires: ends, number: o.policy, issuer: 'Copperfield Motor' },
    pages: [pg],
  };
});

paper('furrow-pet', 'insurance_policy', 0.3, (r, h, p, o) => {
  const issued = o.issued;
  const renew = addYears(issued, 1);
  const pg = new Page({ size: 10.5 });
  pg.line('Furrow Pet Cover', { size: 15, bold: true });
  pg.line('Certificate of insurance');
  pg.gap();
  pg.line(`Insured pet: ${o.pet}`);
  pg.line(`Policy number ${o.policy}`);
  pg.line(`Taken out by ${full(p)}`);
  pg.line(`Start of cover ${fmt(issued, 'longth')}`);
  pg.line(`Renew by ${fmt(renew, 'longth')}`);
  pg.foot();
  return {
    truth: { issued, expires: renew, number: o.policy, issuer: 'Furrow Pet Cover' },
    pages: [pg],
  };
});

// ---- money kept

paper('oakridge-investments', 'bank_statement', 0.2, (r, h, p, o) => {
  const issued = o.issued;
  const pg = new Page({ size: 10 });
  pg.line('Oakridge Investments', { size: 15, bold: true });
  pg.line('Annual valuation');
  pg.gap();
  pg.line([full(p), ...address(h)]);
  pg.gap();
  pg.row([
    [56, 'Plan number'],
    [220, o.plan],
  ]);
  pg.row([
    [56, 'Valuation date'],
    [220, fmt(issued, 'long')],
  ]);
  pg.row([
    [56, 'Value of your plan'],
    [220, `£${money(r, 4000, 40000)}`],
  ]);
  pg.foot();
  return {
    truth: { issued, expires: null, number: o.plan, issuer: 'Oakridge Investments' },
    pages: [pg],
  };
});

paper('kingsmere-mortgage', 'loan', 0.3, (r, h, p, o) => {
  const issued = o.issued;
  const pg = new Page({ size: 10 });
  pg.line('Kingsmere Building Society', { size: 14, bold: true });
  pg.line('Your mortgage this year');
  pg.gap();
  pg.line([full(p), ...address(h)]);
  pg.gap();
  pg.row([
    [56, 'Mortgage account'],
    [240, o.account],
  ]);
  pg.row([
    [56, 'Year ending'],
    [240, fmt(issued, 'long')],
  ]);
  pg.row([
    [56, 'Balance owed'],
    [240, `£${money(r, 90000, 160000)}`],
  ]);
  pg.row([
    [56, 'Term ends'],
    [240, fmt(o.ends, 'long')],
  ]);
  pg.foot();
  return {
    truth: { issued, expires: o.ends, number: o.account, issuer: 'Kingsmere Building Society' },
    pages: [pg],
  };
});

// ---- health

paper('millbrook-letter', 'medical_record', 0.5, (r, h, p, o) => {
  const pg = new Page({ size: 10.5 });
  pg.line('Millbrook Surgery', { size: 15, bold: true });
  pg.line('Patient letter', { size: 9 });
  pg.gap();
  pg.line([full(p), ...address(h)]);
  pg.gap();
  pg.line(fmt(o.issued, 'long'));
  pg.gap();
  pg.line(`Dear ${p.title} ${p.surname},`);
  pg.line(
    r.pick([
      'Your recent test results are normal. No further action is needed.',
      'Please book a review appointment with the practice nurse.',
      'Your repeat medication has been reviewed by the doctor.',
    ]),
  );
  pg.line('Yours sincerely, The Millbrook Surgery team');
  pg.foot();
  return {
    truth: { issued: o.issued, expires: null, number: null, issuer: 'Millbrook Surgery' },
    pages: [pg],
  };
});

paper('bright-smile-recall', 'medical_record', 0.4, (r, h, p, o) => {
  const due = addMonths(o.issued, 6);
  const pg = new Page({ size: 11 });
  pg.line('Bright Smile Dental', { size: 15, bold: true });
  pg.line(`For ${full(p)}`);
  pg.line(`Seen on ${fmt(o.issued, 'short')}`);
  pg.line(`Your next check-up is due in ${fmt(due, 'month')}.`);
  pg.foot();
  return {
    truth: { issued: o.issued, expires: null, number: null, issuer: 'Bright Smile Dental' },
    pages: [pg],
  };
});

// ---- school and things bought

paper('st-aidans-report', 'school_report', 0.4, (r, h, p, o) => {
  const pg = new Page({ size: 10 });
  pg.line("St Aidan's School", { size: 15, bold: true });
  pg.line(`End of term report, ${o.term} ${o.year}`);
  pg.gap();
  pg.line(`Pupil: ${full(p)}`);
  pg.row(
    [
      [56, 'Subject'],
      [230, 'Working at'],
    ],
    { bold: true },
  );
  for (const s of ['English', 'Mathematics', 'Science', 'History']) {
    pg.row([
      [56, s],
      [230, r.pick(['Expected', 'Above expected', 'Working towards'])],
    ]);
  }
  pg.foot();
  return {
    truth: { issued: null, expires: null, number: null, issuer: "St Aidan's School" },
    pages: [pg],
  };
});

paper('gadgetry-order', 'warranty', 0.3, (r, h, p, o) => {
  const issued = o.issued;
  const ends = addYears(issued, 2);
  const pg = new Page({ size: 10 });
  pg.line('Gadgetry Direct', { size: 15, bold: true });
  pg.line(`Thank you for your order, ${p.first}`);
  pg.gap();
  pg.row([
    [56, 'Order placed'],
    [220, fmt(issued, 'short')],
  ]);
  pg.row([
    [56, 'Item'],
    [220, r.pick(['Cordless vacuum', 'Coffee machine', 'Tablet, 10 inch'])],
  ]);
  pg.row([
    [56, 'Guarantee until'],
    [220, fmt(ends, 'short')],
  ]);
  pg.foot();
  return {
    truth: { issued, expires: ends, number: null, issuer: 'Gadgetry Direct' },
    pages: [pg],
  };
});

// ---- papers of no kind

paper('gym-leaflet', null, 0.3, (r) => {
  const pg = new Page({ size: 12 });
  pg.line('FLEXFIT GYM', { size: 18, bold: true });
  pg.line(`Join this month for £${r.int(10, 25)} — no joining fee`);
  pg.foot();
  return { truth: { issued: null, expires: null, number: null, issuer: null }, pages: [pg] };
});

paper('church-news', null, 0.3, (r) => {
  const pg = new Page({ size: 11 });
  pg.line('Parish News', { size: 15, bold: true });
  pg.line(`The summer fair raised £${r.int(300, 900)} for the roof fund. Thank you all.`);
  pg.foot();
  return { truth: { issued: null, expires: null, number: null, issuer: null }, pages: [pg] };
});

// ------------------------------------------------------------------ the plan

const monthsFrom = (from, n, day) =>
  Array.from({ length: n }, (_, i) => addMonths(`${from.slice(0, 7)}-${day}`, i));
const monthEnds = (from, n) =>
  Array.from({ length: n }, (_, i) => addDays(addMonths(`${from.slice(0, 7)}-01`, i + 1), -1));

/** The third set's papers, with the blanks and copies smartCorpus adds. */
export function plan3() {
  const out = [];
  const add = (paper, who, opts = {}) => out.push({ paper, who, opts });
  // The same bank: Olivia's and Ahmed's own accounts, and Maryam's junior one.
  for (const issued of monthEnds('2025-10-31', 10)) {
    add('thornbury-statement', 'olivia', { issued, account: '70412288' });
  }
  for (const issued of monthEnds('2025-11-30', 8)) {
    add('thornbury-statement', 'ahmed', { issued, account: '70398154' });
  }
  for (const issued of ['2025-12-31', '2026-03-31', '2026-06-30', '2026-09-30']) {
    add('thornbury-statement', 'maryam', { issued, account: '70455903', junior: true });
  }
  for (const issued of monthsFrom('2026-01', 8, '11')) add('halcyon-card', 'ahmed', { issued });
  for (const issued of ['2025-07-02', '2025-10-02', '2026-01-03', '2026-04-02', '2026-07-02']) {
    add('voltwise-bill', 'olivia', { issued, account: 'VW-5521907' });
  }
  for (const issued of monthsFrom('2026-01', 8, '05')) {
    add('skyline-invoice', 'ahmed', { issued, account: 'SKY88412' });
  }
  for (const issued of ['2025-04-01', '2025-10-01', '2026-04-01', '2026-10-01']) {
    add('riverbend-water', 'ahmed', { issued, account: 'RB 4471 0093' });
  }
  add('brackenford-council-tax', 'olivia', { issued: '2025-03-10', account: '58102231' });
  add('brackenford-council-tax', 'olivia', { issued: '2026-03-09', account: '58102231' });
  for (const issued of ['2024-05-20', '2025-05-20', '2026-05-20']) {
    add('copperfield-motor', 'olivia', { issued, policy: 'CPM-772104', plate: 'AV19 RKH' });
  }
  add('furrow-pet', 'olivia', { issued: '2025-02-14', policy: 'FPC90313', pet: 'Biscuit' });
  add('furrow-pet', 'olivia', { issued: '2026-02-14', policy: 'FPC90313', pet: 'Biscuit' });
  add('oakridge-investments', 'olivia', { issued: '2025-04-05', plan: 'OKR-118342' });
  add('oakridge-investments', 'olivia', { issued: '2026-04-05', plan: 'OKR-118342' });
  add('kingsmere-mortgage', 'ahmed', {
    issued: '2024-12-31',
    account: 'KM 2203 7781',
    ends: '2047-06-30',
  });
  add('kingsmere-mortgage', 'ahmed', {
    issued: '2025-12-31',
    account: 'KM 2203 7781',
    ends: '2047-06-30',
  });
  for (const [who, issued] of [
    ['farida', '2025-11-04'],
    ['farida', '2026-02-17'],
    ['ahmed', '2026-03-23'],
    ['olivia', '2026-05-12'],
    ['farida', '2026-06-30'],
    ['tariq', '2026-08-19'],
  ]) {
    add('millbrook-letter', who, { issued });
  }
  for (const [who, issued] of [
    ['maryam', '2025-09-15'],
    ['maryam', '2026-03-16'],
    ['tariq', '2026-03-16'],
  ]) {
    add('bright-smile-recall', who, { issued });
  }
  for (const [who, term, year] of [
    ['tariq', 'Spring', 2026],
    ['tariq', 'Summer', 2026],
    ['maryam', 'Summer', 2026],
  ]) {
    add('st-aidans-report', who, { term, year });
  }
  for (const [who, issued] of [
    ['ahmed', '2025-08-08'],
    ['olivia', '2026-01-19'],
    ['olivia', '2026-07-27'],
  ]) {
    add('gadgetry-order', who, { issued });
  }
  for (let i = 0; i < 3; i += 1) add('gym-leaflet', null, { n: i });
  for (let i = 0; i < 2; i += 1) add('church-news', null, { n: i });
  return out;
}

/** Where the family keeps the third set. */
export function home3(item, P) {
  const who = item.who ? P[item.who].name : null;
  const [y, m] = (item.truth.issued ?? item.truth.expires ?? '2026-10-01').split('-');
  const ym = `${y}-${m}`;
  switch (item.paper) {
    case 'thornbury-statement':
      return [`Thornbury/${who}`, `statement ${ym}`];
    case 'halcyon-card':
      return ['Cards', `Halcyon ${ym}`];
    case 'voltwise-bill':
    case 'skyline-invoice':
    case 'riverbend-water':
    case 'brackenford-council-tax':
      return [`Household bills/${y}`, `${item.paper} ${ym}`];
    case 'copperfield-motor':
    case 'furrow-pet':
      return ['Policies', `${item.paper} ${y}`];
    case 'oakridge-investments':
    case 'kingsmere-mortgage':
      return ['Savings and mortgage', `${item.paper} ${y}`];
    case 'millbrook-letter':
    case 'bright-smile-recall':
      return [`Doctors/${who}`, `${item.paper} ${ym}`];
    case 'st-aidans-report':
      return [`School/${who}`, `${item.opts.term} ${item.opts.year}`];
    case 'gadgetry-order':
      return ['Receipts', `gadgetry ${ym}`];
    default:
      return ['Post', `${item.paper} ${item.opts.n ?? ''}`.trim()];
  }
}
