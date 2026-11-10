# Step 19 — A student lets their instructor know

> Final state: see `Steps/README.md`. This is your Part 19 request, in your own words, with every decision made while designing and building it merged into the instructions. Running it after Steps 1–18 rebuilds the current app.

## Your original request

> This is conversation of the student it should have said who would you like to notify and if they said my classes then just like the instructor have something that says type message and have it sent to the instructor and the instructor agent acknowledges receipt and tells the student that the instructor has been notified. This process should feel very natural.

## Your decisions while designing it (merged into the instructions below)

- *“prefill it with what they typed so they can edit or add more to it”*: the card's box starts with the student's own words.
- *“noe one thanks is werid if this si to cancel just say “Cancel"”*: the second button is **Cancel**.
- You approved the mockup: `docs/superpowers/specs/2026-11-09-student-notify-mockup.html`.

## Instructions

1. **The Student agent notices a student who can't come** (`src/student-notify.js`, code only, no model). `readsAbsence(text)` is true for first-person statements such as “i am sick today”, “I have the flu”, “I'll miss class Thursday”, “I can't make it to class”, “I'll be absent”, “family emergency”. It is false for a question (“what should I do if I'm sick?”), for another service (tutoring, library, book, room, appointment, HR, time off) and for “sick of …”. A message that already names the instructor (“tell Dr. Dabirian I'm sick”) goes on as before and is sent at once.
2. **It asks who should know** — nothing is sent to the university yet. Reply: “Sorry you're not feeling well. Who would you like me to let know?” (without “Sorry …” when no illness is named), with two tap buttons: **Dr. Dabirian · Marketing 351** and **Cancel**. Who teaches which course comes from the course notice in the Student agent's own inbox; the course capability is the one public capability tagged for the class. No course notice yet → nothing changes.
3. **The answer** (`whoOf`, short answers only, 15-minute wait): “my classes”, “my professor”, “teacher”, “Dr. Dabirian”, “marketing”, the button → the instructor; “Cancel”, “no one”, “never mind” → “OK, I didn't send anything.”; someone the demo can't reach (“my boss”, “my mom”) → “Here I can only reach Dr. Dabirian, your Marketing 351 instructor. Want me to let them know?” (then “yes” opens the card); anything longer is a new message, handled as usual.
4. **The message card** (`public/notify-ui.js`, native, `textContent` only): “Message to your instructor”, “To: **Dr. Dabirian** · Marketing 351”, “Your message — edit it or add more” with the student's words already in the box (1000 characters), “Only Dr. Dabirian will see this — not your classmates.”, **Send** and **Don't send**. States: open, sending, sent (“✓ Sent”, the words shown as sent), not_sent (struck through, “Not sent”), unsure. The server owns the state (`notify_card` events, memory only, cleared by New conversation).
5. **Send** (`POST /api/notify/:cardId/send { text }` → a chat run to the course capability with `metadata.studentNote: true`). The Hub forwards `studentNote` only for a course the Student agent named and never with a lesson. The Faculty agent stores the words in Dr. Dabirian's chat as a hand-over FIRST (the existing “waiting for your answer” card with ↩ Reply), then answers “Got it — Dr. Dabirian has been notified. They'll reply to you here.” (+ “Feel better soon.” when an illness is named), outcome `notified`. Only that outcome marks the card sent. Not delivered → the card stays open with “I couldn't reach Dr. Dabirian just now, so nothing was sent. Press Send again in a moment.” (a new request ID). No answer in time → “I'm not sure this reached Dr. Dabirian. Press Send again — they won't get it twice.” and the same request ID is reused, so the Hub returns the first result instead of sending twice. A second Send after sent is refused (409). **Don't send** → `POST /api/notify/:cardId/decline`, nothing sent.
6. **Privacy.** The words go only to the instructor. The student's own words are not drawn twice (the card shows them; `request_sent` carries `notifyCardId` and is not drawn as a bubble). Topology labels name no words.
7. **Tests:** `test/student-notify.test.js` (reader, answers, end to end on a mock stack: ask → card prefilled → Send → hand-over stored → receipt; Cancel; Don't send; a message to Dr. Dabirian goes on as before).

## Avoid these known problems

- A test that reads a card's state right after the answer of `/decline` must wait for the `notify_card` event; it can arrive a moment later.
- Never mark the card sent from the Student agent's side: only the Faculty agent's `notified` outcome (stored before it answers) may.
- Re-sending after an unsure answer must reuse the same request ID and the same words, or the instructor could get the message twice.

## Enhancements merged into this step

- Mockup review: “No one, thanks” became **Cancel** (owner).
