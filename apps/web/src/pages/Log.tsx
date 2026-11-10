import { useSearchParams } from 'react-router-dom';
import { CostForm } from '../components/CostForm';
import { LabourForm } from '../components/LabourForm';
import { PayForm } from '../components/PayForm';
import { PageHead } from '../components/Shell';
import { Tabs } from '../components/ui';
import { useAuthed } from '../lib/session';
import { say } from '../lib/words';

type Tab = 'labour' | 'cost' | 'pay';

/** The phone screen: log the crew's day, add a cost with a photo of the slip, pay someone. */
export default function LogPage() {
  const { has, can, canAny } = useAuthed();
  // Each tab is someone's job: logging days, capturing slips, paying the workers.
  const isOwner = has('workers') && can('workers.manage');
  const workers = has('workers') && canAny('labour.log', 'workers.manage');
  const costs = canAny('costs.capture', 'costs.manage');
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab') as Tab | null;
  const allowed = (t: Tab) => (t === 'labour' ? workers : t === 'cost' ? costs : isOwner);
  const tab: Tab = asked && allowed(asked) ? asked : workers ? 'labour' : costs ? 'cost' : 'pay';
  const setTab = (t: Tab) => setParams({ tab: t }, { replace: true });
  return (
    <div className="narrow stack-lg">
      <PageHead title="Log" sub={say('addSub')} />
      {[workers, costs, isOwner].filter(Boolean).length > 1 && (
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            ...(workers ? [{ value: 'labour' as Tab, label: 'Day’s work' }] : []),
            ...(costs ? [{ value: 'cost' as Tab, label: 'Cost' }] : []),
            ...(isOwner ? [{ value: 'pay' as Tab, label: 'Pay a worker' }] : []),
          ]}
        />
      )}
      <div className="panel panel-pad">
        {tab === 'labour' && workers && <LabourForm />}
        {tab === 'cost' && costs && <CostForm key="new-cost" />}
        {tab === 'pay' && isOwner && <PayForm />}
      </div>
    </div>
  );
}
