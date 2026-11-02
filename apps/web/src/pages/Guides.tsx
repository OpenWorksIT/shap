/**
 * Step-by-step guides to SARS's returns, with where to find each figure in Shap. Shap doesn't
 * file anything, and we're not accountants or tax practitioners: these are directions, not advice.
 */
import { Link, useParams } from 'react-router-dom';
import { PageHead } from '../components/Shell';
import { Icon } from '../components/ui';
import { useAuthed } from '../lib/session';

interface Guide {
  key: string;
  title: string;
  who: string;
  when: string;
  figures: { label: string; to: string }[];
  steps: string[];
  tips: string[];
  source: string;
  show?: (s: { company: boolean; vat: boolean; payroll: boolean; turnover: boolean }) => boolean;
}

const GUIDES: Guide[] = [
  {
    key: 'vat201',
    title: 'VAT return (VAT201)',
    who: 'Businesses registered for VAT.',
    when: 'Every two months (or monthly), by the last business day of the month after the period when you file and pay on eFiling (the 25th if you file on paper).',
    figures: [{ label: 'Accounts → VAT201: the boxes for the period, worked out', to: '/accounts?tab=vat201' }],
    steps: [
      'In Shap, open Accounts → VAT201 and choose the period. Check the invoices, credit notes and costs behind it are all captured (slips with VAT on them, bills not yet paid).',
      'Log in to SARS eFiling (sarsefiling.co.za) and open your VAT return for that period (under Returns, the returns SARS has issued to you).',
      'Type each box from Shap into the same box on the form: supplies and output tax at the top, input tax (capital goods, other goods and services, bad debts) below.',
      'Check the VAT payable (or refund) matches Shap\'s box 20, then submit.',
      'Pay by the due date with the payment reference number (PRN) eFiling gives you, using eFiling or your bank.',
    ],
    tips: [
      'Shap uses the invoice basis (invoices and slips by their dates). If you’re registered on the payments basis, check with your accountant.',
      'Zero-rated sales (box 2) are invoices without VAT. Exempt supplies and exports aren’t split out: check those yourself.',
      'Keep the tax invoices for every input VAT claim. Shap keeps the slip photos with each cost.',
    ],
    source: 'https://www.sars.gov.za/types-of-tax/value-added-tax/',
    show: (s) => s.vat,
  },
  {
    key: 'provisional',
    title: 'Provisional tax (IRP6)',
    who: 'Anyone with income other than a salary (sole proprietors), and every company.',
    when: 'Twice a year: by 31 August and by the last business day of February (for a year starting in March). An optional third top-up by the end of September. Companies: six months into their year, and at year end.',
    figures: [{ label: 'Accounts → Tax estimate: the year projected from the months so far', to: '/accounts?tab=tax' }],
    steps: [
      'In Shap, open Accounts → Tax estimate. Check the projected income and costs make sense for the whole year (change any month you know will be different).',
      'Log in to eFiling and request the provisional tax return (IRP6) for the period (first or second).',
      'Enter your estimated taxable income for the year from Shap’s estimate, and any tax already paid for the year.',
      'Check the tax payable eFiling works out, then submit.',
      'Pay by the due date with the PRN.',
    ],
    tips: [
      'Underestimating at the second payment can bring a penalty. A careful estimate (or your accountant’s) is worth it.',
      'If turnover tax applies to you instead, see the turnover tax guide: it replaces provisional tax.',
    ],
    source: 'https://www.sars.gov.za/types-of-tax/provisional-tax/',
    show: (s) => !s.turnover,
  },
  {
    key: 'itr12',
    title: 'Personal income tax return (ITR12), sole proprietors',
    who: 'You, as a sole proprietor: your business profit is part of your own income.',
    when: 'In SARS’s filing season. For 2026: from 13 July 2026; provisional taxpayers by 22 January 2027.',
    figures: [
      { label: 'Accounts → Income statement for the tax year (March to February)', to: '/accounts?tab=income' },
      { label: 'Accounts → Assets: wear and tear', to: '/accounts?tab=assets' },
    ],
    steps: [
      'In Shap, open the income statement for the tax year. Make sure every invoice, cost and slip for the year is in, and the year is locked (Accounts → Year end).',
      'Log in to eFiling and open your income tax return (ITR12) for the year.',
      'In the return’s questions, say you had business (trade) income, so the local business section appears.',
      'Enter the business’s gross income and its deductible expenses from Shap’s income statement (leave out what you took for yourself: that’s drawings, not a cost).',
      'Add your other income (salary, interest) and deductions (retirement annuity, medical) as usual, then submit.',
    ],
    tips: ['Keep the slips for at least five years: SARS can ask for them. Shap keeps them with each cost.', 'If you have employees, the payroll guides apply too.'],
    source: 'https://www.sars.gov.za/types-of-tax/personal-income-tax/tax-season/',
    show: (s) => !s.company && !s.turnover,
  },
  {
    key: 'itr14',
    title: 'Company income tax return (ITR14)',
    who: 'Every company (Pty) Ltd, trading or not.',
    when: 'Within 12 months after the company’s financial year end.',
    figures: [
      { label: 'Accounts → Income statement and balance sheet for the financial year', to: '/accounts?tab=income' },
      { label: 'Accounts → Year end: the accountant’s figures, agreed', to: '/accounts?tab=yearend' },
    ],
    steps: [
      'Get the company’s annual financial statements done (by your accountant). In Shap, enter their figures under Accounts → Year end so the books agree, and lock the year.',
      'Log in to eFiling as the company (organisation tax types) and open the company income tax return (ITR14) for the year.',
      'The return asks about the company first (size, activities), then the income statement, balance sheet and tax adjustments: take them from the financial statements.',
      'Submit, and pay any tax still owing (after provisional payments) with the PRN.',
    ],
    tips: ['This one really is for your accountant if you’re not sure: the tax adjustments are where mistakes happen.'],
    source: 'https://www.sars.gov.za/types-of-tax/corporate-income-tax/',
    show: (s) => s.company && !s.turnover,
  },
  {
    key: 'emp201',
    title: 'Monthly employer declaration (EMP201)',
    who: 'Employers registered for PAYE (and UIF and SDL).',
    when: 'Every month, by the 7th of the next month (earlier if the 7th is a weekend or holiday).',
    figures: [{ label: 'Payroll → SARS: PAYE, UIF and SDL for each month', to: '/payroll?tab=sars' }],
    steps: [
      'In Shap, finalise the month’s pay run (Payroll), then open Payroll → SARS for the month’s PAYE, UIF and SDL.',
      'Log in to eFiling and open the EMP201 for the month.',
      'Enter the PAYE, SDL and UIF amounts from Shap, check the total and submit.',
      'Pay by the 7th with the PRN, then record the payment in Shap (Payroll → SARS) so it’s off the books.',
    ],
    tips: ['The EMP201 is due even in a month with no payments: file a nil return.'],
    source: 'https://www.sars.gov.za/types-of-tax/pay-as-you-earn/',
    show: (s) => s.payroll,
  },
  {
    key: 'emp501',
    title: 'Employer reconciliation (EMP501) and IRP5s',
    who: 'Employers registered for PAYE.',
    when: 'Twice a year: the interim (March to August) by 31 October, and the annual (the whole tax year) by 31 May.',
    figures: [{ label: 'Payroll → SARS → the tax year: each employee’s totals (CSV)', to: '/payroll?tab=sars' }],
    steps: [
      'In Shap, download the tax year’s payroll totals per employee (Payroll → SARS).',
      'Open SARS’s e@syFile Employer, import or type each employee’s figures, and check they match your EMP201s for the period.',
      'Make the IRP5 certificates and submit the reconciliation to SARS, then give each employee their IRP5.',
    ],
    tips: ['The monthly EMP201s and the reconciliation must agree: fix any month in Shap before you reconcile.'],
    source: 'https://www.sars.gov.za/types-of-tax/pay-as-you-earn/employer-reconciliation/',
    show: (s) => s.payroll,
  },
  {
    key: 'turnover',
    title: 'Turnover tax (TT02 and TT03)',
    who: 'Micro businesses registered for turnover tax (turnover up to R2.3 million a year). It replaces income tax, provisional tax, capital gains tax and dividends tax.',
    when: 'Two interim payments (by the last business day of August and of February, for a March–February year), and the annual return (TT03) from 1 July to 31 January.',
    figures: [{ label: 'Accounts → Tax estimate: turnover so far, the year projected, the two payments', to: '/accounts?tab=tax' }],
    steps: [
      'In Shap (with Turnover tax switched on under Settings → Invoicing), open Accounts → Tax estimate for the turnover and the tax on it.',
      'For each interim payment, pay half the year’s estimated tax by the due date (the TT02 is your own record; it isn’t submitted).',
      'After the year, file the turnover tax return (TT03) on eFiling with the year’s actual turnover from Shap, and pay any balance.',
    ],
    tips: ['Register first (form TT01) before the year starts. You can stay registered for VAT as well.'],
    source: 'https://www.sars.gov.za/types-of-tax/turnover-tax/',
    show: (s) => s.turnover,
  },
  {
    key: 'dividends',
    title: 'Dividends tax return (DTR01)',
    who: 'Companies that pay a dividend.',
    when: 'By the last day of the month after the dividend was paid.',
    figures: [{ label: 'Payroll → Dividends: each dividend and the 20% tax held back', to: '/payroll?tab=dividends' }],
    steps: [
      'In Shap, open Payroll → Dividends for the dividend and the dividends tax on it.',
      'Log in to eFiling as the company and complete the dividends tax return for the month, with the dividend and the tax withheld.',
      'Pay the dividends tax by the end of the next month with the PRN, and record the payment in Shap.',
    ],
    tips: ['Dividends paid to a South African company are exempt, but the return is still needed.'],
    source: 'https://www.sars.gov.za/types-of-tax/dividends-tax/',
    show: (s) => s.company,
  },
];

export default function GuidesPage() {
  const { settings, has } = useAuthed();
  const { topic } = useParams();
  const state = { company: settings.businessType === 'company', vat: settings.vatRegistered, payroll: has('payroll'), turnover: settings.turnoverTax };
  const mine = GUIDES.filter((g) => !g.show || g.show(state));
  const others = GUIDES.filter((g) => g.show && !g.show(state));
  const guide = GUIDES.find((g) => g.key === topic);

  return (
    <div className="stack-lg narrow-wide">
      <PageHead title={guide ? guide.title : 'SARS filing guides'} back={guide ? { to: '/guides', label: 'Guides' } : undefined} />
      <div className="banner signal small">
        <strong>We’re not accountants or tax practitioners, and Shap doesn’t file anything for you.</strong> These guides show where SARS’s forms are and where
        Shap keeps each figure. Only file yourself if you’re lekker with some accounting; if not, a registered tax practitioner is worth every rand. OpenWorks IT
        can’t be held responsible for what’s filed.
      </div>
      {guide ? (
        <article className="stack">
          <section className="panel panel-pad stack">
            <p className="small">
              <strong>Who:</strong> {guide.who}
            </p>
            <p className="small">
              <strong>When:</strong> {guide.when}
            </p>
            <div className="stack-sm">
              <strong className="small">Your figures in Shap</strong>
              {guide.figures.map((f) => (
                <Link key={f.to} to={f.to} className="small">
                  {f.label} →
                </Link>
              ))}
            </div>
          </section>
          <section className="panel panel-pad stack">
            <h3>Step by step</h3>
            <ol className="small steps-list">
              {guide.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </section>
          {guide.tips.length > 0 && (
            <section className="panel panel-pad stack">
              <h3>Good to know</h3>
              <ul className="small steps-list">
                {guide.tips.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </section>
          )}
          <p className="xs muted">
            SARS’s own page:{' '}
            <a href={guide.source} target="_blank" rel="noopener noreferrer">
              {guide.source.replace('https://', '')}
            </a>
            . Dates move when they fall on weekends and holidays: check eFiling.
          </p>
        </article>
      ) : (
        <>
          <ul className="panel list">
            {mine.map((g) => (
              <li key={g.key} className="list-row">
                <Link to={`/guides/${g.key}`} className="grow">
                  <strong>{g.title}</strong>
                  <div className="xs muted">{g.when}</div>
                </Link>
                <Icon name="chevronRight" size={18} />
              </li>
            ))}
          </ul>
          {others.length > 0 && (
            <details className="small">
              <summary>Other returns (not set up for your business)</summary>
              <ul className="list">
                {others.map((g) => (
                  <li key={g.key} className="list-row">
                    <Link to={`/guides/${g.key}`}>{g.title}</Link>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
