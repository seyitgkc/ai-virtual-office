# What is functional, simulated and proposed

Part of the documentation of the [AI Virtual Office](../README.md).

## Functional

- The access resolver: precedence, conflict reporting, expiry by time or task,
  and limiting a grant made for one task to work on that task.
- The workflow engine: handoffs, halts on permission and on questions,
  retesting blocked tasks after a rule change.
- Sign-in, sessions, sign-out, invites and password accounts.
- Server-side enforcement: per-viewer message filtering, per-action
  authorization, and a separate permission for each kind of set-up change.
- Permission tokens and the room thread endpoint they open.
- Persistence in SQLite and the audit log.
- The settings screen: rooms, people and agents, roles and permissions, access
  rules and AI providers.
- Playbook agents: the step editor, storage, and the matching of steps to
  work.
- AI agents on an OpenAI compatible provider, end to end. On the deployed
  site, two AI agents on a DeepSeek model took a quote request through every
  stage: each reply came back in 7 to 13 seconds in the expected shape, one
  agent asked for a room it could not read and the task halted until access
  was granted for that task, and the other halted at review because it could
  not read the room the answers were given in. The check scripts cover the
  same path against a stand-in service on the same machine.
- AI agents on an Anthropic compatible provider, and both interfaces in one
  office. On the deployed site an office of five AI agents had three on a
  provider that speaks chat completions and two on one that speaks the
  Messages interface. A stock check went through four of them, two on each
  interface, in 15 seconds and reached review with the count confirmed
  against the storefront's live record. Both kinds of provider are set up
  the same way: an address, a model id and a key if the service needs one.
- Room records edited in Settings, and connected systems. The office calls the
  mock services over HTTP with a stored key, reads their records live,
  and places and cancels orders and shipments in them. In the demo office, the
  agent working a dealer order places it in the storefront once its halt for
  Finance is cleared, and the storefront's stock goes down. This was run on
  the deployed site: the grant on T-1 produced order SO-1001 for six heads
  from Laval, and the storefront's stock there went from 120 to 114.
- An AI agent using a connected system, on the deployed site. An agent on a
  DeepSeek model read the storefront's live stock, saw that one branch alone
  could fill a three-unit order, asked to place it, halted because it lacked
  `act` on the Warehouse, and placed order SO-1001 once access was granted
  for that task. The storefront's stock at that branch went from 4 to 1.
  On a second request the same agent placed an order for two condensers and,
  in the same stage, booked ground freight with the carrier under the new
  order number: order SO-1001, then shipment SH-5001 with reference SO-1001.
- Approval for actions in a connected system: the held action, the question
  to a person, and carrying it out only on Approve.
- Resetting the demo office to its seeded state, without signing anyone out.
  The reset also puts the mock services back to their starting data. On the
  deployed site the README's walkthrough was run twice in a row with a reset
  between, and the order was placed afresh each time.
- The summary and the briefing at the top of the screen. The counts are
  worked out from the tasks for every viewer. On the deployed site the
  briefing of an office of five AI agents was written by its own model once
  the agents had gone quiet, within the two sentences and 34 words it is
  held to. The demo office has no model, so its briefing is put together
  from the same facts.
- Rejecting a request before review. On the deployed site two orders were
  rejected while they were halted at Planning, one on a question and one set
  to wait, and each closed with its question and its wait removed.
- Answering a question by picking one of the agent's choices or by typing an
  answer.
- Agents carrying work forward in the background: the step taken again after
  an answer, attending to a colleague's note, and handing a finished step on.
- AI providers that belong to an account, usable in each of its offices, and
  the permission that lets other people hand them to agents.
- The sample office with AI agents.
- A large office on the deployed site: nine rooms and 18 AI agents on two
  providers that belong to an account. One request ran from intake into
  execution in about two minutes with no click. The intake agent's needs for
  Accounts and Shipping went to the agents in those rooms as notes, both
  answered, and it took its step again with their answers. The execution
  agent asked Accounts the same way, then stopped with a question for a
  person, because that office had no storefront connected to place the order.
- The same office with both systems connected, end to end. With one click to
  file the request and one to approve the order, seven of the 18 agents took
  it from intake to review in under two minutes of working time. Warehouse
  asked Accounts for credit by note and got it. The order waited for a
  person's approval, then became SO-1001 in the storefront. Warehouse passed
  the order number to Shipping by note, and the Shipping agent booked shipment
  SH-5001 under it in the carrier. The reviewing agent noticed the storefront
  recorded list price where tier 2 applied, asked a person how to handle it,
  and had Billing confirm the figures. No task halted for access.
- An office of five AI agents and five connected systems on the deployed
  site, run through its newer parts with real models:
  - Urgent work: of three requests filed within a second, the urgent one,
    filed last, was taken second.
  - A document: a request that said only to place the order as the attached
    purchase order lists became order SO-1001 with both lines from the
    document.
  - Standing work: a weekly request filed itself 28 seconds after it fell
    due and ran through to review.
  - Earlier work: on a new order for a dealer, the agents named the closed
    task that last dealt with that dealer, and said that the payment it
    recorded was no longer on the ledger.
  - A kept record: a line kept in Fulfilment's records was followed on the
    next two tasks that passed through that room.
  - A wait: a task set itself to wait for a day five weeks off, kept the
    wait through restarts, and its agent picked the right work up again when
    the wait was ended by hand.
- Winding up a rejected task, on the deployed site:
  - An order with its freight and invoice was rejected and answered with
    "Undo all of them". The three agents voided the invoice, cancelled the
    shipment and cancelled the order, newest first, and the task closed by
    itself 22 seconds after the answer. The three systems' own records
    showed all of it gone.
  - A second was answered in the reviewer's own words, to cancel the freight
    and the invoice and keep the order. The agents did that, the office
    asked what next because the order still stood, and "Close it as it
    stands" closed it.
  - A factory order that had been moved to air freight was rejected. The
    cancellation waited for approval, was approved, and was refused by the
    supplier portal because the order had left. The person was told both
    reasons and asked what next.
- Several AI providers per office, each with an encrypted, write-only API key
  and a connection test.
- Many offices per account, each isolated, with adding, switching and
  removing.
- Messages between people, with unread counts, and the inbox.
- Notes from an agent to a person or another agent, from a model's reply or a
  playbook step, and the note to the requester when a system refuses.
- Talking to an agent: the conversation box, the reply of a playbook agent,
  the call to either kind of provider for an AI agent, and the limit to what
  both sides may read.
- The 3D office, walking, the map, live desk screens and the prompt to talk to
  whoever you face. The lamps, the task names at each desk and everything seen
  moving are drawn from the office's own tasks and messages, one mark per real
  message.
- Picking a place or a person on the map to stand there, names shown when
  pointing at someone on the map, and the refusal for a room that is closed
  to the walker. Walking by touch: taps on the map, a finger to look around,
  and a tap on the prompt to talk.

## Simulated

- The demo office's agents are playbook agents. Their playbooks were written
  for a dealer order of multi-zone heads and answer any request that way. The
  demo says so on its title card and on its request form.
- All business data: dealers, branches, stock, pricing tiers, people. The
  records in `lib/referenceData.ts` are invented.
- The five mock services: storefront, freight carrier, accounts ledger,
  supplier portal and service desk. They are real HTTP services with keys,
  validation, refusals and repeat-safe requests, and the office talks to them
  as it would to any other. Their catalogue, stock, accounts and rates are
  invented, and they keep their data in memory: it returns to its starting
  state when a service restarts, once a day, and when the demo is reset. An
  office connected to any of them says so on its title card, in every view:
  *Mock services*, their names, and that all data in them is simulated for
  demonstration.

The stored data says which is which. Every agent is labelled as an AI agent or
a playbook agent, and every output message records whether it came from a
playbook.

## Not verified in this repository

- The office ending a wait by itself on the day, on the deployed site. The
  one task waiting there is due on 21 December 2026. The check scripts cover
  it with a clock of their own.
- An agent that cannot be reached while a rejected task is wound up, on the
  deployed site. The check scripts cover it: three tries, then the person is
  asked.
- A real phone or tablet. The phone layout and walking by touch were run in
  a desktop browser set to a phone's size and touch input, against the
  deployed site.
- The briefing with `BRIEFING=0`, and a briefing call that fails, on the
  deployed site. The check scripts cover both: a failed call leaves the
  composed briefing in place and is not repeated straight away.

## Proposed

- Adapters for named products such as Shopify, WooCommerce or an accounting
  package. Each would be a small service in front of the product that
  describes it in the format the mock services use. The office itself
  needs no change for a new system.
- Lookups an AI agent chooses for itself during a step. Today it is shown a
  fixed snapshot of each system it may read.
- A small tool-calling model in front of the connected systems, such as
  Needle from Cactus Compute. Needle is an open model of a few tens of
  megabytes that picks a function and fills in its arguments, and it can run
  beside the office with no provider behind it. Today an agent's step lists
  every operation of every system it may use. That works for a storefront
  with two operations and would stop working for a system with two hundred,
  or for an agent that reaches many systems. The small model would shortlist
  the operations that fit the task before the agent's own model is asked. It
  would choose only among what the agent's access already allows, the engine
  would still check every action, and a step where nothing on the shortlist
  fits would fall back to the full list. This has not been tried, and the
  published figures for the model's accuracy are its maker's own.
- More playbook conditions, such as the answer to an earlier question.
- A drag-and-drop floorplan editor. Rooms are added today through a form.
- Workflows with a different number of stages.
- Live updates pushed to the browser. Today each browser re-reads the office
  every five seconds, and every second and a half while agents are at work.
