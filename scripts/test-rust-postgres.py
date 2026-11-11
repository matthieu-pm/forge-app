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
            subprocess.run(["psql", "-X", "-v", "ON_ERROR_STOP=1", "--dbname", connection, "-c", "CREATE DATABASE forge_rust_journal"], check=True, capture_output=True)
            journal_connection = f"postgresql://forge_rust_test@127.0.0.1:{port}/forge_rust_journal"
            journal_setup = subprocess.run(["psql", "-X", "-v", "ON_ERROR_STOP=1", "--dbname", journal_connection], input="\n".join(statements) + "\nSELECT forge_install_recovery_triggers();\nUPDATE recovery_journal_state SET enabled=true WHERE id='singleton';\n", text=True, capture_output=True)
            if journal_setup.returncode:
                print(journal_setup.stderr, file=sys.stderr)
                return journal_setup.returncode
            # Global retention workers must not delete expired lifecycle fixtures
            # while the ordinary acceptance suite is inspecting them.
            subprocess.run(["psql", "-X", "-v", "ON_ERROR_STOP=1", "--dbname", connection, "-c", "CREATE DATABASE forge_rust_retention"], check=True, capture_output=True)
            retention_connection = f"postgresql://forge_rust_test@127.0.0.1:{port}/forge_rust_retention"
            retention_setup = subprocess.run(["psql", "-X", "-v", "ON_ERROR_STOP=1", "--dbname", retention_connection], input="\n".join(statements), text=True, capture_output=True)
            if retention_setup.returncode:
                print(retention_setup.stderr, file=sys.stderr)
                return retention_setup.returncode
            # The agent-file sweeper runs through its real CLI and owns a separate
            # database so global expiry cannot consume another test's bytes.
            subprocess.run(["psql", "-X", "-v", "ON_ERROR_STOP=1", "--dbname", connection, "-c", "CREATE DATABASE forge_rust_agent_retention"], check=True, capture_output=True)
            agent_retention_connection = f"postgresql://forge_rust_test@127.0.0.1:{port}/forge_rust_agent_retention"
            agent_retention_setup = subprocess.run(["psql", "-X", "-v", "ON_ERROR_STOP=1", "--dbname", agent_retention_connection], input="\n".join(statements), text=True, capture_output=True)
            if agent_retention_setup.returncode:
                print(agent_retention_setup.stderr, file=sys.stderr)
                return agent_retention_setup.returncode
            subprocess.run(["psql", "-X", "-v", "ON_ERROR_STOP=1", "--dbname", connection, "-c", "CREATE DATABASE forge_rust_product_retention"], check=True, capture_output=True)
            product_retention_connection = f"postgresql://forge_rust_test@127.0.0.1:{port}/forge_rust_product_retention"
            product_retention_setup = subprocess.run(["psql", "-X", "-v", "ON_ERROR_STOP=1", "--dbname", product_retention_connection], input="\n".join(statements), text=True, capture_output=True)
            if product_retention_setup.returncode:
                print(product_retention_setup.stderr, file=sys.stderr)
                return product_retention_setup.returncode
            # The native runtime owns a private schema and explicit installer.
            # Keep its journal tests independent of the reference app's schema.
            subprocess.run(["psql", "-X", "-v", "ON_ERROR_STOP=1", "--dbname", connection, "-c", "CREATE DATABASE forge_rust_runtime"], check=True, capture_output=True)
            runtime_connection = f"postgresql://forge_rust_test@127.0.0.1:{port}/forge_rust_runtime"
            print(f'Applied all {len(statements)} reference migrations to disposable local PostgreSQL.', flush=True)
            environment = os.environ.copy()
            environment["FORGE_FEATURE_INITIATIVES"] = "true"
            environment["FORGE_FEATURE_SAVED_VIEWS"] = "true"
            environment["FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED"] = "true"
            environment["FORGE_PERSON_NAME_FORMATTING_ENABLED"] = "true"
            environment["FORGE_SHARED_DOCUMENTS_ENABLED"] = "true"
            environment["FORGE_TEAM_RESOURCES_ENABLED"] = "true"
            environment["FORGE_RUST_RUNTIME_TEST_DATABASE_URL"] = runtime_connection
            environment["FORGE_RUST_TEST_DATABASE_URL"] = connection
            environment["FORGE_RUST_JOURNAL_TEST_DATABASE_URL"] = journal_connection
            environment["FORGE_RUST_RETENTION_TEST_DATABASE_URL"] = retention_connection
            environment["FORGE_RUST_AGENT_RETENTION_TEST_DATABASE_URL"] = agent_retention_connection
            environment["FORGE_RUST_PRODUCT_RETENTION_TEST_DATABASE_URL"] = product_retention_connection
            return subprocess.run(["cargo", "test", "--workspace", "--locked", "--no-fail-fast"], cwd=ROOT, env=environment).returncode
        finally:
            if started:
                subprocess.run(["pg_ctl", "-D", str(data), "-m", "fast", "-w", "stop"], check=True)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as error:
        print(f"Local PostgreSQL test setup failed: {error}", file=sys.stderr)
        sys.exit(1)
