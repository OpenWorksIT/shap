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
  const { has } = useAuthed();
  const workers = has('workers');
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab') as Tab | null;
  const tab: Tab = asked && (workers || asked === 'cost') ? asked : workers ? 'labour' : 'cost';
  const setTab = (t: Tab) => setParams({ tab: t }, { replace: true });
  return (
    <div className="narrow stack-lg">
      <PageHead title={workers ? 'Add' : 'Add a cost'} sub={say('addSub')} />
      {workers && (
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'labour', label: 'Day’s work' },
            { value: 'cost', label: 'Cost' },
            { value: 'pay', label: 'Pay a worker' },
          ]}
        />
      )}
      <div className="panel panel-pad">
        {tab === 'labour' && <LabourForm />}
        {tab === 'cost' && <CostForm key="new-cost" />}
        {tab === 'pay' && <PayForm />}
      </div>
    </div>
  );
}
