import React, { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import type {
  PayeeEntity,
  TransactionEntity,
} from '@actual-app/core/types/models';
import { format as formatDate } from 'date-fns';

import { FinancialText } from '#components/FinancialText';
import { useDateFormat } from '#hooks/useDateFormat';
import { useFormat } from '#hooks/useFormat';
import { useLocale } from '#hooks/useLocale';
import {
  rankLedgerCandidates,
  rankStatementCandidates,
} from '#util/reconciliation/matcher';

import type { NewEntryRow } from './NewTransactionsTable';

export type MatchFocus =
  | { kind: 'statement'; key: string; mode: 'new' | 'repoint' }
  | { kind: 'ledger'; id: string };

type MatchPanelProps = {
  focus: MatchFocus;
  statementItem: NewEntryRow | null;
  ledgerItem: TransactionEntity | null;
  ledgerCandidates: TransactionEntity[];
  statementCandidates: NewEntryRow[];
  payeeNamesById: Map<PayeeEntity['id'], string>;
  onPair: (statementKey: string, ledgerId: string) => void;
  onClose: () => void;
};

type CandidateRow = {
  id: string;
  date: string;
  payee: string;
  amount: number;
  confidence: number | null;
  statementKey: string;
  ledgerId: string;
};

function confidenceColor(confidence: number) {
  if (confidence >= 85) {
    return theme.noticeText;
  }
  if (confidence >= 50) {
    return theme.warningText;
  }
  return theme.pageTextSubdued;
}

export function MatchPanel({
  focus,
  statementItem,
  ledgerItem,
  ledgerCandidates,
  statementCandidates,
  payeeNamesById,
  onPair,
  onClose,
}: MatchPanelProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const dateFormat = useDateFormat() || 'MM/dd/yyyy';
  const locale = useLocale();
  const [search, setSearch] = useState('');

  function getPayeeName(payeeId: string | null | undefined): string {
    return payeeId ? (payeeNamesById.get(payeeId) ?? '') : '';
  }

  function fmtDate(value: string) {
    return formatDate(new Date(value + 'T00:00:00'), dateFormat, { locale });
  }

  let focusedDate = '';
  let focusedPayee = '';
  let focusedAmount = 0;
  let rows: CandidateRow[] = [];

  if (focus.kind === 'statement' && statementItem) {
    focusedDate = statementItem.saleDate;
    focusedPayee = statementItem.cleanPayee || statementItem.rawDescription;
    focusedAmount = statementItem.amount;
    rows = rankLedgerCandidates(
      statementItem,
      ledgerCandidates,
      getPayeeName,
    ).map(({ ledger, confidence }) => ({
      id: ledger.id,
      date: ledger.date,
      payee: getPayeeName(ledger.payee) || (ledger.imported_payee ?? ''),
      amount: ledger.amount,
      confidence,
      statementKey: statementItem.key,
      ledgerId: ledger.id,
    }));
  } else if (focus.kind === 'ledger' && ledgerItem) {
    focusedDate = ledgerItem.date;
    focusedPayee =
      getPayeeName(ledgerItem.payee) || (ledgerItem.imported_payee ?? '');
    focusedAmount = ledgerItem.amount;
    rows = rankStatementCandidates(
      ledgerItem,
      statementCandidates,
      getPayeeName(ledgerItem.payee),
    ).map(({ statement, confidence }) => ({
      id: statement.key,
      date: statement.saleDate,
      payee: statement.cleanPayee || statement.rawDescription,
      amount: statement.amount,
      confidence,
      statementKey: statement.key,
      ledgerId: ledgerItem.id,
    }));
  }

  const normalizedQuery = search.trim().toLowerCase().replace(/,/g, '');
  const filtered = normalizedQuery
    ? rows.filter(row => {
        const haystack =
          `${row.payee} ${row.date} ${(row.amount / 100).toFixed(2)}`.toLowerCase();
        return haystack.includes(normalizedQuery);
      })
    : rows;

  const targetLabel =
    focus.kind === 'statement'
      ? t('Pick the ledger transaction to match this statement entry with')
      : t('Pick the statement entry to match this ledger transaction with');

  return (
    <View
      style={{
        width: 360,
        flexShrink: 0,
        borderLeftWidth: 1,
        borderColor: theme.tableBorder,
        paddingLeft: 16,
        paddingBottom: 8,
        maxHeight: 520,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <Text style={{ fontWeight: 600 }}>
          <Trans>Match manually</Trans>
        </Text>
        <Button variant="bare" onPress={onClose}>
          <Trans>Close</Trans>
        </Button>
      </View>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '6px 0',
          marginBottom: 6,
          borderBottomWidth: 1,
          borderColor: theme.tableBorder,
        }}
      >
        <Text style={styles.smallText}>
          {fmtDate(focusedDate)} · {focusedPayee}
        </Text>
        <FinancialText style={styles.smallText}>
          {format(focusedAmount, 'financial')}
        </FinancialText>
      </View>

      <Text style={{ ...styles.smallText, color: theme.pageTextSubdued }}>
        {targetLabel}
      </Text>

      <Input
        value={search}
        onChangeValue={setSearch}
        placeholder={t('Search payee, amount or date')}
        style={{ marginTop: 8, marginBottom: 6 }}
      />

      <Text
        style={{
          ...styles.smallText,
          color: theme.pageTextSubdued,
          marginBottom: 4,
        }}
      >
        {filtered.length} {t('candidates')}
      </Text>

      <View style={{ overflow: 'auto', flex: 1, minHeight: 0 }}>
        {filtered.length === 0 ? (
          <View style={{ padding: 12, alignItems: 'center' }}>
            <Text style={{ ...styles.smallText, color: theme.pageTextSubdued }}>
              <Trans>No matching transactions.</Trans>
            </Text>
          </View>
        ) : (
          filtered.map(row => (
            <Button
              key={row.id}
              variant="bare"
              onPress={() => onPair(row.statementKey, row.ledgerId)}
              style={{
                flexDirection: 'column',
                alignItems: 'stretch',
                justifyContent: 'center',
                padding: '6px 8px',
                borderRadius: 0,
                borderBottomWidth: 1,
                borderColor: theme.tableBorder,
                textAlign: 'left',
              }}
            >
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <Text style={styles.smallText}>
                  {fmtDate(row.date)} · {row.payee || t('(no payee)')}
                </Text>
                <FinancialText style={styles.smallText}>
                  {format(row.amount, 'financial')}
                </FinancialText>
              </View>
              {row.confidence != null && row.confidence >= 50 && (
                <Text
                  style={{
                    ...styles.smallText,
                    color: confidenceColor(row.confidence),
                  }}
                >
                  {row.confidence}% {t('match')}
                </Text>
              )}
            </Button>
          ))
        )}
      </View>
    </View>
  );
}
