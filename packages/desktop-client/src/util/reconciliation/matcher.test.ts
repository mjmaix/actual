import type { TransactionEntity } from '@actual-app/core/types/models';

import type { BDOSoaTransaction } from './bdoParser';
import {
  payeeSimilarity,
  reconcileStatementTransactions,
  scoreMatch,
} from './matcher';

function makeStatement(
  overrides: Partial<BDOSoaTransaction> = {},
): BDOSoaTransaction {
  return {
    saleDate: '2026-10-09',
    postDate: '2026-10-11',
    rawDescription: 'SHOPEE PH MANDALUYONG PH',
    cleanPayee: 'SHOPEE PH',
    amount: -227900,
    type: 'charge',
    cardNumberMasked: '****-****-****-5113',
    ...overrides,
  };
}

function makeLedger(
  overrides: Partial<TransactionEntity> = {},
): TransactionEntity {
  return {
    id: 'ledger-1',
    account: 'account-1',
    amount: -227900,
    date: '2026-10-11',
    payee: 'payee-1',
    cleared: false,
    ...overrides,
  } as TransactionEntity;
}

const payeeNames = new Map([
  ['payee-1', 'Shopee'],
  ['payee-2', 'Grab Food'],
  ['payee-3', 'Watsons'],
]);

const getPayeeName = (payeeId: string | null | undefined) =>
  payeeNames.get(payeeId ?? '');

describe('payeeSimilarity', () => {
  it('scores identical payees at 1', () => {
    expect(payeeSimilarity('SHOPEE PH', 'Shopee PH')).toBe(1);
  });

  it('scores a subset match above the high-confidence threshold', () => {
    expect(payeeSimilarity('SHOPEE PH', 'Shopee')).toBeGreaterThan(0.7);
  });

  it('scores unrelated payees low', () => {
    expect(payeeSimilarity('SHOPEE PH', 'Mercury Drug')).toBeLessThan(0.7);
  });
});

describe('reconcileStatementTransactions', () => {
  it('matches exact amount, date and payee as high confidence', () => {
    const result = reconcileStatementTransactions({
      statementTransactions: [makeStatement()],
      ledgerTransactions: [makeLedger()],
      getPayeeName,
    });

    expect(result.matches).toHaveLength(1);
    const match = result.matches[0];
    expect(match.tier).toBe('high');
    expect(match.confidence).toBeGreaterThanOrEqual(95);
    expect(match.dateDiffDays).toBe(0);
    expect(match.amountDiffCents).toBe(0);
    expect(result.newEntries).toHaveLength(0);
    expect(result.unmatchedLedger).toHaveLength(0);
  });

  it('matches exact amount and date without payee overlap at 85-90', () => {
    const result = reconcileStatementTransactions({
      statementTransactions: [makeStatement()],
      ledgerTransactions: [
        makeLedger({ payee: 'payee-unknown', id: 'ledger-2' }),
      ],
      getPayeeName: () => 'Unrelated Merchant',
    });

    const match = result.matches[0];
    expect(match.tier).toBe('high');
    expect(match.confidence).toBeGreaterThanOrEqual(85);
    expect(match.confidence).toBeLessThan(95);
  });

  it('treats exact amount with 5-14 day drift as review', () => {
    const result = reconcileStatementTransactions({
      statementTransactions: [makeStatement()],
      ledgerTransactions: [makeLedger({ date: '2026-09-28' })],
      getPayeeName,
    });

    const match = result.matches[0];
    expect(match.tier).toBe('review');
    expect(match.confidence).toBeGreaterThanOrEqual(70);
    expect(match.confidence).toBeLessThan(85);
    expect(Math.abs(match.dateDiffDays)).toBeGreaterThanOrEqual(5);
  });

  it('treats small fee variance as review with an amount difference', () => {
    const result = reconcileStatementTransactions({
      statementTransactions: [makeStatement({ amount: -1052500 })],
      ledgerTransactions: [makeLedger({ amount: -1000000 })],
      getPayeeName,
    });

    const match = result.matches[0];
    expect(match.tier).toBe('review');
    expect(match.confidence).toBeGreaterThanOrEqual(50);
    expect(match.confidence).toBeLessThan(85);
    expect(match.amountDiffCents).toBe(-52500);
  });

  it('rejects fee variance beyond the small-delta window', () => {
    const result = reconcileStatementTransactions({
      statementTransactions: [makeStatement({ amount: -1052500 })],
      ledgerTransactions: [makeLedger({ amount: -500000 })],
      getPayeeName,
    });

    expect(result.matches).toHaveLength(0);
    expect(result.newEntries).toHaveLength(1);
  });

  it('keeps polarity straight: statement charges match ledger debits only', () => {
    const result = reconcileStatementTransactions({
      statementTransactions: [makeStatement()],
      ledgerTransactions: [makeLedger({ amount: 227900 })],
      getPayeeName,
    });

    expect(result.matches).toHaveLength(0);
    expect(result.newEntries).toHaveLength(1);
  });

  it('matches statement payments against positive ledger amounts', () => {
    const result = reconcileStatementTransactions({
      statementTransactions: [
        makeStatement({
          amount: 5569179,
          type: 'payment',
          cleanPayee: 'PAYMENT RECEIVED',
          postDate: '2026-09-20',
        }),
      ],
      ledgerTransactions: [makeLedger({ amount: 5569179, date: '2026-09-19' })],
      getPayeeName,
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].tier).toBe('high');
  });

  it('stages unmatched statement items as new entries', () => {
    const result = reconcileStatementTransactions({
      statementTransactions: [makeStatement()],
      ledgerTransactions: [],
      getPayeeName,
    });

    expect(result.newEntries).toHaveLength(1);
    expect(result.matches).toHaveLength(0);
    expect(result.unmatchedLedger).toHaveLength(0);
  });

  it('reports unmatched ledger transactions and never double-matches', () => {
    const result = reconcileStatementTransactions({
      statementTransactions: [makeStatement()],
      ledgerTransactions: [
        makeLedger({ id: 'ledger-a' }),
        makeLedger({ id: 'ledger-b', date: '2026-10-12' }),
      ],
      getPayeeName,
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].ledger.id).toBe('ledger-a');
    expect(result.unmatchedLedger.map(t => t.id)).toEqual(['ledger-b']);
  });

  it('prefers zero-day and stronger payee matches when resolving ties', () => {
    const result = reconcileStatementTransactions({
      statementTransactions: [makeStatement()],
      ledgerTransactions: [
        makeLedger({ id: 'ledger-b', date: '2026-10-09' }),
        makeLedger({ id: 'ledger-a', date: '2026-10-11' }),
      ],
      getPayeeName,
    });

    expect(result.matches[0].ledger.id).toBe('ledger-a');
  });

  it('matches on imported_payee when the payee name was renamed', () => {
    const result = reconcileStatementTransactions({
      statementTransactions: [
        makeStatement({
          cleanPayee: 'SHOPEE PH',
          rawDescription: 'SHOPEE PH MANDALUYONG PH',
        }),
      ],
      ledgerTransactions: [
        makeLedger({
          payee: 'payee-renamed',
          imported_payee: 'SHOPEE PH MANDALUYONG PH',
        }),
      ],
      getPayeeName: id => (id === 'payee-renamed' ? 'Shopping' : undefined),
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].confidence).toBeGreaterThanOrEqual(95);
  });

  it('matches on ledger notes containing the statement description', () => {
    const result = reconcileStatementTransactions({
      statementTransactions: [
        makeStatement({ rawDescription: 'BAYAD CENTER MERALCO PASIG PH' }),
      ],
      ledgerTransactions: [
        makeLedger({
          payee: 'payee-renamed',
          notes: 'BAYAD CENTER MERALCO',
        }),
      ],
      getPayeeName: () => 'Utilities',
    });

    expect(result.matches).toHaveLength(1);
  });
});

describe('scoreMatch', () => {
  it('scores a manual exact match highly', () => {
    const score = scoreMatch(makeStatement(), makeLedger(), 'Shopee');
    expect(score.confidence).toBeGreaterThanOrEqual(90);
  });

  it('scores a forced manual match with mismatched amount at low confidence', () => {
    const score = scoreMatch(
      makeStatement({ amount: -227900 }),
      makeLedger({ amount: -99999, date: '2026-09-01' }),
      'Unrelated',
    );
    expect(score.confidence).toBeLessThan(50);
  });
});
