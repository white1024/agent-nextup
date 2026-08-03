---
name: align-scope
description: Turn a vague direction into a settled scope before any work starts — one question at a time, facts checked by you, decisions left to the human. Run it when the ask is broad, ambiguous, or would be expensive to get wrong; skip it when the next step is obvious.
---

# align-scope — settle the scope before building

Goal: when the work starts, there is nothing left that "we will figure out later" — and every assumption behind it is either verified or written down as an assumption.

Use it when the ask is broad ("make the reporting better"), when two readings of the request would lead to materially different work, or when the cost of building the wrong thing is high. Skip it when the next step is obvious — an alignment ritual on a one-line fix is just friction.

## 1. Separate what you can find out from what only the human knows

Before asking anything, split the unknowns into two piles:

- **Findable**: the answer exists in the code, the files, the history, or the environment. Go and read it. **Never spend a question on something you could have looked up** — it wastes the human's attention and it teaches them that answering you is cheap for you and expensive for them.
- **Human-only**: priorities, trade-offs, what "good" means here, what happens to whoever uses this, what the deadline really is. These are the questions worth asking.

Say what you found before you ask. "The task files already carry a priority field, so ordering is possible today — the question is whether…" is a better question than "how should tasks be ordered?"

## 2. Ask one question at a time

A list of six questions gets one answer to the easiest one. Ask the single highest-leverage question, wait, then let the answer reshape what you ask next — half the remaining questions usually dissolve.

Highest-leverage means: the answer that changes the most about what gets built. Ask that one first, not the one that is easiest to phrase.

Where the answer is a choice between a few concrete options, present the options and say which one you would pick and why. "Either A or B, and I would take A because X" is easier to answer than an open question, and it puts your reasoning where it can be corrected.

## 3. Name the trade-off, do not hide it

If an option is cheaper now and costlier later, say so in the same sentence as the option. If you think the request has a problem, say it in a sentence or two — then keep going with the work as asked unless the human changes it. The decision is theirs; the honesty about consequences is yours.

## 4. Write the alignment down where the work will look for it

When the scope settles, record it in the project's own record — the decision, the reasoning, and the options that were rejected **with the reason they were rejected**. A rejected option that is not written down comes back three sessions later as a fresh idea.

State the assumptions you did not verify, explicitly, as assumptions. An assumption on the record can be checked by the next person; an assumption in your head cannot.

## 5. Know when to stop asking

Alignment is finished when you can state, in a few lines, what will exist when the work is done and how anyone will know it is correct. If you can write that, stop asking and start building. If you cannot, the missing piece is your next question.

Two failure modes, equally bad: building on a guess, and interrogating someone who already told you enough.
