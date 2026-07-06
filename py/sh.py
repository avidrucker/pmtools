"""sh.py — shared impure I/O helpers for the pmtools command CLIs (#41).

One copy of sh / sh_capture / sh_trim + die/log factories, so the claim / close /
release / ... wrappers stop drifting. The drift this consolidates:
  - close's sh_capture returned {"ok","out"} while release's returned a trimmed
    STRING under the same name — now {"ok","out"} owns ``sh_capture`` and the
    string variant is ``sh_trim``;
  - claim's sh discarded stderr (DEVNULL) where close/release captured it
    (PIPE) — now all share one stderr-captured sh.
Twin of js/sh.js. These run shell STRINGS (the lccjs lineage builds command
strings); the arg-array git/gh exec added in #37 stays in each wrapper.
"""
import os
import signal
import subprocess
import sys


def sh(cmd, allow_fail=False):
    """Run a shell command, returning stdout text. allow_fail -> None on a
    non-zero exit (else it raises). stderr is captured (PIPE), so it never leaks
    to the terminal and is available on the raised error."""
    try:
        out = subprocess.run(
            cmd, shell=True, check=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        return out.stdout
    except subprocess.CalledProcessError:
        if allow_fail:
            return None
        raise


def sh_capture(cmd, cwd=None, timeout_sec=0):
    """Like sh() but returns {"ok", "out"} with stdout+stderr merged, never raises.
    Optional `cwd` runs the command in that directory (the #106 pre-close verify
    gate runs project commands in the worktree or repo root).

    Optional `timeout_sec` (#107): when > 0, a command exceeding it is killed and
    the result is {"ok": False, "timedOut": True, "out": ...}. The kill targets the
    whole process GROUP — the command runs in a new session (`start_new_session`),
    so `os.killpg(SIGKILL)` reaps the shell AND any children it spawned, leaving no
    orphan. `timeout_sec` <= 0 keeps the original no-limit path (byte-identical)."""
    if timeout_sec and timeout_sec > 0:
        proc = subprocess.Popen(
            cmd, shell=True, cwd=cwd,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            start_new_session=True,
        )
        try:
            out, err = proc.communicate(timeout=timeout_sec)
            return {"ok": proc.returncode == 0, "out": (out or "") + (err or "")}
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                proc.kill()
            out, err = proc.communicate()
            partial = (out or "") + (err or "")
            return {"ok": False, "timedOut": True,
                    "out": partial + "[verify] timed out after {}s (killed)\n".format(timeout_sec)}
    res = subprocess.run(
        cmd, shell=True, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    return {"ok": res.returncode == 0, "out": (res.stdout or "") + (res.stderr or "")}


def sh_trim(cmd):
    """Like sh() but returns trimmed stdout, "" on any error (never raises). The
    string-returning variant release.py used to call ``sh_capture`` — renamed so
    the {"ok","out"} contract above unambiguously owns the ``sh_capture`` name (#41)."""
    res = subprocess.run(
        cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return (res.stdout or "").strip()


def git_capture(args):
    """arg-array git exec (#37): values are argv, never re-parsed by a shell.
    Returns {"ok", "out"} with stdout+stderr merged, never raises — the arg-array
    twin of sh_capture, consolidated here (#45)."""
    res = subprocess.run(
        ["git", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return {"ok": res.returncode == 0, "out": (res.stdout or "") + (res.stderr or "")}


def git_trim(args):
    """Like git_capture but returns trimmed stdout on success, "" otherwise — the
    arg-array twin of sh_trim (#45)."""
    res = subprocess.run(
        ["git", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return (res.stdout or "").strip() if res.returncode == 0 else ""


def make_die(tag):
    """die factory parameterized by the command tag — `die = make_die('close')`
    yields the per-command `[close] ✗ <msg>` dialect uniformly."""
    def die(msg, code=1):
        sys.stderr.write("[{}] ✗ {}\n".format(tag, msg))
        sys.exit(code)
    return die


def make_log(tag):
    def log(msg):
        print("[{}] {}".format(tag, msg))
    return log
