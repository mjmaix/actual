import React from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import type { PayeeEntity } from '@actual-app/core/types/models';
import { format as formatDate } from 'date-fns';

import { FinancialText } from '#components/FinancialText';
import { Checkbox } from '#components/forms';
import { useDateFormat } from '#hooks/useDateFormat';
import { useFormat } from '#hooks/useFormat';
import { useLocale } from '#hooks/useLocale';
import type { ReconciliationMatch } from '#util/reconciliation/matcher';

export type MatchRow = ReconciliationMatch & {
  key: string;
  source: 'auto' | 'manual';
};

type ReconciliationTableProps = {
  matches: MatchRow[];
  selectedKeys: Set<string>;
  onToggle: (key: string) => void;
  onToggleAll: (keys: string[], checked: boolean) => void;
  payeeNamesById: Map<PayeeEntity['id'], string>;
  onFocus: (key: string) => void;
  onUnmatch: (key: string) => void;
};

function confidenceColor(confidence: number) {
  if (confidence >= 85) {
    return theme.noticeText;
  }
  if (confidence >= 50) {
    return theme.warningText;
  }
  return theme.errorText;
}

function tierLabel(confidence: number) {
  if (confidence >= 85) {
    return 'High';
  }
  if (confidence >= 50) {
    return 'Med';
  }
  return 'Low';
}

export function ReconciliationTable({
  matches,
  selectedKeys,
  onToggle,
  onToggleAll,
  payeeNamesById,
  onFocus,
  onUnmatch,
}: ReconciliationTableProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const dateFormat = useDateFormat() || 'MM/dd/yyyy';
  const locale = useLocale();

  if (matches.length === 0) {
    return (
      <View style={{ padding: 20, alignItems: 'center' }}>
        <Text style={{ color: theme.pageTextSubdued }}>
          <Trans>No matches for this section.</Trans>
        </Text>
      </View>
    );
  }

  const allSelected = matches.every(match => selectedKeys.has(match.key));

  return (
    <View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          padding: '6px 10px',
          backgroundColor: theme.tableHeaderBackground,
          color: theme.tableHeaderText,
          borderTopWidth: 1,
          borderBottomWidth: 1,
          borderColor: theme.tableBorder,
          ...styles.smallText,
          fontWeight: 600,
        }}
      >
        <View style={{ width: 30 }}>
          <Checkbox
            checked={allSelected}
            onChange={() =>
              onToggleAll(
                matches.map(m => m.key),
                !allSelected,
              )
            }
            aria-label={t('Select all rows')}
          />
        </View>
        <View style={{ width: 90 }}>
          <Trans>Confidence</Trans>
        </View>
        <View style={{ flex: 1 }}>
          <Trans>Statement entry</Trans>
        </View>
        <View style={{ flex: 1 }}>
          <Trans>Matched ledger entry</Trans>
        </View>
        <View style={{ width: 80, textAlign: 'right' }}>
          <Trans>Date diff</Trans>
        </View>
        <View style={{ width: 170 }}>
          <Trans>Adjust</Trans>
        </View>
      </View>

      {matches.map(match => {
        const isSelected = selectedKeys.has(match.key);
        const ledgerPayee = match.ledger.payee
          ? (payeeNamesById.get(match.ledger.payee) ?? '')
          : '';
        const amountDiff =
          match.amountDiffCents !== 0
            ? Math.abs(match.amountDiffCents) / 100
            : null;

        return (
          <View
            key={match.key}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              padding: '6px 10px',
              borderBottomWidth: 1,
              borderColor: theme.tableBorder,
              backgroundColor: isSelected
                ? theme.tableRowBackgroundHover
                : undefined,
              ...styles.smallText,
            }}
          >
            <View style={{ width: 30 }}>
              <Checkbox
                checked={isSelected}
                onChange={() => onToggle(match.key)}
                aria-label={t('Select row')}
              />
            </View>
            <View style={{ width: 90 }}>
              <Text
                style={{
                  color: confidenceColor(match.confidence),
                  fontWeight: 600,
                }}
              >
                {match.confidence}% {tierLabel(match.confidence)}
              </Text>
              {match.source === 'manual' && (
                <Text style={{ color: theme.pageTextSubdued }}>
                  <Trans>Manual</Trans>
                </Text>
              )}
            </View>
            <View style={{ flex: 1, flexDirection: 'column', gap: 2 }}>
              <Text>
                {formatDate(
                  new Date(match.statement.saleDate + 'T00:00:00'),
                  dateFormat,
                  { locale },
                )}{' '}
                {match.statement.cleanPayee}
              </Text>
              <FinancialText style={{ color: theme.pageTextSubdued }}>
                {format(match.statement.amount, 'financial')}
              </FinancialText>
            </View>
            <View style={{ flex: 1, flexDirection: 'column', gap: 2 }}>
              <Text>
                {formatDate(
                  new Date(match.ledger.date + 'T00:00:00'),
                  dateFormat,
                  { locale },
                )}{' '}
                {ledgerPayee}
              </Text>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                <FinancialText style={{ color: theme.pageTextSubdued }}>
                  {format(match.ledger.amount, 'financial')}
                </FinancialText>
                {amountDiff != null && (
                  <Text style={{ color: theme.warningText }}>
                    {t('Diff: {{ diff }}', { diff: amountDiff.toFixed(2) })}
                  </Text>
                )}
              </View>
            </View>
            <View style={{ width: 80, alignItems: 'flex-end' }}>
              <Text
                style={{
                  color:
                    match.dateDiffDays === 0
                      ? theme.pageTextSubdued
                      : theme.warningText,
                }}
              >
                {match.dateDiffDays > 0 ? '+' : ''}
                {match.dateDiffDays} {t('days')}
              </Text>
              {amountDiff != null && (
                <Text style={{ color: theme.warningText }}>
                  <Trans>Note: fee/FX?</Trans>
                </Text>
              )}
            </View>
            <View
              style={{
                width: 170,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Button
                variant="bare"
                style={{ padding: '2px 6px' }}
                onPress={() => onFocus(match.key)}
              >
                <Trans>Change</Trans>
              </Button>
              <Button
                variant="bare"
                style={{ padding: '2px 6px', color: theme.errorText }}
                onPress={() => onUnmatch(match.key)}
              >
                <Trans>Unmatch</Trans>
              </Button>
            </View>
          </View>
        );
      })}
    </View>
  );
}
