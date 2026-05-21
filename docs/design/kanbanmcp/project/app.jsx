/* ============================================================
   KanbanMCP — Design canvas app entry
   Mounts all screens + variations as artboards in sections.
   ============================================================ */

function App() {
  return (
    <DesignCanvas>
      <DCSection
        id="screens"
        title="screens"
        subtitle="canonical KanbanMCP screens — light-paper Autogeny variant"
      >
        <DCArtboard id="board"      label="01 · board"        width={1440} height={900}>
          <BoardScreen />
        </DCArtboard>
        <DCArtboard id="card-modal" label="02 · card detail"  width={1440} height={900}>
          <CardModalScreen />
        </DCArtboard>
        <DCArtboard id="dashboard"  label="03 · dashboard"    width={1440} height={900}>
          <DashboardScreen />
        </DCArtboard>
        <DCArtboard id="helpdesk"   label="04 · helpdesk"     width={1440} height={900}>
          <HelpdeskScreen />
        </DCArtboard>
      </DCSection>

      <DCSection
        id="priority"
        title="priority indicators"
        subtitle="three ways to render P1–P4 on a kanban card"
      >
        <DCArtboard id="prio-a" label="A · edge bar (canonical)" width={640} height={520}>
          <PrioVariantA />
        </DCArtboard>
        <DCArtboard id="prio-b" label="B · mono pill"            width={640} height={520}>
          <PrioVariantB />
        </DCArtboard>
        <DCArtboard id="prio-c" label="C · tally bars"           width={640} height={520}>
          <PrioVariantC />
        </DCArtboard>
      </DCSection>

      <DCSection
        id="subtree"
        title="sub-issue tree"
        subtitle="three layouts for the materialised-path hierarchy"
      >
        <DCArtboard id="tree-a" label="A · indent (canonical)"   width={720} height={560}>
          <TreeVariantA />
        </DCArtboard>
        <DCArtboard id="tree-b" label="B · outline numbers"      width={720} height={560}>
          <TreeVariantB />
        </DCArtboard>
        <DCArtboard id="tree-c" label="C · path-graph"           width={720} height={620}>
          <TreeVariantC />
        </DCArtboard>
      </DCSection>

      <DCSection
        id="ai-comments"
        title="ai review comments"
        subtitle="three quiet treatments — structured findings selected"
      >
        <DCArtboard id="ai-a" label="A · inline"                 width={680} height={420}>
          <AiCommentA />
        </DCArtboard>
        <DCArtboard id="ai-b" label="B · hairline-bordered"      width={680} height={420}>
          <AiCommentB />
        </DCArtboard>
        <DCArtboard id="ai-c" label="C · structured (canonical)" width={680} height={520}>
          <AiCommentC />
        </DCArtboard>
      </DCSection>
    </DesignCanvas>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
