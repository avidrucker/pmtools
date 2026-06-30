#!/usr/bin/env python3
"""ice.py — score GitHub issues by ICE (Impact x Confidence x Ease).

  ice score '<batch json>'        {"<issue>":{"I":_,"C":_,"E":_, ...}} upsert (human, provisional=0)
  ice score --auto [--dry-run]    provisionally score unscored open issues from labels
  ice list [--label S] [--json]   ranked view (table or JSON)
  ice export [--csv P]            ranked CSV mirror (ICE_CSV_COLS incl. derived ice_rank)

ICE is OPT-IN: disabled by default; a command prints a notice + exits 0 unless
.claude/orchestrate.json enables storage.ice. Exit codes: 0 success/disabled;
2 usage; 1 operational (bad JSON / validation / DB). Twin of js/ice.js.

The pure scoring/ranking/auto-heuristic live in ice_core (#99); persistence in
store (#101). This wrapper only parses argv, enriches via the gh provider, and
calls those. The provider seam is injectable (last main()/_cmd_score arg) so the
gh calls are faked in unit tests.
"""
import datetime
import json
import os
import sys

import config
import store
import store_core as core
import ice_core
from provider import get_provider
from sh import make_die

AUTO_LIMIT = 500


def _now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _label_dicts(names):
    """Adapt the provider's name-string labels to the [{'name':..}] shape
    ice_core.derive_auto_score / detect_ice_tier expect (raw-gh / lccjs format)."""
    return [{"name": n} for n in (names or [])]


def _parse(argv):
    """Own arg parser (the generic store_core.parse_store_args only knows
    log|export and rejects --auto). Unknown --flag -> ValueError (usage, exit 2)."""
    a = {"cmd": None, "json": None, "auto": False, "dry_run": False,
         "label": None, "as_json": False, "db_path": None, "csv": None, "no_csv": False}
    pos = []
    i = 0
    while i < len(argv):
        t = argv[i]
        if t == "--auto":
            a["auto"] = True
        elif t == "--dry-run":
            a["dry_run"] = True
        elif t == "--json":
            a["as_json"] = True
        elif t == "--no-csv":
            a["no_csv"] = True
        elif t == "--label":
            i += 1
            a["label"] = argv[i] if i < len(argv) else None
        elif t == "--db-path":
            i += 1
            a["db_path"] = argv[i] if i < len(argv) else None
        elif t == "--csv":
            i += 1
            a["csv"] = argv[i] if i < len(argv) else None
        elif t.startswith("--"):
            raise ValueError("unknown flag: " + t)
        else:
            pos.append(t)
        i += 1
    a["cmd"] = pos[0] if pos else None
    a["json"] = pos[1] if len(pos) > 1 else None
    return a


def _ranked_csv(db_path, csv_path):
    """Custom rank-aware export: select_all -> rank_rows -> ICE_CSV_COLS rows
    (with the derived ice_rank). NOT store.export_csv (which dumps raw table
    cols, no rank). Atomic temp->rename, byte-shape identical to store.export_csv."""
    ranked = ice_core.rank_rows(store.select_all(db_path, "ice"))
    resolved = store._resolve(db_path)
    lines = [core.csv_preamble(resolved), core.csv_header(ice_core.ICE_CSV_COLS)]
    lines.extend(core.csv_encode_row(r, ice_core.ICE_CSV_COLS) for r in ranked)
    out = os.path.abspath(os.path.expanduser(csv_path))
    parent = os.path.dirname(out)
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp = out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(tmp, out)
    return len(ranked)


def _build_auto_rows(prov, db_path):
    issues = prov.list_open_issues_with_labels(AUTO_LIMIT)
    scored = {r["issue"] for r in store.select_all(db_path, "ice")}
    rows = []
    for it in issues:
        if it["number"] in scored:
            continue
        sc = ice_core.derive_auto_score(_label_dicts(it.get("labels")))
        rows.append({
            "issue": it["number"], "title": it.get("title"),
            "I": sc["I"], "C": sc["C"], "E": sc["E"],
            "tier": ice_core.detect_ice_tier(_label_dicts(it.get("labels"))),
            "labels": ";".join(it.get("labels") or []) or None,
            "notes": "auto-swept from labels (provisional — review I/C/E)",
            "provisional": 1,
        })
    return rows


def _build_batch_rows(prov, batch, die):
    rows = []
    for num_str, fields in batch.items():
        try:
            num = int(num_str)
        except (ValueError, TypeError):
            die("issue keys must be integers — got {}".format(json.dumps(num_str)))
        labels = []
        try:
            labels = (prov.issue_states([num]).get(num) or {}).get("labels") or []
        except Exception:
            labels = []
        try:
            title = prov.issue_title(num)
        except Exception:
            title = None
        raw = dict(fields)
        raw["issue"] = num
        if title:
            raw.setdefault("title", title)
        raw.setdefault("tier", ice_core.detect_ice_tier(_label_dicts(labels)))
        raw.setdefault("labels", ";".join(labels) or None)
        rows.append(raw)
    return rows


def _cmd_score(a, db_path, store_cfg, die, provider=None):
    if not store_cfg["enabled"]:
        print("ice store disabled for this project")
        return 0
    prov = provider or get_provider("github")

    if a["auto"]:
        raws = _build_auto_rows(prov, db_path)
        summary = "Auto sweep: {} unscored open issue(s).".format(len(raws))
    else:
        if not a["json"]:
            die("usage: ice score '{\"<issue>\":{\"I\":1,\"C\":0.8,\"E\":5}}' "
                "[--auto] [--dry-run]", 2)
        try:
            batch = json.loads(a["json"])
        except (ValueError, TypeError) as e:
            die("invalid JSON: {}".format(e))
        if not isinstance(batch, dict):
            die("payload must be a JSON object of {issue: {I,C,E}}")
        raws = _build_batch_rows(prov, batch, die)
        summary = "Scored {} issue(s).".format(len(raws))

    validated = []
    for raw in raws:
        try:
            row = ice_core.validate_ice_row(raw)
        except ValueError as e:
            die(str(e))
        row["updated_iso"] = _now_iso()
        validated.append(row)

    if a["dry_run"]:
        for row in validated:
            print("[dry-run] #{} I={} C={} E={} -> ICE={}".format(
                row["issue"], row["I"], row["C"], row["E"], row["ice_score"]))
        print("[dry-run] " + summary + " (no writes)")
        return 0

    for row in validated:
        try:
            store.upsert(db_path, "ice", row)
        except Exception as e:
            die("DB upsert failed: {}".format(e))
    print(summary)

    csv_path = None if a["no_csv"] else (a["csv"] or store_cfg["csvMirror"])
    if csv_path:
        n = _ranked_csv(db_path, csv_path)
        print("Exported {} rows -> {}".format(n, csv_path))
    return 0


def _cmd_list(a, db_path, store_cfg, die):
    if not store_cfg["enabled"]:
        print("ice store disabled for this project")
        return 0
    rows = store.select_all(db_path, "ice")
    if a["label"]:
        rows = [r for r in rows if a["label"] in (r.get("labels") or "")]
    ranked = ice_core.rank_rows(rows)
    if a["as_json"]:
        print(json.dumps(ranked))
        return 0
    if not ranked:
        print("(no ICE-scored issues)")
        return 0
    for r in ranked:
        ice = r["ice_score"] if r["ice_score"] is not None else "?"
        print("{:>4}. #{:<6} ICE={:<6} I={} C={} E={}  {}".format(
            r["ice_rank"], r["issue"], ice, r["I"], r["C"], r["E"],
            (r.get("title") or "")[:50]))
    return 0


def _cmd_export(a, db_path, store_cfg, die):
    if not store_cfg["enabled"]:
        print("ice store disabled for this project")
        return 0
    csv_path = a["csv"] or store_cfg["csvMirror"]
    if not csv_path:
        die("no CSV target: pass --csv P or set storage.ice.csvMirror")
    n = _ranked_csv(db_path, csv_path)
    print("Exported {} rows -> {}".format(n, csv_path))
    return 0


def main(argv, provider=None):
    die = make_die("ice")
    try:
        a = _parse(argv)
    except ValueError as e:
        die(str(e), 2)
    cfg = config.load_storage_config()
    store_cfg = cfg["ice"]
    db_path = a["db_path"] or cfg["dbPath"]
    cmd = a["cmd"]
    if cmd == "score":
        return _cmd_score(a, db_path, store_cfg, die, provider)
    if cmd == "list":
        return _cmd_list(a, db_path, store_cfg, die)
    if cmd == "export":
        return _cmd_export(a, db_path, store_cfg, die)
    die("usage: ice <score|list|export> [...]  (got {})".format(
        json.dumps(cmd, ensure_ascii=False)), 2)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
