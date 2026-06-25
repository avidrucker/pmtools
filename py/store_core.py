"""Pure storage-core seams (no I/O) for the pmtools error + velocity stores.

Ported faithfully from the lccjs scripts that own these two tables:
  - errors:   scripts/errors-seed.js + scripts/error-log.js
  - velocity: scripts/velocity-seed.js + scripts/velocity-log.js + velocity-export.js

These are the I/O-free decision seams: the column orders, the validation
vocabularies, the row validators (which RAISE ValueError on a bad row), the
delta derivation, and the CSV encoders. The sqlite engine (store.py) and the
CLIs (error.py / velocity.py) call into this layer so the rules are testable
without a database and graded against the shared fixtures/{error,velocity}/*.

Parity: a future JS port (store_core.js) mirrors every function here and is
graded against the SAME fixtures. Validation-FAILURE fixtures use the convention
`{"name":..., "args":[row], "expected_error": true}` — both languages assert a
raised/thrown error rather than a return value.
"""

import json
import re

# ---------------------------------------------------------------------------
# vocabularies (copied verbatim from lccjs)
# ---------------------------------------------------------------------------

# error-log.js VALID_ERROR_TYPES (closed vocabulary — hard reject on unknown).
ERROR_TYPES = [
    "TOOL_DENIED", "HOOK_BLOCK", "CLAIM_FAIL", "BASH_FAIL", "GIT_FAIL",
    "GIT_STATE", "GH_FAIL", "GH_INFO", "DB_FAIL", "FILE_FAIL", "EDIT_PRECOND",
    "SKILL_FAIL", "NETWORK_FAIL", "VALIDATION_FAIL",
    "COMPLIANCE_FAIL", "BEHAVIORAL_FAIL",
    "OTHER",
]

# velocity-log.js VALID_ROLES (closed vocabulary — hard reject on unknown).
VALID_ROLES = [
    "DEV", "TEST", "WRITER", "RESEARCH", "SPIKE", "ARC", "PM", "COMBO",
    "DATA", "CHORE", "REVIEW",
]

# Canonical model format (e.g. opus-4.8). errors: hard reject; velocity: notice.
CANONICAL_MODEL = re.compile(r"^[a-z]+-\d+\.\d+$")

# Column order for each table — drives BOTH the INSERT and the CSV export header.
# Mirrors errors-seed.js / velocity-seed.js schema declaration order.
ERROR_COLS = [
    "id", "occurred_iso", "agent", "model", "ticket", "repo",
    "error_type", "message", "context", "notes",
]

VELOCITY_COLS = [
    "id", "ticket", "title", "role",
    "h_min", "c_min", "actual_min", "delta_h_min", "delta_c_min",
    "started_iso", "finished_iso", "closed_commit",
    "notes", "agent", "model", "repo",
]


# ---------------------------------------------------------------------------
# small value helpers (mirror the lccjs toStr/toNum semantics)
# ---------------------------------------------------------------------------

def _to_str(v):
    """Empty/None -> None, else str(v). Mirrors lccjs `toStr`."""
    if v is None or v == "":
        return None
    return str(v)


def _to_optional_number(name, v):
    """None/'' -> None; finite number -> that number; else raise. Mirrors
    velocity-log.js parseOptionalNumber."""
    if v is None or v == "":
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        raise ValueError('"{}" must be a finite number'.format(name))
    if n != n or n in (float("inf"), float("-inf")):
        raise ValueError('"{}" must be a finite number'.format(name))
    # Normalise integral floats to int so fixtures compare cleanly (20.0 -> 20).
    if n.is_integer():
        return int(n)
    return n


def _to_optional_nonneg_number(name, v):
    n = _to_optional_number(name, v)
    if n is None:
        return None
    if n < 0:
        raise ValueError('"{}" must be >= 0'.format(name))
    return n


# ---------------------------------------------------------------------------
# delta derivation (velocity-log.js deriveDelta)
# ---------------------------------------------------------------------------

def derive_delta(estimate, actual):
    """estimate - actual, or None when either operand is None."""
    if estimate is None or actual is None:
        return None
    return estimate - actual


# ---------------------------------------------------------------------------
# context normalisation (error-log.js normalizeContext)
# ---------------------------------------------------------------------------

def normalize_context(ctx):
    """None/'' -> None; dict/list -> compact JSON string; str -> must already
    be valid JSON (else raise). Guards json_extract() queries against malformed
    rows (lccjs #1386)."""
    if ctx is None or ctx == "":
        return None
    if isinstance(ctx, (dict, list)):
        return json.dumps(ctx, separators=(",", ":"))
    s = str(ctx)
    try:
        json.loads(s)
    except (ValueError, TypeError) as e:
        raise ValueError(
            '"context" must be valid JSON (pass an object, or a JSON string) — '
            "got {}: {}".format(json.dumps(s[:60]), e)
        )
    return s


# ---------------------------------------------------------------------------
# row validators — return a normalised row dict, or raise ValueError
# ---------------------------------------------------------------------------

def validate_error_row(row):
    """Validate + normalise an error row (error-log.js rules).

    Required: occurred_iso (non-empty str), message (non-empty). error_type, if
    given, must be in ERROR_TYPES. model, if given, must match CANONICAL_MODEL.
    ticket, if given, must be a positive int. context must be valid JSON.
    repo defaults to None here (the CLI fills the git-repo basename); a provided
    repo is preserved. Returns a dict keyed by the non-id ERROR_COLS.
    """
    if not isinstance(row, dict):
        raise ValueError("error row must be an object")

    occurred = row.get("occurred_iso")
    if not occurred or not isinstance(occurred, str):
        raise ValueError('Missing required field: "occurred_iso"')

    message = row.get("message")
    if message is None or str(message).strip() == "":
        raise ValueError(
            'Missing required field: "message" — a row with only a timestamp '
            "and error_type cannot be classified or acted on (analytically "
            "useless). Provide a short description of what failed."
        )

    error_type = row.get("error_type")
    if error_type is not None and error_type not in ERROR_TYPES:
        raise ValueError(
            'unknown error_type "{}" (valid: {})'.format(
                error_type, ", ".join(ERROR_TYPES))
        )

    model = row.get("model")
    if model is not None and model != "" and not CANONICAL_MODEL.match(str(model)):
        raise ValueError(
            '"model" must follow canonical format <family>-<major>.<minor> '
            '(e.g. sonnet-4.6) — got "{}"'.format(model)
        )

    ticket = row.get("ticket")
    if ticket is not None:
        if isinstance(ticket, bool) or not isinstance(ticket, int) or ticket <= 0:
            raise ValueError(
                '"ticket" must be a positive integer — got {}'.format(ticket)
            )

    return {
        "occurred_iso": occurred,
        "agent": _to_str(row.get("agent")),
        "model": _to_str(model),
        "ticket": ticket if ticket is not None else None,
        "repo": _to_str(row.get("repo")),
        "error_type": _to_str(error_type),
        "message": _to_str(message),
        "context": normalize_context(row.get("context")),
        "notes": _to_str(row.get("notes")),
    }


def validate_velocity_row(row):
    """Validate + normalise a velocity row (velocity-log.js rules).

    Required: role (in VALID_ROLES), agent. ticket nullable but, if given, a
    positive int. h_min/c_min/actual_min are optional non-negative numbers;
    delta_h_min/delta_c_min are DERIVED here (estimate - actual, None if either
    operand is None). model is a NOTICE-not-reject open vocabulary (a non-
    canonical model is recorded, never rejected). repo preserved (CLI defaults).
    Returns a dict keyed by the non-id VELOCITY_COLS.
    """
    if not isinstance(row, dict):
        raise ValueError("velocity row must be an object")

    role = row.get("role")
    if role is None or role == "":
        raise ValueError('Missing required field: "role"')
    agent = row.get("agent")
    if agent is None or agent == "":
        raise ValueError('Missing required field: "agent"')
    if role not in VALID_ROLES:
        raise ValueError(
            'unknown role "{}" (valid: {})'.format(role, ", ".join(VALID_ROLES))
        )

    ticket = row.get("ticket")
    if ticket is not None:
        if isinstance(ticket, bool) or not isinstance(ticket, int) or ticket <= 0:
            raise ValueError('"ticket" must be a positive integer when provided')

    h_min = _to_optional_nonneg_number("h_min", row.get("h_min"))
    c_min = _to_optional_nonneg_number("c_min", row.get("c_min"))
    actual_min = _to_optional_nonneg_number("actual_min", row.get("actual_min"))

    return {
        "ticket": ticket if ticket is not None else None,
        "title": _to_str(row.get("title")),
        "role": role,
        "h_min": h_min,
        "c_min": c_min,
        "actual_min": actual_min,
        "delta_h_min": derive_delta(h_min, actual_min),
        "delta_c_min": derive_delta(c_min, actual_min),
        "started_iso": _to_str(row.get("started_iso")),
        "finished_iso": _to_str(row.get("finished_iso")),
        "closed_commit": _to_str(row.get("closed_commit")),
        "notes": _to_str(row.get("notes")),
        "agent": agent,
        "model": _to_str(row.get("model")),
        "repo": _to_str(row.get("repo")),
    }


def model_notice(row):
    """A non-canonical/new model is recorded but NOTICED for velocity (lccjs
    #1184). Returns a one-line notice string, or None when no notice is due."""
    model = row.get("model") if isinstance(row, dict) else None
    if model is not None and model != "" and not CANONICAL_MODEL.match(str(model)):
        return (
            'model "{}" is new or non-canonical (canonical form is '
            "<family>-<major>.<minor>, e.g. opus-4.8) — recording it anyway".format(model)
        )
    return None


# ---------------------------------------------------------------------------
# CSV encoders (velocity-export.js encodeField/encodeRow + the preamble)
# ---------------------------------------------------------------------------

def csv_encode_field(val):
    """RFC-4180 field encoding: None -> ''; quote+double-escape when the value
    contains a comma, double-quote, CR, or LF."""
    if val is None:
        return ""
    # Match JS Number stringification: an integral REAL read back from sqlite
    # (e.g. 42.0) renders as "42", not Python's "42.0" — else the CSV bytes drift
    # from the JS twin (#38). A genuine fractional value keeps its decimals.
    if isinstance(val, float) and val.is_integer():
        val = int(val)
    s = str(val)
    if "," in s or '"' in s or "\n" in s or "\r" in s:
        return '"' + s.replace('"', '""') + '"'
    return s


def csv_encode_row(row, cols):
    """Encode one row dict into a CSV line, in `cols` order."""
    return ",".join(csv_encode_field(row.get(c)) for c in cols)


def csv_header(cols):
    """The header line: the columns joined by commas."""
    return ",".join(cols)


def csv_preamble(db_path):
    """First line of every exported CSV — the AUTO-GENERATED provenance banner."""
    return ("# AUTO-GENERATED by pmtools — do not edit directly. Source: {}"
            .format(db_path))
