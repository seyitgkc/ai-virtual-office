"use client";

import { useState } from "react";
import { EVERY, type Every } from "../lib/standing";
import type { StandingOp } from "../lib/useOffice";
import type { OfficeView } from "../lib/view";
import { ConfirmButton, Section } from "./settingsParts";
import { taskLabel } from "../lib/taskLabels";

/** A time as the field for picking a date and time wants it, in the viewer's own zone. */
const forField = (at: number): string => {
  const d = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

const when = (at: number): string =>
  new Date(at).toLocaleString("en-CA", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

/** Nine in the morning tomorrow: a first time most standing work can start from. */
const tomorrowMorning = (): number => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
};

const blank = () => ({ id: "", title: "", detail: "", urgent: false, every: "weekday" as Every, firstAt: forField(tomorrowMorning()) });

/**
 * Requests the office files by itself. Each is filed in the name of the
 * person who set it up, and from there it is a task like any other.
 */
export function StandingTab({ view, standingOp }: { view: OfficeView; standingOp: (op: StandingOp) => Promise<boolean> }) {
  const [form, setForm] = useState(blank);
  const locked = !view.standingEditable;
  const editing = view.standing.find((s) => s.id === form.id) ?? null;
  const rhythm = (every: Every): string => EVERY.find((e) => e.id === every)?.label ?? every;

  return (
    <>
      <Section
        title="Standing work"
        hint={
          view.isDemoOffice
            ? "The demo office is shared, so it has no standing work. An office of your own can."
            : "When its turn comes, the office files the request and the agent at intake takes it up. It is not filed while the last one it filed is still open."
        }
      >
        <div className="table-scroll">
          <table className="grid-table">
            <thead>
              <tr>
                <th scope="col">Request</th>
                <th scope="col">How often</th>
                <th scope="col">Next</th>
                <th scope="col">Last filed</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {view.standing.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    No standing work yet.
                  </td>
                </tr>
              )}
              {view.standing.map((s) => (
                <tr key={s.id} data-selected={s.id === editing?.id}>
                  <td className="cell-system">
                    {s.title}
                    {s.urgent && <span className="cell-note">Filed as urgent</span>}
                    <span className="cell-note cell-clamp" title={s.detail}>
                      {s.detail}
                    </span>
                  </td>
                  <td className="muted">
                    {rhythm(s.every)}
                    <span className="cell-note">In the name of {s.filedAs}</span>
                  </td>
                  <td className="muted nowrap">{s.active ? when(s.nextAt) : "Paused"}</td>
                  <td className="muted nowrap">
                    {s.lastFiledAt ? when(s.lastFiledAt) : "Not yet"}
                    {s.lastTaskId && <span className="cell-note">{taskLabel(view.office, s.lastTaskId)}</span>}
                  </td>
                  <td className="actions">
                    {!locked && (
                      <>
                        <button type="button" className="btn" onClick={() => void standingOp({ operation: "file", id: s.id })}>
                          File now
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => void standingOp({ operation: s.active ? "pause" : "resume", id: s.id })}
                        >
                          {s.active ? "Pause" : "Take up again"}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() =>
                            setForm({ id: s.id, title: s.title, detail: s.detail, urgent: s.urgent, every: s.every, firstAt: forField(s.nextAt) })
                          }
                        >
                          Edit
                        </button>
                        <ConfirmButton
                          label="Remove"
                          onConfirm={() => {
                            void standingOp({ operation: "remove", id: s.id });
                            if (form.id === s.id) setForm(blank());
                          }}
                        />
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {!locked && (
        <Section title={editing ? `Edit "${editing.title}"` : "Add standing work"}>
          <form
            className="form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              void standingOp({
                operation: "save",
                ...(editing ? { id: editing.id } : {}),
                title: form.title,
                detail: form.detail,
                urgent: form.urgent,
                every: form.every,
                firstAt: new Date(form.firstAt).getTime(),
              }).then((saved) => {
                if (saved) setForm(blank());
              });
            }}
          >
            <label className="wide">
              Title
              <input
                value={form.title}
                maxLength={120}
                placeholder="Morning stock check"
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                required
              />
            </label>
            <label className="wide">
              What is wanted
              <textarea
                value={form.detail}
                rows={4}
                maxLength={2000}
                placeholder="Say what to look at and what to do about it, as you would in a request you filed yourself."
                onChange={(e) => setForm({ ...form, detail: e.target.value })}
                required
              />
            </label>
            <label>
              How often
              <select value={form.every} onChange={(e) => setForm({ ...form, every: e.target.value as Every })}>
                {EVERY.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {editing ? "Next due" : "First due"}
              <input
                type="datetime-local"
                value={form.firstAt}
                onChange={(e) => setForm({ ...form, firstAt: e.target.value })}
                required
              />
            </label>
            <label className="wide check">
              <input type="checkbox" checked={form.urgent} onChange={(e) => setForm({ ...form, urgent: e.target.checked })} />
              File it as urgent, so agents take it ahead of their other work
            </label>
            <p className="wide hint">
              It is filed at the same time of day each time, in your name, for as long as you may file requests here.
            </p>
            <div className="wide row-actions">
              <button type="submit" className="btn primary">
                {editing ? "Save changes" : "Add standing work"}
              </button>
              {editing && (
                <button type="button" className="btn" onClick={() => setForm(blank())}>
                  Cancel
                </button>
              )}
            </div>
          </form>
        </Section>
      )}
    </>
  );
}
