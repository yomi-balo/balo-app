# Call now: notification copy sheet

Status: proposed, awaiting MJ sign-off. Companion to `.claude/design-references/call-now.jsx` (v3), whose in-product strings live in its `COPY` object and are not repeated here.

Every notification below goes through the notification engine, is idempotent on retries, and needs a row in the Notification Inventory.

## Naming

- The client sees the expert's first name: `Sandy`.
- The expert sees the client company in live and prospective copy: `Northwind Industrial`.
- Retrospective copy to the expert names the person with the company: `Jordan Lee @Northwind Industrial`.
- `{case}` is the case title. `{time}` is the recipient's local time.

## 1. Incoming call (ring)

Trigger: the caller confirms Call now. Recipient: the callee. Lives for the ring window only (45 s, or 120 s when the callee is reached by SMS).

| Channel                                              | To client                                                   | To expert                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| In-app toast (same on every page, the case included) | In `call-now.jsx`                                           | In `call-now.jsx`                                                          |
| Screen reader, once                                  | Sandy is calling.                                           | Northwind Industrial is calling.                                           |
| Browser notification title                           | Sandy is calling                                            | Northwind Industrial is calling                                            |
| Browser notification body                            | {case}. Open Balo to join.                                  | {case}. Open Balo to join.                                                 |
| SMS                                                  | Balo: Sandy is calling you now about "{case}". Join: {link} | Balo: Northwind Industrial is calling you now about "{case}". Join: {link} |
| Email                                                | None                                                        | None                                                                       |

- SMS goes to experts by default and to clients only if they opted in.
- SMS is skipped when the callee is active in the app, when it is outside reasonable hours in their time zone, or when the caller has reached the daily cap for that callee.
- The SMS link opens the call room on mobile web. If the ring has expired, it opens the case, where the missed-call toast offers Call back.
- The in-app surfaces need a realtime push. The bell's 30-second poll is too slow for a 45-second ring.

## 2. Missed call

Trigger: the ring window ends with no answer. Recipient: the callee. Not sent when the callee chose "Not now".

The ringing toast turns into the missed-call toast in place and stays until the person dismisses it, calls back or opens the case. Someone who was offline gets the same toast on their next page load. It never navigates on its own.

| Channel         | To client                                                                                                       | To expert                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Toast title     | You missed a call from Sandy                                                                                    | You missed a call from Northwind Industrial                                                                                            |
| Toast body      | They tried to reach you at {time}.                                                                              | They tried to reach you at {time}.                                                                                                     |
| Toast action    | Call back                                                                                                       | Call back                                                                                                                              |
| Bell item title | Missed call from Sandy                                                                                          | Missed call from Jordan Lee @Northwind Industrial                                                                                      |
| Bell item body  | Sandy tried to reach you at {time} about {case}.                                                                | They tried to reach you at {time} about {case}.                                                                                        |
| Bell action     | Open case                                                                                                       | Open case                                                                                                                              |
| Email subject   | You missed a call from Sandy                                                                                    | You missed a call from Northwind Industrial                                                                                            |
| Email body      | Sandy tried to call you at {time} about {case}. Nothing was charged. Open the case to call back or book a time. | Jordan Lee @Northwind Industrial tried to call you at {time} about {case}. Nothing was counted or charged. Open the case to call back. |
| SMS             | None                                                                                                            | None                                                                                                                                   |

- Needs a new notification kind (`call`) with its own icon in the bell.
- The bell action label follows the existing rule: it is derived from the action URL, so it reads "Open case".
- The toast is sticky while the notification is unread. Dismiss, Call back and visiting the case all mark it read.
- A missed call is never folded into the collapsed "updates" toast.
- Several missed calls from the same person show as one toast ("2 missed calls from Sandy") and, within 10 minutes, one email.
- If a call connects before the email is sent, the email is dropped.

## 3. No answer or declined

Recipient: the caller. In-app only (the call room's end state). No bell item, SMS or email: the caller is watching.

## 4. Call replaced a booked consultation

Trigger: a Call now connects with "in place of today's consultation" chosen. No message on any channel. The calendar event moves to the actual start time, so neither party gets a reminder for a consultation that has already happened.

## 5. Call ended

Existing recap notification and email, unchanged.

## 6. Other party is waiting in a scheduled consultation

Not part of Call now, but agreed in the same thread. Trigger: one party has been alone in the room for about a minute past the scheduled start. Recipient: the absent party.

| Channel | To client                                                        | To expert                                                                       |
| ------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| In-app  | Existing join surfaces                                           | Existing join surfaces                                                          |
| SMS     | Balo: Sandy is waiting in your {time} consultation. Join: {link} | Balo: Northwind Industrial is waiting in your {time} consultation. Join: {link} |
| Email   | None                                                             | None                                                                            |

- Same opt-in and suppression rules as the incoming-call SMS. One SMS per consultation.
- This fires earlier than the existing 5-minute missed-call alert to the Balo team and does not replace it.

## 7. Expert proposes new times close to the start

Existing proposal notification and email, unchanged. Addition: when the consultation starts within 2 hours, also send an SMS to a client who opted in.

SMS: Balo: Sandy can't make your {time} consultation and suggested new times. Pick one: {link}
