/**
 * Builds a fictional project tracker workbook in the same layout Shap imports
 * (Per Project, Costs, Wages List, Trade Statement, Trial Balance). It feeds the demo
 * company and the test suite, so neither needs anyone's real figures.
 * Deterministic: the same `today` gives the same workbook.
 */
import ExcelJS from 'exceljs';
import { addDays, addMonths, financialYear, monthStart } from '@shap/shared';

export interface DemoTrackerTotals {
  invoicedByMonth: Map<string, number>;
  labourByProject: Map<string, number>;
  partsByProject: Map<string, number>;
  wagesByWorker: Map<string, { earned: number; paid: number }>;
  costs: number;
  labourDays: number;
  projects: number;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const CLIENTS = ['Naidoo001', 'Mokoena001', 'Smith001', 'Dlamini001', 'VanWyk001', 'Pillay001'];
const JOBS = [
  ['Naidoo', 'Bathroom revamp'],
  ['Mokoena', 'Roof repairs'],
  ['Smith', 'Boundary wall'],
  ['Dlamini', 'Kitchen cupboards'],
  ['VanWyk', 'Paving'],
  ['Pillay', 'Garage conversion'],
  ['Naidoo', 'Patio roof'],
  ['Smith', 'Exterior paint'],
  ['Mokoena', 'Gutters and fascias'],
  ['Dlamini', 'Braai area'],
  ['VanWyk', 'Carport'],
  ['Pillay', 'Shower re-tile'],
  ['Smith', 'Damp proofing'],
  ['Naidoo', 'Pergola'],
] as const;
const SUPPLIERS = ['Builders', 'Cashbuild', 'Mica', 'Buco', 'Tile Africa', 'Mr Builder'];
const PARTS = ['Cement', 'Sand', 'Timber', 'Screws', 'Paint', 'Tiles', 'Roof sheets', 'Silicone', 'Bricks', 'Plumbing'];
const OVERHEADS: [string, string, string, number][] = [
  ['Petrol', 'Fuel – bakkie', 'Engen', 1400],
  ['Cellphone', 'Cellphone contract', 'Vodacom', 650],
  ['Bank', 'Monthly account fee', 'Bank', 395],
  ['Insurance', 'Business insurance', 'Insurer', 1250],
  ['Accounting', 'Accounting software', 'Software', 450],
];

export async function buildDemoTracker(today: string, fyEndMonth = 2): Promise<{ buffer: Buffer; totals: DemoTrackerTotals }> {
  const rand = rng(42);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const start = monthStart(addMonths(today, -13));
  const wb = new ExcelJS.Workbook();
  const pp = wb.addWorksheet('Per Project');
  const costs = wb.addWorksheet('Costs');
  const wages = wb.addWorksheet('Wages List');
  const trade = wb.addWorksheet('Trade Statement');

  pp.getRow(1).getCell(8).value = 'Estimate';
  pp.getRow(3).values = ['#', 'Project', 'Client', 'Match Cost?', 'Match Labour?', 'Invoice #', 'Date', 'Q Total', 'Q Labour', 'Q Parts', 'Q Demo', 'C Total', 'C Labour', 'C Parts', 'C Demo', 'Received', 'I Total', 'I Labour', 'I Parts', 'I Demo', 'Gross Profit', 'Profit %', 'Costs for Projects in Progress', 'To Charge'];
  costs.getRow(1).values = ['Date', 'Name', 'Cost', 'Supplier', 'Type', 'Account', 'Project', 'Personal'];
  wages.getRow(1).values = ['Date', 'Worker', 'Wage', 'Allowance', 'Total', 'Paid', 'Project', 'Casual?', 'Personal'];

  const totals: DemoTrackerTotals = {
    invoicedByMonth: new Map(),
    labourByProject: new Map(),
    partsByProject: new Map(),
    wagesByWorker: new Map(),
    costs: 0,
    labourDays: 0,
    projects: JOBS.length,
  };
  const crew = [
    { name: 'Sipho', rate: 400, allowance: 50 },
    { name: 'Thabo', rate: 350, allowance: 50 },
  ];
  let costRow = 2;
  let wageRow = 2;
  const wage = (date: string, worker: string, rate: number, allow: number, paid: number | null, project: string | null, casual?: string) => {
    wages.getRow(wageRow++).values = [new Date(`${date}T00:00:00Z`), casual ? 'Casual' : worker, rate, allow, { formula: `C${wageRow - 1}+D${wageRow - 1}`, result: rate + allow }, paid ?? undefined, project ?? undefined, casual];
    const key = casual ?? worker;
    const w = totals.wagesByWorker.get(key) ?? { earned: 0, paid: 0 };
    w.earned += rate + allow;
    w.paid += paid ?? 0;
    totals.wagesByWorker.set(key, w);
    totals.labourDays++;
    if (project) totals.labourByProject.set(project, (totals.labourByProject.get(project) ?? 0) + rate + allow);
  };
  const cost = (date: string, name: string, amount: number, supplier: string, type: string, account: string, project: string | null) => {
    costs.getRow(costRow++).values = [new Date(`${date}T00:00:00Z`), name, amount, supplier, type, account || undefined, project ?? undefined];
    totals.costs++;
    if (project && type === 'Parts') totals.partsByProject.set(project, r2((totals.partsByProject.get(project) ?? 0) + amount));
  };

  let cursor = start;
  let invoiceNo = 1;
  JOBS.forEach(([clientName, what], i) => {
    const name = `${clientName} ${what}`;
    const client = CLIENTS[CLIENTS.findIndex((c) => c.startsWith(clientName))]!;
    const days = 3 + Math.floor(rand() * 8);
    const last = i >= JOBS.length - 2; // the last two jobs are still on the go
    // Roughly a job a month, so every month of the last year has some work in it.
    cursor = addDays(start, 3 + i * 28);
    let d = cursor;
    let parts = 0;
    for (let k = 0; k < days; k++) {
      if (d > today) break;
      for (const c of crew) wage(d, c.name, c.rate, c.allowance, k === days - 1 ? (c.rate + c.allowance) * days : 50, name);
      if (k % 3 === 0) {
        const amt = r2(300 + rand() * 2500);
        parts += amt;
        cost(d, PARTS[Math.floor(rand() * PARTS.length)]!, amt, SUPPLIERS[Math.floor(rand() * SUPPLIERS.length)]!, 'Parts', k % 2 ? 'FNB CS' : '', name);
      }
      d = addDays(d, d.endsWith('5') ? 3 : 1);
    }
    const labourCost = totals.labourByProject.get(name) ?? 0;
    const qLabour = Math.round((labourCost * 1.6) / 50) * 50;
    const qParts = Math.round((parts * 1.35) / 10) * 10;
    const row = pp.getRow(4 + i);
    row.values = [i + 1, name, client, null, null, last ? null : invoiceNo, last ? null : new Date(`${d}T00:00:00Z`), qLabour + qParts, qLabour, qParts, 0, null, null, null, null];
    if (!last) {
      const received = i === JOBS.length - 3 ? Math.round((qLabour + qParts) / 2) : qLabour + qParts;
      row.getCell(16).value = received;
      row.getCell(17).value = { formula: `SUM(R${4 + i}:T${4 + i})`, result: qLabour + qParts };
      row.getCell(18).value = qLabour;
      row.getCell(19).value = qParts;
      row.getCell(20).value = 0;
      const ym = d.slice(0, 7);
      totals.invoicedByMonth.set(ym, (totals.invoicedByMonth.get(ym) ?? 0) + qLabour + qParts);
      invoiceNo++;
    } else {
      row.getCell(24).value = { formula: `L${4 + i}*1.35`, result: 0 };
    }
  });
  // A casual helper on one job, a yard day with no job, and running costs every month.
  wage(addDays(start, 10), 'Casual', 300, 50, 350, `${JOBS[1][0]} ${JOBS[1][1]}`, 'Lwazi');
  wage(addDays(start, 40), 'Sipho', 400, 50, 450, null);
  // Per Project's actual labour and parts, once every row is in.
  JOBS.forEach(([clientName, what], i) => {
    const name = `${clientName} ${what}`;
    pp.getRow(4 + i).getCell(13).value = totals.labourByProject.get(name) ?? 0;
    pp.getRow(4 + i).getCell(14).value = totals.partsByProject.get(name) ?? 0;
  });
  for (let m = 0; m < 13; m++) {
    const day = addDays(monthStart(addMonths(start, m)), 5);
    if (day > today) break;
    for (const [type, name, supplier, amount] of OVERHEADS) cost(day, name, amount, supplier, type, type === 'Petrol' ? 'Owner CC' : 'FNB CS', null);
  }
  cost(addDays(start, 20), 'Angle grinder', 899, 'Builders', 'Tool', 'Owner CC', null);

  // Trade Statement: invoiced by month (parts and labour rows left out of the check here).
  const months = [...totals.invoicedByMonth.keys()].sort();
  trade.getRow(5).values = ['', ...months.map((m, i) => (i === 0 || m.slice(5) === '01' ? m.slice(0, 4) : ''))];
  trade.getRow(6).values = ['Values', ...months.map((m) => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m.slice(5)) - 1])];
  trade.getRow(7).values = ['Invoiced', ...months.map((m) => totals.invoicedByMonth.get(m) ?? 0)];

  // A trial balance for the first financial year that ended inside the data.
  const fy = financialYear(start, fyEndMonth);
  const tb = wb.addWorksheet(`Trial Balance ${fy.end.slice(0, 7).replace('-', ' ')}`);
  const [y, mo, dd] = fy.end.split('-');
  const monthName = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(mo) - 1];
  tb.getRow(1).getCell(2).value = 'Demo Builders';
  tb.getRow(3).getCell(2).value = `As of ${monthName} ${Number(dd)}, ${y}`;
  tb.getRow(27).values = ['', 'Share capital', null, 100];
  tb.getRow(29).values = ['', 'Example Bank Business Account - 0001', 12500, null];
  tb.getRow(33).values = ['', 'Loan - Demo Owner', null, 20000];

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, totals };
}
