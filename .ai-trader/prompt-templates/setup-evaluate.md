# Setup Evaluation Prompt Template

Use when a potential setup is identified and needs scoring before committing.

---

Evaluate this potential setup on [SYMBOL] [TIMEFRAME]:

Proposed:
- Direction: [LONG/SHORT]
- Setup type: [ORB Retest / Liquidity Sweep + FVG / Other]
- Entry zone: [price]
- Proposed stop: [price]
- Proposed TP1: [price]
- Proposed TP2: [price]

Check:
1. Is stop at a logical structure level? (not arbitrary)
2. R to TP1 — is it ≥ 1.2R?
3. HTF (15m) bias alignment?
4. Is price above/below VWAP?
5. Is there an FVG or key level supporting entry?
6. Is liquidity swept before entry?
7. Any major news imminent?
8. Orderflow conflict? (lower confidence if yes, don't auto-reject)
9. Is chart scaling clean?

Then output:

---
Decision: LONG / SHORT / WAIT / REJECT
Confidence: HIGH / MEDIUM / LOW
R to TP1:
R to TP2:
Key support factors:
Key risk factors:
Invalidation:
---
