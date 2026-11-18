# Walkthrough: an office of your own with AI agents

Part of the documentation of the [AI Virtual Office](../README.md).

The demo office runs on written playbooks. This walkthrough builds a second
office from nothing and staffs it with agents on a real language model. It
takes about fifteen minutes and covers signing in, creating an office,
rooms and roles, agents, connected systems, inviting a person, and three
requests.

## What you need

The access details are sent separately from this repository. They hold:

- the address of the site;
- the email and password of the administrator's account;
- the address of each mock service, and the API key they share. The
  services run beside the office and have no address on the internet, so
  these are the names the office itself reaches them by.

The second person in step 7 is an account you make yourself, on the
invitation's own page, with any email and a password you choose.

No model key is needed. The administrator's account already holds an AI
provider, listed under Settings, *Your AI providers*, and it can be given to
agents in every office that account sits in.

## 1. Sign in as the administrator

Open the site and sign in with the administrator's email and password. You
arrive in an office that account already has. The office you are in is named
at the top of the title card on the left, and when the account has more than
one, a list under the name switches between them.

## 2. Create an office

1. Click **Settings**, then **Your offices**.
2. Under *Add a new office*, type a name such as `Northside Supply` and click
   **Add a new office**.

You are now in the new office. It has a corridor, one room called *Main
room* with you in it, and two roles. The panel on the right, *Setting up
this office*, lists what is still missing, and each line ticks itself off as
you go.

## 3. Add rooms and place the stages

A room is a permission boundary, so each kind of work that should have its
own access gets its own room. This office gets three.

1. Open **Settings**, then **Rooms**.
2. Click the name *Main room*, change it to `Front office`, and leave the
   field. A name is saved when you leave it.
3. Under *Add a room*, type `Warehouse` as the name and click **Add room**.
   Do the same for `Accounts`. Each takes the next place along the corridor.
4. Under *Where each stage happens*, set **Execution** to *Warehouse* and
   **Review** to *Accounts*. Intake and Planning stay in *Front office*.

## 4. Give each room a role

1. Open **Roles and access**. On the *Roles* tab, rename *Member* to
   `Front office`. It may already work in that room.
2. Add two roles with **Add role**: `Warehouse` and `Accounts`.
3. Open the *Room access* tab and pick the *Warehouse* role. In the *Set to*
   list of the *Corridor* row choose **Walk through**, and in the
   *Warehouse* row choose **Work here**.
4. Pick the *Accounts* role and do the same for *Corridor* and *Accounts*.

Each role can now enter, read and act in its own room and nowhere else.

## 5. Add the agents

1. Open **People and agents**.
2. Under *Add an agent*, leave the name empty (one is picked), and give a
   title such as `Intake and planning agent`. Choose the role *Front office*
   and a desk in *Front office*. Keep **AI agent** selected. Under *AI
   provider*, choose a provider marked *from your account*. Click **Add
   agent**.
3. Add a second agent with the role and desk *Warehouse*, and a third with
   the role and desk *Accounts*.

The table now lists three agents with the provider and model each works
from, and three figures have appeared at desks in the office.

## 6. Connect two services

1. Open **Connected systems**.
2. Under *Connect a system*, set **Operated from** to *Warehouse*. Paste the
   API key and the storefront's address. Leave **Hold each action until a
   person approves it** ticked, and click **Connect**. The office asks the
   service to describe itself, and the table shows *Storefront* with what
   agents can do in it: place an order and cancel one.
3. Connect the accounts ledger the same way, operated from *Accounts*, with
   the approval box unticked.

**Live records** on a row shows what the service holds at that moment. The
storefront lists 60 ecobee thermostats and 4 PTAC units at Laval when it is
at its starting data.

Whoever may read a room sees the records of the system operated from it, and
whoever may act there can use it. So the Warehouse agent can place orders,
the Accounts agent can see credit standing, and the Front office agent can
do neither.

Close Settings. In the set-up list only *File the first request* is still
to do.

## 7. Invite a person and accept as them

1. On the title card, click **Invite**.
2. Give a name and a job title for the person you are inviting, choose the
   role *Front office* and a desk in *Front office*, and click **Create
   invite**.
3. Click **Copy link**. The link is shown once. The invitation waits in the
   list below it until it is accepted, and nobody is in the office before
   then.
4. Click **Done**, then **Sign out**.
5. Open the copied link. The page names the office, the role and the desk.
   Enter an email and a password of at least 10 characters and click
   **Accept and enter**. That creates the invited person's account. The
   email is only the name they sign in with, and nothing is sent to it.
   Keep both if you want to sign in as that person again. An email that
   already has an account would join with that account and its own
   password.

You are now in the office as the second person, at a desk in *Front office*.
There is no Invite or Report button and Settings holds only that person's
own pages, because the *Front office* role carries no permissions.

## 8. Three requests

What a model writes varies from run to run. If an agent asks a question on
the way, answer it under *Your move* and the task carries on.

### A stock question, filed by the invited person

1. Still signed in as the second person, click **New request**.
2. Title: `Stock check: PTAC units at Laval`. Details: `How many PTAC-12
   units does the Laval branch hold right now? Nothing is to be ordered.`
3. Click **Send to Front office**.

The task moves through intake and planning in the Front office, execution in
the Warehouse and review in Accounts, with nobody clicking. Lamps light at
each desk as its agent works, and the handoffs cross the office. It should
reach *In review* within a minute. The Accounts agent may not read the
Warehouse, so it asks the Warehouse agent for the count in a note and gets
its answer the same way. Nothing halts for that.

Open the task. The thread says how many messages were said in rooms you
cannot read and leaves them out, and the review buttons are disabled with
the reason. The server withholds those messages and would refuse the
decision if it were sent by hand.

Click **Sign out**.

### An order that waits for approval

1. Sign in as the administrator and pick the new office from the list under
   the office's name.
2. Open the stock check. You can read the whole thread now, including the
   count the Warehouse agent read from the storefront. Click **Approve**.
3. Click **New request**. Title: `Order: two ecobee thermostats for
   Northline Mechanical`. Details: `Northline Mechanical, account NOR-0188,
   orders two ECOBEE-T thermostats from Laval. The dealer collects them
   from the branch, so no freight applies.` Send it.
4. The task stops in the Warehouse, outlined in amber, and the summary at
   the top counts it as waiting for a person. Under *Your move* the agent
   asks whether it may place the order in Storefront, with the account, the
   branch and the items. Click **Approve**.
5. The thread shows the storefront's answer with an order number such as
   SO-1001, and the task moves on to review. There the Accounts agent
   checks the dealer's credit and raises the invoice in the ledger, at the
   dealer's tier discount. The ledger was connected without the approval
   box, so that goes straight through.
6. Under Settings, Connected systems, **Live records** on the storefront
   row shows Laval's thermostats down by two.
7. Back on the task, click **Approve** to complete it.

The agent asked because the storefront holds every action for approval.
That rule is enforced by the engine, whatever the model writes.

### A rejection that takes an order back

1. File a third request. Title: `Order: one PTAC unit for Brightline
   Mechanical`. Details: `Brightline Mechanical, account BRT-0931, orders
   one PTAC-12 unit from Laval. The dealer collects it from the branch, so
   no freight applies.`
2. Approve the order when the agent asks, and wait for the task to reach
   review.
3. Click **Reject**. The order is still an order in the storefront and the
   invoice still stands in the ledger, so the task stays open. It lists
   what it did and asks what should happen to it.
4. Click **Undo all of them**. The Accounts agent voids the invoice at
   once. The Warehouse agent asks whether it may cancel the order, because
   the storefront holds a cancellation for approval like any other action.
5. Click **Approve**. The order is cancelled and the task closes as
   rejected, with a last line saying that nothing it did is left standing.
   **Live records** shows the order as cancelled and the PTAC unit back in
   stock.

## More to try

- Click **Walk the office** and go through it on foot. Sign in as the
  second person to find the Warehouse and Accounts doorways closed.
- Click an agent and ask it about its work in the message box. It answers
  from what you may both read.
- Open **Report** for what was filed, where work stopped for a person and
  how long each stage took.
- Under Settings, *Your offices*, **Add the sample office** builds the
  demo's five rooms, five AI agents and five connected services in one
  step.
- A task halted for missing access, with the rule that decided it, is
  easiest to see in the demo office. The
  [example workflows](example-workflows.md) go through it.

The mock services are shared by every office connected to them and return
to their starting data once a day, so the stock figures above assume nobody
else has ordered since.
