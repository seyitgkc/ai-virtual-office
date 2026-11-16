"use client";

import type { Office } from "../lib/model";
import { splitAtTasks } from "../lib/taskLabels";

/**
 * Text that may name tasks. Each task is shown by its number in the office,
 * and where there is somewhere to open it, the number is a link to the task.
 */
export function TaskText({
  office,
  text,
  onOpen,
  current,
}: {
  office: Pick<Office, "tasks">;
  text: string;
  /** Opens a task. Without it the numbers are plain text. */
  onOpen?: (taskId: string) => void;
  /** The task already on screen, which is not linked to itself. */
  current?: string;
}) {
  if (!text.includes("T-")) return <>{text}</>;
  return (
    <>
      {splitAtTasks(office, text).map((part, at) =>
        part.task && onOpen && part.task.id !== current ? (
          <button
            key={at}
            type="button"
            className="task-ref"
            title={part.task.title}
            onClick={(event) => {
              event.stopPropagation();
              onOpen(part.task!.id);
            }}
          >
            {part.text}
          </button>
        ) : (
          <span key={at}>{part.text}</span>
        ),
      )}
    </>
  );
}
