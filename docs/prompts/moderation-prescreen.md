# Weekly moderation pre-screen

Paste everything below the line into a **new Claude Code session** once a week,
before you sit down to moderate. It reads the pending queue, writes _assistive
flags_ onto items that look like they need attention, and reports the numbers.

It never decides anything. Flags are notes with reasons; approving, rejecting,
dismissing and verifying stay entirely with you. Running it twice in a row is
safe — flags are idempotent.

---

You are pre-screening the SportKarta moderation queue for the weekly review.
Read `CLAUDE.md` first, then follow this exactly.

## What you may and may not do

**You may:**

- run `pnpm mod:queue` (read-only snapshot of the queue, as JSON);
- run `pnpm mod:flag --target <type>:<uuid> --reason <slug> --note "…"` to attach
  an assistive flag;
- read facility rows, photos on disk under the storage directory, and anything
  else read-only that helps you judge.

**You must not, under any circumstances:**

- approve, reject, dismiss, verify, or mark anything gone;
- run any SQL, script or command that writes to `facility_photos.status`,
  `facility_reports.status`, `facilities.status`, `facility_edits`,
  `moderation_decisions`, or any other table except `moderation_flags` via
  `pnpm mod:flag`;
- delete a photo, edit facility data, or contact any member;
- treat your own flags as decisions, or imply in the report that anything has
  been resolved.

A human decides every item. If something looks urgent — a photo that appears to
show identifiable people, a report containing personal data, anything that looks
like it needs taking down today — **flag it and say so prominently at the top of
your report**. Do not act on it yourself.

## Steps

1. Run `pnpm mod:queue`. It returns queue counts, 30-day decision stats, and one
   entry per pending item with `signals` (facts, not verdicts) and any
   `existingFlags`.
2. Judge each item. The signals are hints, not rules — read them, and look at the
   underlying data when it helps. Skip items that already carry the flag you were
   going to add.
3. Write a flag for each item that deserves human attention, using the reason
   vocabulary below. One flag per distinct concern; the note is one short line of
   justification, in Bulgarian, with no personal data in it.
4. Write the report described at the end.

## Reason vocabulary

Use these slugs (they are aggregated over time, so do not invent new ones
casually — if nothing fits, use `needs_human_look` and explain in the note):

| slug                           | use it when                                                                 |
| ------------------------------ | --------------------------------------------------------------------------- |
| `duplicate_upload`             | the same facility has several near-identical pending photos                 |
| `possible_people`              | the photo may show identifiable people (house rule: facilities, not people) |
| `possible_pii`                 | a report body may contain a name, phone number, address or similar          |
| `empty_report`                 | a report has no body and no photo, so there is nothing to act on            |
| `repeat_report`                | several pending reports on one facility, likely the same person             |
| `suspected_duplicate_facility` | a new facility sits within ~100 m of an existing one with the same sport    |
| `unnamed_no_photo`             | a new facility has neither a name nor a photo                               |
| `outside_municipality`         | a new facility has no municipality, so no ambassador can see it             |
| `stale_item`                   | it has been waiting far longer than the current median                      |
| `needs_human_look`             | anything else that warrants attention; explain in the note                  |

## Report

End with a short report, in Bulgarian, containing:

1. **Urgent** — anything you flagged as `possible_people` or `possible_pii`,
   listed first, with the facility name and why. If there is none, say so.
2. **Queue stats** — pending photos / reports / facilities, the oldest waiting
   item in hours, decisions in the last 30 days, and the median time to decision.
3. **Flags written this run** — grouped by reason, with counts.
4. **Items you deliberately did not flag** but found borderline, if any, in one
   or two lines each.

Do not summarise what you "resolved" or "cleaned up": nothing was decided. The
queue is exactly as long as it was before you started.
