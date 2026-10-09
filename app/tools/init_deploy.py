"""Write a local deployment environment without printing the database password."""
import argparse
import os
from pathlib import Path
import re
import secrets


def create_env(domain: str, destination: Path):
    if not re.fullmatch(r"(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}", domain):
        raise ValueError("Use a DNS hostname, without https://, a path or a port.")
    # POSIX permissions apply at creation, before the secret is written.
    # Windows inherits the directory ACL; use a private user directory there.
    descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as file:
        file.write(f"APP_DOMAIN={domain.lower()}\nPOSTGRES_PASSWORD={secrets.token_hex(32)}\n")
    destination.chmod(0o600)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--domain", required=True)
    parser.add_argument("--output", type=Path, default=Path(".env.production"))
    args = parser.parse_args()
    create_env(args.domain, args.output)
    print(f"Created {args.output}; keep it private. No services have been deployed.")
