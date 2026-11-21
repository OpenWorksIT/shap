/** Words a bank puts on many statement lines, not the business's name: left out of a rule's starting words. */
const BANK_WORDS = new Set(['pos', 'purchase', 'debit', 'credit', 'order', 'payment', 'card', 'transfer', 'eft', 'int', 'fee', 'fees', 'acb', 'ref', 'from', 'the', 'and', 'cash', 'deposit', 'online', 'banking', 'magtape', 'debicheck', 'sent', 'received', 'immediate', 'internet', 'cheque', 'account']);

/**
 * A rule's starting words (Bank → Always this): the first word of the statement line that isn't one
 * of the bank's own, which the owner can change before saving. Not the supplier's name as captured,
 * which the statement may not say.
 */
export const ruleWord = (description: string): string => description.split(/[^A-Za-z&]+/).find((w) => w.length >= 3 && !BANK_WORDS.has(w.toLowerCase())) ?? description.trim().slice(0, 30);
