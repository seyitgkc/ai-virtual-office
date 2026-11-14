"use client";

import { useState, type ReactNode } from "react";
import { ALL_SCOPES, type AccessScope, type Effect, type RoomSelector } from "../lib/model";

/** A button that asks for a second click before doing something drastic. */
export function ConfirmButton({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      className="btn warn"
      onClick={() => {
        if (armed) onConfirm();
        setArmed(!armed);
      }}
      onBlur={() => setArmed(false)}
    >
      {armed ? "Click again to confirm" : label}
    </button>
  );
}

/** A text field that saves when you leave it, if the value changed. */
export function SavedField({
  value,
  label,
  placeholder,
  allowEmpty = false,
  onSave,
}: {
  value: string;
  label: string;
  placeholder?: string;
  /** Let the field be cleared. Otherwise an empty field goes back to its value. */
  allowEmpty?: boolean;
  onSave: (next: string) => void;
}) {
  return (
    <input
      key={value}
      aria-label={label}
      defaultValue={value}
      placeholder={placeholder}
      onBlur={(e) => {
        const next = e.target.value.trim();
        if (next !== value && (next || allowEmpty)) onSave(next);
        else e.target.value = value;
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {hint && <p className="hint">{hint}</p>}
      {children}
    </section>
  );
}

/** A row of tabs with an underline on the open one. Arrow keys move along it. */
export function TabBar<T extends string>({
  tabs,
  active,
  onChange,
  label,
  small = false,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
  label: string;
  small?: boolean;
}) {
  return (
    <div className="tabbar" role="tablist" aria-label={label} data-small={small}>
      {tabs.map((t, index) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          tabIndex={active === t.id ? 0 : -1}
          className="tab"
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
            if (step === 0) return;
            const next = tabs[(index + step + tabs.length) % tabs.length];
            onChange(next.id);
            const buttons = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
            buttons?.[(index + step + tabs.length) % tabs.length]?.focus();
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export type CellEffect = Effect | "none";

/**
 * Room access as a table: one row per room, and for each of enter, read and
 * act an Allow box and a Deny box. Ticking one clears the other.
 */
export function AccessGrid({
  rows,
  caption,
  effectOf,
  onChange,
}: {
  rows: { id: RoomSelector; label: string }[];
  caption: string;
  effectOf: (room: RoomSelector, scope: AccessScope) => CellEffect;
  onChange: (room: RoomSelector, scope: AccessScope, effect: CellEffect) => void;
}) {
  return (
    <div className="table-scroll">
      <table className="grid-table access-grid">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th rowSpan={2} scope="col">
              Room
            </th>
            {ALL_SCOPES.map((scope) => (
              <th key={scope} colSpan={2} scope="colgroup" className="group">
                {scope}
              </th>
            ))}
          </tr>
          <tr>
            {ALL_SCOPES.flatMap((scope) => [
              <th key={`${scope}-allow`} scope="col" className="allow">
                Allow
              </th>,
              <th key={`${scope}-deny`} scope="col" className="deny">
                Deny
              </th>,
            ])}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">{row.label}</th>
              {ALL_SCOPES.flatMap((scope) => {
                const effect = effectOf(row.id, scope);
                return (["allow", "deny"] as const).map((kind) => (
                  <td key={`${scope}-${kind}`} className={kind} data-on={effect === kind}>
                    <input
                      type="checkbox"
                      aria-label={`${kind} ${scope} on ${row.label}`}
                      checked={effect === kind}
                      onChange={(e) => onChange(row.id, scope, e.target.checked ? kind : "none")}
                    />
                  </td>
                ));
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
