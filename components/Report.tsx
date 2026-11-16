"use client";

import { span, workReport } from "../lib/report";
import type { OfficeView } from "../lib/view";
import { KindBadge } from "./Panels";

/**
 * How the office has been doing: what was filed and closed, where work
 * stopped for a person, how long each stage takes, and what each agent and
 * person did. Counted from the tasks and threads the viewer can see, so it is
 * offered to people who see everything.
 */
export function Report({ view, onClose }: { view: OfficeView; onClose: () => void }) {
  const { office } = view;
  const report = workReport(office);
  const figures: { label: string; value: string; note: string }[] = [
    { label: "Filed", value: String(report.filed), note: `${report.open} open${report.urgentOpen > 0 ? `, ${report.urgentOpen} of them urgent` : ""}, ${report.completed} completed, ${report.rejected} rejected` },
    {
      label: "Completed with nobody asked",
      value: report.completed === 0 ? "none yet" : `${report.straightThrough} of ${report.completed}`,
      note: "No question, approval, request for access or send-back before the review",
    },
    { label: "From filed to closed", value: span(report.medianToClose), note: "The middle value across closed tasks" },
    { label: "From a question to its answer", value: span(report.medianToAnswer), note: "How long agents wait for people" },
    { label: "Waiting for a person now", value: String(report.waitingOnAPerson), note: "A question, missing access or a review" },
    { label: "Waiting for a day", value: String(report.waitingForADay), note: "Set by an agent to be picked up again on a named day" },
  ];
  const load = (id: string): string => {
    const now = view.agentLoad[id];
    if (!now) return "Free";
    return `${now.taskId ? `On ${now.taskId}` : "About to start"}${now.waiting > 0 ? `, ${now.waiting} waiting` : ""}`;
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog report" role="dialog" aria-modal="true" aria-labelledby="report-heading" onClick={(e) => e.stopPropagation()}>
        <div className="report-head">
          <div>
            <h2 id="report-heading">How {office.name} is doing</h2>
            <p>Counted from every task and thread in the office, since it began.</p>
          </div>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="report-body">
          <dl className="figures">
            {figures.map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
                <span>{f.note}</span>
              </div>
            ))}
          </dl>

          <h3>Where work stopped for a person</h3>
          <table className="grid-table">
            <thead>
              <tr>
                <th scope="col">Reason</th>
                <th scope="col" className="number">Times</th>
                <th scope="col">What it means</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["A question", report.halts.questions, "An agent could not settle something from the request, the thread or the records."],
                ["An approval", report.halts.approvals, "An agent asked to act in a system that holds each action for a person."],
                ["Missing access", report.halts.access, "An agent needed a room its role may not use."],
                ["Sent back from review", report.halts.sentBack, "A reviewer found the work unfinished."],
              ].map(([reason, times, meaning]) => (
                <tr key={String(reason)}>
                  <th scope="row">{reason}</th>
                  <td className="number">{times}</td>
                  <td className="muted">{meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>By stage</h3>
          <table className="grid-table">
            <thead>
              <tr>
                <th scope="col">Stage</th>
                <th scope="col">Room</th>
                <th scope="col" className="number">Tasks there now</th>
                <th scope="col" className="number">Time a task spends there</th>
              </tr>
            </thead>
            <tbody>
              {report.stages.map((s) => (
                <tr key={s.stage}>
                  <th scope="row">{s.label}</th>
                  <td className="muted">
                    {office.floorplan.rooms.find((r) => r.id === office.stageRooms[s.stage as keyof typeof office.stageRooms])?.name ?? ""}
                  </td>
                  <td className="number">{s.now}</td>
                  <td className="number">{span(s.median)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>By agent</h3>
          <table className="grid-table">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Right now</th>
                <th scope="col" className="number">Open tasks</th>
                <th scope="col" className="number">Updates written</th>
                <th scope="col" className="number">Actions in systems</th>
                <th scope="col" className="number">Questions asked</th>
                <th scope="col" className="number">Notes sent</th>
              </tr>
            </thead>
            <tbody>
              {report.agents.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    No agents work here yet.
                  </td>
                </tr>
              )}
              {report.agents.map((a) => {
                const agent = office.participants.find((p) => p.id === a.id);
                return (
                  <tr key={a.id}>
                    <th scope="row">
                      {agent && <KindBadge kind={agent.kind} agentType={agent.agentType} />} {a.name}
                      <span className="cell-note">{a.title}</span>
                    </th>
                    <td className="muted">{load(a.id)}</td>
                    <td className="number">{a.openTasks}</td>
                    <td className="number">{a.updates}</td>
                    <td className="number">{a.actions}</td>
                    <td className="number">{a.questions}</td>
                    <td className="number">{a.notes}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <h3>By person</h3>
          <table className="grid-table">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col" className="number">Requests filed</th>
                <th scope="col" className="number">Answers given</th>
                <th scope="col" className="number">Reviews decided</th>
              </tr>
            </thead>
            <tbody>
              {report.people.map((p) => (
                <tr key={p.id}>
                  <th scope="row">
                    {p.name}
                    <span className="cell-note">{p.title}</span>
                  </th>
                  <td className="number">{p.filed}</td>
                  <td className="number">{p.answers}</td>
                  <td className="number">{p.decisions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
