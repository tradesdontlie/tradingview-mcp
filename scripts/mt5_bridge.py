#!/usr/bin/env python3
"""
MT5 bridge — a tiny local HTTP server that wraps the MetaTrader5 Python
package so the Node.js MCP server can reach a running MT5 terminal.

Must run on the same Windows machine as the MT5 terminal (the MetaTrader5
package talks to the terminal over a local IPC channel, not a network
socket). Listens on 127.0.0.1 only by default — do not expose this port
publicly, it can place and close real orders.

Usage:
    pip install MetaTrader5
    python scripts/mt5_bridge.py [--port 8721] [--path "C:\\...\\terminal64.exe"]

Env vars (override CLI flags):
    MT5_BRIDGE_PORT   default 8721
    MT5_BRIDGE_HOST   default 127.0.0.1
    MT5_LOGIN, MT5_PASSWORD, MT5_SERVER   optional — auto-login on startup
    MT5_TERMINAL_PATH                     optional — path to terminal64.exe
"""
import argparse
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

try:
    import MetaTrader5 as mt5
except ImportError:
    print("MetaTrader5 package not found. Install it with: pip install MetaTrader5", file=sys.stderr)
    sys.exit(1)

ORDER_TYPE_MAP = {
    "buy": mt5.ORDER_TYPE_BUY,
    "sell": mt5.ORDER_TYPE_SELL,
}


def _ensure_initialized(terminal_path=None, login=None, password=None, server=None):
    if not mt5.initialize(path=terminal_path) if terminal_path else not mt5.initialize():
        raise RuntimeError(f"MT5 initialize() failed: {mt5.last_error()}")
    if login and password and server:
        if not mt5.login(int(login), password=password, server=server):
            raise RuntimeError(f"MT5 login() failed: {mt5.last_error()}")


def _account_dict():
    info = mt5.account_info()
    if info is None:
        raise RuntimeError(f"account_info() failed: {mt5.last_error()}")
    d = info._asdict()
    d["is_demo"] = d.get("trade_mode") == mt5.ACCOUNT_TRADE_MODE_DEMO
    return d


def _positions_list(symbol=None):
    positions = mt5.positions_get(symbol=symbol) if symbol else mt5.positions_get()
    if positions is None:
        return []
    return [p._asdict() for p in positions]


def _quote_dict(symbol):
    if not mt5.symbol_select(symbol, True):
        raise RuntimeError(f"symbol_select({symbol}) failed: {mt5.last_error()}")
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        raise RuntimeError(f"symbol_info_tick({symbol}) failed: {mt5.last_error()}")
    return tick._asdict()


def _place_order(body):
    symbol = body.get("symbol")
    side = str(body.get("side", "")).lower()
    volume = body.get("volume")
    if not symbol or side not in ORDER_TYPE_MAP or not volume:
        raise ValueError("symbol, side (buy|sell), and volume are required")
    volume = float(volume)
    if not (volume > 0):
        raise ValueError("volume must be > 0")

    if not mt5.symbol_select(symbol, True):
        raise RuntimeError(f"symbol_select({symbol}) failed: {mt5.last_error()}")
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        raise RuntimeError(f"symbol_info_tick({symbol}) failed: {mt5.last_error()}")
    price = tick.ask if side == "buy" else tick.bid

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": ORDER_TYPE_MAP[side],
        "price": price,
        "deviation": int(body.get("deviation", 20)),
        "magic": int(body.get("magic", 990500)),
        "comment": str(body.get("comment", "tradingview-mcp"))[:31],
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    if body.get("sl") is not None:
        request["sl"] = float(body["sl"])
    if body.get("tp") is not None:
        request["tp"] = float(body["tp"])

    result = mt5.order_send(request)
    if result is None:
        raise RuntimeError(f"order_send() returned None: {mt5.last_error()}")
    out = result._asdict()
    if hasattr(result, "request") and result.request is not None:
        out["request"] = result.request._asdict()
    return out


def _close_position(body):
    ticket = body.get("ticket")
    if not ticket:
        raise ValueError("ticket is required")
    ticket = int(ticket)
    positions = mt5.positions_get(ticket=ticket)
    if not positions:
        raise RuntimeError(f"no open position with ticket {ticket}")
    pos = positions[0]
    volume = float(body.get("volume") or pos.volume)
    close_side = "sell" if pos.type == mt5.ORDER_TYPE_BUY else "buy"

    tick = mt5.symbol_info_tick(pos.symbol)
    if tick is None:
        raise RuntimeError(f"symbol_info_tick({pos.symbol}) failed: {mt5.last_error()}")
    price = tick.bid if close_side == "sell" else tick.ask

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": pos.symbol,
        "volume": volume,
        "type": ORDER_TYPE_MAP[close_side],
        "position": ticket,
        "price": price,
        "deviation": int(body.get("deviation", 20)),
        "magic": int(body.get("magic", 990500)),
        "comment": "tradingview-mcp close",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(request)
    if result is None:
        raise RuntimeError(f"order_send() returned None: {mt5.last_error()}")
    return result._asdict()


def _modify_position(body):
    ticket = body.get("ticket")
    if not ticket:
        raise ValueError("ticket is required")
    ticket = int(ticket)
    positions = mt5.positions_get(ticket=ticket)
    if not positions:
        raise RuntimeError(f"no open position with ticket {ticket}")
    pos = positions[0]

    request = {
        "action": mt5.TRADE_ACTION_SLTP,
        "symbol": pos.symbol,
        "position": ticket,
        "sl": float(body["sl"]) if body.get("sl") is not None else pos.sl,
        "tp": float(body["tp"]) if body.get("tp") is not None else pos.tp,
    }
    result = mt5.order_send(request)
    if result is None:
        raise RuntimeError(f"order_send() returned None: {mt5.last_error()}")
    return result._asdict()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8")) if raw else {}

    def _handle(self, method):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        try:
            if path == "/health" and method == "GET":
                info = mt5.terminal_info()
                self._send_json({"success": True, "connected": info is not None,
                                  "terminal": info._asdict() if info else None})
            elif path == "/account" and method == "GET":
                self._send_json({"success": True, "account": _account_dict()})
            elif path == "/positions" and method == "GET":
                symbol = qs.get("symbol", [None])[0]
                self._send_json({"success": True, "positions": _positions_list(symbol)})
            elif path == "/quote" and method == "GET":
                symbol = qs.get("symbol", [None])[0]
                if not symbol:
                    raise ValueError("symbol query param is required")
                self._send_json({"success": True, "quote": _quote_dict(symbol)})
            elif path == "/order" and method == "POST":
                self._send_json({"success": True, "result": _place_order(self._read_json_body())})
            elif path == "/order/close" and method == "POST":
                self._send_json({"success": True, "result": _close_position(self._read_json_body())})
            elif path == "/order/modify" and method == "POST":
                self._send_json({"success": True, "result": _modify_position(self._read_json_body())})
            else:
                self._send_json({"success": False, "error": f"not found: {method} {path}"}, status=404)
        except Exception as e:  # noqa: BLE001 — bridge must never crash on a bad request
            self._send_json({"success": False, "error": str(e)}, status=400)

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")


def main():
    parser = argparse.ArgumentParser(description="MT5 HTTP bridge for tradingview-mcp")
    parser.add_argument("--port", type=int, default=int(os.environ.get("MT5_BRIDGE_PORT", 8721)))
    parser.add_argument("--host", default=os.environ.get("MT5_BRIDGE_HOST", "127.0.0.1"))
    parser.add_argument("--path", default=os.environ.get("MT5_TERMINAL_PATH"))
    args = parser.parse_args()

    _ensure_initialized(
        terminal_path=args.path,
        login=os.environ.get("MT5_LOGIN"),
        password=os.environ.get("MT5_PASSWORD"),
        server=os.environ.get("MT5_SERVER"),
    )
    account = _account_dict()
    mode = "DEMO" if account["is_demo"] else "LIVE"
    print(f"MT5 bridge connected — account {account.get('login')} ({mode}), "
          f"server {account.get('server')}, balance {account.get('balance')} {account.get('currency')}",
          file=sys.stderr)
    if mode == "LIVE":
        print("WARNING: this is a LIVE account. Orders placed through this bridge use real money.", file=sys.stderr)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"MT5 bridge listening on http://{args.host}:{args.port}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    main()
