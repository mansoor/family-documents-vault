import type { ProposalFixture } from './proposal-fixtures.js';

/**
 * The kinds C1 adds (0.9.0, 0077), measured as 5.37's fixtures are: two
 * payslips and two investment statements, written for these tests, and the
 * C1 review's probe — an employment contract that says what the pay will
 * be, which must never be read as a payslip. Made up, every one.
 */

const lines = (...l: string[]) => l.join('\n');

export const C1_FIXTURES: ProposalFixture[] = [
  {
    name: 'uk-payslip-sara',
    text: lines(
      'Northwind Logistics Ltd',
      'PAYSLIP',
      'Employee: Sara Khan        Employee no. 40412',
      'Pay date: 30 September 2026        Pay period: September 2026',
      'Gross pay   3,250.00',
      'Income tax    412.60     National Insurance   218.40',
      'Total deductions   631.00',
      'Net pay   2,619.00',
    ),
    truth: {
      type_key: 'pay_statement',
      owner: 'm-sara',
      issued: '2026-09-30',
      expires: null,
      identifier: null,
      issued_by: 'Northwind Logistics',
    },
  },
  {
    name: 'us-earnings-statement-ahmed',
    text: lines(
      'EARNINGS STATEMENT',
      'Contoso Inc.',
      'Employee: Ahmed Khan',
      'Pay Date: 15 October 2026     Pay Period: 01 Oct 2026 - 15 Oct 2026',
      'Hours worked 80   Rate 41.25',
      'Gross Pay $3,300.00     FICA 252.45   Federal Withholding 390.00',
      'Net Pay $2,657.55       YTD 62,700.00',
    ),
    truth: {
      type_key: 'pay_statement',
      owner: 'm-ahmed',
      issued: '2026-10-15',
      expires: null,
      identifier: null,
      issued_by: 'Contoso',
    },
  },
  {
    name: 'uk-portfolio-statement-ahmed',
    text: lines(
      'Meridian Investments',
      'Portfolio statement',
      'Statement date: 30 September 2026',
      'Account holder: Ahmed Khan',
      'Holdings',
      'Global Index Fund   1,204.33 units   Market value 18,402.10',
      'Total portfolio value 24,880.00',
      'Dividends reinvested 112.40',
    ),
    truth: {
      type_key: 'investment_statement',
      owner: 'm-ahmed',
      issued: '2026-09-30',
      expires: null,
      identifier: null,
      issued_by: 'Meridian Investments',
    },
  },
  {
    name: 'us-401k-statement-sara',
    text: lines(
      'Harbor Retirement Services',
      '401(k) Statement',
      'Participant: Sara Khan',
      'Statement date: 30 June 2026',
      'Your holdings          Units held     Price per unit    Market value',
      'Target Date 2055 Fund   812.400       31.22             25,363.13',
      'Total account value 25,363.13',
    ),
    truth: {
      type_key: 'investment_statement',
      owner: 'm-sara',
      issued: '2026-06-30',
      expires: null,
      identifier: null,
      issued_by: 'Harbor Retirement Services',
    },
  },
  {
    // The C1 review's probe: pay, a pay date, deductions — and a contract.
    name: 'uk-employment-contract-pay-sara',
    text: lines(
      'Northwind Logistics Ltd',
      'Contract of Employment',
      'Employee: Sara Khan',
      'Start date: 1 March 2026',
      'Pay: your gross pay will be 39,000.00 a year, paid monthly on the pay date, the last working day of each month.',
      'Gross pay 3,250.00 a month. Net pay after deductions about 2,600.00.',
      'Deductions for income tax and National Insurance are made from your pay.',
      'Holiday entitlement: 25 days a year. Notice period: one month.',
      'These terms and conditions of employment replace any made before.',
    ),
    truth: {
      type_key: 'employment_contract',
      owner: 'm-sara',
      issued: '2026-03-01',
      expires: null,
      identifier: null,
      issued_by: 'Northwind Logistics',
    },
  },
];
