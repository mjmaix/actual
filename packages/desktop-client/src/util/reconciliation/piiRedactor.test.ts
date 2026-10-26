import { cleanPayee, maskCardNumbers, redactText } from './piiRedactor';

describe('maskCardNumbers', () => {
  it('masks a dash-separated PAN keeping the last four digits', () => {
    expect(maskCardNumbers('CARD NUMBER 4183-5903-8855-5113')).toBe(
      'CARD NUMBER ****-****-****-5113',
    );
  });

  it('masks a space-separated PAN', () => {
    expect(maskCardNumbers('Card 4183 5903 8855 5113')).toBe(
      'Card ****-****-****-5113',
    );
  });

  it('masks a compact PAN', () => {
    expect(maskCardNumbers('4183590388555113')).toBe('****-****-****-5113');
  });

  it('does not treat amounts, dates or reference numbers as PANs', () => {
    const text = 'TOTAL 85,833.55 09/09/26 Reference: 202609139015000021903907';
    expect(maskCardNumbers(text)).toBe(text);
  });
});

describe('redactText', () => {
  it('redacts tokenized card strings including embedded names', () => {
    expect(redactText('*4183590388555113MLABADILLA*')).toBe('[CARD TOKEN]');
  });

  it('redacts both PANs and tokenized cards in one pass', () => {
    const text =
      'Card Number 4183-5903-8855-5113 / *4183590388555113MLABADILLA*';
    const redacted = redactText(text);
    expect(redacted).toContain('****-****-****-5113');
    expect(redacted).toContain('[CARD TOKEN]');
    expect(redacted).not.toContain('MLABADILLA');
    expect(redacted).not.toContain('4183590388555113');
  });
});

describe('cleanPayee', () => {
  it.each([
    ['SHOPEE PH MANDALUYONG PH', 'SHOPEE PH'],
    ['LAZADA PH TAGUIG PH', 'LAZADA PH'],
    ['PLDT MAKATI PH', 'PLDT'],
    ['WATSONS PIONEER CENTER PASIG PH', 'WATSONS PIONEER CENTER'],
    ['BAYAD CENTER MERALCO PASIG PH', 'BAYAD CENTER MERALCO'],
    ['SM STORE-MEGAMALL MANDALUYONG PH', 'SM STORE-MEGAMALL'],
    ['SM SUPERMARKET SM MEG MANDALUYONG PH', 'SM SUPERMARKET SM MEG'],
    ['MFG TAGUIG PH', 'MFG'],
    ['APPLE.COM/BILL ITUNES.COM IE', 'APPLE.COM/BILL ITUNES.COM'],
    ['GOOGLE G1AI103M LONDON GB', 'GOOGLE G1AI103M'],
    ['PIKAPODS.COM NAXXAR MT', 'PIKAPODS.COM'],
    ['S & R WAREHOUSE ONLINE PARANAQUE CIT PH', 'S & R WAREHOUSE ONLINE'],
    ['INSULAR HEALTHCARE -IP PH PH', 'INSULAR HEALTHCARE'],
    ['XDT*ANYTIME FITNESS PI https://xendi PH', 'ANYTIME FITNESS'],
    ['PAYMENT RECEIVED - THANK YOU', 'PAYMENT RECEIVED'],
    ['MONTHLY MEMBERSHIP FEE', 'MONTHLY MEMBERSHIP FEE'],
    ['BALANCE TRANSFER Z TM MANDALUYONG PH', 'BALANCE TRANSFER Z'],
    ['GOOGLE YOUTUBE PREMIUM LILONDON GB', 'GOOGLE YOUTUBE PREMIUM LILONDON'],
  ])('cleans %s to %s', (raw, expected) => {
    expect(cleanPayee(raw)).toBe(expected);
  });
});
