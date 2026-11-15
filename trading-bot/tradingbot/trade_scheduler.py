"""Decides which fresh signal goes to which node, enforcing the account-wide slot limit.

Children may use at most (max_open - reserve_root_slots) slots at once, so a growing
queue of children can never starve new root trades. With the defaults (2 and 1) that
also gives the 'one child at a time' behaviour from the design document.
"""


def assign(signals, queued_children, n_open_total, n_open_children, cfg):
    """Returns [(child_node_or_None, signal)]; None means 'start a new root'."""
    free = cfg.max_open - n_open_total
    child_cap = max(0, cfg.max_open - cfg.reserve_root_slots - n_open_children)
    kids = list(queued_children)
    out = []
    for sig in sorted(signals, key=lambda s: s.created_at):
        if free <= 0:
            break
        if child_cap > 0 and kids:
            out.append((kids.pop(0), sig))
            child_cap -= 1
        else:
            out.append((None, sig))
        free -= 1
    return out
