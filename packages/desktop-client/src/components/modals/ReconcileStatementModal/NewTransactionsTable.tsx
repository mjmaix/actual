import React from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Select } from '@actual-app/components/select';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import type { CategoryEntity } from '@actual-app/core/types/models';
import { format as formatDate } from 'date-fns';

import { FinancialText } from '#components/FinancialText';
import { Checkbox } from '#components/forms';
import { useDateFormat } from '#hooks/useDateFormat';
import { useFormat } from '#hooks/useFormat';
import { useLocale } from '#hooks/useLocale';
import type { BDOSoaTransaction } from '#util/reconciliation/bdoParser';

export type NewEntryRow = BDOSoaTransaction & {
  key: string;
  categoryId: string;
};

type NewTransactionsTableProps = {
  entries: NewEntryRow[];
  selectedKeys: Set<string>;
  onToggle: (key: string) => void;
  onToggleAll: (keys: string[], checked: boolean) => void;
  onCategoryChange: (key: string, categoryId: string) => void;
  categories: CategoryEntity[];
  onFocus: (key: string) => void;
};

export function NewTransactionsTable({
  entries,
  selectedKeys,
  onToggle,
  onToggleAll,
  onCategoryChange,
  categories,
  onFocus,
}: NewTransactionsTableProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const dateFormat = useDateFormat() || 'MM/dd/yyyy';
  const locale = useLocale();

  if (entries.length === 0) {
    return (
      <View style={{ padding: 20, alignItems: 'center' }}>
        <Text style={{ color: theme.pageTextSubdued }}>
          <Trans>No new entries for this section.</Trans>
        </Text>
      </View>
    );
  }

  const allSelected = entries.every(entry => selectedKeys.has(entry.key));

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
                entries.map(e => e.key),
                !allSelected,
              )
            }
            aria-label={t('Select all rows')}
          />
        </View>
        <View style={{ width: 100 }}>
          <Trans>Date</Trans>
        </View>
        <View style={{ flex: 1 }}>
          <Trans>Payee</Trans>
        </View>
        <View style={{ width: 110, textAlign: 'right' }}>
          <Trans>Amount</Trans>
        </View>
        <View style={{ width: 200 }}>
          <Trans>Category</Trans>
        </View>
        <View style={{ width: 170 }}>
          <Trans>Match</Trans>
        </View>
      </View>

      {entries.map(entry => {
        const isSelected = selectedKeys.has(entry.key);

        return (
          <View
            key={entry.key}
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
                onChange={() => onToggle(entry.key)}
                aria-label={t('Select row')}
              />
            </View>
            <View style={{ width: 100 }}>
              {formatDate(new Date(entry.saleDate + 'T00:00:00'), dateFormat, {
                locale,
              })}
            </View>
            <View style={{ flex: 1 }}>
              <Text>{entry.cleanPayee || entry.rawDescription}</Text>
            </View>
            <View style={{ width: 110, alignItems: 'flex-end' }}>
              <FinancialText>{format(entry.amount, 'financial')}</FinancialText>
            </View>
            <View style={{ width: 200 }}>
              <Select<string>
                bare
                value={entry.categoryId}
                defaultLabel={t('Categorize')}
                options={[
                  ['', t('Uncategorized')] as const,
                  ...categories.map(
                    category => [category.id, category.name] as const,
                  ),
                ]}
                onChange={value => onCategoryChange(entry.key, value ?? '')}
              />
            </View>
            <View style={{ width: 170 }}>
              <Button
                variant="bare"
                style={{ padding: '2px 6px' }}
                onPress={() => onFocus(entry.key)}
              >
                <Trans>Match…</Trans>
              </Button>
            </View>
          </View>
        );
      })}
    </View>
  );
}
