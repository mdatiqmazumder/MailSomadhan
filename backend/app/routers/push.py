"""Push notification settings (super admin) and browser registration (mailbox users)."""
import json
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import push
from ..db import get_db
from ..deps import require_admin, require_user
from ..models import Mailbox, PushToken, Setting

admin_router = APIRouter(dependencies=[Depends(require_admin)])
user_router = APIRouter()

WEB_KEYS = ("apiKey", "authDomain", "projectId", "storageBucket", "messagingSenderId", "appId", "measurementId")
SAFE_VALUE = re.compile(r"^[A-Za-z0-9:._\-/]{1,200}$")
VAPID_RE = re.compile(r"^[A-Za-z0-9_-]{80,100}$")


def parse_web_config(text: str) -> dict:
    """Accepts the snippet Firebase shows under Project settings → Your apps: JSON, or the JavaScript
    `const firebaseConfig = { apiKey: "…", … };` block as pasted."""
    text = text.strip()
    try:
        data = json.loads(text)
    except ValueError:
        data = {k: v for k, v in re.findall(r'["\']?(\w+)["\']?\s*:\s*["\']([^"\']*)["\']', text)}
    if not isinstance(data, dict):
        raise HTTPException(400, "The Firebase config is not valid")
    web = {k: str(data[k]).strip() for k in WEB_KEYS if data.get(k)}
    for k in ("apiKey", "projectId", "messagingSenderId", "appId"):
        if not web.get(k):
            raise HTTPException(400, f"The Firebase config is missing {k}")
    for k, v in web.items():
        if not SAFE_VALUE.match(v):
            raise HTTPException(400, f"The Firebase config value of {k} is not valid")
    return web


def parse_service_account(text: str) -> dict:
    try:
        sa = json.loads(text)
    except ValueError as exc:
        raise HTTPException(400, "The service account key must be the JSON file downloaded from Firebase") from exc
    if not isinstance(sa, dict) or sa.get("type") != "service_account" or not sa.get("private_key") or not sa.get("client_email"):
        raise HTTPException(400, "This is not a Google service account key file")
    keep = ("type", "project_id", "private_key_id", "private_key", "client_email", "client_id", "token_uri")
    return {k: sa[k] for k in keep if k in sa}


def status(db: Session) -> dict:
    creds = push.load_credentials(db)
    encrypted_but_unreadable = bool((row := db.get(Setting, push.SETTING)) and row.value) and creds is None
    out = {"configured": bool(creds), "unreadable": encrypted_but_unreadable, "show_preview": push.show_preview(db),
           "devices": db.query(PushToken).count(), "mailboxes": db.query(PushToken.mailbox_id).distinct().count()}
    if creds:
        web, sa = creds["web"], creds["service_account"]
        out.update({"project_id": web["projectId"], "sender_id": web["messagingSenderId"], "app_id": web["appId"],
                    "service_account": sa["client_email"], "vapid_key": creds["vapid_key"][:12] + "…",
                    "updated_at": creds.get("updated_at")})
    return out


@admin_router.get("/push")
def get_push(db: Session = Depends(get_db)):
    return status(db)


class PushIn(BaseModel):
    web_config: str = Field(max_length=5000)
    vapid_key: str = Field(max_length=200)
    service_account: str = Field(max_length=20000)


@admin_router.put("/push")
def save_push(body: PushIn, db: Session = Depends(get_db)):
    web = parse_web_config(body.web_config)
    vapid = body.vapid_key.strip()
    if not VAPID_RE.match(vapid):
        raise HTTPException(400, "The Web Push certificate key pair (VAPID public key) is not valid")
    sa = parse_service_account(body.service_account)
    if sa.get("project_id") and sa["project_id"] != web["projectId"]:
        raise HTTPException(400, f"The service account belongs to project {sa['project_id']}, the config to {web['projectId']}")
    sa["project_id"] = web["projectId"]
    try:
        push._token_cache.clear()
        push.access_token(sa)  # proves the key works before it is stored
    except push.PushError as exc:
        raise HTTPException(400, str(exc)) from exc
    push.save_credentials(db, {"web": web, "vapid_key": vapid, "service_account": sa,
                               "updated_at": datetime.now(timezone.utc).isoformat()})
    return status(db)


class PreviewIn(BaseModel):
    show_preview: bool


@admin_router.put("/push/preview")
def set_preview(body: PreviewIn, db: Session = Depends(get_db)):
    row = db.get(Setting, push.PREVIEW_SETTING)
    value = "1" if body.show_preview else "0"
    if row:
        row.value = value
    else:
        db.add(Setting(key=push.PREVIEW_SETTING, value=value))
    db.commit()
    return status(db)


@admin_router.delete("/push")
def delete_push(db: Session = Depends(get_db)):
    push.save_credentials(db, None)
    db.query(PushToken).delete()
    db.commit()
    return status(db)


# ---------------------------------------------------------------- mailbox users
@user_router.get("/push/config")
def push_config(user: Mailbox = Depends(require_user), db: Session = Depends(get_db)):
    """The public part of the Firebase setup the browser needs to register (never the service account)."""
    creds = push.load_credentials(db)
    if not creds:
        return {"enabled": False}
    return {"enabled": True, "web": creds["web"], "vapid_key": creds["vapid_key"],
            "devices": db.query(PushToken).filter_by(mailbox_id=user.id).count()}


class TokenIn(BaseModel):
    token: str = Field(min_length=20, max_length=500, pattern=r"^[A-Za-z0-9:_\-]+$")


@user_router.post("/push/subscribe")
def subscribe(body: TokenIn, request: Request, user: Mailbox = Depends(require_user), db: Session = Depends(get_db)):
    if not push.load_credentials(db):
        raise HTTPException(400, "Notifications are not set up on this server")
    row = db.query(PushToken).filter_by(token=body.token).first()
    if not row:
        row = PushToken(token=body.token)
        db.add(row)
    # A browser belongs to whoever signed in last on it.
    row.mailbox_id, row.token_version = user.id, user.token_version
    row.user_agent = request.headers.get("user-agent", "")[:300]
    row.last_seen = datetime.now(timezone.utc)
    db.commit()
    return {"ok": True}


@user_router.post("/push/unsubscribe")
def unsubscribe(body: TokenIn, user: Mailbox = Depends(require_user), db: Session = Depends(get_db)):
    db.query(PushToken).filter_by(token=body.token, mailbox_id=user.id).delete()
    db.commit()
    return {"ok": True}


@user_router.post("/push/test")
def test(user: Mailbox = Depends(require_user), db: Session = Depends(get_db)):
    sent = push.notify_mailbox(db, user.email, {"title": "Notifications are on", "kind": "test",
                                                "body": f"New mail for {user.email} will show up like this.",
                                                "url": "/mail", "tag": "test"})
    if not sent:
        raise HTTPException(400, "No notification could be sent to this browser")
    return {"sent": sent}
