#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from kite_api import (
    DEFAULT_ENV_FILES,
    DEFAULT_KITE_SESSION_DIR,
    DEFAULT_LOCAL_ENV,
    build_login_url,
    exchange_request_token,
    get_user_profile,
    load_env_files,
    require_env,
    upsert_env_values,
    write_json,
)


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REDIRECT_LOG = REPO_ROOT / "market" / "kite" / "kite_redirect_events.jsonl"


def latest_request_token(path: Path) -> str | None:
    if not path.exists():
        return None
    lines = path.read_text(encoding="utf-8").splitlines()
    for raw_line in reversed(lines):
        line = raw_line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        token = str(payload.get("request_token") or "").strip()
        if token:
            return token
    return None


def exchange_and_store(
    *,
    request_token: str,
    env_out: Path,
    session_dir: Path,
) -> dict:
    api_key = require_env("KITE_API_KEY")
    api_secret = require_env("KITE_API_SECRET")
    token_payload = exchange_request_token(api_key, api_secret, request_token)
    data = token_payload.get("data", {}) if isinstance(token_payload, dict) else {}
    access_token = str(data.get("access_token") or "").strip()
    public_token = str(data.get("public_token") or "").strip()
    user_id = str(data.get("user_id") or "").strip()
    login_time = str(data.get("login_time") or "").strip()
    if not access_token:
        raise RuntimeError("Kite token exchange succeeded but returned no access_token.")
    upsert_env_values(
        env_out,
        {
            "KITE_ACCESS_TOKEN": access_token,
            "KITE_PUBLIC_TOKEN": public_token,
            "KITE_USER_ID": user_id,
            "KITE_LOGIN_TIME": login_time,
        },
    )
    write_json(session_dir / "latest_session.json", token_payload)
    profile_payload = get_user_profile(api_key, access_token)
    write_json(session_dir / "latest_profile.json", profile_payload)
    return {
        "request_token": request_token,
        "env_file": str(env_out.resolve()),
        "session_file": str((session_dir / "latest_session.json").resolve()),
        "profile_file": str((session_dir / "latest_profile.json").resolve()),
        "user_id": user_id,
        "login_time": login_time,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Handle Zerodha Kite login URL generation and request_token exchange.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    login_url = subparsers.add_parser("login-url", help="Print the Kite login URL for the configured API key.")
    login_url.add_argument("--redirect-params", default="source=codex", help="Optional redirect_params string.")
    login_url.add_argument("--json", action="store_true")

    exchange_latest = subparsers.add_parser("exchange-latest", help="Read the latest request_token from the callback log and exchange it.")
    exchange_latest.add_argument("--redirect-log", default=str(DEFAULT_REDIRECT_LOG))
    exchange_latest.add_argument("--env-out", default=str(DEFAULT_LOCAL_ENV))
    exchange_latest.add_argument("--session-dir", default=str(DEFAULT_KITE_SESSION_DIR))
    exchange_latest.add_argument("--json", action="store_true")

    exchange_manual = subparsers.add_parser("exchange-request-token", help="Exchange an explicit request_token.")
    exchange_manual.add_argument("--request-token", required=True)
    exchange_manual.add_argument("--env-out", default=str(DEFAULT_LOCAL_ENV))
    exchange_manual.add_argument("--session-dir", default=str(DEFAULT_KITE_SESSION_DIR))
    exchange_manual.add_argument("--json", action="store_true")

    profile = subparsers.add_parser("profile", help="Fetch the current Kite user profile using the stored access token.")
    profile.add_argument("--json", action="store_true")

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    load_env_files(DEFAULT_ENV_FILES)

    if args.command == "login-url":
        api_key = require_env("KITE_API_KEY")
        payload = {
            "api_key": api_key,
            "login_url": build_login_url(api_key, redirect_params=args.redirect_params),
        }
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            print(payload["login_url"])
        return

    if args.command == "exchange-latest":
        token = latest_request_token(Path(args.redirect_log))
        if not token:
            raise RuntimeError(f"No request_token found in {args.redirect_log}. Complete the login flow first.")
        payload = exchange_and_store(
            request_token=token,
            env_out=Path(args.env_out),
            session_dir=Path(args.session_dir),
        )
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            print(json.dumps(payload, indent=2))
        return

    if args.command == "exchange-request-token":
        payload = exchange_and_store(
            request_token=args.request_token,
            env_out=Path(args.env_out),
            session_dir=Path(args.session_dir),
        )
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            print(json.dumps(payload, indent=2))
        return

    if args.command == "profile":
        api_key = require_env("KITE_API_KEY")
        access_token = require_env("KITE_ACCESS_TOKEN")
        payload = get_user_profile(api_key, access_token)
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            print(json.dumps(payload, indent=2))
        return

    raise RuntimeError(f"Unsupported command: {args.command}")


if __name__ == "__main__":
    main()
