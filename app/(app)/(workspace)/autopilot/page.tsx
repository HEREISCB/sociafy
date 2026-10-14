import PlanSettings from '../../../../components/autopilot/plan-settings';

export default function AutopilotPage() {
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Autopilot</h1>
          <p className="page-header__sub">What autopilot prepares for you between visits.</p>
        </div>
      </div>
      <PlanSettings />
    </>
  );
}
