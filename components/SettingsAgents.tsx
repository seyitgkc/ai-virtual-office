"use client";

import { useState } from "react";
import type { AdminOp } from "../lib/admin";
import { SUGGESTED_MODELS } from "../lib/aiModels";
import { stageSpec } from "../lib/engine";
import {
  ALL_SCOPES,
  PLAYBOOK_STAGES,
  type AccessScope,
  type AgentType,
  type Office,
  type Participant,
  type PlaybookStep,
} from "../lib/model";
import { operationOf, type ConnectedSystem, type SystemAction } from "../lib/systems";
import type { ProviderOp } from "../lib/useOffice";
import type { OfficeView, ProviderKind, ProviderView } from "../lib/view";
import { KindBadge } from "./Panels";
import { ConfirmButton, SavedField, Section } from "./settingsParts";

const KIND_LABEL: Record<ProviderKind, string> = {
  anthropic: "Anthropic",
  openai_compatible: "OpenAI compatible",
};

const AGENT_TYPES: { id: AgentType; label: string; note: string }[] = [
  { id: "ai", label: "AI agent", note: "Asks a language model what to do at each step." },
  { id: "playbook", label: "Playbook agent", note: "Follows written when-then steps. No model is involved." },
];

/** Choose between the two kinds of agent. */
function AgentTypeChoice({
  name,
  value,
  onChange,
}: {
  name: string;
  value: AgentType;
  onChange: (next: AgentType) => void;
}) {
  return (
    <fieldset className="choice wide">
      <legend>Kind of agent</legend>
      {AGENT_TYPES.map((t) => (
        <label key={t.id} className="choice-option" data-on={value === t.id}>
          <input type="radio" name={name} checked={value === t.id} onChange={() => onChange(t.id)} />
          <span>
            <strong>{t.label}</strong>
            <span className="cell-note">{t.note}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function ProviderSelect({
  providers,
  value,
  label,
  onChange,
}: {
  providers: ProviderView[];
  value: string;
  label: string;
  onChange: (next: string) => void;
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">No provider chosen</option>
      {providers.map((p) => (
        <option key={p.id} value={p.id} disabled={!p.selectable && p.id !== value}>
          {p.name}: {p.defaultModel}
          {p.sharedBy ? ` (from ${p.sharedBy === "you" ? "your account" : `${p.sharedBy}'s account`})` : ""}
          {p.usable ? "" : " (needs a key)"}
        </option>
      ))}
    </select>
  );
}

/** How an agent gets its answers, in a few words. */
function worksFrom(p: Participant, providers: ProviderView[]): { text: string; warn: boolean } {
  if (p.kind !== "agent") return { text: "", warn: false };
  if (p.agentType !== "ai") {
    const n = p.playbook.length;
    return { text: `Playbook, ${n} step${n === 1 ? "" : "s"}`, warn: n === 0 };
  }
  const provider = providers.find((x) => x.id === p.providerId);
  if (!provider) return { text: "No provider chosen", warn: true };
  return { text: `${provider.name}, ${p.model ?? provider.defaultModel}`, warn: !provider.usable };
}

// ---------------------------------------------------------------------------

export function PeopleTab({
  office,
  viewer,
  providers,
  adminOp,
}: {
  office: Office;
  viewer: Participant;
  providers: ProviderView[];
  adminOp: (op: AdminOp) => Promise<boolean>;
}) {
  const roles = Object.values(office.roles);
  // A corridor holds no desk, so it is not offered as a place to sit.
  const rooms = office.floorplan.rooms.filter((r) => !r.corridor);
  const agentRoles = roles.filter((r) => r.permissions.length === 0);
  const [configuring, setConfiguring] = useState<string | null>(null);
  const agent = office.participants.find((p) => p.id === configuring && p.kind === "agent") ?? null;

  return (
    <>
      <Section
        title="People and agents"
        hint="Names and titles save when you leave the field. Changing the room moves the desk. People join through Invite on the main screen."
      >
        <div className="table-scroll">
          <table className="grid-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Title</th>
                <th scope="col">Role</th>
                <th scope="col">Room</th>
                <th scope="col">Works from</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {office.participants.map((p) => {
                const desk = office.floorplan.desks.find((d) => d.id === p.deskId);
                const source = worksFrom(p, providers);
                return (
                  <tr key={p.id} data-selected={p.id === agent?.id}>
                    <td>
                      <span className="name-cell">
                        <KindBadge kind={p.kind} agentType={p.agentType} />
                        <SavedField
                          label={`Name of ${p.displayName}`}
                          value={p.displayName}
                          onSave={(next) =>
                            adminOp({ type: "UPDATE_PARTICIPANT", participantId: p.id, displayName: next })
                          }
                        />
                      </span>
                    </td>
                    <td>
                      <SavedField
                        label={`Title of ${p.displayName}`}
                        value={p.title}
                        onSave={(next) => adminOp({ type: "UPDATE_PARTICIPANT", participantId: p.id, title: next })}
                      />
                    </td>
                    <td>
                      <select
                        aria-label={`Role of ${p.displayName}`}
                        value={p.roleId}
                        onChange={(e) =>
                          adminOp({ type: "UPDATE_PARTICIPANT", participantId: p.id, roleId: e.target.value })
                        }
                      >
                        {roles
                          .filter((r) => p.kind === "human" || r.permissions.length === 0 || r.id === p.roleId)
                          .map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                      </select>
                    </td>
                    <td>
                      <select
                        aria-label={`Room of ${p.displayName}`}
                        value={desk?.roomId ?? ""}
                        onChange={(e) =>
                          adminOp({ type: "UPDATE_PARTICIPANT", participantId: p.id, roomId: e.target.value })
                        }
                      >
                        {!desk && <option value="">No desk</option>}
                        {rooms.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="muted" data-warn={source.warn}>
                      {p.kind === "human" ? (p.id === viewer.id ? "You" : "") : source.text}
                    </td>
                    <td className="actions">
                      {p.kind === "agent" && (
                        <button
                          type="button"
                          className="btn"
                          aria-expanded={p.id === agent?.id}
                          onClick={() => setConfiguring(p.id === agent?.id ? null : p.id)}
                        >
                          {p.id === agent?.id ? "Close" : "Configure"}
                        </button>
                      )}
                      {p.id !== viewer.id && (
                        <ConfirmButton
                          label="Remove"
                          onConfirm={() => adminOp({ type: "REMOVE_PARTICIPANT", participantId: p.id })}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      {agent && <AgentEditor office={office} agent={agent} providers={providers} adminOp={adminOp} />}

      <AddAgent office={office} agentRoles={agentRoles} providers={providers} adminOp={adminOp} />
    </>
  );
}

// ---------------------------------------------------------------------------

function AddAgent({
  office,
  agentRoles,
  providers,
  adminOp,
}: {
  office: Office;
  agentRoles: Office["roles"][string][];
  providers: ProviderView[];
  adminOp: (op: AdminOp) => Promise<boolean>;
}) {
  // A corridor holds no desk, so it is not offered as a place to sit.
  const rooms = office.floorplan.rooms.filter((r) => !r.corridor);
  const [displayName, setDisplayName] = useState("");
  const [title, setTitle] = useState("");
  const [roleId, setRoleId] = useState(agentRoles[0]?.id ?? "");
  const [roomId, setRoomId] = useState(rooms[0]?.id ?? "");
  const [agentType, setAgentType] = useState<AgentType>(providers.some((p) => p.usable) ? "ai" : "playbook");
  const [providerId, setProviderId] = useState(providers.find((p) => p.usable)?.id ?? "");
  const [model, setModel] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const role = agentRoles.some((r) => r.id === roleId) ? roleId : (agentRoles[0]?.id ?? "");
  const room = rooms.some((r) => r.id === roomId) ? roomId : (rooms[0]?.id ?? "");
  const provider = providers.find((p) => p.id === providerId);

  return (
    <Section
      title="Add an agent"
      hint="An agent gets a desk and a role, and its access follows from the role. Only roles without permissions can be given to an agent."
    >
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void adminOp({
            type: "ADD_AGENT",
            displayName,
            title,
            roleId: role,
            roomId: room,
            capabilities: capabilities.split("\n"),
            agentType,
            providerId: agentType === "ai" ? provider?.id ?? null : null,
            model: agentType === "ai" && model.trim() ? model.trim() : null,
          }).then((added) => {
            if (!added) return;
            setDisplayName("");
            setTitle("");
            setCapabilities("");
            setModel("");
          });
        }}
      >
        <label>
          Name
          <input
            value={displayName}
            maxLength={60}
            placeholder="Leave empty and one is picked"
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
        <label>
          Title
          <input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRoleId(e.target.value)}>
            {agentRoles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Desk in
          <select value={room} onChange={(e) => setRoomId(e.target.value)}>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <AgentTypeChoice name="new-agent-type" value={agentType} onChange={setAgentType} />
        {agentType === "ai" && (
          <>
            <label>
              AI provider
              <ProviderSelect
                label="AI provider for the new agent"
                providers={providers}
                value={provider?.id ?? ""}
                onChange={setProviderId}
              />
            </label>
            <label>
              Model
              <input
                value={model}
                maxLength={80}
                placeholder={provider ? `${provider.defaultModel} (the provider's default)` : "The provider's default"}
                onChange={(e) => setModel(e.target.value)}
              />
            </label>
            {providers.length === 0 && (
              <p className="hint wide">
                This office has no AI provider yet. Add one under AI providers, or the agent will stop work when a
                task reaches it.
              </p>
            )}
          </>
        )}
        {agentType === "playbook" && (
          <p className="hint wide">A new playbook agent starts with no steps. Add them with Configure once it exists.</p>
        )}
        <label className="wide">
          What it can do, one per line
          <textarea rows={3} value={capabilities} onChange={(e) => setCapabilities(e.target.value)} />
        </label>
        <button type="submit" className="btn primary" disabled={agentRoles.length === 0}>
          Add agent
        </button>
      </form>
    </Section>
  );
}

// ---------------------------------------------------------------------------

function AgentEditor({
  office,
  agent,
  providers,
  adminOp,
}: {
  office: Office;
  agent: Participant;
  providers: ProviderView[];
  adminOp: (op: AdminOp) => Promise<boolean>;
}) {
  const agentType: AgentType = agent.agentType === "ai" ? "ai" : "playbook";
  const provider = providers.find((p) => p.id === agent.providerId);
  const update = (change: Partial<Extract<AdminOp, { type: "UPDATE_PARTICIPANT" }>>) =>
    adminOp({ type: "UPDATE_PARTICIPANT", participantId: agent.id, ...change });

  return (
    <Section title={`Configure ${agent.displayName}`}>
      <div className="form-grid">
        <AgentTypeChoice
          name={`agent-type-${agent.id}`}
          value={agentType}
          onChange={(next) =>
            update(
              next === "ai" && !agent.providerId
                ? { agentType: next, providerId: providers.find((p) => p.usable)?.id ?? null }
                : { agentType: next },
            )
          }
        />
        {agentType === "ai" && (
          <>
            <label>
              AI provider
              <ProviderSelect
                label={`AI provider for ${agent.displayName}`}
                providers={providers}
                value={provider?.id ?? ""}
                onChange={(next) => update({ providerId: next || null })}
              />
            </label>
            <label>
              Model
              <SavedField
                label={`Model for ${agent.displayName}`}
                value={agent.model ?? ""}
                placeholder={provider ? `${provider.defaultModel} (the provider's default)` : "The provider's default"}
                allowEmpty
                onSave={(next) => update({ model: next || null })}
              />
            </label>
            {(!provider || !provider.usable) && (
              <p className="hint wide" data-warn="true">
                {provider
                  ? `${provider.name} has no usable API key, so ${agent.displayName} will stop work when a task reaches it.`
                  : `${agent.displayName} has no AI provider, so it will stop work when a task reaches it.`}
              </p>
            )}
          </>
        )}
        <label className="wide">
          What it can do, one per line
          <textarea
            key={agent.capabilities.join("\n")}
            rows={3}
            defaultValue={agent.capabilities.join("\n")}
            onBlur={(e) => {
              if (e.target.value.trim() !== agent.capabilities.join("\n")) {
                update({ capabilities: e.target.value.split("\n") });
              }
            }}
          />
        </label>
      </div>
      {agentType === "playbook" && (
        <PlaybookEditor
          key={`${agent.id}:${JSON.stringify(agent.playbook)}`}
          office={office}
          agent={agent}
          onSave={(steps) => adminOp({ type: "SET_PLAYBOOK", participantId: agent.id, steps })}
        />
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------

const blankStep = (id: string): PlaybookStep => ({
  id,
  when: { stage: "any", requestContains: "", requestedBy: "anyone" },
  then: { statusNote: "", output: null, question: null, assumption: null, need: null, action: null, note: null },
});

/** The first thing a system offers, with nothing filled in. */
const blankAction = (system: ConnectedSystem): SystemAction => ({
  systemId: system.id,
  operation: system.operations[0]?.id ?? "",
  fields: {},
});

/** The system, the operation and that operation's fields, for one playbook step. */
function ActionFields({
  action,
  systems,
  onChange,
}: {
  action: SystemAction;
  systems: Office["systems"];
  onChange: (action: SystemAction) => void;
}) {
  const system = systems.find((s) => s.id === action.systemId);
  if (!system) {
    return <p className="hint">The system this step used is no longer connected, so the step skips it.</p>;
  }
  const operation = operationOf(system, action.operation) ?? system.operations[0];
  if (!operation) return <p className="hint">{system.name} lists nothing that can be done in it.</p>;
  return (
    <>
      <div className="step-fields">
        <label>
          System
          <select
            value={system.id}
            onChange={(e) => {
              const next = systems.find((s) => s.id === e.target.value);
              if (next) onChange(blankAction(next));
            }}
          >
            {systems.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Do
          <select
            value={operation.id}
            onChange={(e) => onChange({ systemId: system.id, operation: e.target.value, fields: {} })}
          >
            {system.operations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="step-fields three">
        {operation.fields.map((field) => (
          <label key={field.name}>
            {field.label}
            <input
              value={action.fields[field.name] ?? ""}
              maxLength={200}
              placeholder={field.hint}
              onChange={(e) =>
                onChange({ ...action, operation: operation.id, fields: { ...action.fields, [field.name]: e.target.value } })
              }
            />
          </label>
        ))}
      </div>
      <p className="hint">
        The agent needs act access to the room the system is connected to. Without it the task halts and its
        supervisor is asked.
      </p>
    </>
  );
}

function Part({
  label,
  on,
  onToggle,
  children,
}: {
  label: string;
  on: boolean;
  onToggle: (next: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="step-part" data-on={on}>
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} />
        {label}
      </label>
      {on && <div className="step-fields">{children}</div>}
    </div>
  );
}

/**
 * The steps a playbook agent follows. Each step has conditions and an
 * outcome. Changes are kept here until Save playbook is pressed.
 */
function PlaybookEditor({
  office,
  agent,
  onSave,
}: {
  office: Office;
  agent: Participant;
  onSave: (steps: PlaybookStep[]) => void;
}) {
  const [steps, setSteps] = useState<PlaybookStep[]>(agent.playbook);
  const [made, setMade] = useState(0);
  const dirty = JSON.stringify(steps) !== JSON.stringify(agent.playbook);
  const people = office.participants.filter((p) => p.id !== agent.id);
  const rooms = office.floorplan.rooms;
  const systems = office.systems;

  const change = (index: number, next: PlaybookStep) => setSteps(steps.map((s, i) => (i === index ? next : s)));
  const move = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= steps.length) return;
    const next = [...steps];
    [next[index], next[to]] = [next[to], next[index]];
    setSteps(next);
  };

  return (
    <div className="playbook">
      <p className="hint">
        Steps are tried from the top. {agent.displayName} takes the first step whose conditions all hold, and does
        what it says. When no step applies, it does nothing and says so.
      </p>
      {steps.length === 0 && <p className="hint">No steps yet.</p>}
      {steps.map((step, index) => {
        const { when, then } = step;
        const setWhen = (part: Partial<PlaybookStep["when"]>) => change(index, { ...step, when: { ...when, ...part } });
        const setThen = (part: Partial<PlaybookStep["then"]>) => change(index, { ...step, then: { ...then, ...part } });
        return (
          <fieldset key={step.id} className="step">
            <legend>Step {index + 1}</legend>
            <div className="step-tools">
              <button type="button" className="btn" disabled={index === 0} onClick={() => move(index, -1)}>
                Move up
              </button>
              <button
                type="button"
                className="btn"
                disabled={index === steps.length - 1}
                onClick={() => move(index, 1)}
              >
                Move down
              </button>
              <button type="button" className="btn warn" onClick={() => setSteps(steps.filter((_, i) => i !== index))}>
                Remove step
              </button>
            </div>

            <h4>When</h4>
            <div className="step-fields three">
              <label>
                The work is at
                <select
                  value={when.stage}
                  onChange={(e) => setWhen({ stage: e.target.value as PlaybookStep["when"]["stage"] })}
                >
                  <option value="any">any stage</option>
                  {PLAYBOOK_STAGES.map((stage) => (
                    <option key={stage} value={stage}>
                      {stageSpec(stage).label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                The request contains
                <input
                  value={when.requestContains}
                  maxLength={80}
                  placeholder="any text"
                  onChange={(e) => setWhen({ requestContains: e.target.value })}
                />
              </label>
              <label>
                The request is from
                <select value={when.requestedBy} onChange={(e) => setWhen({ requestedBy: e.target.value })}>
                  <option value="anyone">anyone</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <h4>Then</h4>
            <div className="step-fields">
              <label>
                Say in the activity log
                <input
                  value={then.statusNote}
                  maxLength={300}
                  placeholder={`What ${agent.displayName} did, in a sentence`}
                  onChange={(e) => setThen({ statusNote: e.target.value })}
                />
              </label>
            </div>

            <Part
              label="Post an output"
              on={then.output !== null}
              onToggle={(on) => setThen({ output: on ? { label: "", body: "" } : null })}
            >
              <label>
                Heading
                <input
                  value={then.output?.label ?? ""}
                  maxLength={60}
                  onChange={(e) => setThen({ output: { label: e.target.value, body: then.output?.body ?? "" } })}
                />
              </label>
              <label>
                Text
                <textarea
                  rows={3}
                  value={then.output?.body ?? ""}
                  maxLength={1200}
                  onChange={(e) => setThen({ output: { label: then.output?.label ?? "", body: e.target.value } })}
                />
              </label>
            </Part>

            <Part
              label="Ask a question"
              on={then.question !== null}
              onToggle={(on) =>
                setThen({ question: on ? { body: "", to: "requester", blocking: true, options: [] } : null })
              }
            >
              {then.question && (
                <>
                  <label>
                    Question
                    <input
                      value={then.question.body}
                      maxLength={400}
                      onChange={(e) => setThen({ question: { ...then.question!, body: e.target.value } })}
                    />
                  </label>
                  <div className="step-fields three">
                    <label>
                      Ask
                      <select
                        value={then.question.to}
                        onChange={(e) => setThen({ question: { ...then.question!, to: e.target.value } })}
                      >
                        <option value="requester">whoever made the request</option>
                        {people.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.displayName}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Suggested answers, one per line
                      <textarea
                        rows={2}
                        value={then.question.options.join("\n")}
                        onChange={(e) =>
                          setThen({ question: { ...then.question!, options: e.target.value.split("\n") } })
                        }
                      />
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={then.question.blocking}
                        onChange={(e) => setThen({ question: { ...then.question!, blocking: e.target.checked } })}
                      />
                      Work waits for the answer
                    </label>
                  </div>
                </>
              )}
            </Part>

            <Part
              label="Record an assumption"
              on={then.assumption !== null}
              onToggle={(on) =>
                setThen({ assumption: on ? { assumed: "", because: "", confidence: "medium" } : null })
              }
            >
              {then.assumption && (
                <div className="step-fields three">
                  <label>
                    Assume
                    <input
                      value={then.assumption.assumed}
                      maxLength={200}
                      onChange={(e) => setThen({ assumption: { ...then.assumption!, assumed: e.target.value } })}
                    />
                  </label>
                  <label>
                    Because
                    <input
                      value={then.assumption.because}
                      maxLength={300}
                      onChange={(e) => setThen({ assumption: { ...then.assumption!, because: e.target.value } })}
                    />
                  </label>
                  <label>
                    Confidence
                    <select
                      value={then.assumption.confidence}
                      onChange={(e) =>
                        setThen({
                          assumption: {
                            ...then.assumption!,
                            confidence: e.target.value as "low" | "medium" | "high",
                          },
                        })
                      }
                    >
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                    </select>
                  </label>
                </div>
              )}
            </Part>

            <Part
              label="Need access to a room"
              on={then.need !== null}
              onToggle={(on) =>
                setThen({ need: on && rooms[0] ? { room: rooms[0].id, scope: "read", purpose: "" } : null })
              }
            >
              {then.need && (
                <div className="step-fields three">
                  <label>
                    Room
                    <select
                      value={then.need.room}
                      onChange={(e) => setThen({ need: { ...then.need!, room: e.target.value } })}
                    >
                      {rooms.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    To
                    <select
                      value={then.need.scope}
                      onChange={(e) => setThen({ need: { ...then.need!, scope: e.target.value as AccessScope } })}
                    >
                      {ALL_SCOPES.map((scope) => (
                        <option key={scope} value={scope}>
                          {scope}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    What for
                    <input
                      value={then.need.purpose}
                      maxLength={200}
                      onChange={(e) => setThen({ need: { ...then.need!, purpose: e.target.value } })}
                    />
                  </label>
                </div>
              )}
            </Part>

            <Part
              label="Leave a note for someone"
              on={then.note !== null}
              onToggle={(on) => setThen({ note: on ? { to: "requester", body: "" } : null })}
            >
              {then.note && (
                <div className="step-fields">
                  <label>
                    For
                    <select value={then.note.to} onChange={(e) => setThen({ note: { ...then.note!, to: e.target.value } })}>
                      <option value="requester">Whoever filed the request</option>
                      {office.participants
                        .filter((p) => p.id !== agent.id)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.displayName}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    What they should know
                    <input
                      value={then.note.body}
                      maxLength={400}
                      onChange={(e) => setThen({ note: { ...then.note!, body: e.target.value } })}
                    />
                  </label>
                </div>
              )}
            </Part>

            {(systems.length > 0 || then.action) && (
              <Part
                label="Do something in a connected system"
                on={then.action !== null}
                onToggle={(on) => setThen({ action: on && systems[0] ? blankAction(systems[0]) : null })}
              >
                {then.action && (
                  <ActionFields
                    action={then.action}
                    systems={systems}
                    onChange={(action) => setThen({ action })}
                  />
                )}
              </Part>
            )}
          </fieldset>
        );
      })}
      <div className="row-actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            setSteps([...steps, blankStep(`new:${made}`)]);
            setMade(made + 1);
          }}
        >
          Add step
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!dirty}
          // A step made here has no stored id yet. The server gives it one.
          onClick={() => onSave(steps.map((s) => (s.id.startsWith("new:") ? { ...s, id: "" } : s)))}
        >
          Save playbook
        </button>
        <button type="button" className="btn" disabled={!dirty} onClick={() => setSteps(agent.playbook)}>
          Discard changes
        </button>
        {dirty && <span className="unsaved">Unsaved changes</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const EMPTY_FORM = { id: "", name: "", kind: "anthropic" as ProviderKind, baseUrl: "", defaultModel: "", apiKey: "" };

/**
 * AI providers, of either kind. With scope "office" these are the office's
 * own. With scope "account" they belong to the signed-in person and can be
 * used in every office that person has a seat in.
 */
export function ProvidersTab({
  view,
  providerOp: sendOp,
  scope,
}: {
  view: OfficeView;
  providerOp: (op: ProviderOp) => Promise<boolean>;
  scope: "office" | "account";
}) {
  const own = scope === "account";
  const providers = own ? view.ownProviders : view.providers.filter((p) => p.sharedBy === null);
  const shared = own ? [] : view.providers.filter((p) => p.sharedBy !== null);
  const providerOp = (op: ProviderOp): Promise<boolean> => sendOp({ ...op, scope });
  const [form, setForm] = useState(EMPTY_FORM);
  const locked = own ? !view.ownProvidersEditable : !view.providersEditable;
  const editing = providers.find((p) => p.id === form.id) ?? null;
  const usedBy = (id: string) =>
    view.office.participants.filter((p) => p.kind === "agent" && p.agentType === "ai" && p.providerId === id);
  const keyState = (p: ProviderView): string =>
    p.keyUnreadable ? "Stored but unreadable. Enter it again." : p.hasKey ? `Ends in ${p.keyHint}` : "None";

  return (
    <>
      <Section
        title={own ? "Your AI providers" : "This office's AI providers"}
        hint={
          own
            ? "These belong to your account. They can be given to agents in every office you have a seat in, so a key is entered once. Other people in an office see that the provider is yours, and can give it to an agent only if their role has the Use shared AI providers permission."
            : view.isDemoOffice
              ? "The demo office is shared with every visitor, so it cannot hold API keys. Its agents are playbook agents."
              : locked
                ? "Sign in with a password account to change AI providers."
                : "These belong to this office alone. Each AI agent names the provider it uses, under People and agents."
        }
      >
        <div className="table-scroll">
          <table className="grid-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Type</th>
                <th scope="col">Default model</th>
                <th scope="col">API key</th>
                <th scope="col">Used by</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {providers.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    No AI providers yet.
                  </td>
                </tr>
              )}
              {providers.map((p) => {
                const agents = usedBy(p.id);
                return (
                  <tr key={p.id} data-selected={p.id === editing?.id}>
                    <td>
                      {p.name}
                      {p.baseUrl && <span className="cell-note">{p.baseUrl}</span>}
                    </td>
                    <td>{KIND_LABEL[p.kind]}</td>
                    <td>{p.defaultModel}</td>
                    <td className="muted" data-warn={!p.usable}>
                      {keyState(p)}
                    </td>
                    <td className="muted">
                      {agents.length === 0 ? "No agents" : agents.map((a) => a.displayName).join(", ")}
                    </td>
                    <td className="actions">
                      <button
                        type="button"
                        className="btn"
                        disabled={locked || !p.usable}
                        onClick={() => providerOp({ operation: "test", id: p.id })}
                      >
                        Test
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={locked}
                        onClick={() =>
                          setForm({
                            id: p.id,
                            name: p.name,
                            kind: p.kind,
                            baseUrl: p.baseUrl ?? "",
                            defaultModel: p.defaultModel,
                            apiKey: "",
                          })
                        }
                      >
                        Edit
                      </button>
                      {!locked && (
                        <ConfirmButton
                          label="Remove"
                          onConfirm={() => {
                            providerOp({ operation: "remove", id: p.id });
                            if (form.id === p.id) setForm(EMPTY_FORM);
                          }}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="hint">
          Testing checks the key and the model with the provider. Nothing is generated, so it costs nothing. The one
          exception is an Anthropic provider at its own address that keeps no list of models, which is sent a request
          for a single token.
        </p>
      </Section>

      {shared.length > 0 && (
        <Section
          title="Brought in from people's accounts"
          hint="Providers that belong to someone seated in this office. Their owner changes them under Your AI providers, in their own settings."
        >
          <div className="table-scroll">
            <table className="grid-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Belongs to</th>
                  <th scope="col">Default model</th>
                  <th scope="col">You may give it to agents</th>
                  <th scope="col">Used by</th>
                </tr>
              </thead>
              <tbody>
                {shared.map((p) => {
                  const agents = usedBy(p.id);
                  return (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td>{p.sharedBy === "you" ? "You" : p.sharedBy}</td>
                      <td>{p.defaultModel}</td>
                      <td className="muted">{p.selectable ? "Yes" : "No"}</td>
                      <td className="muted">
                        {agents.length === 0 ? "No agents" : agents.map((a) => a.displayName).join(", ")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <Section title={editing ? `Edit ${editing.name}` : "Add a provider"}>
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void providerOp({
              operation: "save",
              ...(editing ? { id: editing.id } : {}),
              name: form.name,
              kind: form.kind,
              baseUrl: form.baseUrl,
              defaultModel: form.defaultModel,
              ...(form.apiKey ? { apiKey: form.apiKey } : {}),
            }).then((saved) => {
              if (saved) setForm(EMPTY_FORM);
            });
          }}
        >
          <label>
            Name
            <input
              value={form.name}
              maxLength={40}
              disabled={locked}
              placeholder="How this provider is listed here"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </label>
          <label>
            Type
            <select
              value={form.kind}
              disabled={locked}
              onChange={(e) => setForm({ ...form, kind: e.target.value as ProviderKind })}
            >
              <option value="anthropic">{KIND_LABEL.anthropic}</option>
              <option value="openai_compatible">{KIND_LABEL.openai_compatible}</option>
            </select>
          </label>
          <label className="wide">
            {form.kind === "anthropic" ? "Address (optional)" : "Address"}
            <input
              type="url"
              value={form.baseUrl}
              disabled={locked}
              placeholder={
                form.kind === "anthropic"
                  ? "Leave empty for Anthropic itself, or enter a compatible service's address"
                  : "https://api.openai.com/v1"
              }
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              required={form.kind === "openai_compatible"}
            />
          </label>
          <label>
            Default model
            <input
              list={form.kind === "anthropic" && !form.baseUrl.trim() ? "suggested-models" : undefined}
              value={form.defaultModel}
              maxLength={100}
              disabled={locked}
              placeholder={
                form.kind === "anthropic" && !form.baseUrl.trim()
                  ? SUGGESTED_MODELS[0]
                  : "The model id the provider expects"
              }
              onChange={(e) => setForm({ ...form, defaultModel: e.target.value })}
              required
            />
            <datalist id="suggested-models">
              {SUGGESTED_MODELS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <label>
            API key
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={form.apiKey}
              disabled={locked}
              placeholder={
                editing?.hasKey
                  ? "Leave empty to keep the stored key"
                  : form.kind === "anthropic"
                    ? "Paste the API key"
                    : "Paste the API key, if the service needs one"
              }
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              required={form.kind === "anthropic" && !editing}
            />
          </label>
          <div className="wide row-actions">
            <button type="submit" className="btn primary" disabled={locked}>
              {editing ? "Save changes" : "Add provider"}
            </button>
            {editing && (
              <button type="button" className="btn" onClick={() => setForm(EMPTY_FORM)}>
                Cancel
              </button>
            )}
            {editing?.hasKey && !locked && (
              <ConfirmButton
                label="Remove stored key"
                onConfirm={() => {
                  providerOp({
                    operation: "save",
                    id: editing.id,
                    name: editing.name,
                    kind: editing.kind,
                    baseUrl: editing.baseUrl ?? "",
                    defaultModel: editing.defaultModel,
                    removeKey: true,
                  });
                  setForm(EMPTY_FORM);
                }}
              />
            )}
          </div>
        </form>
        <p className="hint">
          A key is encrypted before it is stored, used only on the server when an agent takes a step, and never sent
          back to this page. An OpenAI compatible provider is any service that offers the OpenAI chat completions
          interface, including a model running on your own machine. An Anthropic provider with an address is a gateway
          or another service that offers the Anthropic Messages interface.
        </p>
        <p className="hint">
          An AI agent is shown only the messages and room records it is allowed to read. One model call is made each
          time work reaches it.
        </p>
      </Section>
    </>
  );
}
