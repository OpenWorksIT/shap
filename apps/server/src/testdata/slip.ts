/**
 * A made-up supplier's slip for the test server's made-up costs (docs/TEST_SERVER.md): a small PDF
 * that says plainly it's made up, with the supplier, date, what was bought, the total and the VAT
 * in it, so a cost that claims VAT has a slip behind it as a real one would.
 */
import PDFDocument from 'pdfkit';

export interface Slip {
  supplier: string;
  /** The supplier's VAT number (made up), when it charged VAT. */
  vatNumber: string;
  date: string;
  number: string;
  description: string;
  totalCents: number;
  vatCents: number;
}

const rand = (c: number) => `R ${(c / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`;

export function slipPdf(s: Slip): Promise<string> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [226, 340], margin: 14, info: { Title: `Made-up slip ${s.number}`, Producer: 'Shap test server' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    doc.on('error', reject);
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#b91c1c').text('MADE UP FOR TESTING: NOT A REAL SLIP', { align: 'center' });
    doc.moveDown(0.6).fillColor('#000').fontSize(10).text(s.supplier, { align: 'center' });
    doc.font('Helvetica').fontSize(7).text(s.vatNumber ? `TAX INVOICE · VAT no. ${s.vatNumber}` : 'Invoice (not registered for VAT)', { align: 'center' });
    doc.moveDown(0.8).fontSize(8).text(`No. ${s.number}`).text(`Date: ${s.date}`);
    doc.moveDown(0.6).text(s.description, { width: 198 });
    doc.moveDown(0.8).font('Helvetica-Bold').text(`Total: ${rand(s.totalCents)}`);
    doc.font('Helvetica').text(s.vatCents ? `VAT included (15%): ${rand(s.vatCents)}` : 'No VAT');
    doc.end();
  });
}
