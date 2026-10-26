import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { q } from '@actual-app/core/shared/query';
import { integerToCurrency } from '@actual-app/core/shared/util';
import type {
  CategoryEntity,
  TransactionEntity,
} from '@actual-app/core/types/models';
import type { TransObjectLiteral } from '@actual-app/core/types/util';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, format as formatDate, parseISO, subDays } from 'date-fns';
import { v4 as uuidv4 } from 'uuid';

import {
  Modal,
  ModalButtons,
  ModalCloseButton,
  ModalHeader,
} from '#components/common/Modal';
import { useCategories } from '#hooks/useCategories';
import { useDateFormat } from '#hooks/useDateFormat';
import { useLocale } from '#hooks/useLocale';
import { closeModal } from '#modals/modalsSlice';
import type { Modal as ModalType } from '#modals/modalsSlice';
import { payeeQueries } from '#payees/queries';
import { aqlQuery } from '#queries/aqlQuery';
import { useDispatch } from '#redux';
import { transactionQueries } from '#transactions';
import {
  parseBdoStatement,
  SoaPasswordRequiredError,
} from '#util/reconciliation/bdoParser';
import type { BDOSoaStatement } from '#util/reconciliation/bdoParser';
import {
  reconcileStatementTransactions,
  scoreMatch,
} from '#util/reconciliation/matcher';

import { MatchPanel } from './MatchPanel';
import type { MatchFocus } from './MatchPanel';
import { NewTransactionsTable } from './NewTransactionsTable';
import type { NewEntryRow } from './NewTransactionsTable';
import { ReconciliationTable } from './ReconciliationTable';
import type { MatchRow } from './ReconciliationTable';

type ReconcileStatementModalProps = Extract<
  ModalType,
  { name: 'reconcile-statement' }
>['options'];

type Pair = {
  key: string;
  ledgerId: string;
  confidence: number;
  dateDiffDays: number;
  amountDiffCents: number;
  source: 'auto' | 'manual';
};

type TabName = 'matched' | 'review' | 'new' | 'uncleared';

const CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/\bFEE\b|\bMEMBERSHIP\b|\bANNUAL\b|\bDUES\b/, 'fee'],
  [/\bINTEREST\b/, 'interest'],
];

function suggestCategory(
  description: string,
  payee: string,
  categories: CategoryEntity[] | undefined,
): string {
  if (!categories) {
    return '';
  }
  const haystack = `${payee} ${description}`;
  for (const [pattern, keyword] of CATEGORY_HINTS) {
    if (pattern.test(haystack)) {
      const match = categories.find(category =>
        category.name.toLowerCase().includes(keyword),
      );
      if (match) {
        return match.id;
      }
    }
  }
  return '';
}

function buildAutoNote(soa: BDOSoaStatement, postDate: string): string {
  const monthYear = formatDate(parseISO(soa.periodEnd), 'MM/yy');
  return `[Reconciled BDO SOA ${monthYear} | Post: ${postDate}]`;
}

function appendNote(existingNotes: string | undefined, note: string): string {
  if (!existingNotes) {
    return note;
  }
  return `${existingNotes} ${note}`;
}

export function ReconcileStatementModal({
  accountId,
}: ReconcileStatementModalProps) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingFileRef = useRef<File | null>(null);

  const [status, setStatus] = useState<'pick' | 'parsing' | 'review'>('pick');
  const [error, setError] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [statement, setStatement] = useState<BDOSoaStatement | null>(null);
  const [filename, setFilename] = useState('');
  const [statementItems, setStatementItems] = useState<NewEntryRow[]>([]);
  const [ledgerItems, setLedgerItems] = useState<TransactionEntity[]>([]);
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [focus, setFocus] = useState<MatchFocus | null>(null);
  const [activeTab, setActiveTab] = useState<TabName>('matched');
  const [applying, setApplying] = useState(false);
  const dateFormat = useDateFormat() || 'MM/dd/yyyy';
  const locale = useLocale();

  const categoriesQuery = useCategories();
  const payeesQuery = useQuery(payeeQueries.list());
  const payeeNamesById = new Map(
    (payeesQuery.data ?? []).map(payee => [payee.id, payee.name]),
  );

  const statementByKey = new Map(statementItems.map(item => [item.key, item]));
  const ledgerById = new Map(ledgerItems.map(txn => [txn.id, txn]));
  const pairedLedgerIds = new Set(pairs.map(pair => pair.ledgerId));
  const pairedStatementKeys = new Set(pairs.map(pair => pair.key));

  function getPayeeName(payeeId: string | null | undefined): string {
    return payeeId ? (payeeNamesById.get(payeeId) ?? '') : '';
  }

  async function fetchLedgerTransactions(
    soa: BDOSoaStatement,
  ): Promise<TransactionEntity[]> {
    const start = formatDate(
      subDays(parseISO(soa.periodStart), 45),
      'yyyy-MM-dd',
    );
    const end = formatDate(addDays(parseISO(soa.periodEnd), 45), 'yyyy-MM-dd');
    const { data } = await aqlQuery(
      q('transactions')
        .filter({ account: accountId, date: { $gte: start, $lte: end } })
        .select('*'),
    );
    return data as TransactionEntity[];
  }

  async function parseAndReview(file: File, pass?: string) {
    setStatus('parsing');
    setError(null);
    try {
      const buffer = await file.arrayBuffer();
      const parsed = await parseBdoStatement(
        new Uint8Array(buffer),
        pass || undefined,
      );
      const ledger = await fetchLedgerTransactions(parsed);
      const reconciled = reconcileStatementTransactions({
        statementTransactions: parsed.transactions,
        ledgerTransactions: ledger,
        getPayeeName: payeeId => getPayeeName(payeeId),
      });

      const items: NewEntryRow[] = parsed.transactions.map((txn, index) => ({
        ...txn,
        key: `s${index}`,
        categoryId: suggestCategory(
          txn.rawDescription,
          txn.cleanPayee,
          categoriesQuery.data?.list,
        ),
      }));
      const keyByStatement = new Map(
        parsed.transactions.map((txn, index) => [txn, `s${index}`]),
      );
      const initialPairs: Pair[] = reconciled.matches.map(match => ({
        key: keyByStatement.get(match.statement) ?? '',
        ledgerId: match.ledger.id,
        confidence: match.confidence,
        dateDiffDays: match.dateDiffDays,
        amountDiffCents: match.amountDiffCents,
        source: 'auto',
      }));

      const pairedKeys = new Set(initialPairs.map(pair => pair.key));
      const initialSelected = new Set<string>();
      for (const pair of initialPairs) {
        if (pair.confidence >= 85) {
          initialSelected.add(pair.key);
        }
      }
      for (const item of items) {
        if (!pairedKeys.has(item.key)) {
          initialSelected.add(item.key);
        }
      }

      pendingFileRef.current = null;
      setPassword('');
      setPasswordError(null);
      setStatement(parsed);
      setStatementItems(items);
      setLedgerItems(ledger);
      setPairs(initialPairs);
      setSelectedKeys(initialSelected);
      setFocus(null);
      setStatus('review');
    } catch (err) {
      if (err instanceof SoaPasswordRequiredError) {
        setNeedsPassword(true);
        setStatus('pick');
        setError(null);
        setPasswordError(
          err.incorrectPassword
            ? t('Incorrect password. Please try again.')
            : null,
        );
      } else {
        setStatus('pick');
        setError(
          err instanceof Error
            ? err.message
            : t('Something went wrong reading the statement.'),
        );
      }
    }
  }

  async function onFilePicked(
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    setFilename(file.name);
    pendingFileRef.current = file;
    setNeedsPassword(false);
    setPasswordError(null);
    setPassword('');
    await parseAndReview(file);
  }

  async function onUnlock(): Promise<void> {
    const file = pendingFileRef.current;
    if (!file || password.length === 0) {
      return;
    }
    await parseAndReview(file, password);
  }

  async function resolvePayeeId(name: string): Promise<string | undefined> {
    if (!name) {
      return undefined;
    }
    const existing = (payeesQuery.data ?? []).find(
      payee =>
        !payee.transfer_acct && payee.name.toUpperCase() === name.toUpperCase(),
    );
    if (existing) {
      return existing.id;
    }
    return send('payee-create', { name });
  }

  function pair(statementKey: string, ledgerId: string) {
    const item = statementByKey.get(statementKey);
    const ledger = ledgerById.get(ledgerId);
    if (!item || !ledger) {
      return;
    }
    const score = scoreMatch(item, ledger, getPayeeName(ledger.payee));
    setPairs(prev => {
      const next = prev.filter(
        existing =>
          existing.key !== statementKey && existing.ledgerId !== ledgerId,
      );
      return [
        ...next,
        {
          key: statementKey,
          ledgerId,
          confidence: score.confidence,
          dateDiffDays: score.dateDiffDays,
          amountDiffCents: score.amountDiffCents,
          source: 'manual',
        },
      ];
    });
    setSelectedKeys(prev => {
      const next = new Set(prev);
      next.add(statementKey);
      return next;
    });
  }

  function unpair(statementKey: string) {
    setPairs(prev => prev.filter(existing => existing.key !== statementKey));
  }

  function onCategoryChange(key: string, categoryId: string) {
    setStatementItems(prev =>
      prev.map(item => (item.key === key ? { ...item, categoryId } : item)),
    );
  }

  async function onApprove(): Promise<void> {
    if (!statement || statementItems.length === 0) {
      return;
    }
    setApplying(true);
    setError(null);
    try {
      const updated: TransactionEntity[] = [];
      const added: TransactionEntity[] = [];

      for (const pair of pairs) {
        if (!selectedKeys.has(pair.key)) {
          continue;
        }
        const ledger = ledgerById.get(pair.ledgerId);
        const item = statementByKey.get(pair.key);
        if (!ledger || !item) {
          continue;
        }
        updated.push({
          ...ledger,
          cleared: true,
          notes: appendNote(
            ledger.notes,
            buildAutoNote(statement, item.postDate),
          ),
        });
      }

      for (const item of statementItems) {
        if (pairedStatementKeys.has(item.key) || !selectedKeys.has(item.key)) {
          continue;
        }
        const payeeId = await resolvePayeeId(
          item.cleanPayee || item.rawDescription.slice(0, 60),
        );
        added.push({
          id: uuidv4(),
          account: accountId,
          date: item.saleDate,
          amount: item.amount,
          payee: payeeId,
          category: item.categoryId || undefined,
          cleared: true,
          notes: buildAutoNote(statement, item.postDate),
          imported_payee: item.rawDescription,
        });
      }

      if (updated.length > 0 || added.length > 0) {
        await send('transactions-batch-update', { updated, added });
      }

      void queryClient.invalidateQueries({
        queryKey: transactionQueries.all(),
      });
      dispatch(closeModal());
    } catch (err) {
      setApplying(false);
      setError(
        err instanceof Error
          ? err.message
          : t('Something went wrong applying the reconciliation.'),
      );
    }
  }

  const matchRows: MatchRow[] = pairs.flatMap(pair => {
    const item = statementByKey.get(pair.key);
    const ledger = ledgerById.get(pair.ledgerId);
    if (!item || !ledger) {
      return [];
    }
    const tier: 'high' | 'review' = pair.confidence >= 85 ? 'high' : 'review';
    return [
      {
        statement: item,
        ledger,
        tier,
        confidence: pair.confidence,
        dateDiffDays: pair.dateDiffDays,
        amountDiffCents: pair.amountDiffCents,
        key: pair.key,
        source: pair.source,
      },
    ];
  });

  const newEntries = statementItems.filter(
    item => !pairedStatementKeys.has(item.key),
  );
  const unmatchedLedger = ledgerItems.filter(
    txn => !pairedLedgerIds.has(txn.id) && !txn.is_child,
  );

  const selectedCount = selectedKeys.size;
  const matchedCount = matchRows.filter(row => row.tier === 'high').length;
  const reviewCount = matchRows.filter(row => row.tier === 'review').length;
  const newCount = newEntries.length;
  const unclearedCount = unmatchedLedger.length;

  const tabs: Array<[TabName, string, number]> = [
    ['matched', t('Matched'), matchedCount],
    ['review', t('Review Needed'), reviewCount],
    ['new', t('New Entries'), newCount],
    ['uncleared', t('Uncleared'), unclearedCount],
  ];

  const visibleMatches = matchRows.filter(row =>
    activeTab === 'matched' ? row.tier === 'high' : row.tier === 'review',
  );

  const focusedStatementItem =
    focus?.kind === 'statement'
      ? (statementByKey.get(focus.key) ?? null)
      : null;
  const focusedLedgerItem =
    focus?.kind === 'ledger' ? (ledgerById.get(focus.id) ?? null) : null;

  let ledgerCandidates: TransactionEntity[] = [];
  if (focus?.kind === 'statement') {
    if (focus.mode === 'repoint') {
      const currentLedgerId = pairs.find(p => p.key === focus.key)?.ledgerId;
      ledgerCandidates = ledgerItems.filter(
        txn => !txn.is_child && txn.id !== currentLedgerId,
      );
    } else {
      ledgerCandidates = unmatchedLedger;
    }
  }

  const statementCandidates = focus?.kind === 'ledger' ? newEntries : [];

  return (
    <Modal
      name="reconcile-statement"
      isLoading={status === 'parsing' || applying}
    >
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Reconcile with Statement')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />

          <View
            style={{
              padding: 20,
              overflow: 'auto',
              flexDirection: 'column',
              gap: 12,
              flex: 1,
            }}
          >
            {error && (
              <View
                style={{
                  padding: 10,
                  borderRadius: 6,
                  backgroundColor: theme.errorBackground,
                  color: theme.errorText,
                }}
              >
                <Text>{error}</Text>
              </View>
            )}

            {status === 'pick' && (
              <View style={{ flexDirection: 'column', gap: 12 }}>
                <Text>
                  <Trans>
                    Upload a BDO credit card eSOA PDF. Everything is parsed
                    locally in your browser: card numbers and personal details
                    are scrubbed before anything is shown, and nothing changes
                    in your budget until you approve.
                  </Trans>
                </Text>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  style={{ display: 'none' }}
                  onChange={e => {
                    void onFilePicked(e);
                  }}
                />
                <Button
                  variant="primary"
                  onPress={() => fileInputRef.current?.click()}
                >
                  <Trans>Choose statement PDF</Trans>
                </Button>

                {needsPassword && (
                  <View
                    style={{
                      flexDirection: 'column',
                      gap: 8,
                      padding: 12,
                      borderRadius: 6,
                      backgroundColor: theme.tableHeaderBackground,
                    }}
                  >
                    <Text>
                      <Trans>
                        This statement is password protected. The password stays
                        in memory only for unlocking and is never stored.
                      </Trans>
                    </Text>
                    {passwordError && (
                      <Text style={{ color: theme.errorText }}>
                        {passwordError}
                      </Text>
                    )}
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <Input
                        type="password"
                        value={password}
                        onChangeValue={value => setPassword(value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            void onUnlock();
                          }
                        }}
                        style={{ flex: 1 }}
                        placeholder={t('Statement password')}
                      />
                      <Button
                        variant="primary"
                        onPress={() => {
                          void onUnlock();
                        }}
                      >
                        <Trans>Unlock</Trans>
                      </Button>
                    </View>
                  </View>
                )}
              </View>
            )}

            {status === 'review' && statement && (
              <>
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  <Text>
                    <Trans>
                      Statement: {{ filename } as TransObjectLiteral}
                    </Trans>
                  </Text>
                  <Text>
                    <Trans>
                      Period:{' '}
                      {
                        {
                          start: statement.periodStart,
                          end: statement.periodEnd,
                        } as TransObjectLiteral
                      }
                    </Trans>
                  </Text>
                  <Text>
                    <Trans>
                      Statement balance:{' '}
                      {
                        {
                          balance: integerToCurrency(statement.totalAmountDue),
                        } as TransObjectLiteral
                      }
                    </Trans>
                  </Text>
                </View>

                <View
                  style={{
                    flexDirection: 'row',
                    gap: 16,
                    alignItems: 'flex-start',
                  }}
                >
                  <View
                    style={{
                      flex: 1,
                      minWidth: 0,
                      flexDirection: 'column',
                      gap: 12,
                    }}
                  >
                    <View style={{ flexDirection: 'row', gap: 4 }}>
                      {tabs.map(([name, label, count]) => (
                        <Button
                          key={name}
                          variant={activeTab === name ? 'normal' : 'bare'}
                          style={
                            activeTab === name
                              ? {
                                  backgroundColor:
                                    theme.buttonBareBackgroundHover,
                                }
                              : undefined
                          }
                          onPress={() => {
                            setActiveTab(name);
                            setFocus(null);
                          }}
                        >
                          {label} ({count})
                        </Button>
                      ))}
                    </View>

                    {(activeTab === 'matched' || activeTab === 'review') && (
                      <ReconciliationTable
                        matches={visibleMatches}
                        selectedKeys={selectedKeys}
                        onToggle={key =>
                          setSelectedKeys(prev => {
                            const next = new Set(prev);
                            if (next.has(key)) {
                              next.delete(key);
                            } else {
                              next.add(key);
                            }
                            return next;
                          })
                        }
                        onToggleAll={(keys, checked) =>
                          setSelectedKeys(prev => {
                            const next = new Set(prev);
                            for (const key of keys) {
                              if (checked) {
                                next.add(key);
                              } else {
                                next.delete(key);
                              }
                            }
                            return next;
                          })
                        }
                        payeeNamesById={payeeNamesById}
                        onFocus={key =>
                          setFocus({ kind: 'statement', key, mode: 'repoint' })
                        }
                        onUnmatch={unpair}
                      />
                    )}

                    {activeTab === 'new' && (
                      <NewTransactionsTable
                        entries={newEntries}
                        selectedKeys={selectedKeys}
                        onToggle={key =>
                          setSelectedKeys(prev => {
                            const next = new Set(prev);
                            if (next.has(key)) {
                              next.delete(key);
                            } else {
                              next.add(key);
                            }
                            return next;
                          })
                        }
                        onToggleAll={(keys, checked) =>
                          setSelectedKeys(prev => {
                            const next = new Set(prev);
                            for (const key of keys) {
                              if (checked) {
                                next.add(key);
                              } else {
                                next.delete(key);
                              }
                            }
                            return next;
                          })
                        }
                        onCategoryChange={onCategoryChange}
                        categories={categoriesQuery.data?.list ?? []}
                        onFocus={key =>
                          setFocus({ kind: 'statement', key, mode: 'new' })
                        }
                      />
                    )}

                    {activeTab === 'uncleared' && (
                      <View style={{ flexDirection: 'column' }}>
                        {unmatchedLedger.length === 0 ? (
                          <View style={{ padding: 20, alignItems: 'center' }}>
                            <Text style={{ color: theme.pageTextSubdued }}>
                              <Trans>
                                Every ledger transaction has a statement
                                counterpart.
                              </Trans>
                            </Text>
                          </View>
                        ) : (
                          unmatchedLedger.map(txn => (
                            <View
                              key={txn.id}
                              style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                padding: '6px 10px',
                                borderBottomWidth: 1,
                                borderColor: theme.tableBorder,
                                ...styles.smallText,
                              }}
                            >
                              <Text style={{ width: 110 }}>
                                {formatDate(
                                  new Date(txn.date + 'T00:00:00'),
                                  dateFormat,
                                  { locale },
                                )}
                              </Text>
                              <Text style={{ flex: 1, marginLeft: 10 }}>
                                {txn.payee
                                  ? (payeeNamesById.get(txn.payee) ?? '')
                                  : ''}
                              </Text>
                              <Text style={{ ...styles.tnum, width: 120 }}>
                                {integerToCurrency(txn.amount)}
                              </Text>
                              <View style={{ width: 120 }}>
                                <Button
                                  variant="bare"
                                  style={{ padding: '2px 6px' }}
                                  onPress={() =>
                                    setFocus({ kind: 'ledger', id: txn.id })
                                  }
                                >
                                  <Trans>Match…</Trans>
                                </Button>
                              </View>
                            </View>
                          ))
                        )}
                      </View>
                    )}
                  </View>
                  {focus && (
                    <MatchPanel
                      focus={focus}
                      statementItem={focusedStatementItem}
                      ledgerItem={focusedLedgerItem}
                      ledgerCandidates={ledgerCandidates}
                      statementCandidates={statementCandidates}
                      payeeNamesById={payeeNamesById}
                      onPair={(statementKey, ledgerId) => {
                        pair(statementKey, ledgerId);
                        setFocus(null);
                      }}
                      onClose={() => setFocus(null)}
                    />
                  )}
                </View>
              </>
            )}
          </View>

          <ModalButtons style={{ padding: 20, paddingTop: 0 }}>
            <Button onPress={() => state.close()}>
              <Trans>Cancel</Trans>
            </Button>
            {status === 'review' && (
              <Button
                variant="primary"
                isDisabled={applying || selectedCount === 0}
                onPress={() => {
                  void onApprove();
                }}
              >
                <Trans>
                  Approve & Apply ({' '}
                  {{ count: selectedCount } as TransObjectLiteral})
                </Trans>
              </Button>
            )}
          </ModalButtons>
        </>
      )}
    </Modal>
  );
}
