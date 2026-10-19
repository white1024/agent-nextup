---
name: align-scope
description: Turn a vague direction into a settled scope before any work starts — rounds of numbered questions with your recommended answers, facts checked by you, decisions left to the human. Run it when the ask is broad, ambiguous, or would be expensive to get wrong; skip it when the next step is obvious.
---

# align-scope — settle the scope before building

Goal: when the work starts, there is nothing left that "we will figure out later" — and every assumption behind it is either verified or written down as an assumption.

Use it when the ask is broad ("make the reporting better"), when two readings of the request would lead to materially different work, or when the cost of building the wrong thing is high. Skip it when the next step is obvious — an alignment ritual on a one-line fix is just friction.

## 1. Separate what you can find out from what only the human knows

Before asking anything, split the unknowns into two piles:

- **Findable**: the answer exists in the code, the files, the history, or the environment. Look it up yourself and spend the human's attention only on what needs their judgement. When a lookup will take a while, hand it to a sub-agent if your host has them and carry on: only the questions that depend on its answer wait for it.
- **Human-only**: priorities, trade-offs, what "good" means here, what happens to whoever uses this, what the deadline really is. These are the questions worth asking.

Say what you found before you ask. "The task files already carry a priority field, so ordering is possible today — the question is whether…" is a better question than "how should tasks be ordered?"

## 2. Ask in rounds: the whole frontier at once

The open decisions form a tree — some can only be asked once others are settled. The **frontier** is every question whose prerequisites are already answered: the ones you can ask now without guessing at answers you have not heard yet.

Ask the whole frontier in one round. Number each question, put your recommended answer under it with the reason in a line, and word the question so that "yes" accepts your recommendation:

```
Q1 — <short title>: <the question; the options, if it is a choice>
   Recommended: <your answer> — <why, in one line>

Q2 — <short title>: …
```

Lead the round with the question whose answer changes the most about what gets built. A question that depends on another question in the same round belongs to the next round. Then wait for the answers: each round settles part of the tree and moves the frontier outward, so recompute it and ask the next round.

## 3. Name the trade-off, do not hide it

If an option is cheaper now and costlier later, say so in the same sentence as the option. If you think the request has a problem, say it in a sentence or two — then keep going with the work as asked unless the human changes it. The decision is theirs; the honesty about consequences is yours.

## 4. Write the alignment down where the work will look for it

When the scope settles, record it in the project's own record — the decision, the reasoning, and the options that were rejected **with the reason they were rejected**. A rejected option that is not written down comes back three sessions later as a fresh idea.

State the assumptions you did not verify, explicitly, as assumptions. An assumption on the record can be checked by the next person; an assumption in your head cannot.

## 5. Know when to stop asking

Alignment is finished when both hold: the frontier is empty — every branch visited, nothing silently assumed — and you can state, in a few lines, what will exist when the work is done and how anyone will know it is correct. Write those lines, have the human confirm them, and start building. If you cannot write them, the missing piece is your next question.

Two failure modes, equally bad: building on a guess, and interrogating someone who already told you enough.
