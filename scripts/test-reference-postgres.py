#!/usr/bin/env python3
"""Run all reference suites, including their explicitly local PostgreSQL cases.

Each fixed target belongs to a fresh cluster owned by this process. Never reuse
an existing listener, load dotenv files or inherit external test credentials.
The original test assertions and their target guards are unchanged.
"""

from contextlib import ExitStack, contextmanager
import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = (
    ("FORGE_JOB_TEST_DATABASE_URL", 56464, "for64_jobs_test", "for64", True),
    ("FORGE_SLA_TEST_DATABASE_URL", 56525, "for125_sla_test", "forge_reference_test", True),
    # This suite applies the journal itself and records its own checkpoints.
    ("FORGE_PREF_IMPORT_TEST_DATABASE_URL", 55444, "for144_acceptance", "forge_reference_test", False),
)


def run(command, environment, **kwargs):
    return subprocess.run(command, env=environment, check=True, **kwargs)


@contextmanager
def fixture(temporary, environment, port, name, user, migrate):
    directory = temporary / name
    directory.mkdir()
    data = directory / "data"
    log = directory / "postgres.log"
    # Refuse occupied targets before starting anything. A race also causes
    # pg_ctl to fail; we never fall back to connecting to somebody else's DB.
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", port))
    with log.open("a") as output:
        run(["initdb", "-D", str(data), "-A", "trust", "-U", user,
             "--no-locale", "--encoding=UTF8"], environment, stdout=output, stderr=output)
    connection = f"postgresql://{user}@127.0.0.1:{port}/{name}"
    try:
        run(["pg_ctl", "-D", str(data), "-l", str(log), "-o",
             f"-h 127.0.0.1 -p {port} -k {shlex.quote(str(temporary))} -c shared_buffers=32MB",
             "-w", "start"], environment)
        run(["psql", "-X", "-v", "ON_ERROR_STOP=1", "--dbname",
             connection.rsplit("/", 1)[0] + "/postgres", "-c", f'CREATE DATABASE "{name}"'],
            environment, capture_output=True, text=True)
        if migrate:
            journal = json.loads((ROOT / "apps/forge/drizzle/meta/_journal.json").read_text())
            statements = []
            for entry in journal["entries"]:
                path = ROOT / "apps/forge/drizzle" / f'{entry["tag"]}.sql'
                statements.append("BEGIN;\n" + path.read_text() + "\nCOMMIT;\n")
            run(["psql", "-X", "-v", "ON_ERROR_STOP=1", "--dbname", connection],
                environment, input="\n".join(statements), capture_output=True, text=True)
            print(f"Applied all {len(statements)} reference migrations to {name}.", flush=True)
        yield connection
    finally:
        # Even a failed startup can leave our postmaster running. Only this
        # unique temporary data directory is ever stopped or removed.
        if (data / "postmaster.pid").exists():
            run(["pg_ctl", "-D", str(data), "-m", "fast", "-w", "stop"], environment)


def main():
    for executable in ("initdb", "pg_ctl", "psql", "bun", "node"):
        if not shutil.which(executable):
            print(f"Required local test tool is unavailable: {executable}", file=sys.stderr)
            return 1
    real_bun = shutil.which("bun")
    # The reference suite deliberately supports external fixture opt-ins. Do
    # not accidentally enable those through a developer's shell environment.
    environment = {key: value for key, value in os.environ.items()
                   if key in {"PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "TZ", "CI"}
                   or key.startswith("LC_")}
    with tempfile.TemporaryDirectory(prefix="forge-reference-pg-") as temporary_name:
        temporary = Path(temporary_name)
        binaries = temporary / "bin"
        binaries.mkdir()
        # Nested worker-crash tests spawn `bun` themselves. Preserve their
        # exact entry points while disabling Bun's automatic dotenv loading.
        shim = binaries / "bun"
        shim.write_text(f'#!/bin/sh\nexec {shlex.quote(real_bun)} --no-env-file "$@"\n')
        shim.chmod(0o700)
        environment["PATH"] = f'{binaries}{os.pathsep}{environment["PATH"]}'
        with ExitStack() as stack:
            for variable, port, name, user, migrate in FIXTURES:
                environment[variable] = stack.enter_context(
                    fixture(temporary, environment, port, name, user, migrate))
            print("Running every reference suite with jobs, SLA and preference-import local fixtures enabled.", flush=True)
            return subprocess.run([str(shim), "run", "test", "--force"],
                                  cwd=ROOT, env=environment).returncode


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as error:
        print(f"Disposable reference PostgreSQL setup failed: {error}", file=sys.stderr)
        if error.stderr:
            print(error.stderr, file=sys.stderr)
        sys.exit(1)
    except OSError as error:
        print(f"Disposable reference PostgreSQL target unavailable: {error}", file=sys.stderr)
        sys.exit(1)
