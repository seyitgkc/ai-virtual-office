# Limitations

Part of the documentation of the [AI Virtual Office](../README.md).

- The workflow always has the same five stages, though each office chooses
  which room hosts each one.
- A playbook's conditions are the stage, text in the request and who asked.
  A message cannot start work or change anything. An agent writes to someone
  only as a note while it takes a step on a task.
  An AI agent reads what its rooms and their connected systems hold and
  replies. It cannot search a system or page through it.
- Winding up a rejected task rests on what each system says about itself. A
  system that does not say which operation takes another back, or gives no
  record numbers, leaves its part to the person. A payment recorded in the
  mock ledger cannot be taken back by anyone here. A playbook agent takes
  back only where the operation needs the record's number and nothing else,
  and it cannot follow an answer given in a person's own words. A rejection
  takes no reason: the reviewer's words go into the answer about what the
  task did, or into "Send back".
- A task's number is its place among the office's tasks. Clearing all work
  starts the count again.
- A connected system has to describe itself in the format the mock services
  use. No existing ordering, accounting or carrier system does, so each would
  need a small adapter in front of it, and none has been tried. A playbook's
  action has fixed field values.
- The agents' queues are held in the server's memory, and each item on them
  is also written to the database until it is done. After a restart the
  office reads them back within a minute. An item that fails three times is
  left for a person, and any action a person takes on the task starts the
  count again.
- Earlier work is found by shared account, part and order numbers and by
  uncommon words in the title and details. It is not a search by meaning.
  At most three closed tasks are shown, each cut to its last result.
- Standing work is filed when the server's clock passes the time, checked
  once a minute. If the server was down at that time, one request is filed
  when it comes back and the missed ones are skipped. The demo office has
  none.
- A document is text only, read in the browser and stored whole. Long
  documents are shortened in what an agent is shown, with a line saying so.
- An agent that is asked again because the task changed while it was thinking
  costs a second model call.
- A wait is stored with the task, so it survives a restart. The office looks
  for waits that have ended once a minute. The demo office keeps a clock that
  only moves with a click, so a wait there ends only when a person ends it.
- A task stops being carried after forty background steps, until a person
  acts on it.
- A provider from someone's account can be used in an office only while its
  owner has a seat there.
- When a connected system refuses or cannot be reached, the thread says so and
  the task carries on. It does not halt.
- An office holds up to 20 invitations that wait. One whose role or room was
  removed in the meantime cannot be repaired: it is withdrawn and made again.
  The office does not send the link: whoever invites passes it on.
- No password reset and no email. An administrator would issue a new invite.
  An email given at sign-up is not verified, so nothing proves that the person
  owns it.
- Browsers poll for changes every five seconds, and every second and a half
  while agents are at work. A tab that is not in view does not poll.
- SQLite suits one server process. More than one would need a different
  database.
- Rooms are rectangles placed along a corridor or against an existing room's
  wall. A room cannot be moved or resized once it exists.
- An agent that appears in tasks or messages cannot be removed until the work
  is cleared. A person in the same position is kept in the record as having
  left, and cannot be brought back: inviting them again gives them a new desk
  and a second entry under the same name.
- On a phone the interface shows one section at a time, chosen from a bar at
  the bottom. Walking there is by taps on the map: there is no way to move a
  step at a time without a keyboard. Settings tables scroll sideways there, and an office of more than four or five rooms
  along its corridor is wider than the screen until the view is pinched out.
- With a task open on a window narrower than about 1,100 pixels, the strip
  left for the office is small and a long office is drawn small in it.
- The demo office shows a fixed demo clock that steps forward three minutes
  per action. Other offices use real time.

## What a real office has that this one lacks

Five jobs were run through an office of five AI agents and the five mock
services on the deployed site: orders with a credit check, freight and an
invoice, a factory order for a shortfall, a warranty call and a refused
return. They completed with correct figures, and a person was asked only for
what was theirs to decide. The same runs showed where the office stops short
of a human one.

| A real office has | Here |
| --- | --- |
| Memory across jobs: who paid late, which branch miscounts | An agent is shown up to three closed tasks that share an account, part or order number with the one in hand, each with its result, and a person can keep a line from a thread as a room record in one click. Agents do not write records themselves, and earlier work is matched on shared numbers and uncommon words, so a related job described in different terms is missed. |
| Initiative: someone notices stock running low and starts the work | The office files standing work by itself on a schedule a person sets, such as a stock check every Monday. Agents still do not decide for themselves that something needs doing. |
| Time: due dates, a reminder on Friday, a job that waits for a delivery | A task can wait for one day at a time and is picked up again then. There are no due dates, no reminders to people and no working hours, and an agent takes the day from the thread or the records and cannot look ahead in a calendar. |
| Conversation: two rooms talk a problem through | Agents leave each other notes of up to 120 words on a task and answer them in turn. They cannot meet, and a reviewer cannot ask the worker a question without sending the work back. |
| Parallel work: Finance and Purchasing on the same order at once | A task has one owner in one room. Colleagues do their parts at the same time through notes, each from its own queue. Those parts are written down, tried again when they fail, and the task is not handed on until they are done. The task panel names who is on it. There is still no second owner. |
| Priority and load: this one is urgent, that desk is swamped | A person can mark a task urgent, and agents take urgent work first. The report and the status line show what each agent is on and how much waits behind it. There is no finer order than urgent or not, no due date, and work is not moved from a busy agent to a free one. |
| Documents: a purchase order as a PDF, an email from the dealer | Up to five text documents of 20,000 characters each can be attached to a task: text, CSV, Markdown, a saved email. PDFs, images and spreadsheets are turned away, and nothing is sent outside the office. |
| A different path for different work | Every task passes all four stages. A stage with nothing to do says so in a line and passes it on. |
| Reporting: how did we do last month | A report counts everything since the office began. It cannot be narrowed to a period, compared with an earlier one, or exported. |
