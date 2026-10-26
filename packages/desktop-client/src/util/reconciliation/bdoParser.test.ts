import {
  groupTextItemsIntoLines,
  parseAmountToCents,
  parseShortDate,
  parseStatementLines,
} from './bdoParser';

const STATEMENT_LINES = [
  'Credit Cards',
  'Statement of Account',
  'VISA GOLD (PHP)',
  'MR MICHAEL JAMES L ABADILLA',
  'Statement Date Oct 11, 2026',
  '447F MASILANG ST',
  'Card Number ****-****-****-5113',
  'PINEDA',
  '₱ Credit Limit 120,000',
  'PASIG CITY METRO MANILA',
  '₱ Cash Advance Limit 36,000',
  '1600 PHILIPPINES',
  '₱ Interest Rate per Month 3.00%',
  '₱ Minimum Amount Due 2,575.00',
  '₱ Total Amount Due 85,833.55',
  'Payment Due Date Nov 05, 2026',
  '*4183590388555113MLABADILLA*',
  'Your Account Summary',
  'Previous Balance Purchases and Advances (+) Finance Charge (+)',
  '₱ 55,691.79 ₱ 87,299.55 ₱ 0.00 ₱ 200.00 ₱ 0.00 ₱ 57,357.79 ₱ 85,833.55',
  'Sale Date Post Date Transaction Details Amount',
  'PREVIOUS STATEMENT BALANCE 55,691.79',
  'CARD NUMBER ****-****-****-5113',
  '10/11/26 10/11/26 BALANCE TRANSFER Z TM MANDALUYONG PH 1,583.94',
  'INSTALMENT 35 OF 36',
  '10/11/26 10/11/26 MONTHLY MEMBERSHIP FEE 200.00',
  '09/16/26 09/16/26 PIONEER CENTRE INC PASIG PH 1,893.05',
  '09/19/26 09/20/26 PAYMENT RECEIVED - THANK YOU -55,691.79',
  '09/27/26 09/27/26 SM STORE-MEGAMALL MANDALUYONG PH 1,978.00',
  '10/01/26 10/04/26 XDT*ANYTIME FITNESS PI https://xendi PH 2,252.50',
  'Reference: 7908193015646829303858',
  '10/09/26 10/11/26 WATSONS PIONEER CENTER PASIG PH 963.00',
  '10/10/26 10/11/26 S & R WAREHOUSE ONLINE PARANAQUE CIT PH 8,089.97',
  'SUBTOTAL 19,539.88',
  'CARD NUMBER ****-****-****-6130',
  '09/09/26 09/13/26 SHOPEE PH MANDALUYONG PH 1,582.00',
  '09/15/26 09/15/26 LAZADA PH TAGUIG PH -265.00',
  '09/15/26 09/16/26 SHOPEE PH MANDALUYONG PH -331.00',
  '09/16/26 09/17/26 APPLE.COM/BILL ITUNES.COM IE 69.69',
  'Reference: MKS0QY9LXWa0',
  '09/27/26 09/28/26 PIKAPODS.COM NAXXAR MT 640.42',
  '10.00 U.S.DOLLARS',
  '09/27/26 09/28/26 BAYAD CENTER MERALCO PASIG PH 10,555.58',
  'SUBTOTAL 66,293.67',
  'TOTAL 85,833.55',
  'BDO Unibank, Inc. is regulated by the Bangko Sentral ng Pilipinas',
  'Page 1 of 5',
];

describe('parseShortDate', () => {
  it('converts MM/DD/YY to ISO date with 20YY century', () => {
    expect(parseShortDate('09/09/26')).toBe('2026-09-09');
    expect(parseShortDate('12/31/99')).toBe('1999-12-31');
  });

  it('rejects invalid dates', () => {
    expect(parseShortDate('13/01/26')).toBeNull();
    expect(parseShortDate('not-a-date')).toBeNull();
  });
});

describe('parseAmountToCents', () => {
  it('parses comma-grouped amounts into integer cents', () => {
    expect(parseAmountToCents('1,582.00')).toBe(158200);
    expect(parseAmountToCents('-55,691.79')).toBe(-5569179);
    expect(parseAmountToCents('0.00')).toBe(0);
  });
});

describe('groupTextItemsIntoLines', () => {
  it('joins items on the same baseline and orders them left to right', () => {
    const lines = groupTextItemsIntoLines([
      { str: '1,582.00', x: 400, y: 227 },
      { str: 'SHOPEE PH MANDALUYONG PH', x: 200, y: 227 },
      { str: '09/09/26', x: 50, y: 227 },
      { str: '09/13/26', x: 120, y: 227 },
    ]);
    expect(lines.map(line => line.text)).toEqual([
      '09/09/26 09/13/26 SHOPEE PH MANDALUYONG PH 1,582.00',
    ]);
  });

  it('separates items on different baselines', () => {
    const lines = groupTextItemsIntoLines([
      { str: 'SUBTOTAL', x: 50, y: 266 },
      { str: '10.00 U.S.DOLLARS', x: 200, y: 227 },
    ]);
    expect(lines.map(line => line.text)).toHaveLength(2);
  });
});

describe('parseStatementLines', () => {
  const statement = parseStatementLines(STATEMENT_LINES);

  it('extracts statement metadata', () => {
    expect(statement.statementDate).toBe('2026-10-11');
    expect(statement.paymentDueDate).toBe('2026-11-05');
    expect(statement.totalAmountDue).toBe(8583355);
    expect(statement.previousBalance).toBe(5569179);
    expect(statement.periodStart).toBe('2026-09-09');
    expect(statement.periodEnd).toBe('2026-10-11');
  });

  it('extracts every transaction row', () => {
    expect(statement.transactions).toHaveLength(14);
  });

  it('converts charges to negative Actual amounts', () => {
    const charge = statement.transactions[0];
    expect(charge.rawDescription).toBe(
      'BALANCE TRANSFER Z TM MANDALUYONG PH INSTALMENT 35 OF 36',
    );
    expect(charge.cleanPayee).toBe('BALANCE TRANSFER Z');
    expect(charge.amount).toBe(-158394);
    expect(charge.type).toBe('charge');
    expect(charge.saleDate).toBe('2026-10-11');
    expect(charge.postDate).toBe('2026-10-11');
  });

  it('converts payments and refunds to positive Actual amounts', () => {
    const payment = statement.transactions.find(
      t => t.rawDescription === 'PAYMENT RECEIVED - THANK YOU',
    );
    expect(payment?.amount).toBe(5569179);
    expect(payment?.type).toBe('payment');

    const refund = statement.transactions.find(
      t => t.rawDescription === 'LAZADA PH TAGUIG PH',
    );
    expect(refund?.amount).toBe(26500);
    expect(refund?.type).toBe('payment');
  });

  it('appends continuation lines to the preceding transaction', () => {
    const balanceTransfer = statement.transactions[0];
    expect(balanceTransfer.rawDescription).toContain('INSTALMENT 35 OF 36');

    const pikapods = statement.transactions.find(t =>
      t.rawDescription.startsWith('PIKAPODS.COM'),
    );
    expect(pikapods?.rawDescription).toContain('10.00 U.S.DOLLARS');
  });

  it('tracks the active card section', () => {
    const primaryCard = statement.transactions[0];
    expect(primaryCard.cardNumberMasked).toBe('****-****-****-5113');

    const secondaryCard = statement.transactions.find(t =>
      t.rawDescription.startsWith('SHOPEE PH'),
    );
    expect(secondaryCard?.cardNumberMasked).toBe('****-****-****-6130');
  });

  it('never retains raw card numbers or cardholder PII', () => {
    const serialized = JSON.stringify(statement);
    expect(serialized).not.toContain('4183590388555113');
    expect(serialized).not.toContain('4183-5903-8855-5113');
    expect(serialized).not.toContain('ABADILLA');
    expect(serialized).not.toContain('MASILANG');
  });

  it('throws when no transaction rows exist', () => {
    expect(() => parseStatementLines(['Statement Date Oct 11, 2026'])).toThrow(
      /No transactions found/,
    );
  });

  it('parses a negative Total Amount Due (credit balance)', () => {
    const statement = parseStatementLines([
      'Statement Date Jul 12, 2026',
      '₱ Total Amount Due -14,392.44',
      '₱ Minimum Amount Due 0.00',
      'Payment Due Date Aug 06, 2026',
      'Sale Date Post Date Transaction Details Amount',
      'PREVIOUS STATEMENT BALANCE -5,000.00',
      'CARD NUMBER 4183-5903-8855-5113',
      '07/12/26 07/12/26 MONTHLY MEMBERSHIP FEE 200.00',
      'TOTAL -14,392.44',
    ]);
    expect(statement.totalAmountDue).toBe(-1439244);
    expect(statement.previousBalance).toBe(-500000);
    expect(statement.transactions).toHaveLength(1);
  });
});
