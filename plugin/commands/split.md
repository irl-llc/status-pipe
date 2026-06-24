---
description: Carve a focused discussion out of an epic's tracking ticket into a cross-linked sub-ticket (GitHub native sub-issue / Jira parent link), leave one pointer comment on the parent, and record it in the ticket file's subTickets[]. A sub-ticket is a discussion channel, not a work item.
argument-hint: "<ticket-key> <topic...>"
---

**STATUS-PIPE SPLIT — sub-ticket carve-out**

$ARGUMENTS

The first argument is the parent (tracking) ticket key; the rest is the
topic, e.g. `/status-pipe:split 853 token rotation window semantics`. Load
the `protocol` skill (§8 is the splitting rule). Purpose: a long epic funnels
design Q&A, review chatter, and incident follow-ups into one tracking ticket,
which becomes unreadable exactly when the operator most needs the checklist.
Move the conversation out; the parent converges on the checklist plus
one-line lifecycle summaries.

## Steps

1. **Resolve context.** `PROTO="$(git rev-parse --git-common-dir)/../.status-pipe"`;
   read `$PROTO/tickets/<key>.json` (slug, repo, source) and
   `config.json` (ticketing source, attribution). Epic slug = the ticket
   file's `slug`, else derive from the epic header/title. Read the parent's
   comment digest via `fetch-comments --repo-root
   "$(git rev-parse --show-toplevel)" --ticket <key>` to identify the
   in-flight discussion being moved (operator comments are the authoritative
   thread).

2. **Create the sub-ticket**, titled **`<epic-slug>: <topic>`**, body =
   a two-line summary of the discussion so far (quote operator decisions
   only; link — don't quote — non-operator comments) plus a link back to the
   parent. Then cross-link both ways, natively:
   - **GitHub**: create with `gh issue create --title "<epic-slug>: <topic>"
     --body-file ...`, then attach as a **native sub-issue** of the parent:

     ```bash
     SUB_ID=$(gh api repos/{owner}/{repo}/issues/<sub-number> -q .id)
     gh api --method POST repos/{owner}/{repo}/issues/<parent-number>/sub_issues \
       -F sub_issue_id="$SUB_ID"
     ```

     (If the sub-issues API is unavailable on this repo/plan, fall back to
     "Parent: #<parent>" in the sub body — the pointer comment below still
     cross-links.)
   - **Jira**: create the issue with the **parent link** set
     (`fields.parent = {key: "<parent-key>"}` via REST), same title shape.

3. **One pointer comment on the parent** replaces the in-flight discussion —
   via the posting wrapper only, and only after it passes the comment gate
   (protocol skill §7a — run the adversarial reviewer subagent on the draft;
   a pointer comment is short, so this is quick):

   ```bash
   post-comment --repo-root "$(git rev-parse --show-toplevel)" \
     --ticket <key> --issue <parent-number> \
     --body "Discussion on **<topic>** moved to <sub-ticket-url> to keep this checklist readable. Please continue there."
   ```

   Do not delete or edit anyone's existing comments.

4. **Record it in the ticket file** — atomic rewrite of
   `$PROTO/tickets/<key>.json`:
   `subTickets[] += {key: "<sub-key>", url: "<sub-url>", topic: "<topic>",
   status: "open"}`, append history `{at, note: "split '<topic>' out to
   <sub-key>"}`, set `updatedAt`. Do NOT create a ticket file for the
   sub-ticket: it is a **discussion channel, not a work item** — the epic
   stays one card, one state file, one worker.

5. **Report**: the sub-ticket link, the pointer comment link, and a reminder
   that future `waitingOn.ref` values for this topic should deep-link into
   the sub-ticket.
