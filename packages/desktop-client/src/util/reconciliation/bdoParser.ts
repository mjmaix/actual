import { cleanPayee, maskCardNumbers, redactText } from './piiRedactor';

export type BDOSoaTransaction = {
  saleDate: string;
  postDate: string;
  rawDescription: string;
  cleanPayee: string;
  amount: number;
  type: 'charge' | 'payment';
  cardNumberMasked: string;
};

export type BDOSoaStatement = {
  statementDate: string;
  paymentDueDate: string;
  totalAmountDue: number;
  previousBalance: number;
  periodStart: string;
  periodEnd: string;
  transactions: BDOSoaTransaction[];
};

export class SoaPasswordRequiredError extends Error {
  incorrectPassword: boolean;

  constructor(incorrectPassword = false) {
    super(
      incorrectPassword
        ? 'Incorrect password for this statement.'
        : 'This statement is password protected.',
    );
    this.name = 'SoaPasswordRequiredError';
    this.incorrectPassword = incorrectPassword;
  }
}

export class SoaParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SoaParseError';
  }
}

const ROW_REGEX =
  /^(\d{2}\/\d{2}\/\d{2})\s+(\d{2}\/\d{2}\/\d{2})\s+(.+?)\s+(-?[\d,]+\.\d{2})\s*(CR)?$/i;
const CARD_HEADER_REGEX = /^CARD NUMBER\s+(\S+)$/i;
const PREVIOUS_BALANCE_ROW_REGEX =
  /^PREVIOUS STATEMENT BALANCE\s+(-?[\d,]+\.\d{2})$/i;
const SKIP_LINE_REGEX = /^(SUBTOTAL|TOTAL)\b.*[\d,.]+$/i;
const SALE_DATE_REGEX = /^(\d{2})\/(\d{2})\/(\d{2})$/;
const LABELED_AMOUNT_REGEX =
  /^₱?\s*(Total Amount Due|Minimum Amount Due)\s+₱?\s*(-?[\d,]+\.\d{2})/i;
const DATE_LABEL_REGEX =
  /^(Statement Date|Payment Due Date)\s+([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})/i;
const TABLE_HEADER_REGEX =
  /Sale\s+Date\s+Post\s+Date\s+Transaction\s+Details\s+Amount/i;
const CONTINUATION_REGEXES = [
  /^Reference:\s*\S+$/i,
  /^INSTALMENT\s+\d+\s+OF\s+\d+$/i,
  /^\d[\d,.]*\s+U\.?S\.?\s*DOLLARS?$/i,
  /^CONVERTED TO INSTALMENT/i,
  /^FX RATE:/i,
];

const MONTHS: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function shortYearToFull(shortYear: number): number {
  return shortYear <= 69 ? 2000 + shortYear : 1900 + shortYear;
}

export function parseShortDate(value: string): string | null {
  const match = SALE_DATE_REGEX.exec(value.trim());
  if (!match) {
    return null;
  }
  const month = parseInt(match[1], 10);
  const day = parseInt(match[2], 10);
  const year = shortYearToFull(parseInt(match[3], 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function parseLongDate(
  monthName: string,
  day: string,
  year: string,
): string | null {
  const month = MONTHS[monthName.toUpperCase().slice(0, 3)];
  if (!month) {
    return null;
  }
  return `${year}-${pad2(month)}-${pad2(parseInt(day, 10))}`;
}

export function parseAmountToCents(value: string): number {
  return Math.round(parseFloat(value.replace(/,/g, '')) * 100);
}

export type SoaLine = { y: number; x: number; text: string };

export function groupTextItemsIntoLines(
  items: Array<{ str: string; x: number; y: number }>,
): SoaLine[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: SoaLine[] = [];
  let currentItems: typeof sorted = [];
  let currentY = Number.NaN;

  const flush = () => {
    if (currentItems.length > 0) {
      currentItems.sort((a, b) => a.x - b.x);
      lines.push({
        y: currentY,
        x: currentItems[0].x,
        text: currentItems
          .map(item => item.str)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
      });
    }
  };

  for (const item of sorted) {
    if (!Number.isNaN(currentY) && Math.abs(item.y - currentY) > 2) {
      flush();
      currentItems = [];
      currentY = Number.NaN;
    }
    if (Number.isNaN(currentY)) {
      currentY = item.y;
    }
    currentItems.push(item);
  }
  flush();

  return lines.filter(line => line.text.length > 0);
}

export function parseStatementLines(lines: string[]): BDOSoaStatement {
  const transactions: BDOSoaTransaction[] = [];
  let statementDate: string | null = null;
  let paymentDueDate: string | null = null;
  let totalAmountDue: number | null = null;
  let previousBalance: number | null = null;
  let currentCard = '';
  let sawTableHeader = false;

  for (const rawLine of lines) {
    const line = redactText(rawLine.trim());

    const dateLabel = DATE_LABEL_REGEX.exec(line);
    if (dateLabel) {
      const parsed = parseLongDate(dateLabel[2], dateLabel[3], dateLabel[4]);
      if (parsed) {
        if (dateLabel[1].toLowerCase() === 'statement date') {
          statementDate = parsed;
        } else {
          paymentDueDate = parsed;
        }
      }
      continue;
    }

    const labeledAmount = LABELED_AMOUNT_REGEX.exec(line);
    if (labeledAmount) {
      if (labeledAmount[1].toLowerCase() === 'total amount due') {
        totalAmountDue ??= parseAmountToCents(labeledAmount[2]);
      }
      continue;
    }

    const previousBalanceRow = PREVIOUS_BALANCE_ROW_REGEX.exec(line);
    if (previousBalanceRow) {
      previousBalance ??= parseAmountToCents(previousBalanceRow[1]);
      continue;
    }

    if (TABLE_HEADER_REGEX.test(line)) {
      sawTableHeader = true;
      continue;
    }

    const cardHeader = CARD_HEADER_REGEX.exec(line);
    if (cardHeader) {
      currentCard = maskCardNumbers(cardHeader[1]);
      continue;
    }

    if (SKIP_LINE_REGEX.test(line)) {
      continue;
    }

    const row = ROW_REGEX.exec(line);
    if (row) {
      const saleDate = parseShortDate(row[1]);
      const postDate = parseShortDate(row[2]);
      if (!saleDate || !postDate) {
        continue;
      }
      const statementValue = parseAmountToCents(row[4]);
      const isCredit = statementValue < 0 || /^CR$/i.test(row[5] ?? '');
      const absoluteCents = Math.abs(statementValue);

      transactions.push({
        saleDate,
        postDate,
        rawDescription: row[3].trim(),
        cleanPayee: cleanPayee(row[3]),
        amount: isCredit ? absoluteCents : -absoluteCents,
        type: isCredit ? 'payment' : 'charge',
        cardNumberMasked: currentCard,
      });
      continue;
    }

    if (sawTableHeader && transactions.length > 0) {
      const isContinuation = CONTINUATION_REGEXES.some(regex =>
        regex.test(line),
      );
      if (isContinuation) {
        const last = transactions[transactions.length - 1];
        last.rawDescription = redactText(
          `${last.rawDescription} ${line}`.trim(),
        );
      }
    }
  }

  if (transactions.length === 0) {
    throw new SoaParseError(
      'No transactions found. Is this a BDO Statement of Account PDF?',
    );
  }

  if (totalAmountDue == null) {
    throw new SoaParseError('Could not find the Total Amount Due.');
  }

  const allDates = transactions.flatMap(t => [t.saleDate, t.postDate]).sort();

  return {
    statementDate: statementDate ?? allDates[allDates.length - 1],
    paymentDueDate: paymentDueDate ?? '',
    totalAmountDue,
    previousBalance: previousBalance ?? 0,
    periodStart: allDates[0],
    periodEnd: allDates[allDates.length - 1],
    transactions,
  };
}

type TextItemLike = {
  str: string;
  transform: number[];
};

type PdfDocumentLike = {
  numPages: number;
  getPage(pageNumber: number): Promise<{
    getTextContent(): Promise<{ items: TextItemLike[] }>;
  }>;
};

type PdfJsModule = {
  getDocument(options: { data: Uint8Array; password?: string }): {
    promise: Promise<PdfDocumentLike>;
  };
  GlobalWorkerOptions: { workerSrc: string };
};

let pdfjsPromise: Promise<PdfJsModule> | null = null;

async function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = (await import('pdfjs-dist')) as unknown as PdfJsModule;
      const { default: workerUrl } =
        await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

export async function extractPdfLines(
  data: Uint8Array,
  password?: string,
): Promise<string[]> {
  const pdfjs = await loadPdfJs();

  const bytes = data.slice();

  let doc: PdfDocumentLike;
  try {
    doc = await pdfjs.getDocument({ data: bytes, password }).promise;
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name === 'PasswordException') {
      const code = (error as { code?: number }).code;
      throw new SoaPasswordRequiredError(code === 2);
    }
    throw error;
  }

  const lines: string[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = content.items
      .filter(item => item.str && item.str.trim().length > 0)
      .map(item => ({
        str: item.str,
        x: item.transform[4],
        y: item.transform[5],
      }));
    for (const line of groupTextItemsIntoLines(items)) {
      lines.push(line.text);
    }
  }

  return lines;
}

export async function parseBdoStatement(
  data: Uint8Array,
  password?: string,
): Promise<BDOSoaStatement> {
  const lines = await extractPdfLines(data, password);
  return parseStatementLines(lines);
}
