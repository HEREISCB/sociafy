import PlanSettings from '../../../../components/autopilot/plan-settings';
import { PageHeader } from '../../../../components/ui';

export const metadata = { title: 'Autopilot' };

export default function AutopilotPage() {
  return (
    <>
      <PageHeader title="Autopilot" sub="What Sociafy makes for you between visits." />
      <PlanSettings />
    </>
  );
}
