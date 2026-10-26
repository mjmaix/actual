import type { TransactionEntity } from '@actual-app/core/types/models';

import type { BDOSoaTransaction } from './bdoParser';

export type MatchTier = 'high' | 'review' | 'new' | 'unmatched';

export type ReconciliationMatch = {
  statement: BDOSoaTransaction;
  ledger: TransactionEntity;
  tier: 'high' | 'review';
  confidence: number;
  dateDiffDays: number;
  amountDiffCents: number;
};

export type ReconciliationResult = {
  matches: ReconciliationMatch[];
  newEntries: BDOSoaTransaction[];
  unmatchedLedger: TransactionEntity[];
};

export type PayeeNameLookup = (
  payeeId: string | null | undefined,
) => string | undefined;

const EXACT_DATE_WINDOW_SALE_DAYS = 3;
const EXACT_DATE_WINDOW_POST_DAYS = 4;
const DATE_DRIFT_DAYS = 14;
const FEE_DELTA_RATIO = 0.05;
const FEE_DELTA_MIN_CENTS = 500;
const PAYEE_MATCH_THRESHOLD = 0.7;

function toUtcDay(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcDay(to) - toUtcDay(from)) / 86_400_000);
}

function normalizePayeeTokens(value: string): string[] {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

function trigramSet(value: string): Set<string> {
  const padded = `  ${value.toUpperCase()}  `;
  const grams = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) {
    grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

export function payeeSimilarity(a: string, b: string): number {
  if (!a || !b) {
    return 0;
  }

  const tokensA = new Set(normalizePayeeTokens(a));
  const tokensB = new Set(normalizePayeeTokens(b));
  const intersectionSize = [...tokensA].filter(token =>
    tokensB.has(token),
  ).length;
  const minSize = Math.min(tokensA.size, tokensB.size);
  const tokenOverlap =
    intersectionSize === 0 || minSize === 0 ? 0 : intersectionSize / minSize;

  const gramsA = trigramSet(a);
  const gramsB = trigramSet(b);
  const gramUnion = new Set([...gramsA, ...gramsB]).size;
  const gramIntersection = [...gramsA].filter(gram => gramsB.has(gram)).length;
  const trigram = gramUnion === 0 ? 0 : gramIntersection / gramUnion;

  return Math.max(tokenOverlap, trigram);
}

function bestTextSimilarity(
  statement: BDOSoaTransaction,
  ledger: TransactionEntity,
  ledgerPayeeName: string,
): number {
  const candidates = [
    payeeSimilarity(statement.cleanPayee, ledgerPayeeName),
    payeeSimilarity(statement.cleanPayee, ledger.imported_payee ?? ''),
    payeeSimilarity(statement.rawDescription, ledger.imported_payee ?? ''),
    payeeSimilarity(statement.rawDescription, ledger.notes ?? ''),
  ];
  return Math.max(0, ...candidates);
}

function dateInfo(statement: BDOSoaTransaction, ledgerDate: string) {
  const saleDiff = Math.abs(daysBetween(statement.saleDate, ledgerDate));
  const postDiff = Math.abs(daysBetween(statement.postDate, ledgerDate));
  const inWindow =
    saleDiff <= EXACT_DATE_WINDOW_SALE_DAYS ||
    postDiff <= EXACT_DATE_WINDOW_POST_DAYS;
  const drift = !inWindow && Math.min(saleDiff, postDiff) <= DATE_DRIFT_DAYS;
  return { bestDiff: Math.min(saleDiff, postDiff), inWindow, drift };
}

function amountInfo(statementAmount: number, ledgerAmount: number) {
  const diff = statementAmount - ledgerAmount;
  const absDiff = Math.abs(diff);
  const absStatement = Math.abs(statementAmount);
  const exact = diff === 0;
  const feeDelta =
    !exact &&
    absDiff <=
      Math.max(FEE_DELTA_MIN_CENTS, Math.ceil(absStatement * FEE_DELTA_RATIO));
  return { diff, exact, feeDelta };
}

function scoreCandidate(
  statement: BDOSoaTransaction,
  ledger: TransactionEntity,
  ledgerPayeeName: string,
) {
  const amount = amountInfo(statement.amount, ledger.amount);
  if (!amount.exact && !amount.feeDelta) {
    return null;
  }

  const date = dateInfo(statement, ledger.date);
  if (!date.inWindow && !date.drift) {
    return null;
  }

  const similarity = bestTextSimilarity(statement, ledger, ledgerPayeeName);
  const payeeMatched = similarity >= PAYEE_MATCH_THRESHOLD;

  let confidence: number;
  if (amount.exact && date.inWindow && payeeMatched) {
    confidence = 95;
    if (similarity >= 0.9) {
      confidence += 3;
    }
    if (date.bestDiff === 0) {
      confidence += 2;
    }
  } else if (amount.exact && date.inWindow) {
    confidence = 85;
    if (date.bestDiff === 0) {
      confidence += 3;
    }
    if (similarity >= 0.5) {
      confidence += 2;
    }
  } else if (amount.exact) {
    confidence = 70 + Math.round(similarity * 10);
  } else {
    confidence = 50 + Math.round(similarity * 10);
    if (Math.abs(amount.diff) <= 100) {
      confidence += 5;
    }
    if (!date.inWindow) {
      confidence -= 5;
    }
  }

  confidence = Math.max(1, Math.min(100, confidence));

  return {
    confidence,
    dateDiffDays: daysBetween(ledger.date, statement.postDate),
    amountDiffCents: amount.diff,
    similarity,
  };
}

export function scoreMatch(
  statement: BDOSoaTransaction,
  ledger: TransactionEntity,
  ledgerPayeeName: string,
): { confidence: number; dateDiffDays: number; amountDiffCents: number } {
  const amount = amountInfo(statement.amount, ledger.amount);
  const date = dateInfo(statement, ledger.date);
  const similarity = bestTextSimilarity(statement, ledger, ledgerPayeeName);

  let confidence = 0;
  if (amount.exact) {
    confidence += 45;
  } else if (amount.feeDelta) {
    confidence += 20;
  }
  if (date.inWindow) {
    confidence += 30;
  } else if (date.drift) {
    confidence += 15;
  }
  confidence += Math.round(similarity * 25);

  return {
    confidence: Math.max(0, Math.min(100, confidence)),
    dateDiffDays: daysBetween(ledger.date, statement.postDate),
    amountDiffCents: amount.diff,
  };
}

export function rankLedgerCandidates(
  statement: BDOSoaTransaction,
  ledgerTransactions: TransactionEntity[],
  getPayeeName: PayeeNameLookup,
): Array<{ ledger: TransactionEntity; confidence: number }> {
  return ledgerTransactions
    .filter(ledger => !ledger.is_child)
    .map(ledger => ({
      ledger,
      confidence: scoreMatch(
        statement,
        ledger,
        getPayeeName(ledger.payee) ?? '',
      ).confidence,
    }))
    .sort((a, b) => b.confidence - a.confidence);
}

export function rankStatementCandidates<T extends BDOSoaTransaction>(
  ledger: TransactionEntity,
  statementTransactions: T[],
  ledgerPayeeName: string,
): Array<{ statement: T; confidence: number }> {
  return statementTransactions
    .map(statement => ({
      statement,
      confidence: scoreMatch(statement, ledger, ledgerPayeeName).confidence,
    }))
    .sort((a, b) => b.confidence - a.confidence);
}

export function reconcileStatementTransactions({
  statementTransactions,
  ledgerTransactions,
  getPayeeName,
}: {
  statementTransactions: BDOSoaTransaction[];
  ledgerTransactions: TransactionEntity[];
  getPayeeName: PayeeNameLookup;
}): ReconciliationResult {
  const matches: ReconciliationMatch[] = [];
  const newEntries: BDOSoaTransaction[] = [];
  const usedLedgerIds = new Set<string>();

  for (const statement of statementTransactions) {
    let best: {
      ledger: TransactionEntity;
      score: NonNullable<ReturnType<typeof scoreCandidate>>;
    } | null = null;

    for (const ledger of ledgerTransactions) {
      if (usedLedgerIds.has(ledger.id) || ledger.is_child) {
        continue;
      }
      const ledgerPayeeName = getPayeeName(ledger.payee) ?? '';
      const score = scoreCandidate(statement, ledger, ledgerPayeeName);
      if (!score) {
        continue;
      }
      if (
        !best ||
        score.confidence > best.score.confidence ||
        (score.confidence === best.score.confidence &&
          Math.abs(score.dateDiffDays) < Math.abs(best.score.dateDiffDays))
      ) {
        best = { ledger, score };
      }
    }

    if (best) {
      usedLedgerIds.add(best.ledger.id);
      matches.push({
        statement,
        ledger: best.ledger,
        tier: best.score.confidence >= 85 ? 'high' : 'review',
        confidence: best.score.confidence,
        dateDiffDays: best.score.dateDiffDays,
        amountDiffCents: best.score.amountDiffCents,
      });
    } else {
      newEntries.push(statement);
    }
  }

  const unmatchedLedger = ledgerTransactions.filter(
    ledger => !usedLedgerIds.has(ledger.id) && !ledger.is_child,
  );

  return { matches, newEntries, unmatchedLedger };
}
