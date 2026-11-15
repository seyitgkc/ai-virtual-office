/**
 * Playbook agents. A playbook is an ordered list of when-then steps written
 * by a person. The agent takes the first step whose conditions all hold and
 * does what it says. No model is involved, so the same work always gets the
 * same answer.
 */
import type { AgentRuntime, AgentStepInput, AgentStepResult } from "./engine";
import type { PlaybookStep } from "./model";

/** Does this step apply to the work in front of the agent? */
export function stepApplies(step: PlaybookStep, input: AgentStepInput): boolean {
  const { stage, task } = input;
  const wanted = step.when.requestContains.trim().toLowerCase();
  return (
    (step.when.stage === "any" || step.when.stage === stage) &&
    (wanted === "" || `${task.title} ${task.detail}`.toLowerCase().includes(wanted)) &&
    (step.when.requestedBy === "anyone" || step.when.requestedBy === task.requestedById)
  );
}

/** What a playbook agent does for one piece of work. */
export function runPlaybook(input: AgentStepInput): AgentStepResult {
  const { participant, task } = input;
  const step = participant.playbook.find((s) => stepApplies(s, input));
  if (!step) {
    return {
      statusNote: `${participant.displayName} has no playbook step for this, so nothing was done.`,
      questions: [],
      assumptions: [],
    };
  }

  const { statusNote, output, question, assumption, need, action } = step.then;
  return {
    ...(statusNote.trim() ? { statusNote: statusNote.trim() } : {}),
    questions: question
      ? [
          {
            body: question.body,
            toParticipantId: question.to === "requester" ? task.requestedById : question.to,
            blocking: question.blocking,
            ...(question.options.length > 0 ? { options: question.options } : {}),
          },
        ]
      : [],
    assumptions: assumption ? [assumption] : [],
    ...(need ? { needs: [need] } : {}),
    ...(action ? { actions: [action] } : {}),
    ...(output ? { output } : {}),
  };
}

/** Answers every agent from its own playbook. Used wherever no model is. */
export class PlaybookRuntime implements AgentRuntime {
  async step(input: AgentStepInput): Promise<AgentStepResult> {
    return runPlaybook(input);
  }
}
