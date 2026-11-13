"""Management CLI used by the installer and the `mailsomadhan` command."""
import argparse
import sys

from .db import Base, SessionLocal, engine
from .models import Admin, Host, Setting
from .security import check_password_rules, hash_password
from .system import DEFAULT_SETTINGS, write_hosts_file, write_selector_map


def cmd_init(args) -> None:
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        for key, value in DEFAULT_SETTINGS.items():
            if not db.get(Setting, key):
                db.add(Setting(key=key, value=value))
        if not db.query(Admin).first():
            if not args.admin_password:
                sys.exit("--admin-password is required on first init")
            db.add(Admin(username="admin", password_hash=hash_password(args.admin_password)))
            print("created admin user: admin")
        primary = db.query(Host).filter_by(is_primary=True).first()
        if primary:
            primary.hostname = args.hostname
        else:
            existing = db.query(Host).filter_by(hostname=args.hostname).first()
            if existing:
                existing.is_primary = True
            else:
                db.add(Host(hostname=args.hostname, is_primary=True))
        db.commit()
        write_hosts_file(db)
        write_selector_map(db)
    print("database initialised")


def cmd_reset_admin(args) -> None:
    problem = check_password_rules(args.password)
    if problem:
        sys.exit(problem)
    with SessionLocal() as db:
        admin = db.query(Admin).filter_by(username=args.username).first()
        if admin:
            admin.password_hash = hash_password(args.password)
        else:
            db.add(Admin(username=args.username, password_hash=hash_password(args.password)))
        db.commit()
    print(f"password updated for admin: {args.username}")


def cmd_sync(_args) -> None:
    with SessionLocal() as db:
        write_hosts_file(db)
        write_selector_map(db)
    print("state files written")


def main() -> None:
    parser = argparse.ArgumentParser(prog="mailsomadhan-cli")
    sub = parser.add_subparsers(required=True)
    p = sub.add_parser("init")
    p.add_argument("--hostname", required=True)
    p.add_argument("--admin-password", default="")
    p.set_defaults(func=cmd_init)
    p = sub.add_parser("reset-admin")
    p.add_argument("--username", default="admin")
    p.add_argument("--password", required=True)
    p.set_defaults(func=cmd_reset_admin)
    p = sub.add_parser("sync")
    p.set_defaults(func=cmd_sync)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
