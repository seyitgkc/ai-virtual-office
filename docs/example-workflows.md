# Example workflows

Part of the documentation of the [AI Virtual Office](../README.md).

## 1. A quote blocked at the Finance door

If the demo has been used and T-1 is no longer halted, open Settings,
General, and click **Reset the demo**. That puts back the seeded people, rules
and three tasks for every visitor. It also puts the mock services back to
their starting data, so the order T-1 places is placed afresh each time. The
mock services are shared by every office on the server that connects to them,
so a reset clears what those offices did there as well.

Enter as Dana. Task **T-1** is selected: a dealer order for six multi-zone
heads. It has already moved through Reception, Planning and Fulfilment,
collecting three assumptions on the way. Quill is assembling the quote and
needs the dealer's pricing tier, which lives in Finance. Quill's role,
Fulfilment, explicitly denies Finance. The task is halted and Fulfilment is
outlined in red.

1. Read *Your move*. Quill explains what it needs and names the rule that
   stopped it.
2. Click **Grant read on Finance, for this task only**. An individual allow
   outranks a role deny, so the task returns to *in progress*. A permission
   token for Quill appears in Quill's inspector. Quill takes its step again
   now that it can read Finance: its draft quote lands in the thread, it
   leaves Ledger a note about tier pricing, and it asks whether it may place
   the order in the storefront connected to Fulfilment. The task waits.
3. Click **Approve** under the question. The order is placed, the thread
   shows the order number, and Laval's stock of that product drops by six
   under Settings, Connected systems. Quill's step is now finished, so
   within a second or two the task moves to Finance by itself and Ledger
   picks it up. Nobody clicks Advance.
4. Click **Approve**. The task completes, the grant from step 2 expires with
   it, and Quill's token stops working.

## 2. A grant that does not work

This is the more instructive path, and it starts from a new request.

1. Click **New request**, then **Send to Reception**. Iris takes it, records an
   assumption about the branch, and asks whether the heads are standalone.
2. Answer the question. The task moves on to Planning and then Execution by
   itself, each agent taking its step as the work arrives.
3. In Fulfilment the task goes to Vera, who needs to read Finance to price the
   order. Vera is blocked.
4. Click **Grant read on Finance, for this task only**. The task stays blocked.
5. The reason is on screen. Vera carries two older individual rules: `r-01`
   allows reading Finance (left over from a margin review project) and `r-02`
   denies it (added by a later security review). Deny wins among individual
   rules, so adding another allow changes nothing.
6. Click **Revoke the blocking rule**. With `r-02` gone the task-scoped grant
   applies and the task is unblocked. Vera asks to place the order: approve
   it, and the task moves on to review, where you approve it.

A supervisor learns from step 4 that the policy has a real order of precedence
and that the system will explain it. The same story runs headless under
`npm run scenario`. An abridged trace:

```text
> Advance to Execution
   - T-1 moved to Execution (Fulfilment), owner Vera
   - Vera recorded an assumption: The dealer will accept shipment from Laval
   - Vera blocked on read access to Finance. Denied by individual rule r-02 (deny: Security review: fulfilment agents should not read credit data); overrides individual rule r-01 (allow: Needed landed-cost visibility for the margin review project)
   pass  blocked on permission -> blocked_permission

> Dana grants Vera read on Finance
   - r-14: allow read on Finance for Vera (expires with T-1)
   - T-1 still blocked after r-14. Denied by individual rule r-02 (...); overrides individual rule r-01 (...), individual rule r-14 (allow: Dealer tier lookup for this order)
   pass  still blocked, because deny outranks allow -> blocked_permission

> Dana revokes r-02, the blanket security deny
   - r-02 revoked by Dana Reyes
   - T-1 unblocked by revocation of r-02. Advance it to continue.
   pass  unblocked, on the scoped grant alone -> in_progress

> Check Vera's access now the task has closed
   pass  Vera read Finance -> deny
   - Denied by role Fulfilment (deny)
```

## 3. Two people, two views

1. Enter as Dana and open T-1. The thread shows Quill's escalation, which
   was addressed to Dana.
2. Sign out and enter as Sam. The same task shows one message fewer, with a
   note that it was withheld. The grant buttons are gone, and *Advance* is
   disabled with the reason: Sam cannot act in Fulfilment.
3. Sam can still file a new request, because the Intake role may act in
   Reception.

Nothing here is hidden by the interface alone. The server leaves the messages
out of what it sends to Sam, and it refuses the actions if they are sent by
hand.

## 4. A program reading a room with a token

After the grant in workflow 1, open Quill in the inspector and click
**Copy token**. Then, from a terminal:

```bash
curl -H "Authorization: Bearer <token>" http://localhost:8080/api/rooms/finance/thread
```

The reply holds Finance's records and thread for that task. The same token
against `/api/rooms/operations/thread` is refused, because it names Finance.
Approve T-1 and call again: refused, because the task has closed.

## 5. A task waiting on an answer

**T-2** is a branch transfer. Vera asked whether to send four units now or
split the shipment, and the task waits in amber until someone chooses. It is
the same halt as T-1 with a different cause and a different fix.

**T-3** is already complete, so the full path from request to approval can
be read in its thread without clicking through anything.
