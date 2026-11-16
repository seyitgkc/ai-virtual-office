"use client";

import type { Office } from "../lib/model";
import { splitAtTasks } from "../lib/taskLabels";
import { TaskRef } from "./TaskCard";

/**
 * Text that may name tasks. Each task is shown by its number in the office,
 * and pressing the number shows that task's card.
 */
export function TaskText({ office, text }: { office: Pick<Office, "tasks">; text: string }) {
  if (!text.includes("T-")) return <>{text}</>;
  return (
    <>
      {splitAtTasks(office, text).map((part, at) =>
        part.task ? <TaskRef key={at} task={part.task} label={part.text} /> : <span key={at}>{part.text}</span>,
      )}
    </>
  );
}
