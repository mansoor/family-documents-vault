import { describe, expect, it } from 'vitest';
import { ITEM_SURE } from './batch-levels.js';
import { proposeDetails, type ProposalContext } from './proposals.js';
import { folderMatcher } from './folders.js';
import {
  FIXTURE_HOUSEHOLD,
  FIXTURE_ISSUERS,
  FIXTURE_KINDS,
  FIXTURE_PEOPLE,
} from './testdata/proposal-fixtures.js';

/**
 * The two kinds C1 adds (0.9.0, 0077): a payslip and an investment's
 * statement, read with the care S5 gave a card's statement — sure only with
 * marks of their own and none of another's, so that ambiguity is Check,
 * never a wrong Ready. Each on wording of its own, written for these tests.
 */

const ctx: ProposalContext = {
  types: FIXTURE_KINDS,
  people: FIXTURE_PEOPLE,
  issuers: FIXTURE_ISSUERS,
  household: FIXTURE_HOUSEHOLD,
  dateOrder: 'dmy',
};
const lines = (...l: string[]) => l.join('\n');
const sure = (c: number | undefined) => (c ?? 0) >= ITEM_SURE.type_key;

describe('pay statements (C1)', () => {
  const payslip = lines(
    'Northwind Logistics Ltd',
    'PAYSLIP',
    'Employee: Sara Khan        Employee no. 40412',
    'Pay date: 30 September 2026        Pay period: September 2026',
    'Gross pay   3,250.00',
    'Income tax    412.60     National Insurance   218.40',
    'Total deductions   631.00',
    'Net pay   2,619.00',
    'Year to date gross   9,750.00',
  );

  it('a payslip with its pay for a period is sure, dated by the day it pays', () => {
    const p = proposeDetails(payslip, ctx);
    expect(p.type_key?.value).toBe('pay_statement');
    expect(sure(p.type_key?.confidence)).toBe(true);
    expect(p.issued?.value).toEqual({ date: '2026-09-30', precision: 'day' });
    expect(p.owner_member_id?.value).toBe('m-sara');
  });

  it('a US pay stub, as an earnings statement', () => {
    const p = proposeDetails(
      lines(
        'EARNINGS STATEMENT',
        'Contoso Inc.      Pay Date 09/30/2026',
        'Ahmed Khan',
        'Earnings   Hours worked 80   Rate 41.25',
        'Gross Pay 3,300.00     FICA 252.45   Federal Withholding 390.00',
        'Net Pay 2,657.55       YTD 29,700.00',
      ),
      { ...ctx, dateOrder: 'mdy' },
    );
    expect(p.type_key?.value).toBe('pay_statement');
    expect(sure(p.type_key?.confidence)).toBe(true);
  });

  it('a payslip without its pay for a period is offered unsure', () => {
    const p = proposeDetails(
      lines(
        'Payslip',
        'Northwind Logistics Ltd',
        'Total deductions 631.00',
        'Year to date 9,750.00',
      ),
      ctx,
    );
    expect(p.type_key?.value).toBe('pay_statement');
    expect(sure(p.type_key?.confidence)).toBe(false);
  });

  it('its pay named without an amount is unsure; a contract that names its pay is no payslip (the C1 review)', () => {
    const words = proposeDetails(
      lines('Payslip', 'Northwind Logistics Ltd', 'Gross pay', 'Net pay', 'Pay period: September'),
      ctx,
    );
    expect(words.type_key?.value).toBe('pay_statement');
    expect(sure(words.type_key?.confidence)).toBe(false);
    const contract = proposeDetails(
      lines(
        'Payslip arrangements',
        'Your gross pay 3,250.00 a month; net pay about 2,600.00 on the pay date.',
        'Pay period: monthly. Deductions are made for tax.',
        'Notice period: one month. Holiday entitlement: 25 days.',
      ),
      ctx,
    );
    expect(contract.type_key?.value).not.toBe('pay_statement');
  });

  it('a year’s certificate of pay is a tax form, never a payslip', () => {
    const p60 = proposeDetails(
      lines(
        'P60 End of Year Certificate',
        'Tax year to 5 April 2026',
        'Employee: Sara Khan',
        'Pay and Income Tax details',
        'Pay in this employment 39,000.00',
        'Net pay after deductions 30,112.00',
        'Employer PAYE reference 123/AB45678',
      ),
      ctx,
    );
    expect(p60.type_key?.value).toBe('tax_form');
    // One that reads much like a payslip — its pay, its period, its year to
    // date — is still the year's certificate, never a payslip.
    const likePay = proposeDetails(
      lines(
        'P60 End of Year Certificate',
        'Employee: Sara Khan',
        'Pay and Income Tax details',
        'Pay period: tax year to 5 April 2026',
        'Gross pay 39,000.00    Net pay 30,112.00',
        'Year to date deductions 8,888.00',
        'Employer PAYE reference 123/AB45678',
      ),
      ctx,
    );
    expect(likePay.type_key?.value).toBe('tax_form');
    const w2 = proposeDetails(
      lines(
        'Form W-2 Wage and Tax Statement 2025',
        'Gross pay 64,000.00',
        'Federal income tax withheld 7,100.00',
      ),
      ctx,
    );
    expect(w2.type_key?.value).toBe('tax_form');
  });
});

describe('investment statements (C1)', () => {
  it('a brokerage statement with what it holds, and none of a bank account’s marks, is sure', () => {
    const p = proposeDetails(
      lines(
        'Meridian Investments',
        'Portfolio statement',
        'Statement date: 30 September 2026',
        'Account holder: Ahmed Khan',
        'Holdings',
        'Global Index Fund   1,204.33 units   Market value 18,402.10',
        'Total portfolio value 24,880.00',
        'Dividends reinvested 112.40',
      ),
      ctx,
    );
    expect(p.type_key?.value).toBe('investment_statement');
    expect(sure(p.type_key?.confidence)).toBe(true);
    expect(p.issued?.value).toEqual({ date: '2026-09-30', precision: 'day' });
  });

  it('one with a bank account’s marks too is offered unsure', () => {
    const p = proposeDetails(
      lines(
        'Meridian Investments',
        'Brokerage statement',
        'Holdings   Market value 18,402.10',
        'Cash: money in 500.00   money out 0.00',
        'Sort code 20-44-17',
      ),
      ctx,
    );
    expect(p.type_key?.value).toBe('investment_statement');
    expect(sure(p.type_key?.confidence)).toBe(false);
  });

  it('a bank statement with an investment’s marks on it is no longer sure', () => {
    const plain = lines(
      'Harbour Bank',
      'Current account statement',
      'Sort code 20-44-17   Account number 41178203',
      'Opening balance 1,200.00   Closing balance 1,410.00',
      'Money in 2,600.00   Money out 2,390.00',
    );
    const bank = proposeDetails(plain, ctx);
    expect(bank.type_key?.value).toBe('bank_statement');
    expect(sure(bank.type_key?.confidence)).toBe(true);
    const mixed = proposeDetails(lines(plain, 'Your holdings: market value 4,100.00'), ctx);
    expect(mixed.type_key?.value).toBe('bank_statement');
    expect(sure(mixed.type_key?.confidence)).toBe(false);
  });

  it('an ISA’s statement stays a bank statement (S5)', () => {
    const p = proposeDetails(
      lines('Cash ISA statement', 'Sort code 20-44-17', 'Opening balance 4,000.00', 'AER 4.10%'),
      ctx,
    );
    expect(p.type_key?.value).toBe('bank_statement');
  });
});

describe('folder words for the new kinds (C1)', () => {
  // The kinds as 0077 leaves them: the bank's called what it is.
  const types = FIXTURE_KINDS.map((k) =>
    k.key === 'bank_statement' ? { ...k, label: 'Bank statement' } : k,
  );
  const match = folderMatcher({ types, people: [] });
  it.each([
    ['Investments', 'investment_statement'],
    ['Bank/Investments', 'investment_statement'],
    ['Money/Brokerage', 'investment_statement'],
    ['Payslips', 'pay_statement'],
    ['Work/Pay stubs 2026', 'pay_statement'],
    ['Bank', 'bank_statement'],
    ['Bank/Savings', 'bank_statement'],
  ])('%s is %s', (folder, kind) => {
    expect(match(folder)?.type_key).toBe(kind);
  });
});
