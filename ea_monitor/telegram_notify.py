"""
telegram_notify.py — Gửi message lên Telegram bot
Usage:
  python telegram_notify.py "message text"
  echo "message" | python telegram_notify.py
  python telegram_notify.py "message" --html        # HTML format
  python telegram_notify.py --file path/to/msg.txt  # đọc UTF-8 trực tiếp (an toàn nhất trên Windows)

LƯU Ý WINDOWS: KHÔNG pipe qua PowerShell (`Get-Content ... | python ...`) — PS 5.1
mặc định $OutputEncoding = US-ASCII nên tiếng Việt + emoji biến thành '?'. Dùng --file.
"""
import os
import sys
import urllib.request
import urllib.parse
import json

TOKEN   = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
if not TOKEN or not CHAT_ID:
    print("LOI: thieu env TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID (User level)", file=sys.stderr)
    sys.exit(1)
API_URL = f"https://api.telegram.org/bot{TOKEN}/sendMessage"

def send(text: str, parse_mode: str = "HTML") -> bool:
    # Telegram limit: 4096 chars per message
    chunks = [text[i:i+4000] for i in range(0, len(text), 4000)]
    ok = True
    for chunk in chunks:
        payload = json.dumps({
            "chat_id":    CHAT_ID,
            "text":       chunk,
            "parse_mode": parse_mode,
            "disable_web_page_preview": True,
        }).encode("utf-8")
        try:
            req = urllib.request.Request(
                API_URL,
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read())
                if not result.get("ok"):
                    print(f"Telegram error: {result}", file=sys.stderr)
                    ok = False
        except Exception as e:
            print(f"Telegram send error: {e}", file=sys.stderr)
            ok = False
    return ok

def main():
    # Đọc message từ --file, args, hoặc stdin
    use_html = "--html" in sys.argv

    # --file <path>: đọc thẳng file UTF-8 (bỏ qua pipe PowerShell — an toàn nhất)
    file_path = None
    if "--file" in sys.argv:
        idx = sys.argv.index("--file")
        if idx + 1 < len(sys.argv):
            file_path = sys.argv[idx + 1]

    args = [a for a in sys.argv[1:] if not a.startswith("--") and a != file_path]

    if file_path:
        with open(file_path, "r", encoding="utf-8") as f:
            text = f.read().strip()
    elif args:
        text = " ".join(args)
    elif not sys.stdin.isatty():
        text = sys.stdin.read().strip()
    else:
        print("Usage: python telegram_notify.py 'message' | --file path", file=sys.stderr)
        sys.exit(1)

    if not text:
        sys.exit(0)

    parse_mode = "HTML" if use_html else "Markdown"
    success = send(text, parse_mode)
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()
