/**
 * What the test server's made-up businesses sell and spend on, by trade (docs/TEST_SERVER.md).
 * Every name, price, client and supplier here is made up; addresses are on made-up streets, emails
 * on example.com (a domain that never receives mail) and phone numbers start 000.
 *
 * Prices are in rand. A service's price is before VAT; a shelf price (goods sold at the counter)
 * includes VAT, as it would on the shelf. Costs of materials and stock are before VAT.
 */

export type LineCat = 'labour' | 'materials' | 'other' | 'goods';

/** [description, unit, price before VAT, line type] */
export type Service = readonly [string, string, number, LineCat?];
/** [description, unit, cost before VAT] — resold on jobs at a markup. */
export type Material = readonly [string, string, number];
/** [description, SKU, cost before VAT, shelf price with VAT, zero-rated?] */
export type Good = readonly [string, string, number, number, boolean?];

export interface Trade {
  services: readonly Service[];
  materials: readonly Material[];
  /** Sold over the counter, when the business sells. */
  goods?: readonly Good[];
  /** Quotes or invoices a month, before scaling. */
  docs: readonly [number, number];
  /** How big a job is: each line's quantity is multiplied by up to this. */
  size: number;
  /** Counter sales a trading day, when the business sells. */
  sales?: readonly [number, number];
  /** Works from premises it rents (rand a month), or from home (0). */
  rent: number;
  /** A vehicle for the work (a bakkie), or a computer or equipment. */
  asset: 'bakkie' | 'computer' | 'equipment';
  /** Employees on a salary, when there's payroll: [job title, monthly salary in rand]. */
  staff: readonly (readonly [string, number])[];
  /** Day rate for casual workers (rand). */
  dayRate: number;
  /** Who it buys from. */
  suppliers: readonly string[];
}

const SHOP_GOODS: readonly Good[] = [
  ['LED globe 9W', 'LED9', 22, 49],
  ['Extension cord 5 m', 'EXT5', 75, 149],
  ['Batteries AA (4-pack)', 'AA4', 32, 69],
  ['Padlock 40 mm', 'PL40', 55, 119],
  ['Cable ties (100)', 'CT100', 25, 55],
  ['Paint brush 50 mm', 'PB50', 28, 65],
  ['Wood glue 500 ml', 'WG500', 48, 99],
  ['Torch', 'TORCH', 65, 139],
  ['Garden hose 20 m', 'GH20', 180, 349],
  ['Maize meal 5 kg', 'MM5', 52, 79, true],
  ['Brown bread', 'BRD', 14, 21, true],
];

export const TRADES: Record<string, Trade> = {
  builder: {
    services: [
      ['Building labour (team of 2)', 'day', 3200, 'labour'],
      ['Bricklaying', 'm²', 210, 'labour'],
      ['Plastering', 'm²', 95, 'labour'],
      ['Tiling', 'm²', 180, 'labour'],
      ['Site clean-up and rubble removal', 'load', 1450, 'other'],
    ],
    materials: [
      ['Cement 50 kg', 'bag', 105],
      ['Building sand', 'm³', 520],
      ['Face bricks', 'pack of 500', 2400],
      ['Tile adhesive 20 kg', 'bag', 165],
      ['Ceramic floor tiles', 'm²', 189],
      ['Roof sheets 3.6 m', 'each', 285],
    ],
    docs: [3, 6],
    size: 12,
    rent: 0,
    asset: 'bakkie',
    staff: [['Foreman', 16500], ['General worker', 7200]],
    dayRate: 400,
    suppliers: ['Bayside Builders Supply (made up)', 'Coastal Hardware (made up)', 'Karoo Brick Works (made up)'],
  },
  electrician: {
    services: [
      ['Electrical labour', 'hour', 520, 'labour'],
      ['Call-out fee', 'each', 650, 'other'],
      ['Certificate of compliance (CoC)', 'each', 1950, 'labour'],
      ['Distribution board upgrade', 'each', 4800, 'labour'],
      ['Install plug point', 'each', 780, 'labour'],
    ],
    materials: [
      ['Double plug socket', 'each', 89],
      ['2.5 mm² cable', 'm', 14],
      ['Circuit breaker 20 A', 'each', 145],
      ['Earth leakage unit', 'each', 780],
      ['LED downlight', 'each', 95],
    ],
    goods: SHOP_GOODS.slice(0, 5),
    docs: [10, 18],
    size: 4,
    rent: 0,
    asset: 'bakkie',
    staff: [['Electrician', 18500], ['Assistant', 7800]],
    dayRate: 380,
    suppliers: ['Volt Electrical Wholesale (made up)', 'Coastal Hardware (made up)'],
  },
  plumber: {
    services: [
      ['Plumbing labour', 'hour', 480, 'labour'],
      ['Call-out fee', 'each', 600, 'other'],
      ['Geyser replacement (labour)', 'each', 2800, 'labour'],
      ['Unblock drain', 'each', 1150, 'labour'],
      ['Leak detection', 'each', 1600, 'labour'],
    ],
    materials: [
      ['150 L geyser', 'each', 5200],
      ['Geyser element', 'each', 320],
      ['Copper pipe 15 mm', 'm', 95],
      ['Pressure control valve', 'each', 780],
      ['Mixer tap', 'each', 690],
    ],
    docs: [12, 20],
    size: 3,
    rent: 0,
    asset: 'bakkie',
    staff: [['Plumber', 17500]],
    dayRate: 380,
    suppliers: ['Flow Plumbing Supplies (made up)', 'Coastal Hardware (made up)'],
  },
  painter: {
    services: [
      ['Painting labour (team of 3)', 'day', 2900, 'labour'],
      ['Interior painting', 'm²', 48, 'labour'],
      ['Exterior painting', 'm²', 65, 'labour'],
      ['Roof waterproofing', 'm²', 120, 'labour'],
    ],
    materials: [
      ['Acrylic wall paint 20 L', 'tin', 1450],
      ['Primer 5 L', 'tin', 420],
      ['Roller and tray set', 'set', 180],
      ['Masking tape', 'roll', 38],
      ['Waterproofing membrane', 'roll', 650],
    ],
    docs: [3, 7],
    size: 10,
    rent: 0,
    asset: 'bakkie',
    staff: [['Painter', 9800], ['Painter', 9200]],
    dayRate: 350,
    suppliers: ['Colourfast Paint Centre (made up)', 'Coastal Hardware (made up)'],
  },
  handyman: {
    services: [
      ['Handyman labour', 'hour', 380, 'labour'],
      ['Call-out fee', 'each', 450, 'other'],
      ['Rehang door', 'each', 650, 'labour'],
      ['Gutter cleaning', 'each', 950, 'labour'],
      ['Small repairs (half day)', 'each', 1400, 'labour'],
    ],
    materials: [
      ['Door hinges (pair)', 'pair', 85],
      ['Silicone sealant', 'tube', 75],
      ['Wall plugs and screws', 'pack', 45],
      ['Gutter bracket', 'each', 35],
    ],
    docs: [15, 25],
    size: 3,
    rent: 0,
    asset: 'bakkie',
    staff: [['Handyman', 9500]],
    dayRate: 350,
    suppliers: ['Coastal Hardware (made up)'],
  },
  mechanic: {
    services: [
      ['Workshop labour', 'hour', 650, 'labour'],
      ['Minor service (labour)', 'each', 1100, 'labour'],
      ['Major service (labour)', 'each', 2400, 'labour'],
      ['Diagnostics', 'each', 750, 'labour'],
    ],
    materials: [
      ['Oil filter', 'each', 160],
      ['Engine oil 5 L', 'each', 520],
      ['Brake pads (set)', 'set', 780],
      ['Spark plugs (set of 4)', 'set', 360],
      ['Air filter', 'each', 240],
    ],
    goods: [
      ['Wiper blades (pair)', 'WIPER', 120, 249],
      ['Engine oil 1 L', 'OIL1', 95, 179],
      ['Coolant 5 L', 'COOL5', 140, 279],
      ['Car air freshener', 'AIRF', 18, 45],
    ],
    docs: [25, 40],
    size: 2,
    rent: 12000,
    asset: 'equipment',
    staff: [['Mechanic', 16500], ['Apprentice', 6800]],
    dayRate: 380,
    suppliers: ['Gear & Piston Auto Parts (made up)', 'Coastal Hardware (made up)'],
  },
  garden: {
    services: [
      ['Garden maintenance (monthly)', 'month', 1800, 'labour'],
      ['Lawn mowing', 'visit', 450, 'labour'],
      ['Pool cleaning (monthly)', 'month', 950, 'labour'],
      ['Tree felling', 'job', 3800, 'labour'],
      ['Garden refuse removal', 'load', 650, 'other'],
    ],
    materials: [
      ['Pool chlorine 10 kg', 'bucket', 890],
      ['Lawn fertiliser 40 kg', 'bag', 420],
      ['Compost 30 dm³', 'bag', 65],
    ],
    docs: [20, 35],
    size: 2,
    rent: 0,
    asset: 'bakkie',
    staff: [['Garden worker', 6500]],
    dayRate: 300,
    suppliers: ['Green Thumb Nursery (made up)', 'Poolside Supplies (made up)'],
  },
  cleaning: {
    services: [
      ['Office cleaning (monthly contract)', 'month', 4500, 'labour'],
      ['Deep clean', 'each', 2200, 'labour'],
      ['Carpet cleaning', 'm²', 35, 'labour'],
      ['Window cleaning', 'each', 950, 'labour'],
    ],
    materials: [['Cleaning chemicals', 'each', 380]],
    docs: [15, 30],
    size: 2,
    rent: 0,
    asset: 'bakkie',
    staff: [['Cleaner', 6200], ['Cleaner', 6200], ['Supervisor', 9500]],
    dayRate: 280,
    suppliers: ['Sparkle Cleaning Supplies (made up)'],
  },
  hair: {
    services: [
      ['Cut and blow-dry', 'each', 380, 'labour'],
      ['Colour', 'each', 950, 'labour'],
      ['Highlights', 'each', 1250, 'labour'],
      ['Beard trim', 'each', 150, 'labour'],
      ['Manicure', 'each', 280, 'labour'],
    ],
    materials: [['Colour and developer', 'each', 140]],
    goods: [
      ['Shampoo 300 ml', 'SH300', 95, 189],
      ['Conditioner 300 ml', 'CO300', 98, 199],
      ['Styling gel', 'GEL', 55, 119],
      ['Hair treatment mask', 'MASK', 140, 289],
    ],
    docs: [25, 40],
    size: 1,
    sales: [8, 15],
    rent: 9500,
    asset: 'equipment',
    staff: [['Stylist', 9800], ['Nail technician', 7500]],
    dayRate: 300,
    suppliers: ['Salon Pro Wholesale (made up)'],
  },
  it: {
    services: [
      ['IT support', 'hour', 650, 'labour'],
      ['Network installation', 'job', 4800, 'labour'],
      ['Monthly support retainer', 'month', 3500, 'labour'],
      ['Laptop set-up', 'each', 850, 'labour'],
    ],
    materials: [
      ['Wi-Fi access point', 'each', 1450],
      ['Network switch 8-port', 'each', 650],
      ['SSD 1 TB', 'each', 1150],
      ['Cat6 cable', 'm', 9],
    ],
    docs: [8, 15],
    size: 3,
    rent: 0,
    asset: 'computer',
    staff: [['Technician', 18500]],
    dayRate: 450,
    suppliers: ['Bytewise Distribution (made up)', 'Cloudnine Hosting (made up)'],
  },
  design: {
    services: [
      ['Logo design', 'each', 4500, 'labour'],
      ['Brand identity pack', 'each', 12500, 'labour'],
      ['Social media design (monthly)', 'month', 3800, 'labour'],
      ['Design time', 'hour', 550, 'labour'],
      ['Print layout', 'each', 1800, 'labour'],
    ],
    materials: [['Printing (outsourced)', 'job', 1600]],
    docs: [6, 12],
    size: 2,
    rent: 0,
    asset: 'computer',
    staff: [['Junior designer', 12500]],
    dayRate: 450,
    suppliers: ['Inkspot Printers (made up)', 'Cloudnine Hosting (made up)'],
  },
  photo: {
    services: [
      ['Event photography', 'hour', 950, 'labour'],
      ['Wedding package', 'each', 18500, 'labour'],
      ['Product shoot', 'day', 6500, 'labour'],
      ['Photo editing', 'hour', 450, 'labour'],
    ],
    materials: [['Printed album', 'each', 2400]],
    docs: [5, 10],
    size: 2,
    rent: 0,
    asset: 'computer',
    staff: [['Assistant photographer', 9500]],
    dayRate: 500,
    suppliers: ['Lightbox Camera Hire (made up)', 'Inkspot Printers (made up)'],
  },
  consulting: {
    services: [
      ['Consulting', 'hour', 1100, 'labour'],
      ['Strategy workshop', 'day', 9500, 'labour'],
      ['Monthly advisory retainer', 'month', 12000, 'labour'],
      ['Report writing', 'hour', 850, 'labour'],
    ],
    materials: [],
    docs: [5, 10],
    size: 2,
    rent: 0,
    asset: 'computer',
    staff: [['Analyst', 22000]],
    dayRate: 600,
    suppliers: ['Cloudnine Hosting (made up)', 'Paperclip Office Supplies (made up)'],
  },
  tutor: {
    services: [
      ['Lesson (1 hour)', 'hour', 350, 'labour'],
      ['Exam preparation (10 lessons)', 'each', 3200, 'labour'],
      ['Group class', 'each', 180, 'labour'],
    ],
    materials: [['Workbooks', 'each', 120]],
    docs: [20, 35],
    size: 2,
    rent: 0,
    asset: 'computer',
    staff: [['Tutor', 9500]],
    dayRate: 350,
    suppliers: ['Paperclip Office Supplies (made up)'],
  },
  catering: {
    services: [
      ['Catering per head', 'head', 285, 'labour'],
      ['Event set-up and staff', 'event', 3500, 'labour'],
      ['Platters', 'each', 650, 'other'],
    ],
    materials: [
      ['Ingredients', 'event', 2400],
      ['Hired crockery and linen', 'event', 900],
    ],
    goods: [
      ['Sandwich', 'SAND', 18, 45],
      ['Muffin', 'MUF', 9, 25],
      ['Coffee', 'COF', 7, 28],
    ],
    docs: [6, 12],
    size: 4,
    sales: [10, 25],
    rent: 8500,
    asset: 'equipment',
    staff: [['Chef', 14500], ['Kitchen assistant', 6500]],
    dayRate: 350,
    suppliers: ['Fresh Market Foods (made up)', 'Party Hire Co. (made up)'],
  },
  health: {
    services: [
      ['Consultation', 'each', 650, 'labour'],
      ['Follow-up consultation', 'each', 450, 'labour'],
      ['Treatment session', 'each', 550, 'labour'],
    ],
    materials: [['Consumables', 'each', 85]],
    goods: [
      ['Massage oil', 'OIL', 75, 169],
      ['Heat pack', 'HEAT', 60, 139],
    ],
    docs: [25, 40],
    size: 1,
    rent: 11000,
    asset: 'equipment',
    staff: [['Receptionist', 8500]],
    dayRate: 350,
    suppliers: ['Medisupply Wholesale (made up)', 'Paperclip Office Supplies (made up)'],
  },
  transport: {
    services: [
      ['Local delivery', 'trip', 650, 'labour'],
      ['Long-distance load', 'km', 22, 'labour'],
      ['Furniture removal', 'job', 3800, 'labour'],
      ['Waiting time', 'hour', 250, 'other'],
    ],
    materials: [],
    docs: [15, 25],
    size: 3,
    rent: 0,
    asset: 'bakkie',
    staff: [['Driver', 9800], ['Loader', 6200]],
    dayRate: 320,
    suppliers: ['Roadside Tyres (made up)', 'Coastal Hardware (made up)'],
  },
  retail: {
    services: [['Delivery', 'trip', 350, 'other']],
    materials: [],
    goods: SHOP_GOODS,
    docs: [2, 5],
    size: 20,
    sales: [8, 16],
    rent: 14000,
    asset: 'equipment',
    staff: [['Shop assistant', 6500], ['Shop assistant', 6500]],
    dayRate: 300,
    suppliers: ['Highveld Wholesalers (made up)', 'Coastal Hardware (made up)'],
  },
  other: {
    services: [
      ['Services', 'hour', 450, 'labour'],
      ['Call-out fee', 'each', 500, 'other'],
    ],
    materials: [['Materials', 'each', 300]],
    docs: [10, 20],
    size: 3,
    rent: 0,
    asset: 'computer',
    staff: [['Assistant', 8500]],
    dayRate: 350,
    suppliers: ['Coastal Hardware (made up)', 'Paperclip Office Supplies (made up)'],
  },
};

export const tradeFor = (industry: string): Trade => TRADES[industry] ?? TRADES.other!;

/** What a shop sells when a trade has no counter goods of its own. */
export const GENERIC_GOODS: readonly Good[] = SHOP_GOODS;

/** Made-up clients: a mix of people and businesses. The businesses marked `vat` are VAT vendors. */
export const CLIENTS: readonly { name: string; contact?: string; vat?: boolean }[] = [
  { name: 'Acacia Lodge', contact: 'Sibusiso Ndlovu', vat: true },
  { name: 'Bayview Guesthouse', contact: 'Annelie Kruger', vat: true },
  { name: 'Lerato Mokoena' },
  { name: 'Jan Smith' },
  { name: 'Priya Naidoo' },
  { name: 'Riverside Primary School', contact: 'The bursar' },
  { name: 'Umhlanga Property Trust', contact: 'Kevin Pillay', vat: true },
  { name: 'Nomvula Dlamini' },
  { name: 'Kloof Street Dental', contact: 'Dr Fatima Essop', vat: true },
  { name: 'Pieter van Wyk' },
  { name: 'Zanele Khumalo' },
  { name: 'Sunrise Body Corporate', contact: 'The trustees' },
  { name: 'Thabo Molefe' },
  { name: 'Ocean Breeze Restaurant', contact: 'Marco Rossi', vat: true },
  { name: 'Grace Adams' },
  { name: 'Mountain View Estate', contact: 'Estate manager', vat: true },
  { name: 'Sipho Zulu' },
  { name: 'Karabo Sithole' },
  { name: 'Hendrik Botha' },
  { name: 'Ayanda Mthembu' },
  { name: 'Coastline Logistics', contact: 'Nadia Hendricks', vat: true },
  { name: 'Faith Community Church', contact: 'Pastor Moses Tau' },
  { name: 'Michelle de Villiers' },
  { name: 'Bongani Nkosi' },
];

/** Made-up people: owners, partners, directors, trustees, employees and casual workers. */
export const PEOPLE = [
  'Thandi Mokoena',
  'Pieter Botha',
  'Ayesha Patel',
  'Lwazi Dube',
  'Carla Fourie',
  'Musa Ngcobo',
  'Refilwe Maseko',
  'Johan Pretorius',
  'Nandi Cele',
  'Ruben Daniels',
  'Lindiwe Mahlangu',
  'Tshepo Radebe',
] as const;

export const WORKER_NAMES = ['Sipho', 'Themba', 'Lucky', 'Precious', 'Andile', 'Bheki'] as const;

/** Made-up streets, suburbs and town for the addresses: plainly not anyone's real address. */
export const STREETS = ['Test Street', 'Example Road', 'Sample Avenue', 'Specimen Lane', 'Mock Crescent', 'Model Drive', 'Pretend Place', 'Dummy Close'] as const;
export const SUBURBS = ['Testville', 'Exampleton', 'Sampledale', 'Mockford', 'Modelpark'] as const;
export const TOWN = 'Fictional Town 0001';
