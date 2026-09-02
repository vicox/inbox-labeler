---
name: inbox-labeler-setup
description: Set up an empty Inbox Labeler with a useful starter label configuration.
---

# Inbox Labeler — setup

One job: turn an empty Inbox Labeler into a working one by creating a fixed starter set of
labels. Nothing else.

Use this for a first-time request — "set up Inbox Labeler", "initialize Inbox Labeler", "create
the starter labels", "give me a good default setup". Do **not** use it for an ordinary later
change: one new label, a rename, a deletion, a reworded instruction, a different Attention, or
remodelling what already exists. Those belong to `inbox-labeler-manage`, and so does every
question about *which* labels a particular user should have.

The five skills divide the work like this, and the boundaries are strict:

| Skill | Its job |
| --- | --- |
| **setup** *(this one)* | initialize an empty Inbox Labeler with the starter set |
| `inbox-labeler-manage` | customise and model labels afterwards |
| `inbox-labeler-process` | classify new unread inbox mail |
| `inbox-labeler-attention` | carry out Attention on already processed unread mail |
| `inbox-labeler-overview` | show already processed unread mail, grouped for scanning |

**This never touches mail.** It never searches Gmail, never opens a thread, never classifies
anything, never applies a Gmail label to a message, never stars or marks anything, and never
records a match. It writes label definitions to Inbox Labeler's MCP server and stops.

Identity is the authenticated MCP session — never ask the user for an account id and never pass
one to any tool.

## What a label is

Each label names the aspect of a message it detects, and carries the fields `create_label`
takes:

| Field | Meaning |
| --- | --- |
| `label` | the label itself — its identity and its display text |
| `type` | `detection` or `derived` |
| `role` | *detection only, required* — `category` (what kind of email this is) or `attribute` (what it contains, indicates or requires) |
| `attention` | what the label asks of the user: `none`, `normal` or `high`. Defaults to `normal` |
| `instruction` | how to decide whether the aspect is present in a message, in natural language |
| `required_labels` | *derived only* — detection labels that must **all** have matched |
| `recommended_labels` | *derived only* — detection labels offered as context |

**Detection labels recognise facts. Derived labels interpret those facts.** A derived label
reads the email together with the detection labels that already matched, and treats those
matches as established facts rather than rediscovering them. `required_labels` is an **AND
gate** — every one of them must have matched, or the derived label is not evaluated at all.
`recommended_labels` are optional context. Derived labels reference detection labels only;
there is no chaining, and there is no third type.

`label` holds the label only. `IL/` is Inbox Labeler's Gmail namespace, added later when
processing talks to Gmail — never put it in a stored label name.

## Step zero: look before you write

**Call `get_labels` first.** Never assume the configuration is empty; the starter set is meant
for an Inbox Labeler that genuinely is.

1. **It returns business labels.** **Stop, and create nothing.** Say plainly that Inbox Labeler
   is already configured, name what is there, and point at `inbox-labeler-manage` for any change
   to it. Do not overwrite them, do not reset them, do not delete them, do not change their
   definitions, and do not quietly merge the starter set in beside them.
2. **It returns an empty list.** That is the normal starting state, not an error. Create the
   starter set below.
3. **The call fails** — the MCP server is unreachable, the session is not authenticated, or the
   call errors. **Report the error verbatim and stop.** Do not fall back to an empty list, do
   not create part of the set, and do not invent local state.

`get_labels` is the only source of truth for this decision. Do not inspect the inbox, do not
look at the user's mail, and do not read Gmail's own label list to work out whether Inbox
Labeler is configured.

`processed` and `no-match` are **reserved system labels** — Inbox Labeler's own state, rejected
on create, and never business labels. They never count towards a configured set.

## The starter set

Fifteen labels, fixed. The model is already decided: never ask the user to choose between
detection and derived, and do not add, drop or substitute a label.

| # | Label | Type | Role | Attention | Required labels |
| --- | --- | --- | --- | --- | --- |
| 1 | `Action required` | `detection` | `attribute` | `normal` | — |
| 2 | `Question` | `detection` | `attribute` | `normal` | — |
| 3 | `Imminent` | `detection` | `attribute` | `normal` | — |
| 4 | `Deadline` | `detection` | `attribute` | `normal` | — |
| 5 | `Cancellation` | `detection` | `attribute` | `normal` | — |
| 6 | `Invoice` | `detection` | `category` | `normal` | — |
| 7 | `Large amount` | `detection` | `attribute` | `normal` | — |
| 8 | `Delivery` | `detection` | `category` | `normal` | — |
| 9 | `Marketing` | `detection` | `attribute` | `normal` | — |
| 10 | `Newsletter` | `detection` | `category` | `normal` | — |
| 11 | `Travel` | `detection` | `category` | `normal` | — |
| 12 | `Large invoice` | `derived` | — | `high` | `Invoice`, `Large amount` |
| 13 | `Delivery arriving soon` | `derived` | — | `high` | `Delivery`, `Imminent` |
| 14 | `Promotional newsletter` | `derived` | — | `none` | `Marketing`, `Newsletter` |
| 15 | `Travel disruption` | `derived` | — | `high` | `Travel`, `Cancellation` |

Four of the eleven detection labels are categories — the kinds of mail this starter set
recognises — and seven are attributes, which is the shape a useful set tends to have: a handful
of kinds, and rather more facts that can turn up inside any of them. `Large amount` is an
attribute rather than a category because an amount is something an email *contains*, not a kind
of email; `Marketing` is an attribute because promotion is a property a newsletter, an invoice
reminder or a travel offer can all have. The derived labels have no role — they are already
interpretations of detection facts, so there is no kind-of-fact for them to be.

None of the four derived labels takes `recommended_labels`; pass an empty list, and pass no
`role` — a derived label is refused one.

**Create them in the order of that table**, detection labels 1–11 before derived labels 12–15,
because a reference to a label that does not exist yet is rejected.

```text
# a detection label — type defaults to detection; role is required
create_label   label:       "Invoice"
               role:        "category"
               attention:   "normal"
               instruction: "<the instruction below, verbatim>"

# a derived label — the reference lists take several labels, and it takes no role
create_label   label:               "Large invoice"
               type:                "derived"
               attention:           "high"
               instruction:         "<the instruction below, verbatim>"
               required_labels:     ["Invoice", "Large amount"]
               recommended_labels:  []
```

## The instructions

Each label below is created with exactly this instruction. Do not paraphrase them, shorten them
or adapt them to the user — they are the tested wording.

**1. `Action required`** — detection, `attribute`, `normal`

> The message asks the recipient to do something specific: pay, reply, confirm or correct data,
> fill in a form, send a document, book, reschedule or cancel an appointment, renew or cancel a
> subscription, buy, sign up, download, collect a parcel, reset a password. It does not match
> messages that only report, confirm or announce something, or that invite vaguely ('stay in
> touch', 'let us know if you have questions'). A link is an action only when clicking it is
> what is asked ('confirm your address', 'shop now'), not because the message contains links —
> an unsubscribe footer, a 'view in browser' link, or a link to information the message already
> announced is not an action. Urgency, optionality, marketing intent and any existing
> relationship with the sender are not part of this label: 'Buy now', 'Update your preferences'
> and 'Payment due' match equally.

**2. `Question`** — detection, `attribute`, `normal`

> The sender is asking the recipient for information, a response, a confirmation, or a decision,
> and expects an answer to come back. What matters is whether an answer is genuinely expected,
> not whether a question mark is present: 'Are you currently hiring?', 'Could you confirm your
> availability?', 'Can you review this proposal?' and 'Please let me know whether this works for
> you.' all match equally. Does not match rhetorical questions, slogans or headlines phrased as
> questions, or text that reads like a question but expects no response, including a question
> the message goes on to answer itself. Who is asking and what the message is about are
> irrelevant: a colleague, a customer, a support requester, a recruiter and a salesperson asking
> all match the same way.

**3. `Imminent`** — detection, `attribute`, `normal`

> The message states that an event, deadline, expiration, or appointment is happening today or
> within the next few days (roughly 3 days) as of when the message was written — e.g. 'arriving
> today', 'expires in 2 days', 'meeting starts in one hour', 'payment due tomorrow'. Judge this
> against the email's own date, not the current date.

**4. `Deadline`** — detection, `attribute`, `normal`

> The message states a concrete deadline, due date, expiration, cutoff, or latest time by which
> something must or may be done — 'submit by 30 October', 'payment due Friday', 'respond before
> 5 PM', 'registration closes 10 September', 'offer expires tomorrow', 'documents must arrive by
> the 15th'. What matters is that a specific point in time is named by which something has to
> happen; the recipient does not have to be the one who acts, as long as the message
> communicates a concrete deadline that concerns them. Judge a relative date against the email's
> own date, not the current date. Does not match vague urgency with no stated cutoff ('as soon
> as possible', 'don't miss out', 'limited time'). This label says nothing about whether the
> deadline is near — that is Imminent — so a deadline months away matches just as fully as one
> tomorrow.

**5. `Cancellation`** — detection, `attribute`, `normal`

> The message states that something planned, booked, scheduled, ordered, subscribed or reserved
> has been cancelled, or is being cancelled by the sender: a cancelled flight, a cancelled
> appointment, a cancelled reservation, a cancelled order, a cancelled event, a subscription
> cancellation confirmation. The cancellation has to be an accomplished fact the message
> reports — 'Your booking has been cancelled' matches; 'Please cancel my booking' does not,
> because nothing has been cancelled yet. Does not match cancellation policies, instructions
> explaining how to cancel, marketing that mentions 'cancel anytime', or a hypothetical
> cancellation. It is not restricted to travel: a cancelled dentist appointment and a cancelled
> software subscription match the same way.

**6. `Invoice`** — detection, `category`, `normal`

> Emails containing an invoice, bill, or receipt for a purchase/service (e.g. subject or content
> mentions invoice, Rechnung, receipt, payment confirmation with an amount due or paid). Does
> not include payment reminders, order confirmations without an invoice, or general
> marketing/promotional emails.

**7. `Large amount`** — detection, `attribute`, `normal`

> The message mentions a monetary amount over 100 (in any currency, e.g. EUR, USD, GBP) — for
> example an invoice total, price, payment, or charge exceeding 100 units of that currency.

**8. `Delivery`** — detection, `category`, `normal`

> The message is a shipping or delivery status update for an order (e.g. 'out for delivery',
> 'delivered', 'shipped', tracking updates from a carrier or retailer like Amazon, DHL, UPS).

**9. `Marketing`** — detection, `attribute`, `normal`

> The message's primary purpose is promotion, advertising, engagement, or campaign
> communication: trying to get the user to buy, try, sign up for, or pay attention to a product,
> service, sale, offer, event, or brand. This includes one-off promotional emails and ads as
> well as recurring newsletter/mailing-list sends, whenever the content itself is promotional —
> a newsletter can be Marketing too, but plenty of marketing mail is not a newsletter. Does not
> include transactional emails (invoices, receipts, shipping/delivery updates, login/security
> codes, booking confirmations) or personal/direct correspondence, even from a company the user
> has a relationship with.

**10. `Newsletter`** — detection, `category`, `normal`

> Detect whether the email is a newsletter or other recurring email sent to subscribers of a
> mailing list. This includes recurring updates, digests, and other subscription-based
> communications. This label describes the delivery format, not the purpose of the email. A
> newsletter may also be Marketing.

**11. `Travel`** — detection, `category`, `normal`

> The message relates to travel or a trip in any way: hotel, hostel or holiday-home bookings;
> train, flight, bus or ferry tickets and reservations; rental car and camper bookings;
> itineraries, check-in reminders, boarding passes and seat reservations; travel confirmations,
> changes, delays or cancellations; and mail from travel providers, booking platforms or travel
> agencies about a trip. Includes both the booking itself and follow-up messages about it. Does
> not include general travel marketing or destination newsletters that are not tied to a trip of
> the user's.

**12. `Large invoice`** — derived, `high`, required: `Invoice`, `Large amount`

> The message is an invoice whose amount is large enough to represent a significant financial
> obligation — e.g. an invoice for a few hundred euros, an annual software renewal invoice, a
> large supplier invoice, a high-value consulting invoice, an enterprise subscription renewal
> with a substantial amount due. Does not match invoices whose amount does not meet the Large
> amount detection criteria.

**13. `Delivery arriving soon`** — derived, `high`, required: `Delivery`, `Imminent`

> The email is a delivery/shipping update that states the delivery is happening today or within
> the next few days, as of when the message was written.

**14. `Promotional newsletter`** — derived, `none`, required: `Marketing`, `Newsletter`

> The message is a promotional mailing-list send: a recurring newsletter or subscriber mailing
> whose content is itself advertising — a product, service, sale, offer, event or brand being
> pushed to a list. Routine bulk promotion the user can skip without missing anything of their
> own. Does not apply when the mailing carries something that concerns the recipient personally
> rather than the whole list, such as a statement about their account, an order of theirs, or a
> deadline they have to meet.

**15. `Travel disruption`** — derived, `high`, required: `Travel`, `Cancellation`

> A booked or planned part of the trip has been cancelled, so the trip itself is now disrupted
> and has to be rearranged — a cancelled flight, train, ferry, hotel reservation, rental car or
> other travel booking. Read the two detection matches as established facts and decide only
> whether together they amount to a disruption of a trip of the recipient's own. Does not apply
> when the cancellation is not part of such a trip: a general travel cancellation policy, travel
> marketing, or a cancellation mentioned by a travel provider that affects no booking of theirs.

## When something fails

Follow Inbox Labeler's own error behaviour and report what actually happened.

- **Never claim the setup succeeded unless all fifteen labels were created.** Say how many were
  created and name the one that failed, with the error.
- **A partial set is a partial set.** Do not pretend it completed, and do not delete the labels
  that did succeed in order to simulate a transaction — Inbox Labeler offers no such rollback,
  and inventing one would throw away work the user can keep.
- The next step after a failure is to fix the cause and create the remaining labels, which is
  ordinary `inbox-labeler-manage` work.
- Do not invent local fallback state, and do not continue into processing.

## After setup

Report the labels that were created — the detection labels, then the derived ones with what
each builds on — and say that they can be changed, added to or removed at any time through
`inbox-labeler-manage`.

Stop there. Setting up labels does not mean running them: classifying mail is
`inbox-labeler-process`, and it runs when the user asks for it.
