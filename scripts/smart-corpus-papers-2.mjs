// The Smart exit's second held-out set (0.8.0, S5, the owner's decision of
// 16 Oct 2026): the first corpus was seen while the rules were adjusted, so
// these papers are new — new layouts and new issuers, none of them used in
// smart-corpus-papers.mjs — written and frozen before the vault read any of
// them. The same household; everything invented, as in the first set
// (Ofcom's drama numbers, QQ National Insurance numbers, NHS numbers from
// 999). `smartCorpus({ corpus: 'second' })` makes them.
import { Page } from './smart-corpus-render.mjs';
import {
  addDays,
  addMonths,
  addYears,
  fmt,
  licenceNumber,
  money,
  mrz,
} from './smart-corpus-papers.mjs';

/** The second set's templates, by name. */
export const PAPERS_2 = {};

function paper(name, kind, scanned, make) {
  PAPERS_2[name] = { name, kind, set: 'held-out', scanned, make };
}

const full = (p) => `${p.first} ${p.surname}`;
const formal = (p) => `${p.title} ${p.first} ${p.surname}`;
const initialled = (p) => `${p.title} ${p.first.charAt(0)} ${p.surname}`;
const upper = (s) => s.toUpperCase();
const address = (h) => [h.street, `${h.town} ${h.postcode}`];

// ---- identity

paper('passport-renewal-copy', 'passport', 0.9, (r, h, p, o) => {
  const issued = o.issued;
  const expires = addYears(issued, p.child ? 5 : 10);
  const number = `${r.int(1, 9)}${r.digits(8)}`;
  const pg = new Page({ size: 10, top: 120, left: 70 });
  pg.line('Copy of passport details page', { size: 8 });
  pg.row(
    [
      [70, 'UNITED KINGDOM'],
      [330, 'PASSPORT'],
    ],
    { bold: true, size: 12 },
  );
  pg.gap();
  for (const [label, value] of [
    ['Passport No', number],
    ['Surname', upper(p.surname)],
    ['Given names', upper([p.first, p.middle].filter(Boolean).join(' '))],
    ['Nationality', 'BRITISH CITIZEN'],
    ['Date of birth', fmt(p.born, 'dots')],
    ['Date of issue', fmt(issued, 'dots')],
    ['Date of expiry', fmt(expires, 'dots')],
    ['Issuing authority', 'HMPO'],
  ]) {
    pg.row([
      [70, label],
      [210, value],
    ]);
  }
  pg.gap(2);
  pg.line(mrz(p, number, 'GBR', expires), { mono: true, size: 10 });
  pg.foot();
  return { truth: { issued, expires, number, issuer: 'United Kingdom' }, pages: [pg] };
});

paper('dvla-new-licence-letter', 'drivers_licence', 0.3, (r, h, p, o) => {
  const issued = o.issued;
  const expires = addDays(addYears(issued, 10), -1);
  const number = licenceNumber(r, p);
  const pg = new Page({ size: 10.5 });
  pg.line('DVLA', { size: 16, bold: true });
  pg.line('Swansea SA99 1BN', { size: 8.5 });
  pg.gap();
  pg.line([formal(p), ...address(h)]);
  pg.gap();
  pg.line(`Date: ${fmt(issued, 'long')}`);
  pg.gap();
  pg.line('Your new photocard driving licence', { bold: true });
  pg.line(`Dear ${p.title} ${p.surname},`);
  pg.line('Here is your new photocard driving licence. Please check the details on it.');
  pg.line(`Driving licence number: ${number}`);
  pg.line(`Your photocard is valid until ${fmt(expires, 'long')}.`);
  pg.line('You must renew it before then to keep driving.');
  pg.foot();
  return { truth: { issued, expires, number, issuer: 'DVLA' }, pages: [pg] };
});

// ---- insurance

paper('motor-schedule', 'insurance_policy', 0.35, (r, h, p, o) => {
  const issued = o.issued;
  const expires = addDays(addYears(issued, 1), -1);
  const number = `FM/${r.digits(4)}/${r.digits(5)}`;
  const pg = new Page({ size: 9.5 });
  pg.row(
    [
      [56, 'Fenmoor Insurance'],
      [380, 'Motor Policy Schedule'],
    ],
    { size: 14, bold: true },
  );
  pg.gap();
  pg.row([
    [56, 'Policy holder'],
    [190, formal(p)],
    [350, 'Policy no.'],
    [430, number],
  ]);
  pg.row([
    [56, 'Vehicle'],
    [190, `Calder Estate 1.5 (${o.plate})`],
  ]);
  pg.line(
    `Period of insurance: from 00:01 hours on ${fmt(issued, 'long')} to midnight on ${fmt(expires, 'long')}`,
  );
  pg.row([
    [56, 'Cover'],
    [190, 'Comprehensive'],
  ]);
  pg.row([
    [56, 'Compulsory excess'],
    [190, '£250'],
  ]);
  pg.row([
    [56, 'Total premium'],
    [190, `£${money(r, 380, 720)}`],
  ]);
  pg.foot();
  return { truth: { issued, expires, number, issuer: 'Fenmoor Insurance' }, pages: [pg] };
});

paper('home-renewal-notice', 'insurance_policy', 0.2, (r, h, p, o) => {
  const ends = o.ends;
  const issued = addDays(addYears(ends, -1), 1);
  const number = `LKH${r.digits(7)}`;
  const pg = new Page({ size: 10.5 });
  pg.line('Larkspur Home Insurance', { size: 15, bold: true });
  pg.line([formal(p), ...address(h)]);
  pg.gap();
  pg.line(`Policy number ${number}`);
  pg.line('Your home insurance is due for renewal', { bold: true });
  pg.line(
    `Your current policy, which started on ${fmt(issued, 'long')}, ends on ${fmt(ends, 'long')}.`,
  );
  pg.line(`Unless you tell us otherwise, it will renew automatically for £${money(r, 190, 420)}.`);
  pg.line('Buildings and contents cover, accidental damage included.');
  pg.foot();
  return {
    truth: { issued, expires: ends, number, issuer: 'Larkspur Home Insurance' },
    pages: [pg],
  };
});

paper('breakdown-card', 'insurance_policy', 0.7, (r, h, p, o) => {
  const issued = o.issued;
  const expires = addDays(addYears(issued, 1), -1);
  const number = `RS ${r.digits(4)} ${r.digits(4)}`;
  const pg = new Page({ size: 11, top: 120, left: 100 });
  pg.line('ROADSTAR RESCUE', { size: 16, bold: true });
  pg.line('Breakdown cover membership');
  pg.gap();
  pg.line(`Member: ${upper(full(p))}`);
  pg.line(`Membership number: ${number}`);
  pg.line(`Cover from: ${fmt(issued, 'slash')}`);
  pg.line(`Cover expires: ${fmt(expires, 'slash')}`);
  pg.line('Roadside, Recovery and At Home');
  pg.line('Breakdown? Call 0808 157 0000 any time.', { size: 9 });
  pg.foot();
  return { truth: { issued, expires, number, issuer: 'Roadstar Rescue' }, pages: [pg] };
});

// ---- money

paper('society-account-summary', 'bank_statement', 0.2, (r, h, p, o) => {
  const end = o.issued;
  const start = addDays(addMonths(end, -3), 1);
  const number = `${r.digits(8)}`;
  const pg = new Page({ size: 9.5 });
  pg.line('Meridian Building Society', { size: 15, bold: true });
  pg.line('Account summary', { size: 12 });
  pg.gap();
  const holder = o.joint ? `${formal(p)} & ${formal(o.joint)}` : formal(p);
  pg.line([holder, ...address(h)]);
  pg.gap();
  pg.row(
    [
      [56, 'Sort code'],
      [160, 'Account number'],
      [290, 'Summary date'],
    ],
    { bold: true },
  );
  pg.row([
    [56, '40-12-77'],
    [160, number],
    [290, fmt(end, 'short')],
  ]);
  pg.gap();
  const bf = r.int(600, 4000);
  pg.line(`Balance brought forward on ${fmt(start, 'short')}: £${bf}.00`);
  for (let i = 0; i < 6; i += 1) {
    pg.row([
      [56, fmt(addDays(start, r.int(1, 85)), 'short')],
      [
        150,
        r.pick(['Direct debit HEARTHGAS', 'Card TESSELL', 'Salary BRIGHTSTONE', 'Standing order']),
      ],
      [400, money(r, 5, 900)],
    ]);
  }
  pg.line(`Balance carried forward on ${fmt(end, 'short')}: £${money(r, 300, 5000)}`);
  pg.foot();
  return {
    truth: { issued: end, expires: null, number, issuer: 'Meridian Building Society' },
    pages: [pg],
  };
});

paper('cash-isa-statement', 'bank_statement', 0.25, (r, h, p, o) => {
  const end = o.issued;
  const number = `WB-${r.digits(7)}`;
  const pg = new Page({ size: 10.5 });
  pg.line('Westbridge Savings', { size: 15, bold: true });
  pg.line(`${o.junior ? 'Junior ISA' : 'Cash ISA'} statement`, { size: 12 });
  pg.gap();
  pg.line(`Prepared for ${p.child ? full(p) : formal(p)}`);
  pg.line(`Account reference ${number}`);
  pg.line(`Statement to ${fmt(end, 'long')}`);
  pg.gap();
  pg.line(`Opening balance £${money(r, 500, 9000)}`);
  pg.line(`Interest added £${money(r, 10, 300)}`);
  pg.line(`Closing balance £${money(r, 600, 9500)}`);
  pg.line('Rate 3.45% AER variable');
  pg.foot();
  return {
    truth: { issued: end, expires: null, number, issuer: 'Westbridge Savings' },
    pages: [pg],
  };
});

paper('card-monthly-statement', 'credit_card_statement', 0.2, (r, h, p, o) => {
  const issued = o.issued;
  const due = addDays(issued, 24);
  const pg = new Page({ size: 9.5 });
  pg.row(
    [
      [56, 'Corvus Card'],
      [360, 'Monthly statement'],
    ],
    { size: 14, bold: true },
  );
  pg.line([initialled(p), ...address(h)]);
  pg.gap();
  pg.row([
    [56, 'Statement date'],
    [200, fmt(issued, 'dashed')],
    [330, 'Card ending'],
    [430, r.digits(4)],
  ]);
  pg.row([
    [56, 'Credit limit'],
    [200, '£3,200'],
    [330, 'Available'],
    [430, `£${money(r, 1000, 3000)}`],
  ]);
  pg.gap();
  pg.row([
    [56, 'Balance'],
    [200, `£${money(r, 100, 2000)}`],
  ]);
  pg.row([
    [56, 'Minimum to pay'],
    [200, `£${money(r, 25, 60)}`],
  ]);
  pg.row([
    [56, 'Pay by'],
    [200, fmt(due, 'dashed')],
  ]);
  pg.line('Purchase rate 24.9% APR variable', { size: 8.5 });
  pg.foot();
  return { truth: { issued, expires: due, number: null, issuer: 'Corvus Card' }, pages: [pg] };
});

paper('personal-loan-statement', 'loan', 0.3, (r, h, p, o) => {
  const issued = o.issued;
  const number = `AL${r.digits(8)}`;
  const pg = new Page({ size: 10.5 });
  pg.line('Ardent Personal Loans', { size: 15, bold: true });
  pg.line('Annual loan statement');
  pg.gap();
  pg.line([formal(p), ...address(h)]);
  pg.gap();
  pg.line(`Loan account number ${number}`);
  pg.line(`Statement date ${fmt(issued, 'long')}`);
  pg.line(`Amount borrowed £${money(r, 4000, 15000)}`);
  pg.line(`Balance remaining £${money(r, 1000, 9000)}`);
  pg.line(`Monthly repayment £${money(r, 120, 320)}`);
  pg.line(`Final repayment date ${fmt(o.ends, 'long')}`);
  pg.foot();
  return {
    truth: { issued, expires: o.ends, number, issuer: 'Ardent Personal Loans' },
    pages: [pg],
  };
});

// ---- bills

paper('gas-statement', 'utility_bill', 0.3, (r, h, p, o) => {
  const issued = o.issued;
  const due = addDays(issued, 21);
  const number = `HG ${r.digits(6)}`;
  const pg = new Page({ size: 10 });
  pg.line('Hearthgas', { size: 18, bold: true });
  pg.line('Gas statement', { size: 12 });
  pg.line([formal(p), ...address(h)]);
  pg.gap();
  pg.row([
    [56, 'Customer number'],
    [200, number],
  ]);
  pg.row([
    [56, 'Statement date'],
    [200, fmt(issued, 'long')],
  ]);
  pg.gap();
  pg.line(`Gas used this quarter: ${r.int(1500, 5000)} kWh`);
  const total = money(r, 90, 400);
  pg.line(`Total: £${total}`);
  pg.line(`Please pay by ${fmt(due, 'long')}.`);
  pg.foot();
  return { truth: { issued, expires: due, number, issuer: 'Hearthgas' }, pages: [pg] };
});

paper('water-charges', 'utility_bill', 0.4, (r, h, p, o) => {
  const issued = o.issued;
  const due = addDays(issued, 28);
  const number = `${r.digits(10)}`;
  const pg = new Page({ size: 10 });
  pg.line('Calder Valley Water', { size: 15, bold: true });
  pg.line('Your annual water charges');
  pg.gap();
  pg.line([initialled(p), ...address(h)]);
  pg.gap();
  pg.row([
    [56, 'Account'],
    [180, number],
  ]);
  pg.row([
    [56, 'Date'],
    [180, fmt(issued, 'slash')],
  ]);
  pg.row([
    [56, 'Charges for the year'],
    [180, `£${money(r, 380, 620)}`],
  ]);
  pg.row([
    [56, 'Due date'],
    [180, fmt(due, 'slash')],
  ]);
  pg.foot();
  return { truth: { issued, expires: due, number, issuer: 'Calder Valley Water' }, pages: [pg] };
});

paper('phone-invoice', 'utility_bill', 0.1, (r, h, p, o) => {
  const issued = o.issued;
  const paid = addDays(issued, 10);
  const number = `TW${r.digits(8)}`;
  const pg = new Page({ size: 9.5 });
  pg.row(
    [
      [56, 'Telwyn'],
      [400, 'Invoice'],
    ],
    { size: 16, bold: true },
  );
  pg.row([
    [56, full(p)],
    [330, `Invoice number ${r.digits(9)}`],
  ]);
  pg.row([
    [56, address(h)[0]],
    [330, `Account ${number}`],
  ]);
  pg.row([
    [56, address(h)[1]],
    [330, `Invoice date ${fmt(issued, 'short')}`],
  ]);
  pg.gap();
  pg.row([
    [56, 'Broadband 150 and landline'],
    [400, '£38.00'],
  ]);
  pg.row([
    [56, 'Total including VAT'],
    [400, '£38.00'],
  ]);
  pg.line(`Your Direct Debit payment date is ${fmt(paid, 'short')}.`);
  pg.foot();
  return { truth: { issued, expires: paid, number, issuer: 'Telwyn' }, pages: [pg] };
});

paper('council-annual-bill', 'utility_bill', 0.5, (r, h, p, o) => {
  const issued = o.issued;
  const first = addDays(issued, 25);
  const number = `MDC/${r.digits(7)}`;
  const pg = new Page({ size: 10 });
  pg.line('Morland District Council', { size: 15, bold: true });
  pg.line('Annual Council Tax Bill');
  pg.gap();
  pg.line([o.joint ? `${initialled(p)} & ${initialled(o.joint)}` : initialled(p), ...address(h)]);
  pg.gap();
  pg.line(`Reference ${number}   Band D`);
  pg.line(`Issued ${fmt(issued, 'long')}`);
  pg.line(`Amount due for the year £${money(r, 1900, 2300)}`);
  pg.line(`Instalments due on ${fmt(first, 'long')} and the same day of each following month.`);
  pg.foot();
  return {
    truth: { issued, expires: first, number, issuer: 'Morland District Council' },
    pages: [pg],
  };
});

// ---- tax and work

paper('p60-single-column', 'tax_form', 0.5, (r, h, p, o) => {
  const pg = new Page({ size: 10 });
  pg.line(`P60 — end of year certificate, tax year ending 5 April ${o.year}`, { bold: true });
  pg.line(`Employer: ${o.employer}`);
  pg.line(`Employee: ${upper(full(p))}`);
  pg.line(`National Insurance number: ${p.ni}`);
  pg.line(`Total pay in this employment: £${money(r, 18000, 60000)}`);
  pg.line(`Total tax deducted: £${money(r, 1000, 9000)}`);
  pg.line('Tax code at the end of the year: 1257L');
  pg.foot();
  return { truth: { issued: null, expires: null, number: null, issuer: o.employer }, pages: [pg] };
});

paper('tax-return-summary', 'tax_return', 0.3, (r, h, p, o) => {
  const filed = o.issued;
  const pg = new Page({ size: 10.5 });
  pg.line('HM Revenue & Customs', { size: 13, bold: true });
  pg.line(`Your tax return summary ${o.year - 1}-${String(o.year).slice(2)}`);
  pg.gap();
  pg.line(`Name: ${formal(p)}`);
  pg.line(`Unique Taxpayer Reference: ${r.digits(10)}`);
  pg.line(`Return submitted: ${fmt(filed, 'long')}`);
  pg.line(`Tax due: £${money(r, 100, 3000)}`);
  pg.line(`Pay by 31 January ${o.year + 1}.`);
  pg.foot();
  return { truth: { issued: filed, expires: null, number: null, issuer: 'HMRC' }, pages: [pg] };
});

paper('teaching-contract', 'employment_contract', 0.3, (r, h, p, o) => {
  const start = o.issued;
  const pg = new Page({ size: 10.5 });
  pg.line('Pellow & Hart Ltd', { size: 15, bold: true });
  pg.line('Contract of employment', { size: 12 });
  pg.gap();
  pg.line(`This contract is between Pellow & Hart Ltd and ${full(p)} ("you").`);
  pg.line(`Your employment begins on ${fmt(start, 'long')} and is permanent.`);
  pg.line('Your job title is Project Coordinator.');
  pg.line(`Your salary is £${money(r, 32000, 46000)} a year, paid monthly.`);
  pg.line('Notice period: two months on either side.');
  pg.foot();
  return {
    truth: { issued: start, expires: null, number: null, issuer: 'Pellow & Hart Ltd' },
    pages: [pg],
  };
});

// ---- health

paper('health-centre-letter', 'medical_record', 0.6, (r, h, p, o) => {
  const issued = o.issued;
  const pg = new Page({ size: 10 });
  pg.row(
    [
      [56, 'Brookfield Health Centre'],
      [380, `Our ref: BH/${r.digits(5)}`],
    ],
    { bold: true },
  );
  pg.line('Station Road, Ashby Vale AV2 4BH  |  01632 960 840', { size: 8.5 });
  pg.gap();
  pg.line(fmt(issued, 'long'));
  pg.gap();
  pg.line([full(p), ...address(h)]);
  pg.line(`NHS No: ${p.nhs}`);
  pg.gap();
  pg.line(`Dear ${p.first},`);
  pg.line(
    r.pick([
      'Your annual health check is due. Please book an appointment with the practice nurse.',
      'Your recent test results have come back and the doctor would like to discuss them.',
      'We have updated your records following your recent hospital appointment.',
    ]),
  );
  pg.line(['Kind regards,', 'Brookfield Health Centre']);
  pg.foot();
  return {
    truth: { issued, expires: null, number: null, issuer: 'Brookfield Health Centre' },
    pages: [pg],
  };
});

paper('discharge-summary', 'medical_record', 0.6, (r, h, p, o) => {
  const issued = o.issued;
  const pg = new Page({ size: 10 });
  pg.line("St Aidan's Hospital", { size: 15, bold: true });
  pg.line('Discharge summary', { size: 12 });
  pg.gap();
  pg.row([
    [56, `Patient: ${upper(full(p))}`],
    [330, `DOB: ${fmt(p.born, 'slash')}`],
  ]);
  pg.row([
    [56, `Admitted: ${fmt(addDays(issued, -3), 'slash')}`],
    [330, `Discharged: ${fmt(issued, 'slash')}`],
  ]);
  pg.line(`Hospital number: ${r.letters(1)}${r.digits(6)}`);
  pg.gap();
  pg.line('Diagnosis: uncomplicated appendicitis, treated by laparoscopic appendicectomy.');
  pg.line('Follow-up: GP review in two weeks.');
  pg.foot();
  return {
    truth: { issued, expires: null, number: null, issuer: "St Aidan's Hospital" },
    pages: [pg],
  };
});

paper('repeat-slip', 'prescription', 0.6, (r, h, p, o) => {
  const issued = o.issued;
  const expires = addMonths(issued, 6);
  const pg = new Page({ size: 10, left: 120, top: 100 });
  pg.line('Brookfield Health Centre', { bold: true });
  pg.line('Repeat prescription');
  pg.line(`Patient: ${formal(p)}`);
  pg.line(`Issued: ${fmt(issued, 'dots')}`);
  pg.line(
    r.pick([
      'Lansoprazole 30mg capsules x 28',
      'Metformin 500mg tablets x 56',
      'Ramipril 5mg capsules x 28',
    ]),
  );
  pg.line(`Valid until: ${fmt(expires, 'dots')}`);
  pg.foot();
  return {
    truth: { issued, expires, number: null, issuer: 'Brookfield Health Centre' },
    pages: [pg],
  };
});

paper('booster-reminder', 'pet_record', 0.4, (r, h, p, o) => {
  const due = o.due;
  const pg = new Page({ size: 10.5 });
  pg.line('Pawprint Vets', { size: 15, bold: true });
  pg.line([initialled(p), ...address(h)]);
  pg.gap();
  pg.line("Biscuit's booster is due", { bold: true });
  pg.line(`Biscuit's annual vaccination is due on ${fmt(due, 'long')}.`);
  pg.line('Please call 01632 960 909 to book.');
  pg.line('Pawprint Vets, 2 Canal Wharf, Ashby Vale');
  pg.foot();
  return {
    truth: { issued: null, expires: due, number: null, issuer: 'Pawprint Vets' },
    pages: [pg],
  };
});

// ---- school

paper('progress-report', 'school_report', 0.5, (r, h, p, o) => {
  const pg = new Page({ size: 10 });
  pg.line('Hollins Park Academy', { size: 15, bold: true });
  pg.line(`Pupil progress report — ${o.term} term ${o.year}`, { size: 12 });
  pg.gap();
  pg.row([
    [56, `Name: ${full(p)}`],
    [330, `Form: ${r.pick(['10H', '10P', '9K'])}`],
  ]);
  pg.gap();
  pg.row(
    [
      [56, 'Subject'],
      [220, 'Attainment'],
      [330, 'Effort'],
    ],
    { bold: true },
  );
  for (const s of ['English', 'Maths', 'Science', 'Geography', 'Spanish']) {
    pg.row([
      [56, s],
      [220, r.pick(['5', '6', '7'])],
      [330, r.pick(['Excellent', 'Good', 'Satisfactory'])],
    ]);
  }
  pg.line('Form tutor: Ms K Adeyemi');
  pg.foot();
  return {
    truth: { issued: null, expires: null, number: null, issuer: 'Hollins Park Academy' },
    pages: [pg],
  };
});

paper('music-certificate', 'diploma', 0.8, (r, h, p, o) => {
  const pg = new Page({ size: 12, top: 150, left: 100 });
  pg.line('WESTMERE MUSIC BOARD', { size: 16, bold: true });
  pg.line('Certificate of achievement');
  pg.gap();
  pg.line(full(p), { size: 15, bold: true });
  pg.line(`has passed Grade ${r.int(2, 6)} Piano with Merit`);
  pg.line(`Date of examination: ${fmt(o.issued, 'long')}`);
  pg.foot();
  return {
    truth: { issued: o.issued, expires: null, number: null, issuer: 'Westmere Music Board' },
    pages: [pg],
  };
});

// ---- things bought, cars

paper('order-guarantee', 'warranty', 0.3, (r, h, p, o) => {
  const issued = o.issued;
  const expires = addYears(issued, 3);
  const pg = new Page({ size: 10 });
  pg.line('Kelso Home Store', { size: 15, bold: true });
  pg.line(`Order confirmation ${r.digits(8)}`);
  pg.gap();
  pg.line(`Ordered on ${fmt(issued, 'long')} by ${full(p)}`);
  pg.line(r.pick(['Oak dining table', 'Corner sofa', 'Bed frame, king size']));
  pg.line(`Guarantee: 3 years, until ${fmt(expires, 'long')}`);
  pg.line(`Order total £${money(r, 300, 1500)}`);
  pg.foot();
  return { truth: { issued, expires, number: null, issuer: 'Kelso Home Store' }, pages: [pg] };
});

paper('logbook-v5c-new', 'vehicle_registration', 0.8, (r, h, p, o) => {
  const ref = `${r.digits(11)}`;
  const pg = new Page({ size: 9.5 });
  pg.row(
    [
      [56, 'V5C'],
      [200, 'Registration certificate'],
    ],
    { size: 13, bold: true },
  );
  pg.row([
    [56, 'A Registration number'],
    [250, o.plate],
  ]);
  pg.row([
    [56, 'Document reference number'],
    [250, ref],
  ]);
  pg.row([
    [56, 'C.1 Registered keeper'],
    [250, upper(full(p))],
  ]);
  pg.row([
    [56, 'B Date of first registration'],
    [250, fmt(o.first, 'dots')],
  ]);
  pg.row([
    [56, 'D.1 Make'],
    [250, 'ORLA'],
  ]);
  pg.row([
    [56, 'R Colour'],
    [250, 'GREY'],
  ]);
  pg.foot();
  return { truth: { issued: null, expires: null, number: ref, issuer: 'DVLA' }, pages: [pg] };
});

// ---- papers of no kind

paper('watch-newsletter', null, 0.3, (r) => {
  const pg = new Page({ size: 11 });
  pg.line('Elm Street Neighbourhood Watch', { size: 15, bold: true });
  pg.line('Keeping our street safe');
  pg.line(`Issue ${r.int(10, 60)}`);
  pg.line(['Two bikes were taken from front gardens last month.', 'Please lock sheds and gates.']);
  pg.foot();
  return { truth: { issued: null, expires: null, number: null, issuer: null }, pages: [pg] };
});

paper('pizza-leaflet', null, 0.4, (r) => {
  const pg = new Page({ size: 12 });
  pg.line('NONNA ROSA PIZZA', { size: 20, bold: true });
  pg.line(`Two large pizzas for £${r.int(18, 24)} — collection only`);
  pg.line('Open 4pm to 10pm, closed Mondays. 01632 960 333');
  pg.foot();
  return { truth: { issued: null, expires: null, number: null, issuer: null }, pages: [pg] };
});

paper('library-notice', null, 0.3, (r, h, p) => {
  const pg = new Page({ size: 10.5 });
  pg.line('Ashby Vale Libraries', { size: 15, bold: true });
  pg.line(`To: ${full(p)}`);
  pg.line('The book you reserved is ready to collect from Ashby Vale Central Library.');
  pg.line('Please collect it within 7 days.');
  pg.foot();
  return { truth: { issued: null, expires: null, number: null, issuer: null }, pages: [pg] };
});

paper('charity-bag', null, 0.5, (r) => {
  const pg = new Page({ size: 12 });
  pg.line('CLOTHES COLLECTION', { size: 18, bold: true });
  pg.line('Fill this bag with clothes and shoes and leave it outside by 8am on Thursday.');
  pg.line(`Westmere Hospice Shops. Collection round ${r.int(1, 40)}.`);
  pg.foot();
  return { truth: { issued: null, expires: null, number: null, issuer: null }, pages: [pg] };
});

// ------------------------------------------------------------------ the plan

const monthsFrom = (from, n, day) =>
  Array.from({ length: n }, (_, i) => addMonths(`${from.slice(0, 7)}-${day}`, i));

/** The second set's papers: 120 in all, with the blanks and copies smartCorpus adds. */
export function plan2(P) {
  const out = [];
  const add = (paper, who, opts = {}) => out.push({ paper, who, opts });
  add('passport-renewal-copy', 'olivia', { issued: '2024-03-11' });
  add('passport-renewal-copy', 'tariq', { issued: '2022-04-19' });
  add('passport-renewal-copy', 'maryam', { issued: '2023-06-14' });
  add('passport-renewal-copy', 'ahmed', { issued: '2019-08-02' });
  add('dvla-new-licence-letter', 'olivia', { issued: '2021-05-10' });
  add('dvla-new-licence-letter', 'ahmed', { issued: '2018-11-21' });
  for (const [who, issued, plate] of [
    ['olivia', '2026-02-01', 'AV19 RKH'],
    ['olivia', '2025-02-01', 'AV19 RKH'],
    ['ahmed', '2026-08-15', 'AV22 OJK'],
  ]) {
    add('motor-schedule', who, { issued, plate });
  }
  add('home-renewal-notice', 'ahmed', { ends: '2026-11-30' });
  add('home-renewal-notice', 'ahmed', { ends: '2025-11-30' });
  add('breakdown-card', 'olivia', { issued: '2026-04-01' });
  add('breakdown-card', 'ahmed', { issued: '2025-04-01' });
  for (const issued of ['2026-03-31', '2026-06-30', '2026-09-30', '2025-12-31']) {
    add('society-account-summary', 'ahmed', { issued, joint: P.olivia });
  }
  for (const issued of ['2026-03-31', '2026-06-30', '2025-09-30', '2025-12-31', '2025-06-30']) {
    add('society-account-summary', 'olivia', { issued });
  }
  add('breakdown-card', 'olivia', { issued: '2025-04-01' });
  add('motor-schedule', 'ahmed', { issued: '2025-08-15', plate: 'AV22 OJK' });
  add('p60-single-column', 'olivia', { year: 2025, employer: 'Pellow & Hart Ltd' });
  add('booster-reminder', 'olivia', { due: '2024-11-14' });
  add('repeat-slip', 'farida', { issued: '2025-10-20' });
  add('repeat-slip', 'olivia', { issued: '2026-05-06' });
  add('order-guarantee', 'ahmed', { issued: '2024-12-20' });
  add('order-guarantee', 'olivia', { issued: '2024-07-09' });
  add('health-centre-letter', 'olivia', { issued: '2025-09-30' });
  add('health-centre-letter', 'ahmed', { issued: '2026-08-28' });
  add('gas-statement', 'olivia', { issued: '2025-07-03' });
  add('gas-statement', 'olivia', { issued: '2025-04-03' });
  add('cash-isa-statement', 'olivia', { issued: '2026-04-05' });
  add('cash-isa-statement', 'ahmed', { issued: '2026-04-05' });
  add('cash-isa-statement', 'tariq', { issued: '2026-04-05', junior: true });
  add('cash-isa-statement', 'maryam', { issued: '2026-04-05', junior: true });
  for (const issued of monthsFrom('2026-01', 8, '07'))
    add('card-monthly-statement', 'olivia', { issued });
  for (const issued of monthsFrom('2026-05', 4, '22'))
    add('card-monthly-statement', 'ahmed', { issued });
  add('personal-loan-statement', 'ahmed', { issued: '2026-01-31', ends: '2028-07-31' });
  add('personal-loan-statement', 'ahmed', { issued: '2025-01-31', ends: '2028-07-31' });
  for (const issued of ['2025-10-03', '2026-01-05', '2026-04-03', '2026-07-03']) {
    add('gas-statement', 'olivia', { issued });
  }
  add('water-charges', 'ahmed', { issued: '2026-03-10' });
  add('water-charges', 'ahmed', { issued: '2025-03-11' });
  for (const issued of monthsFrom('2026-01', 9, '14')) add('phone-invoice', 'ahmed', { issued });
  add('council-annual-bill', 'ahmed', { issued: '2026-03-02', joint: P.olivia });
  add('council-annual-bill', 'ahmed', { issued: '2025-03-03' });
  add('p60-single-column', 'olivia', { year: 2026, employer: 'Pellow & Hart Ltd' });
  add('p60-single-column', 'ahmed', { year: 2026, employer: 'Brightstone Retail Ltd' });
  add('p60-single-column', 'ahmed', { year: 2025, employer: 'Brightstone Retail Ltd' });
  add('tax-return-summary', 'olivia', { year: 2026, issued: '2026-09-18' });
  add('tax-return-summary', 'olivia', { year: 2025, issued: '2025-10-02' });
  add('teaching-contract', 'olivia', { issued: '2025-04-07' });
  for (const [who, issued] of [
    ['olivia', '2026-02-11'],
    ['ahmed', '2026-05-19'],
    ['farida', '2026-01-08'],
    ['farida', '2026-06-23'],
    ['tariq', '2025-11-12'],
    ['maryam', '2026-03-17'],
  ]) {
    add('health-centre-letter', who, { issued });
  }
  add('discharge-summary', 'ahmed', { issued: '2025-08-14' });
  add('discharge-summary', 'farida', { issued: '2026-02-27' });
  for (const issued of ['2026-01-20', '2026-04-22', '2026-07-21'])
    add('repeat-slip', 'farida', { issued });
  add('repeat-slip', 'ahmed', { issued: '2026-08-05' });
  add('booster-reminder', 'olivia', { due: '2026-11-12' });
  add('booster-reminder', 'ahmed', { due: '2025-11-10' });
  for (const [who, term, year] of [
    ['tariq', 'Autumn', 2025],
    ['tariq', 'Spring', 2026],
    ['tariq', 'Summer', 2026],
  ]) {
    add('progress-report', who, { term, year });
  }
  add('music-certificate', 'maryam', { issued: '2026-06-20' });
  add('music-certificate', 'tariq', { issued: '2024-12-01' });
  for (const [who, issued] of [
    ['olivia', '2025-05-02'],
    ['ahmed', '2026-02-14'],
    ['olivia', '2026-08-30'],
  ]) {
    add('order-guarantee', who, { issued });
  }
  add('logbook-v5c-new', 'olivia', { plate: 'AV19 RKH', first: '2019-03-14' });
  add('logbook-v5c-new', 'ahmed', { plate: 'AV22 OJK', first: '2022-03-02' });
  for (let i = 0; i < 3; i += 1) add('watch-newsletter', null, { n: i });
  for (let i = 0; i < 3; i += 1) add('pizza-leaflet', null, { n: i });
  add('library-notice', 'maryam', { n: 1 });
  add('library-notice', 'olivia', { n: 2 });
  add('charity-bag', null, { n: 1 });
  add('charity-bag', null, { n: 2 });
  return out;
}

/** Where the family keeps the second set: the same habits, other folders. */
export function home2(item, P) {
  const who = item.who ? P[item.who].name : null;
  const [y, m] = (item.truth.issued ?? item.truth.expires ?? '2026-10-01').split('-');
  const ym = `${y}-${m}`;
  switch (item.paper) {
    case 'passport-renewal-copy':
      return [`${who}/Passports`, 'passport copy'];
    case 'dvla-new-licence-letter':
      return [`${who}/Driving licence`, 'DVLA letter'];
    case 'motor-schedule':
    case 'breakdown-card':
      return ['Car', `${item.paper} ${y}`];
    case 'home-renewal-notice':
      return ['Home insurance', `renewal ${y}`];
    case 'society-account-summary':
      return ['Money/Meridian', `summary ${ym}`];
    case 'cash-isa-statement':
      return ['Money/ISAs', `${who} ISA ${y}`];
    case 'card-monthly-statement':
      return ['Money/Credit cards', `Corvus ${ym}`];
    case 'personal-loan-statement':
      return ['Money/Loans', `loan ${y}`];
    case 'gas-statement':
    case 'water-charges':
    case 'phone-invoice':
    case 'council-annual-bill':
      return [`Bills ${y}`, `${item.paper} ${ym}`];
    case 'p60-single-column':
    case 'tax-return-summary':
      return [`${who}/Tax`, `${item.paper} ${item.opts.year}`];
    case 'teaching-contract':
      return [`${who}/Job`, 'contract'];
    case 'health-centre-letter':
    case 'discharge-summary':
    case 'repeat-slip':
      return [`Health/${who}`, `${item.paper} ${ym}`];
    case 'booster-reminder':
      return ['Biscuit', `booster ${ym}`];
    case 'progress-report':
      return [`${who}/School reports`, `${item.opts.term} ${item.opts.year}`];
    case 'music-certificate':
      return [`${who}/Certificates`, 'piano'];
    case 'order-guarantee':
      return ['Receipts', `order ${ym}`];
    case 'logbook-v5c-new':
      return ['Car', `logbook ${item.opts.plate}`];
    default:
      return ['Post', `${item.paper} ${item.opts.n ?? ''}`.trim()];
  }
}
