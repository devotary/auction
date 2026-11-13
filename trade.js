export function resale({buy, sell, quantity = 1, cut = 5, expenses = 0}) {
  for (const [k, v] of Object.entries({buy, sell, quantity, cut, expenses})) if (!Number.isFinite(v) || v < 0 || (k === 'cut' && v > 100) || (k === 'quantity' && (!Number.isInteger(v) || v < 1))) throw new Error('Enter valid, nonnegative amounts and a whole quantity.');
  const gross = Math.round(sell * quantity);
  if (![gross, Math.round(buy * quantity), Math.round(expenses)].every(Number.isSafeInteger)) throw new Error('Trade amounts are too large for accurate copper calculations.');
  const fee = Math.floor(gross * cut / 100);
  return {gross, fee, net: gross - fee - Math.round(buy * quantity) - Math.round(expenses)};
}
