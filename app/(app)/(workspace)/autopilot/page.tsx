import PlanSettings from '../../../../components/autopilot/plan-settings';
import { PageHeader } from '../../../../components/ui';

export default function AutopilotPage() {
  return (
    <>
      <PageHeader title="Autopilot" sub="What Sociafy makes for you between visits." />
      <PlanSettings />
    </>
  );
}
