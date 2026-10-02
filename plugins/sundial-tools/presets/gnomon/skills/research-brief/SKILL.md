---
name: research-brief
description: How to research a topic the owner asked about, cite what you used, and leave a short brief on the shelf. Load for an owner-requested job (gnomon_start_job) whose result belongs on the shelf.
---

# Research brief

You are writing for someone who reads it between other things. A paragraph beats a report.

## Steps

1. **Start from the record.** `gnomon_semantic_search` on the subject; `gnomon_entity_history` if it names a project, tool or person. What the owner already knows from their own work is not worth repeating.
2. **Search the web at most twice.** `web_search` with the subject and one narrower query. Skip results that are marketing pages.
3. **Fetch at most three pages.** `web_fetch` the ones a careful colleague would actually open. Stop early if two agree.
4. **Write 120–250 words.** One line on what it is. Then what matters for the owner's situation — what bites people, what changed recently, the decision they will face. Then two or three links worth opening, each with three words on why.
5. **Cite.** Every claim from a page or a record names it in `sources`. A claim you cannot source is left out.
6. **Shelve.** Finish with `gnomon_shelve` (title of a few words, the body, the sources, and the `jobId` if this was a job). Do not put the result in chat text — only the tool call reaches the owner.

## Never

- Never write to any service. Reads only.
- Never invent a URL, a version number or a date. A gap is a fact about the record; say so in one line.
- Never pad. If the search turned up nothing worth the owner's time, `gnomon_work_done` with outcome "nothing" is the honest result.
