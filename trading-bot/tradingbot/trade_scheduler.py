"""Assign fresh signals to affordable queued child budgets or new roots."""

from itertools import combinations


def _capacity(node, cfg):
    if cfg.dust_use_full_budget:
        return float(node["budget"])
    return float(node["planned_loss"])


def assign(signals, queued_children, n_open_total, n_open_children, cfg,
           min_risk_fn=None, db=None):
    """Return (child_node_or_None, signal) pairs, ranked by setup quality."""
    kids = list(queued_children)
    out = []

    ranked = sorted(
        signals,
        key=lambda sig: (
            -float(getattr(sig, "quality_score", 0.0)),
            sig.created_at,
        ),
    )

    for sig in ranked:
        # Unlinked scanner signals are independent entries, never child trades.
        eligible_kids = [
            k for k in kids
            if sig.root_id is not None and k["root_id"] == sig.root_id
        ]
        required = min_risk_fn(sig) if min_risk_fn else None

        if required is None or required <= 0:
            chosen = eligible_kids[0] if eligible_kids else None
            if chosen is not None:
                kids.remove(chosen)
            out.append((chosen, sig))
            continue

        chosen = next((
            k for k in eligible_kids
            if _capacity(k, cfg) >= required
            and (k["planned_loss"] >= required or (cfg.dust_use_full_budget and db is not None))
        ), None)

        if chosen is None and cfg.merge_small_children and db is not None:
            pairs = combinations(eligible_kids, 2)
            pair = next((
                (a, b) for a, b in pairs
                if a["parent_id"] == b["parent_id"]
                and a["root_id"] == b["root_id"]
                and a["level"] == b["level"]
                and _capacity(a, cfg) + _capacity(b, cfg) >= required
            ), None)

            if pair:
                chosen, absorbed = pair
                total_budget = float(chosen["budget"]) + float(absorbed["budget"])
                total_planned = float(chosen["planned_loss"]) + float(absorbed["planned_loss"])
                new_planned = min(total_budget, max(total_planned, required)
                                  if cfg.dust_use_full_budget else total_planned)

                db.update_node(
                    chosen["node_id"], budget=total_budget,
                    planned_loss=new_planned,
                )
                db.update_node(absorbed["node_id"], state="MERGED")
                db.audit("tree", "child_budgets_merged", {
                    "kept": chosen["node_id"],
                    "absorbed": absorbed["node_id"],
                    "required_min_risk": required,
                })
                chosen = db.node(chosen["node_id"])
                kids.remove(absorbed)
                kids = [chosen if k["node_id"] == chosen["node_id"] else k for k in kids]

        if chosen is not None:
            if cfg.dust_use_full_budget and chosen["planned_loss"] < required:
                db.update_node(chosen["node_id"], planned_loss=required)
                chosen = db.node(chosen["node_id"])
            kids.remove(next(k for k in kids if k["node_id"] == chosen["node_id"]))
            out.append((chosen, sig))
        else:
            out.append((None, sig))

    return out
