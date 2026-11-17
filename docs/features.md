# What it does

Part of the documentation of the [AI Virtual Office](../README.md).

- **One access model for people and agents.** Three scopes per room (enter,
  read, act), roles, per-person overrides, and a fixed order of precedence.
  Every decision comes with an explanation.
- **A workflow that stops where a person is needed.** Agents record their
  guesses as assumptions, ask when they cannot proceed, and escalate when they
  need a room they may not use.
- **Sign-in with real enforcement.** Each person receives only the messages
  their access lets them read, and the server refuses actions their role does
  not allow.
- **Permission tokens.** Every access grant issues a signed, scoped token that
  a program can present to read a room. It stops working the moment the grant
  does.
- **An audit log.** Every action is recorded with who did it, when, and what
  it was about.
- **Two kinds of agent.** An AI agent asks a language model at each step and
  is shown only what it may read. A playbook agent follows when-then steps
  that a person writes in Settings, with no model involved.
- **Agents that keep working between clicks.** Each agent has a queue of its
  own and works through it one item at a time while the others work through
  theirs, so a slow model holds up one agent and nobody else, and a click
  never waits for one. An agent takes its step again
  when its question is answered, looks at a note a colleague left it, and
  hands a finished step on to the next stage by itself. A task runs until it
  reaches a real halt: a question, missing access, an approval or the review.
  When a colleague's request for approval held the task, its owner takes its
  step once more after the answer, so nothing it was waiting for is skipped.
- **An office that shows its work.** Each desk has a lamp and a pool of light
  in the colour of what its occupant is doing, and names the open tasks it
  holds. An agent taking a step leans in to its desk, its ring runs fast and
  its name tag says which task it is on. Each new line in a thread shows at
  the desk of whoever wrote it, and a handoff, a question, an answer or a note
  is seen crossing the office to the desk it is for.
- **Urgent work.** A person can mark a task urgent when filing it or later.
  Every agent takes urgent work ahead of whatever else is on its queue, once
  it has finished what it is on, and the task leads the work list.
- **A report on how the office is doing.** For people who see everything:
  what was filed and closed, how many tasks went through with nobody asked,
  where work stopped for a person and how often, how long each stage takes,
  and what each agent and person did. It is counted from the tasks and
  threads themselves, so there is nothing separate to keep in step.
- **Work that waits for a day.** When the rest of a job depends on a date,
  such as stock due from the factory or a booked visit, the agent does what
  it can now and sets the task to wait until that day. The task shows the day
  and the reason, stays with its owner, and is not handed on. On the day the
  office wakes the agent, which reads the live records and finishes the job.
  A person can end a wait early with one click. An agent is told to wait only
  for something already arranged, such as an order that was placed or a visit
  that is booked. A supplier's lead time is not a day to wait for, and work
  that needs a person's approval first is put to that person, not parked.
  These are instructions to a model and not something the office enforces.
- **Work that survives a failure and a restart.** What each agent has been
  given is written down before it starts. A step that fails is tried again,
  up to three times, and a task is not handed on while a colleague still has
  a part of it to do. After a restart the office picks up from what was
  written down.
- **Text documents on a request.** A purchase order, a price list or a saved
  email can be attached when a request is filed or added later, up to five
  per task. Every agent that works the task is shown them, marked as data.
- **Standing work.** A request the office files by itself every day, every
  weekday or every week, such as a stock check on Monday morning. It is set
  up in Settings, can be paused, and can be filed at once with one click.
- **What the office learned on earlier work.** An agent taking a step is
  shown the closed tasks that share an account, part or order number with
  the one in hand, each with its result, as far as the agent's rooms let it
  read them. A person can keep a result or an answer from a thread as a
  record of a room, and from then on every agent working there is told it.
- **A rejected task settles what it already did.** An order that was placed
  is still an order after the task is rejected. So a task that has done
  things in connected systems stays open when it is rejected: whoever
  rejected it is shown what it did and asked what should happen to that. The
  agent that did each thing carries the answer out, newest first, and says
  what came of it. The task closes only when nothing is left standing or a
  person says to leave it. If something cannot be taken back, the person is
  told why and asked what next.
- **Tasks have short numbers.** A task is T-1, T-2 and so on within its
  office, in the panels, the activity log and what agents write. Wherever a
  task is named in a thread or in the log, pressing the number shows that
  task's card: what was asked, where it stands, who has it, what it waits
  for and the last thing said on it, with a button that opens it.
- **AI providers of your own.** A provider can belong to your account and be
  used in every office you sit in, so a key is entered once.
- **A sample office with AI agents.** Anyone signed in can add the demo's
  distributor as an office of their own, staffed by real AI agents.
- **Several AI providers per office.** A provider is any service that speaks
  the OpenAI chat completions interface or the Anthropic Messages interface.
  Each AI agent names the provider and model it uses.
- **Records and connected systems per room.** Each room keeps records that a
  person writes in Settings, and can be connected to an outside system whose
  records are read live. `read` on the room shows both. `act` on the room lets
  an agent do something in the system, such as placing an order.
- **Five mock services in the stack.** A storefront, a freight carrier, an
  accounts ledger, a supplier portal and a service desk run as their own
  containers beside the office. Each refuses what its real counterpart would,
  such as an invoice past a credit limit. The demo office is connected to all
  of them, and its agents place a real order in the storefront.
- **Systems that describe themselves.** A connected system tells the office
  what it is for and what can be done in it. Agents are given that
  description, and a person can reword it in Settings.
- **Granular role permissions.** Eleven separate permissions, such as managing
  access, deciding reviews or inviting people, ticked per role in a table.
- **Many offices.** An account can add offices, switch between them and remove
  them. Each office is separate, and a new one starts empty.
- **Accounts.** Anyone can create an account on the sign-in page. It starts
  with an empty office of its own, in which that person is the administrator.
- **Invites.** Someone whose role may invite names a person, a role and a
  room, and gets a link to send. The person sets their own password, and is
  added to the office with a desk when they accept. Until then the invitation
  waits in a list, where it can be given a new link or withdrawn. This is how
  a second person joins an office that exists.
- **Leaving.** A person who is removed loses their desk, their access and
  their sign-in to that office. If they asked, answered or decided anything
  there, their name stays on it, and what was meant for them goes to someone
  who manages access.
- **Settings.** Rooms, people and agents, roles and their permissions, access
  rules and AI providers are all set up in the interface, each behind its own
  permission.
- **Messages.** Anyone can write to anyone in the office, and only the two of
  them can read it. Writing to an agent is a conversation at its desk: an AI
  agent answers through its provider from what you may both read, and a
  playbook agent reports where its work stands. A message changes nothing in
  the office.
- **Notes from agents.** While it works on a task, an agent can leave a note
  of up to 120 words for one person or one other agent when they should know
  something the handoff and the outputs do not say. A note blocks nothing.
  An agent that is left a note looks at it soon after and may do its own
  part. The task panel says who is working on a task at the moment and who
  has it waiting behind other work.
- **An inbox.** One place for what is waiting on you, the notes agents left
  you, what agents wrote to each other, and your conversations, with a count
  of what is new.
- **A walkable office.** An overview from above, and a first-person mode with
  a map. Every desk's screen shows what its occupant is doing right now, and
  facing someone offers a key to talk to them.
