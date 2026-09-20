"""Hermes Agent plugin: real pre_tool_call guardrails via eval.seanbehan.ca.

The plugin is dependency-free (stdlib only), so Hermes can load it from
``~/.hermes/plugins/eval-jev-guardrails/`` without a pip install. Every
pre_tool_call sends ``POST {base}/v1/evaluate`` with ``side="action"`` and
returns ``{"action": "block", "message": ...}`` when the verdict is ``block``
or ``support`` (and for ``review`` unless ``EVAL_REVIEW_MODE=allow``).

Configuration is resolved in the same order as the TypeScript client:

1. ``EVAL_API_KEY`` and ``EVAL_BASE_URL``;
2. ``~/.config/eval-jev/config.json`` (or ``EVAL_CONFIG_PATH`` /
   ``XDG_CONFIG_HOME``);
3. ``https://eval.seanbehan.ca``.

Failure behavior is controlled by ``EVAL_FAIL_MODE``:

* ``open`` (default) — allow the tool call when the service cannot answer;
* ``review`` — treat failures as a review verdict (blocked unless
  ``EVAL_REVIEW_MODE=allow``);
* ``closed`` — block the tool call when the service cannot answer.

Hermes itself fails open: if this callback raises, it logs a warning and lets
the tool run. The plugin never raises out of ``pre_tool_call``; it returns an
explicit directive or ``None``.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

__version__ = "0.1.0"
PLUGIN_NAME = "eval-jev-guardrails"
DEFAULT_BASE_URL = "https://eval.seanbehan.ca"
DEFAULT_TIMEOUT_MS = 5000

_FAIL_MODES = ("open", "review", "closed")
_REVIEW_MODES = ("deny", "allow")


def _env(name):
    value = os.environ.get(name)
    if isinstance(value, str):
        value = value.strip()
        return value if value else None
    return None


def _config_path():
    explicit = _env("EVAL_CONFIG_PATH")
    if explicit:
        return explicit
    xdg = _env("XDG_CONFIG_HOME")
    base = xdg if xdg else os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "eval-jev", "config.json")


def _read_file_config():
    path = _config_path()
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _resolve_config():
    file_config = _read_file_config()
    api_key = _env("EVAL_API_KEY") or file_config.get("apiKey") or ""
    base_url = (
        _env("EVAL_BASE_URL")
        or file_config.get("baseUrl")
        or file_config.get("baseURL")
        or DEFAULT_BASE_URL
    )
    if not isinstance(api_key, str):
        api_key = ""
    if not isinstance(base_url, str) or not base_url.strip():
        base_url = DEFAULT_BASE_URL
    return api_key.strip(), base_url.strip().rstrip("/")


def _fail_mode():
    value = (_env("EVAL_FAIL_MODE") or "open").lower()
    return value if value in _FAIL_MODES else "open"


def _review_mode():
    value = (_env("EVAL_REVIEW_MODE") or "deny").lower()
    return value if value in _REVIEW_MODES else "deny"


def _timeout_seconds():
    raw = _env("EVAL_TIMEOUT_MS") or str(DEFAULT_TIMEOUT_MS)
    try:
        milliseconds = float(raw)
    except (TypeError, ValueError):
        milliseconds = float(DEFAULT_TIMEOUT_MS)
    return max(0.25, milliseconds / 1000.0)


def _post_evaluate(api_key, base_url, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(base_url + "/v1/evaluate", data=body, method="POST")
    request.add_header("Authorization", "Bearer " + api_key)
    request.add_header("Content-Type", "application/json")
    request.add_header("Accept", "application/json")
    request.add_header(
        "User-Agent",
        "@codebam/eval-jev-guardrails-hermes/%s" % __version__,
    )
    with urllib.request.urlopen(request, timeout=_timeout_seconds()) as response:
        raw = response.read().decode("utf-8")
    return json.loads(raw) if raw.strip() else {}


def _hazard_label(hazards):
    if not isinstance(hazards, dict):
        return None
    best_name = None
    best_value = None
    for name, value in hazards.items():
        if not isinstance(value, (int, float)):
            continue
        if best_value is None or value > best_value:
            best_name, best_value = name, value
    if best_name is None:
        return None
    label = str(best_name).replace("_", " ")
    if isinstance(best_value, (int, float)):
        return "%s (%.0f%% confidence)" % (label, float(best_value) * 100.0)
    return label


def _reason(verdict, tool_name):
    reason = verdict.get("reason")
    if isinstance(reason, str) and reason.strip():
        return reason.strip()
    reasons = verdict.get("reasons")
    if isinstance(reasons, list):
        for entry in reasons:
            if isinstance(entry, str) and entry.strip():
                return entry.strip()
    label = _hazard_label(verdict.get("hazards"))
    if label:
        return (
            "Blocked by eval guardrails: the tool call `%s` was flagged as %s. "
            "Do not retry it or route around this guardrail." % (tool_name, label)
        )
    severity = verdict.get("severity")
    if isinstance(severity, (int, float)):
        return (
            "Blocked by eval guardrails: the tool call `%s` scored severity %.1f/3. "
            "Do not retry it or route around this guardrail." % (tool_name, float(severity))
        )
    return (
        "Blocked by eval guardrails: the tool call `%s` was flagged as unsafe. "
        "Do not retry it or route around this guardrail." % tool_name
    )


def _failure(detail):
    mode = _fail_mode()
    if mode == "closed":
        return {
            "action": "block",
            "message": (
                "Blocked by eval guardrails: the eval service could not decide this tool call "
                "(%s) and EVAL_FAIL_MODE=closed. Do not retry it or route around this guardrail." % detail
            ),
        }
    if mode == "review" and _review_mode() == "deny":
        return {
            "action": "block",
            "message": (
                "Flagged for review by eval guardrails: the eval service could not decide this "
                "tool call (%s) and EVAL_FAIL_MODE=review. Do not retry it or route around this guardrail." % detail
            ),
        }
    return None


def _failure_detail(error):
    if isinstance(error, urllib.error.HTTPError):
        try:
            raw = error.read().decode("utf-8", "replace").strip()
        except Exception:  # pragma: no cover - defensive
            raw = ""
        if raw:
            return "HTTP %s: %s" % (error.code, raw[:200])
        return "HTTP %s" % error.code
    if isinstance(error, urllib.error.URLError):
        return str(error.reason)
    return str(error) or error.__class__.__name__


def pre_tool_call(tool_name=None, args=None, **kwargs):
    """Hermes pre_tool_call callback. Returns a block directive or None."""
    tool = tool_name if isinstance(tool_name, str) and tool_name.strip() else None
    if tool is None:
        candidate = kwargs.get("tool_name")
        tool = candidate if isinstance(candidate, str) and candidate.strip() else "unknown"
    arguments = args if args is not None else kwargs.get("args")
    if not isinstance(arguments, dict):
        arguments = {"value": arguments} if arguments is not None else {}
    workspace = kwargs.get("workspace") or kwargs.get("cwd") or os.getcwd()

    action = {"tool": tool, "arguments": arguments, "workspace": workspace}
    session_id = kwargs.get("session_id")
    call_id = kwargs.get("tool_call_id")
    if isinstance(session_id, str) and session_id:
        action["sessionID"] = session_id
    if isinstance(call_id, str) and call_id:
        action["callID"] = call_id

    api_key, base_url = _resolve_config()
    if not api_key:
        return _failure(
            "no API key: set EVAL_API_KEY or run `eval-jev login --token eval_...` (%s)"
            % _config_path()
        )

    payload = {
        "side": "action",
        "state": {"tool": tool, "arguments": arguments, "workspace": workspace},
        "action": action,
    }
    try:
        response = _post_evaluate(api_key, base_url, payload)
    except Exception as error:  # noqa: BLE001 - hook must fail according to EVAL_FAIL_MODE
        return _failure(_failure_detail(error))

    verdict = response.get("verdict") if isinstance(response, dict) else None
    if not isinstance(verdict, dict):
        return _failure("the service returned no valid verdict")

    action_name = verdict.get("action")
    if action_name in ("block", "support"):
        return {"action": "block", "message": _reason(verdict, tool)}
    if action_name == "review":
        if _review_mode() == "allow":
            return None
        return {
            "action": "block",
            "message": "Flagged for review by eval guardrails: %s" % _reason(verdict, tool),
        }
    if action_name == "allow":
        return None
    return _failure("the service returned an unknown verdict action %r" % (action_name,))


def register(ctx):
    """Hermes plugin entry point; see docs/observability/ for the hook contract."""
    ctx.register_hook("pre_tool_call", pre_tool_call)
