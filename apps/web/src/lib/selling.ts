/** What the Sales and Inventory screens get from the server (apps/server/src/modules/sales.ts, stock.ts). */
import type { LineCategory, PaymentMethod, SaleVatCode } from '@shap/shared';

export interface Item {
  id: string;
  description: string;
  sku: string;
  category: LineCategory;
  unit: string;
  unitPriceCents: number;
  priceIncludesVat: boolean;
  vatCode: SaleVatCode;
  stocked: boolean;
  reorderLevel: number;
  active: boolean;
  qtyOnHand: number;
  stockValueCents: number;
  lastCostCents: number;
  averageCostCents: number | null;
  lastMoved: string | null;
}

export interface SaleRow {
  id: string;
  kind: 'invoice';
  number: string;
  /** Before 1.24 only: the sale number an invoice made from a sale was first issued under. */
  saleNumber: string | null;
  clientId: string | null;
  issueDate: string;
  totalCents: number;
  vatCents: number;
  customerName: string;
  invoicedAt: string | null;
  clientName: string | null;
  method: PaymentMethod | null;
  sourceName: string | null;
  refundedCents: number;
}

export interface SaleLine {
  id: string;
  itemId: string | null;
  description: string;
  qty: number;
  unit: string;
  unitPriceCents: number;
  lineTotalCents: number;
  vatCode: SaleVatCode;
  category: LineCategory;
  stocked: boolean | null;
  creditedQty: number;
}

export interface SaleDetail {
  doc: {
    id: string;
    kind: 'invoice';
    number: string;
    /** Sold at the counter (an invoice paid on the spot); false: an invoice from Quotes & invoices. */
    counter: boolean;
    saleNumber: string | null;
    status: string;
    issueDate: string;
    customerName: string;
    clientId: string | null;
    clientName: string | null;
    subtotalCents: number;
    vatCents: number;
    totalCents: number;
    /** Paid so far (with credit notes taken off), and written off: an invoice's owing is what's left. */
    paidCents: number;
    writtenOffCents: number;
    vatRateBp: number;
    pricesIncludeVat: boolean;
    notes: string;
    updatedAt: string;
  };
  lines: SaleLine[];
  receipts: { id: string; date: string; amountCents: number; method: PaymentMethod; sourceName: string; reference: string }[];
  refunds: { id: string; date: string; amountCents: number; method: PaymentMethod; sourceName: string; creditNoteId: string; creditNoteNumber: string; creditReason: string }[];
  stock: StockMove[];
}

export type MoveKind = 'opening' | 'purchase' | 'sale' | 'refund' | 'supplier_return' | 'count' | 'void' | 'revalue';

export interface StockMove {
  id: string;
  seq: number;
  itemId: string;
  description?: string;
  date: string;
  kind: MoveKind;
  qty: number;
  valueCents: number;
  qtyAfter: number;
  valueAfterCents: number;
  reason: string;
  documentId: string | null;
  costId: string | null;
  stockTakeId: string | null;
  claimId: string | null;
  createdAt: string;
  byName: string | null;
  documentKind: string | null;
  documentNumber: string | null;
  /** The document was a sale at the counter. */
  counter: boolean | null;
  clientName: string | null;
  costSupplier: string | null;
  costReference: string | null;
  stockTakeNote: string | null;
  claimKind: string | null;
  claimSupplier: string | null;
}

export const MOVE_LABELS: Record<MoveKind, string> = {
  opening: 'Opening stock',
  purchase: 'Bought',
  sale: 'Sold',
  refund: 'Refunded (back in stock)',
  supplier_return: 'Sent back to the supplier',
  count: 'Stock take',
  void: 'Voided (back in stock)',
  revalue: 'Revalued (stock arrived after selling short)',
};

export const qtyText = (q: number | string) => {
  const n = Number(q);
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
};
export const toQty = (q: string) => Number(String(q).replace(',', '.')) || 0;

/** An item's price on the sale's basis: VAT included (as on the shelf) when the business charges VAT. */
export function shelfPriceCents(it: Pick<Item, 'unitPriceCents' | 'priceIncludesVat' | 'vatCode'>, vatRateBp: number): number {
  if (vatRateBp > 0 && it.vatCode === 'standard' && !it.priceIncludesVat) return Math.round((Number(it.unitPriceCents) * (10000 + vatRateBp)) / 10000);
  return Number(it.unitPriceCents);
}

/** The selling price excluding VAT, for comparing with what the stock cost. */
export function netPriceCents(it: Pick<Item, 'unitPriceCents' | 'priceIncludesVat' | 'vatCode'>, vatRateBp: number): number {
  if (vatRateBp > 0 && it.vatCode === 'standard' && it.priceIncludesVat) return Math.round((Number(it.unitPriceCents) * 10000) / (10000 + vatRateBp));
  return Number(it.unitPriceCents);
}
