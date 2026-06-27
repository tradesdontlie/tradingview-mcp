"""
Convert a local HTML file to a PDF using headless Chromium via Playwright.

Designed for the dark-themed self-contained report HTML produced by this repo:
  - Renders backgrounds (the report is dark-themed; without this they print white).
  - A3 portrait keeps the ~1100px-wide single-column layout from being squeezed
    horizontally; the report's CSS max-width still controls the content area.
  - Waits for `networkidle` so embedded base64 images (~300+ KB) are decoded
    before snapshotting.

Usage:
  python scripts/html_to_pdf.py <input.html> [<output.pdf>]

If output is omitted, writes alongside the input with a .pdf extension.
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright


def html_to_pdf(html_path: Path, pdf_path: Path) -> None:
    url = html_path.resolve().as_uri()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto(url, wait_until="networkidle")
        page.pdf(
            path=str(pdf_path),
            format="A3",
            print_background=True,
            margin={"top": "12mm", "bottom": "12mm", "left": "12mm", "right": "12mm"},
            prefer_css_page_size=False,
        )
        browser.close()


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    html_path = Path(sys.argv[1])
    if not html_path.exists():
        print(f"Input not found: {html_path}", file=sys.stderr)
        return 1
    pdf_path = Path(sys.argv[2]) if len(sys.argv) >= 3 else html_path.with_suffix(".pdf")
    html_to_pdf(html_path, pdf_path)
    size = pdf_path.stat().st_size
    print(f"Wrote {pdf_path} ({size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
