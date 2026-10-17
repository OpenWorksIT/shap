import { useSearchParams } from 'react-router-dom';
import { CostForm } from '../components/CostForm';
import { LabourForm } from '../components/LabourForm';
import { PayForm } from '../components/PayForm';
import { PageHead } from '../components/Shell';
import { Tabs } from '../components/ui';
import { useAuthed } from '../lib/session';

type Tab = 'labour' | 'cost' | 'pay';

/** The phone screen: log the crew's day, add a cost with a photo of the slip, pay someone. */
export default function LogPage() {
  const { isOwner } = useAuthed();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'labour';
  const setTab = (t: Tab) => setParams({ tab: t }, { replace: true });
  return (
    <div className="narrow stack-lg">
      <PageHead title="Log" sub="Capture it on site, while it’s fresh." />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'labour', label: 'Day’s work' },
          { value: 'cost', label: 'Cost' },
          ...(isOwner ? [{ value: 'pay' as Tab, label: 'Pay a worker' }] : []),
        ]}
      />
      <div className="panel panel-pad">
        {tab === 'labour' && <LabourForm />}
        {tab === 'cost' && <CostForm key="new-cost" />}
        {tab === 'pay' && isOwner && <PayForm />}
      </div>
    </div>
  );
}
