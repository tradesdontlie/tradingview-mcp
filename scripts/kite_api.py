#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Iterable
from urllib.parse import quote_plus

import requests


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ENV_FILES = [
    REPO_ROOT / "config" / "runtime.env",
    REPO_ROOT / "config" / "local.env",
]
DEFAULT_LOCAL_ENV = REPO_ROOT / "config" / "local.env"
DEFAULT_KITE_SESSION_DIR = REPO_ROOT / "market" / "raw" / "kite" / "session"
KITE_API_ROOT = "https://api.kite.trade"
KITE_LOGIN_ROOT = "https://kite.zerodha.com/connect/login"


def load_env_files(paths: Iterable[Path]) -> None:
    for path in paths:
        if not path.exists():
            continue
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def read_json(path: Path) -> object | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def upsert_env_values(path: Path, values: dict[str, str | None]) -> None:
    existing_lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    existing_map: dict[str, str] = {}
    order: list[str] = []
    for raw_line in existing_lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in raw_line:
            continue
        key, value = raw_line.split("=", 1)
        key = key.strip()
        if key not in order:
            order.append(key)
        existing_map[key] = value.strip()
    for key, value in values.items():
        if value is None:
            continue
        if key not in order:
            order.append(key)
        existing_map[key] = str(value)
    lines = [f"{key}={existing_map[key]}" for key in order]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def require_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing `{name}`. Add it to config/local.env or pass an env file.")
    return value


def kite_headers(*, api_key: str | None = None, access_token: str | None = None) -> dict[str, str]:
    headers = {"X-Kite-Version": "3"}
    if api_key and access_token:
        headers["Authorization"] = f"token {api_key}:{access_token}"
    return headers


def parse_error(response: requests.Response) -> str:
    try:
        payload = response.json()
    except Exception:
        return response.text.strip() or f"HTTP {response.status_code}"
    if isinstance(payload, dict):
        parts = [payload.get("message"), payload.get("error_type"), payload.get("status")]
        message = " | ".join(str(part) for part in parts if part)
        if message:
            return message
    return json.dumps(payload)


def kite_request(
    method: str,
    path: str,
    *,
    api_key: str | None = None,
    access_token: str | None = None,
    params: dict | None = None,
    data: dict | None = None,
    json_body: object | None = None,
    timeout: int = 30,
) -> requests.Response:
    response = requests.request(
        method=method,
        url=f"{KITE_API_ROOT}{path}",
        headers=kite_headers(api_key=api_key, access_token=access_token),
        params=params,
        data=data,
        json=json_body,
        timeout=timeout,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Kite API {method} {path} failed: {parse_error(response)}")
    return response


def build_login_url(api_key: str, redirect_params: str | None = None) -> str:
    base = f"{KITE_LOGIN_ROOT}?v=3&api_key={quote_plus(api_key)}"
    if redirect_params:
        base += f"&redirect_params={quote_plus(redirect_params)}"
    return base


def checksum_for_request_token(api_key: str, request_token: str, api_secret: str) -> str:
    return hashlib.sha256(f"{api_key}{request_token}{api_secret}".encode("utf-8")).hexdigest()


def exchange_request_token(api_key: str, api_secret: str, request_token: str) -> dict:
    response = kite_request(
        "POST",
        "/session/token",
        data={
            "api_key": api_key,
            "request_token": request_token,
            "checksum": checksum_for_request_token(api_key, request_token, api_secret),
        },
    )
    payload = response.json()
    if not isinstance(payload, dict) or "data" not in payload:
        raise RuntimeError("Kite token exchange returned an unexpected response.")
    return payload


def get_user_profile(api_key: str, access_token: str) -> dict:
    response = kite_request("GET", "/user/profile", api_key=api_key, access_token=access_token)
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError("Kite profile returned an unexpected response.")
    return payload


def get_instruments_csv(api_key: str, access_token: str, *, exchange: str | None = None) -> str:
    path = "/instruments" if not exchange else f"/instruments/{exchange}"
    response = kite_request("GET", path, api_key=api_key, access_token=access_token, timeout=120)
    return response.text


def get_historical_candles(
    api_key: str,
    access_token: str,
    instrument_token: str | int,
    interval: str,
    *,
    from_ts: str,
    to_ts: str,
    continuous: int | None = None,
    oi: int | None = None,
) -> dict:
    params = {"from": from_ts, "to": to_ts}
    if continuous is not None:
        params["continuous"] = int(continuous)
    if oi is not None:
        params["oi"] = int(oi)
    response = kite_request(
        "GET",
        f"/instruments/historical/{instrument_token}/{interval}",
        api_key=api_key,
        access_token=access_token,
        params=params,
        timeout=120,
    )
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError("Kite historical data returned an unexpected response.")
    return payload


def get_quotes(api_key: str, access_token: str, instruments: list[str], *, mode: str = "quote") -> dict:
    if mode not in {"quote", "ohlc", "ltp"}:
        raise ValueError("mode must be one of quote, ohlc, ltp")
    path = "/quote" if mode == "quote" else f"/quote/{mode}"
    params = [("i", instrument) for instrument in instruments]
    response = requests.get(
        f"{KITE_API_ROOT}{path}",
        headers=kite_headers(api_key=api_key, access_token=access_token),
        params=params,
        timeout=30,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Kite quote fetch failed: {parse_error(response)}")
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError("Kite quote API returned an unexpected response.")
    return payload


def get_order_charges(api_key: str, access_token: str, orders: list[dict], *, timeout: int = 60) -> dict:
    response = kite_request(
        "POST",
        "/charges/orders",
        api_key=api_key,
        access_token=access_token,
        json_body=orders,
        timeout=timeout,
    )
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError("Kite order charges API returned an unexpected response.")
    return payload
