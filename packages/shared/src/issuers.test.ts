import { describe, expect, it } from 'vitest';
import {
  cleanIssuer,
  issuerCandidates,
  issuerFromFilename,
  issuerKey,
  rankKnownIssuers,
  type KnownIssuer,
} from './issuers.js';

const KHANS = ['Aisha Khan', 'Omar Khan', 'The Khan Family'];
const CARTERS = ['Emily Carter', 'Daniel Carter', 'The Carter Household'];

const page = (...lines: string[]) => lines.join('\n');
/** Pages as the OCR job joins them: a blank line between each. */
const pages = (...each: string[]) => each.join('\n\n');
const suggest = (text: string, known: KnownIssuer[] = [], typeKey?: string, people = KHANS) =>
  issuerCandidates(text, { known, typeKey, people });

const BARCLAYS_FOOTER =
  'Barclays Bank UK PLC. Authorised by the Prudential Regulation Authority and regulated by ' +
  'the Financial Conduct Authority and the Prudential Regulation Authority (Financial Services ' +
  'Register No. 759676). Registered in England. Registered No. 9740322. Registered Office: ' +
  '1 Churchill Place, London E14 5HP.';

const BARCLAYS_STATEMENT = pages(
  page(
    'Barclays Bank UK PLC',
    'PO Box 3333',
    'Snowdon Road',
    'Middlesbrough',
    'TS1 1ZZ',
    '',
    'Mrs Aisha Khan',
    '14 Elm Grove',
    'Leeds',
    'LS6 2AB',
    '',
    'Your Barclays Bank Account statement',
    'Sort code 20-00-00      Account number 12345678',
    '1 Aug 2026 - 31 Aug 2026',
    '',
    'Date      Description                        Money out    Money in    Balance',
    '03 Aug    DIRECT DEBIT BRITISH GAS             45.00                   1,234.56',
    '05 Aug    CARD PAYMENT TESCO STORES            23.10                   1,211.46',
    '',
    'Visit www.barclays.co.uk to manage your account online.',
    BARCLAYS_FOOTER,
    'Page 1 of 2',
  ),
  page(
    'Date      Description                        Money out    Money in    Balance',
    '20 Aug    STANDING ORDER AVIVA                 12.00                   1,199.46',
    '28 Aug    SALARY ACME WIDGETS LTD                          2,000.00    3,199.46',
    BARCLAYS_FOOTER,
    'Page 2 of 2',
  ),
);

const BRITISH_GAS_BILL = page(
  'British Gas',
  'Your energy bill',
  'Account number   8500 1234 5678',
  'Bill date   14 September 2026',
  '',
  'Mr Omar Khan',
  '14 Elm Grove',
  'Leeds',
  'LS6 2AB',
  '',
  'Your energy account at a glance',
  'Amount due £123.45',
  'We will collect this by Direct Debit on or after 1 October 2026.',
  'Manage your account at britishgas.co.uk/myaccount',
  'British Gas is a trading name of British Gas Services Limited. Registered in England and ' +
    'Wales No. 3141243. Registered office: Millstream, Maidenhead Road, Windsor, Berkshire SL4 5GD.',
);

const NHS_LETTER = page(
  'Riverside Surgery',
  '12 High Street',
  'Anytown',
  'AB1 2CD',
  'Tel: 01234 567890',
  '',
  'Private & Confidential',
  'Ms Aisha Khan',
  '14 Elm Grove',
  'Leeds LS6 2AB',
  '',
  '12 September 2026',
  '',
  'NHS number: 485 777 3456',
  '',
  'Dear Ms Khan,',
  'Your recent blood test results are normal and no further action is needed.',
  'Yours sincerely,',
  '',
  'Dr S Patel',
  'GP Partner',
);

const HMRC_LETTER = page(
  'HM Revenue & Customs',
  'Pay As You Earn',
  'BX9 1AS',
  '',
  'Mr Omar Khan',
  '14 Elm Grove',
  'Leeds',
  'LS6 2AB',
  '',
  'Date: 20 September 2026',
  'Our reference: 123/AB45678',
  '',
  'Tax code notice 2026 to 2027',
  'Your tax code for 2026 to 2027 is 1257L.',
  'For more information go to www.gov.uk/hmrc',
);

const AVIVA_SCHEDULE = page(
  'AVIVA',
  'Home Insurance',
  'Policy Schedule',
  '',
  'Policy number: HM 12345678',
  'Policyholder: Mrs Aisha Khan',
  'Address: 14 Elm Grove, Leeds LS6 2AB',
  'Period of cover: 01/10/2026 to 30/09/2027',
  '',
  'Buildings cover       £500,000',
  'Contents cover        £75,000',
  'Annual premium        £312.40',
  '',
  'Aviva Insurance Limited. Registered in Scotland No. 2116. Registered Office: Pitheavlis, ' +
    'Perth PH2 0NH.',
  'Questions? Visit aviva.co.uk/help',
);

const CHASE_STATEMENT = pages(
  page(
    'CHASE',
    'JPMorgan Chase Bank, N.A.',
    'P O Box 182051',
    'Columbus, OH 43218-2051',
    '',
    'EMILY CARTER',
    '1234 MAPLE AVENUE',
    'SPRINGFIELD, IL 62704',
    '',
    'August 1, 2026 through August 31, 2026',
    'Account Number: 000000123456789',
    '',
    'CHECKING SUMMARY',
    'Beginning Balance            $1,234.56',
    'Deposits and Additions       $2,000.00',
    'Customer Service: 1-800-935-9935',
    'www.chase.com',
  ),
  page('Ending Balance $3,034.56', 'JPMorgan Chase Bank, N.A. Member FDIC', 'Page 2 of 2'),
);

const PERSONAL_LETTER = page(
  '14 Elm Grove',
  'Leeds',
  'LS6 2AB',
  '',
  '12 September 2026',
  '',
  'Dear Aisha,',
  'Thank you so much for looking after the cat last week. She was very happy.',
  'We must have you both round for dinner soon.',
  'Best wishes,',
  'Margaret',
);

describe('issuerKey', () => {
  it('the same issuer, however it is written, has one key', () => {
    const key = issuerKey('Barclays Bank UK PLC');
    expect(key).toBe('barclays bank uk');
    expect(issuerKey('BARCLAYS BANK UK')).toBe(key);
    expect(issuerKey('  barclays   bank uk plc. ')).toBe(key);
    expect(issuerKey('Barclays Bank UK p.l.c.')).toBe(key);
  });

  it.each([
    ['JPMorgan Chase Bank, N.A.', 'jpmorgan chase bank'],
    ['Aviva Insurance Limited', 'aviva insurance'],
    ['Acme Ltd.', 'acme'],
    ['Acme LLP', 'acme'],
    ['Acme, LLC', 'acme'],
    ['Acme Inc.', 'acme'],
    ['Acme Corp', 'acme'],
    ['Acme Corporation', 'acme'],
    ['Acme GmbH', 'acme'],
    ['Banco Santander, S.A.', 'banco santander'],
    ['Coutts & Co', 'coutts'],
    ['Foo & Co. Ltd', 'foo'],
    ['Marks & Spencer plc', 'marks spencer'],
    ['The Co-operative Bank p.l.c.', 'co operative bank'],
    ['Société Générale S.A.', 'societe generale'],
    ["Sainsbury's Bank", 'sainsbury s bank'],
  ])('%s', (name, key) => {
    expect(issuerKey(name)).toBe(key);
  });

  it('a legal form is taken only from the end, and only as a word of its own', () => {
    expect(issuerKey('Unlimited Energy')).toBe('unlimited energy');
    expect(issuerKey('Zinc')).toBe('zinc');
    expect(issuerKey('Limited Edition Books')).toBe('limited edition books');
    expect(issuerKey('Visa')).toBe('visa'); // no dots: not S.A.
  });

  it('is empty when nothing useful is left', () => {
    expect(issuerKey('')).toBe('');
    expect(issuerKey('   ')).toBe('');
    expect(issuerKey('---')).toBe('');
    expect(issuerKey('Ltd')).toBe('');
  });
});

describe('cleanIssuer', () => {
  it('trims, collapses and drops the legal form', () => {
    expect(cleanIssuer('  Barclays   Bank UK PLC ')).toBe('Barclays Bank UK');
    expect(cleanIssuer('JPMorgan Chase Bank, N.A.')).toBe('JPMorgan Chase Bank');
    expect(cleanIssuer('• Aviva Insurance Limited.')).toBe('Aviva Insurance');
  });

  it('writes a name printed in capitals the way a person would', () => {
    expect(cleanIssuer('BRITISH GAS')).toBe('British Gas');
    expect(cleanIssuer('AVIVA INSURANCE LIMITED')).toBe('Aviva Insurance');
    expect(cleanIssuer('BANK OF SCOTLAND PLC')).toBe('Bank of Scotland');
    expect(cleanIssuer('HM REVENUE & CUSTOMS')).toBe('HM Revenue & Customs');
    expect(cleanIssuer("SAINSBURY'S BANK")).toBe("Sainsbury's Bank");
    expect(cleanIssuer('ROLLS-ROYCE MOTOR CARS')).toBe('Rolls-Royce Motor Cars');
    expect(cleanIssuer('SKY')).toBe('Sky');
    expect(cleanIssuer('BARCLAYS BANK UK PLC')).toBe('Barclays Bank UK');
  });

  it.each(['NHS', 'HMRC', 'DVLA', 'BT', 'EE', 'IRS', 'DMV', 'HSBC', 'TSB', 'M&S', 'E.ON', 'O2'])(
    'keeps the acronym %s as it is',
    (acronym) => {
      expect(cleanIssuer(acronym)).toBe(acronym);
    },
  );

  it('keeps an acronym inside a name, too', () => {
    expect(cleanIssuer('NHS BUSINESS SERVICES AUTHORITY')).toBe('NHS Business Services Authority');
    expect(cleanIssuer('BT GROUP PLC')).toBe('BT Group');
  });

  it('leaves the issuer’s own styling alone', () => {
    expect(cleanIssuer('eBay')).toBe('eBay');
    expect(cleanIssuer('Which?')).toBe('Which?');
    expect(cleanIssuer('barclays')).toBe('barclays');
  });

  it('keeps at most 200 characters', () => {
    expect(cleanIssuer('Abc '.repeat(100))).toHaveLength(199); // the space at the cut goes too
    expect(cleanIssuer('x'.repeat(300))).toHaveLength(200);
  });

  it('is empty when nothing is left', () => {
    expect(cleanIssuer('')).toBe('');
    expect(cleanIssuer('Limited')).toBe('');
  });
});

describe('issuerCandidates: letterheads', () => {
  it('a UK bank statement is from Barclays, not its payees or its customer', () => {
    // The registered name in the letterhead and on every page's footer,
    // cut down to the brand the web address uses.
    expect(suggest(BARCLAYS_STATEMENT)).toEqual([{ value: 'Barclays', source: 'page' }]);
  });

  it('a payee on a statement line is never the issuer, even when the household knows it', () => {
    const known = [
      { value: 'British Gas', count: 12 },
      { value: 'Aviva', count: 3 },
      { value: 'Tesco', count: 1 },
    ];
    expect(suggest(BARCLAYS_STATEMENT, known)).toEqual([{ value: 'Barclays', source: 'page' }]);
  });

  it('a payee repeated down a statement is still a payee, however registered', () => {
    const lines = [
      'Mr M Khan',
      '14 Oak Road',
      'London SW1A 1AA',
      'Statement for 1 Sep to 30 Sep 2026',
      ...Array.from({ length: 4 }, () => '02 Sep SAINSBURYS SUPERMARKETS LTD 45.20'),
      ...Array.from({ length: 2 }, () => '05 Sep TESCO STORES LTD 12.10'),
    ];
    const footer = 'Barclays Bank UK PLC. Authorised by the Prudential Regulation Authority.';
    expect(suggest(page(...lines, 'Visit barclays.co.uk to manage your account.', footer))).toEqual(
      [{ value: 'Barclays', source: 'page' }],
    );
    // Without the web address the footer alone is not enough — and the
    // payees are still not offered in its place.
    expect(suggest(page(...lines, footer))).toEqual([]);
  });

  it('statement lines at the top of the page are not a letterhead either', () => {
    const text = page(
      'Barclays',
      'Date      Description                        Money out    Balance',
      '03 Sep    DIRECT DEBIT OCTOPUS ENERGY LTD      85.00        1,149.46',
      'CARD PAYMENT TESCO STORES LTD      12.10',
      'CARD PAYMENT TESCO STORES LTD      8.40',
      'CARD PAYMENT TESCO STORES LTD      3.99',
      'www.barclays.co.uk',
    );
    expect(suggest(text)).toEqual([{ value: 'Barclays', source: 'page' }]);
  });

  it('once the household knows Barclays, it is offered as theirs', () => {
    const known = [
      { value: 'Barclays', count: 4 },
      { value: 'British Gas', count: 12 },
    ];
    expect(suggest(BARCLAYS_STATEMENT, known)).toEqual([{ value: 'Barclays', source: 'known' }]);
  });

  it('a utility bill is from British Gas', () => {
    expect(suggest(BRITISH_GAS_BILL)).toEqual([{ value: 'British Gas', source: 'page' }]);
  });

  it('an NHS letter is from the surgery at the top, not the doctor who signed it', () => {
    expect(suggest(NHS_LETTER)).toEqual([{ value: 'Riverside Surgery', source: 'page' }]);
  });

  it('an HMRC letter is from HM Revenue & Customs', () => {
    expect(suggest(HMRC_LETTER)).toEqual([{ value: 'HM Revenue & Customs', source: 'page' }]);
  });

  it('an insurance schedule is from Aviva, not from "Home Insurance"', () => {
    expect(suggest(AVIVA_SCHEDULE)).toEqual([{ value: 'Aviva', source: 'page' }]);
  });

  it('without a web address to agree, the registered name is offered whole', () => {
    const text = page(
      'Aviva Insurance Limited',
      'Home Insurance Policy Schedule',
      'Policyholder: Mrs Aisha Khan',
      'Aviva Insurance Limited. Registered in Scotland No. 2116.',
    );
    expect(suggest(text)).toEqual([{ value: 'Aviva Insurance', source: 'page' }]);
  });

  it('a US bank statement is from JPMorgan Chase Bank, or Chase', () => {
    expect(suggest(CHASE_STATEMENT, [], undefined, CARTERS)).toEqual([
      { value: 'JPMorgan Chase Bank', source: 'page' },
      { value: 'Chase', source: 'page' },
    ]);
  });

  it('a letter with nothing organisation-like suggests nothing', () => {
    expect(suggest(PERSONAL_LETTER)).toEqual([]);
    expect(suggest('')).toEqual([]);
    expect(suggest('\n\n   \n')).toEqual([]);
  });

  it('a line that merely looks important is not enough on its own', () => {
    // A name with no kind of body, and a kind of body with no name.
    expect(suggest(page('Barclays', 'Statement of account'))).toEqual([]);
    expect(suggest(page('Home Insurance', 'Car Insurance', 'Building Society'))).toEqual([]);
    // A heading or a sentence, however capitalised.
    expect(suggest(page('Energy Performance Certificate', 'Your Energy Account'))).toEqual([]);
  });

  it('ties are broken in reading order', () => {
    const footer = 'Lloyds Bank plc and Bank of Scotland plc are authorised by the PRA.';
    expect(suggest(page('Mortgage offer', footer, footer))).toEqual([
      { value: 'Lloyds Bank', source: 'page' },
      { value: 'Bank of Scotland', source: 'page' },
    ]);
  });

  it('a registered name ends at the legal form before it, even without a full stop', () => {
    // OCR sometimes runs two footers into one line.
    const merged = 'Barclays Bank UK PLC Barclays Bank UK PLC Registered in England';
    expect(suggest(page('Notice of variation', merged))).toEqual([
      { value: 'Barclays Bank UK', source: 'page' },
    ]);
    // …and a line made of little else is still read in good time.
    expect(suggest('Abc Ltd '.repeat(8000))).toEqual([{ value: 'Abc', source: 'page' }]);
  });

  it('a line of nothing but brackets costs no more than reading it', () => {
    // OCR of a very wide page can return one line thousands of characters
    // long, and suggestions are worked out inside a request.
    expect(suggest(`${'('.repeat(60_000)}a`)).toEqual([]);
    expect(suggest(`a${')'.repeat(60_000)}`)).toEqual([]);
    expect(suggest(`${'( '.repeat(30_000)}a`)).toEqual([]);
    expect(suggest(`Barclays Bank UK PLC ${'('.repeat(60_000)}`)).toEqual([
      { value: 'Barclays Bank UK', source: 'page' },
    ]);
  });

  it('only the first 60,000 characters are read', () => {
    const filler = 'lorem ipsum dolor sit amet\n'.repeat(2400); // 64,800 characters
    const known = [{ value: 'Barclays', count: 1 }];
    expect(suggest(`${filler}\nBarclays Bank UK PLC`, known)).toEqual([]);
    expect(suggest(`Barclays Bank UK PLC\n${filler}`, known)).toEqual([
      { value: 'Barclays', source: 'known' },
    ]);
  });
});

describe('issuerCandidates: the household', () => {
  it('a member of the household is never suggested, however official they look', () => {
    const text = page(
      'AISHA KHAN',
      'Khan Consulting Ltd',
      '14 Elm Grove, Leeds LS6 2AB',
      '',
      'Invoice 2026-014',
      'Khan Consulting Ltd. Registered in England No. 1234567.',
      'Khan Consulting Ltd. Registered in England No. 1234567.',
      'www.khanconsulting.co.uk',
    );
    expect(suggest(text)).toEqual([]);
    // Not even when someone once typed a name into the issuer field.
    expect(suggest(text, [{ value: 'Aisha Khan', count: 1 }])).toEqual([]);
  });

  it('the addressee block never becomes an issuer', () => {
    const text = page('Mr Daniel Carter', 'Carter Household', '1234 Maple Avenue', 'Springfield');
    expect(suggest(text, [], undefined, CARTERS)).toEqual([]);
    // Someone with a title is a person, even one whose name sounds like a bank.
    expect(suggest(page('Mrs Eleanor Bank', 'Flat 2, Rosebank Court'))).toEqual([]);
  });

  it('nor does a named house, or a street without a number', () => {
    // Addressed to someone outside the household, as letters to a child's
    // other parent or a lodger are.
    expect(
      suggest(page('Mr J Smith', 'The Old School House', 'College Road', 'Oxford OX1 2AB')),
    ).toEqual([]);
    expect(suggest(page('Mrs A Khan', 'Water Lane', 'Leeds LS1 1AA'))).toEqual([]);
    expect(suggest(page('Mr M Khan', 'The Old Post Office', 'Main Street'))).toEqual([]);
    expect(suggest(page('Mr M Khan', 'University Road', 'Leicester LE1 7RH'))).toEqual([]);
    // No title to start the block: the street still reads as a street.
    expect(suggest(page('J Smith', 'Rose Cottage', 'School Lane', 'Oxford'))).toEqual([]);
  });

  it('a letterhead after the addressee block is still read', () => {
    const text = page(
      'Mrs Aisha Khan',
      'The Old School House',
      'Leeds LS6 2AB',
      'Riverside Surgery',
      'www.riversidesurgery.nhs.uk',
    );
    expect(suggest(text)).toEqual([{ value: 'Riverside Surgery', source: 'page' }]);
  });

  it('a known issuer is offered in the household’s spelling, not the page’s', () => {
    const text = page(
      'AVIVA INSURANCE LIMITED',
      'Motor Insurance Certificate',
      'AVIVA INSURANCE LIMITED. Registered in Scotland No. 2116.',
    );
    expect(suggest(text)).toEqual([{ value: 'Aviva Insurance', source: 'page' }]);
    expect(suggest(text, [{ value: 'aviva', count: 2 }])).toEqual([
      { value: 'aviva', source: 'known' },
    ]);
  });

  it('a known issuer spelt longer than the page still claims the page’s name', () => {
    const text = page('HMRC', 'Self Assessment', 'Mr Omar Khan');
    expect(suggest(text, [{ value: 'HMRC Self Assessment', count: 1 }])).toEqual([
      { value: 'HMRC Self Assessment', source: 'known' },
    ]);
  });

  it('a known issuer that is also an ordinary word needs to be named, not just said', () => {
    const known = [{ value: 'Next', count: 3 }];
    const text = page('Dear Aisha,', 'Your next payment will be taken on the first of the month.');
    expect(suggest(text, known)).toEqual([]);
    expect(suggest(page('Thank you for shopping at Next.'), known)).toEqual([
      { value: 'Next', source: 'known' },
    ]);
  });

  it('nor is a one-word issuer named by starting a sentence', () => {
    const known = [
      { value: 'Three', count: 3 },
      { value: 'Next', count: 2 },
    ];
    const bill = page('British Gas', 'Three things you need to know', 'www.britishgas.co.uk');
    expect(suggest(bill, known)).toEqual([{ value: 'British Gas', source: 'page' }]);
    const statement = page(
      'Next steps',
      'Next payment due on the 1st. Three reminders will be sent.',
      'Visit barclays.co.uk',
      'Barclays Bank UK PLC. Registered in England.',
    );
    expect(suggest(statement, known)).toEqual([{ value: 'Barclays', source: 'page' }]);
    expect(suggest(page('NEXT STEPS', 'Pay by the 1st.'), known)).toEqual([]);
    // Alone on its line, it is a letterhead.
    expect(suggest(page('NEXT', 'Order 4471'), known)).toEqual([
      { value: 'Next', source: 'known' },
    ]);
    expect(suggest(page('Your bill', 'Three Ltd.', 'Order 4471'), known)).toEqual([
      { value: 'Three', source: 'known' },
    ]);
  });

  it('what the household has filed this kind of document under comes first', () => {
    const known = [
      { value: 'Barclays', count: 1, typeKeys: ['bank_statement'] },
      { value: 'Aviva', count: 6, typeKeys: ['home_insurance'] },
    ];
    const text = page(
      'Thank you for your letter about Aviva.',
      'We have passed it to Barclays, who hold the mortgage.',
    );
    expect(suggest(text, known, 'bank_statement').map((c) => c.value)).toEqual([
      'Barclays',
      'Aviva',
    ]);
    expect(suggest(text, known, 'home_insurance').map((c) => c.value)).toEqual([
      'Aviva',
      'Barclays',
    ]);
    // With nothing to go on, the one used most.
    expect(suggest(text, known).map((c) => c.value)).toEqual(['Aviva', 'Barclays']);
  });

  it('each issuer is suggested once, however many ways the page writes it', () => {
    const text = page(
      'BARCLAYS BANK UK PLC',
      'Mortgage Services',
      'Barclays Bank UK PLC. Registered in England.',
      'Barclays Bank UK PLC. Registered in England.',
    );
    expect(suggest(text)).toEqual([{ value: 'Barclays Bank UK', source: 'page' }]);
    // Two spellings of one known issuer are one suggestion, in the more used spelling.
    const known = [
      { value: 'BARCLAYS BANK UK', count: 1 },
      { value: 'Barclays Bank UK', count: 5 },
    ];
    expect(suggest(text, known)).toEqual([{ value: 'Barclays Bank UK', source: 'known' }]);
  });

  it('suggests three at most', () => {
    const known = ['Barclays', 'Aviva', 'British Gas', 'Thames Water', 'Anytown Council'].map(
      (value, i) => ({ value, count: 10 - i }),
    );
    const text = page(
      'Household paperwork index',
      'Barclays, Aviva, British Gas, Thames Water and Anytown Council',
    );
    expect(suggest(text, known)).toEqual([
      { value: 'Barclays', source: 'known' },
      { value: 'Aviva', source: 'known' },
      { value: 'British Gas', source: 'known' },
    ]);
  });

  it('is deterministic', () => {
    const known = [{ value: 'Barclays', count: 4 }];
    expect(suggest(BARCLAYS_STATEMENT, known)).toEqual(suggest(BARCLAYS_STATEMENT, known));
  });
});

describe('issuerFromFilename', () => {
  const known: KnownIssuer[] = [
    { value: 'Barclays', count: 4 },
    { value: 'British Gas', count: 9 },
    { value: 'HMRC', count: 2 },
    { value: 'O2', count: 1 },
    { value: 'Aviva', count: 6 },
  ];

  it('recognises a known issuer in the name', () => {
    expect(issuerFromFilename('barclays_estatement_2026-09.pdf', known)).toEqual([
      { value: 'Barclays', source: 'file' },
    ]);
    expect(issuerFromFilename('BritishGasBill.pdf', known)).toEqual([
      { value: 'British Gas', source: 'file' },
    ]);
    expect(issuerFromFilename('british-gas-bill-sept.PDF', known)).toEqual([
      { value: 'British Gas', source: 'file' },
    ]);
    expect(issuerFromFilename('C:\\Scans\\hmrc-tax-code.pdf', known)).toEqual([
      { value: 'HMRC', source: 'file' },
    ]);
    expect(issuerFromFilename('o2-bill.jpg', known)).toEqual([{ value: 'O2', source: 'file' }]);
  });

  it('never invents an issuer', () => {
    expect(issuerFromFilename('barclays_estatement_2026-09.pdf', [])).toEqual([]);
    expect(issuerFromFilename('scan_0001.jpg', known)).toEqual([]);
    expect(issuerFromFilename('IMG_20260914_101500.heic', known)).toEqual([]);
  });

  it('needs every word of the issuer', () => {
    expect(issuerFromFilename('gas-bill.pdf', known)).toEqual([]);
    expect(
      issuerFromFilename('barclays.pdf', [{ value: 'Barclays Bank UK PLC', count: 1 }]),
    ).toEqual([]);
    // The legal form is not a word anyone puts in a file name.
    expect(
      issuerFromFilename('aviva_insurance.pdf', [{ value: 'Aviva Insurance Ltd', count: 1 }]),
    ).toEqual([{ value: 'Aviva Insurance Ltd', source: 'file' }]);
  });

  it('most used first, three at most', () => {
    expect(
      issuerFromFilename('aviva barclays british gas hmrc.pdf', known).map((c) => c.value),
    ).toEqual(['British Gas', 'Aviva', 'Barclays']);
  });
});

describe('rankKnownIssuers', () => {
  const known: KnownIssuer[] = [
    { value: 'Aviva', count: 1, typeKeys: ['home_insurance'] },
    { value: 'Barclays', count: 9, typeKeys: ['bank_statement'] },
    { value: 'Direct Line', count: 3, typeKeys: ['home_insurance', 'car_insurance'] },
    { value: 'British Gas', count: 3 },
    { value: 'anytown council', count: 3 },
  ];

  it('those used with this kind of document first, then the rest; most used first', () => {
    expect(rankKnownIssuers(known, 'home_insurance').map((k) => k.value)).toEqual([
      'Direct Line',
      'Aviva',
      'Barclays',
      'anytown council',
      'British Gas',
    ]);
  });

  it('without a kind, by use and then alphabetically, whatever the case', () => {
    expect(rankKnownIssuers(known).map((k) => k.value)).toEqual([
      'Barclays',
      'anytown council',
      'British Gas',
      'Direct Line',
      'Aviva',
    ]);
    expect(rankKnownIssuers(known, null)).toEqual(rankKnownIssuers(known));
  });

  it('is stable, and leaves the list it was given alone', () => {
    const twins: KnownIssuer[] = [
      { value: 'Aviva', count: 2, typeKeys: ['a'] },
      { value: 'Aviva', count: 2, typeKeys: ['b'] },
    ];
    expect(rankKnownIssuers(twins)).toEqual(twins);
    const before = known.map((k) => k.value);
    rankKnownIssuers(known, 'bank_statement');
    expect(known.map((k) => k.value)).toEqual(before);
  });
});
