#!/usr/bin/env python3
"""Number formatting. One place, so the page reads consistently.

Publishers report in their own units — FRED balance sheets in USD millions, the
ECB in EUR millions, the BoJ sheet in hundred-million yen. These helpers convert
once, at the point of display, and never mutate the computed value.
"""

def _sign(x, digits=1, unit=""):
    if x is None:
        return "n/a"
    return f"{'+' if x >= 0 else '−'}{abs(x):,.{digits}f}{unit}"


def num(x, digits=1):
    return "n/a" if x is None else f"{x:,.{digits}f}"


def pct(x, digits=1):
    return "n/a" if x is None else f"{x:,.{digits}f}%"


def signed_pct(x, digits=1):
    return _sign(x, digits, "%")


def pp(x, digits=2):
    """Percentage points — for spreads and curve slopes."""
    return "n/a" if x is None else f"{x:,.{digits}f}pp"


def signed_pp(x, digits=2):
    return _sign(x, digits, "pp")


def bp(x):
    """A rate change in basis points, from a value expressed in percent."""
    return "n/a" if x is None else f"{'+' if x >= 0 else '−'}{abs(x) * 100:,.0f}bp"


def usd(millions, digits=1):
    """USD millions in the largest unit that keeps it readable.

    Trillion-scale stocks get three decimals: at one decimal a $30bn weekly
    move in a $2.9tn reserve balance rounds away entirely, and that move is
    what the card is about.
    """
    if millions is None:
        return "n/a"
    a = abs(millions)
    if a >= 1_000_000:
        return f"${millions / 1_000_000:,.3f}tn"
    if a >= 1_000:
        return f"${millions / 1_000:,.{digits}f}bn"
    return f"${millions:,.0f}mn"


def usd_bn(bn, digits=1):
    if bn is None:
        return "n/a"
    return f"${bn / 1000:,.3f}tn" if abs(bn) >= 1000 else f"${bn:,.{digits}f}bn"


def signed_usd_bn(bn, digits=1):
    if bn is None:
        return "n/a"
    return f"{'+' if bn >= 0 else '−'}${abs(bn):,.{digits}f}bn"


def eur(millions, digits=1):
    if millions is None:
        return "n/a"
    a = abs(millions)
    if a >= 1_000_000:
        return f"€{millions / 1_000_000:,.3f}tn"
    if a >= 1_000:
        return f"€{millions / 1_000:,.{digits}f}bn"
    return f"€{millions:,.0f}mn"


def signed_eur_bn(bn, digits=2):
    if bn is None:
        return "n/a"
    return f"{'+' if bn >= 0 else '−'}€{abs(bn):,.{digits}f}bn"


def jpy_100mn(value, digits=1):
    """The BoJ reports its balance sheet in hundred-million yen."""
    if value is None:
        return "n/a"
    return f"¥{value / 10_000:,.{digits}f}tn"


def thousands(x, digits=0):
    """A count reported in units, shown in thousands — payrolls, claims."""
    return "n/a" if x is None else f"{x / 1000:,.{digits}f}k"


def signed_thousands(x, digits=0):
    if x is None:
        return "n/a"
    return f"{'+' if x >= 0 else '−'}{abs(x) / 1000:,.{digits}f}k"


def value(x, unit, digits=1):
    """Format by the unit declared in the registry."""
    if x is None:
        return "n/a"
    return {
        "pct": lambda: pct(x, digits),
        "pct_raw": lambda: pct(x, 2),
        "pp": lambda: pp(x),
        "usd_mn": lambda: usd(x),
        "usd_bn": lambda: usd_bn(x),
        "eur_mn": lambda: eur(x),
        "jpy_100mn": lambda: jpy_100mn(x),
        "k": lambda: thousands(x),
        "idx": lambda: num(x, 1),
        "px": lambda: num(x, 2),
        "usd": lambda: f"${x:,.2f}",
        "bp_raw": lambda: f"{x:,.0f}bp",
        "ratio": lambda: f"{x:,.3f}",
    }.get(unit, lambda: num(x, digits))()


def period(label):
    """A publisher's period label, written the way the page speaks."""
    MONTHS = ["January", "February", "March", "April", "May", "June", "July",
              "August", "September", "October", "November", "December"]
    text = str(label)
    if "W" in text:
        year, week = text.split("-W")
        return f"week {int(week)} {year}"
    parts = text.split("-")
    try:
        if len(parts) == 2:
            return f"{MONTHS[int(parts[1]) - 1]} {parts[0]}"
        if len(parts) == 3:
            return f"{int(parts[2])} {MONTHS[int(parts[1]) - 1][:3]} {parts[0]}"
    except (ValueError, IndexError):
        pass
    return text
