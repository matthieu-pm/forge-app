#!/usr/bin/env python3
"""Run the entire Rust test suite on a disposable, loopback-only PostgreSQL.

Never reads DATABASE_URL or any application credentials. The reference SQL is
applied in journal order to a fresh local cluster; nothing is provisioned remotely.
"""

import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def main():
    for executable in ("initdb", "pg_ctl", "psql", "cargo"):
        if not shutil.which(executable):
            print(f"Required local test tool is unavailable: {executable}", file=sys.stderr)
            return 1
    with tempfile.TemporaryDirectory(prefix="forge-rust-pg-") as directory:
        temporary = Path(directory)
        data = temporary / "data"
        log = temporary / "postgres.log"
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        connection = f"postgresql://forge_rust_test@127.0.0.1:{port}/postgres"
        with log.open("a") as output:
            subprocess.run(["initdb", "-D", str(data), "-A", "trust", "-U", "forge_rust_test", "--no-locale", "--encoding=UTF8"], check=True, stdout=output, stderr=output)
        started = False
        try:
            subprocess.run(["pg_ctl", "-D", str(data), "-l", str(log), "-o", f"-h 127.0.0.1 -p {port} -k {temporary}", "-w", "start"], check=True)
            started = True
            journal = json.loads((ROOT / "apps/forge/drizzle/meta/_journal.json").read_text())
            statements = []
            for entry in journal["entries"]:
                path = ROOT / "apps/forge/drizzle" / f'{entry["tag"]}.sql'
                statements.append("BEGIN;\n" + path.read_text() + "\nCOMMIT;\n")
            result = subprocess.run(["psql", "-X", "-v", "ON_ERROR_STOP=1", "--dbname", connection], input="\n".join(statements), text=True, capture_output=True)
            if result.returncode:
                print(result.stderr, file=sys.stderr)
                return result.returncode
            print(f'Applied all {len(statements)} reference migrations to disposable local PostgreSQL.', flush=True)
            environment = os.environ.copy()
            environment["FORGE_RUST_TEST_DATABASE_URL"] = connection
            return subprocess.run(["cargo", "test", "--workspace", "--locked"], cwd=ROOT, env=environment).returncode
        finally:
            if started:
                subprocess.run(["pg_ctl", "-D", str(data), "-m", "fast", "-w", "stop"], check=True)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as error:
        print(f"Local PostgreSQL test setup failed: {error}", file=sys.stderr)
        sys.exit(1)
