"""Mailbox users' own profile: profile picture and forwarding to another address."""
import io
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import Principal, get_principal, require_user
from ..models import Mailbox
from ..security import EMAIL_RE

router = APIRouter()

AVATAR_PX = 256
AVATAR_MAX_BYTES = 5 * 1024 * 1024
MAX_FORWARDS = 5


def avatar_path(mailbox_id: int) -> Path:
    return Path(settings.state_dir) / "avatars" / f"{mailbox_id}.webp"


def avatar_url(m: Mailbox) -> str | None:
    return f"/api/avatar/{m.id}?v={m.avatar_version}" if m.avatar_version else None


def save_avatar(m: Mailbox, raw: bytes) -> None:
    """Decode, crop to a square and re-encode: whatever was uploaded, only clean pixels are stored
    (no metadata, no scripts in SVG, no oversized images)."""
    from PIL import Image, ImageOps, UnidentifiedImageError

    Image.MAX_IMAGE_PIXELS = 40_000_000  # refuse decompression bombs
    try:
        with Image.open(io.BytesIO(raw)) as img:
            if img.format not in ("JPEG", "PNG", "WEBP", "GIF"):
                raise HTTPException(400, "Use a JPEG, PNG, WebP or GIF image")
            img = ImageOps.exif_transpose(img)
            img = ImageOps.fit(img.convert("RGB"), (AVATAR_PX, AVATAR_PX), Image.Resampling.LANCZOS)
            out = io.BytesIO()
            img.save(out, "WEBP", quality=85)
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise HTTPException(400, "This file is not an image that can be read") from exc
    path = avatar_path(m.id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(out.getvalue())
    tmp.replace(path)
    m.avatar_version += 1


def remove_avatar(m: Mailbox) -> None:
    avatar_path(m.id).unlink(missing_ok=True)
    m.avatar_version = 0


async def read_upload(file: UploadFile) -> bytes:
    raw = await file.read(AVATAR_MAX_BYTES + 1)
    if len(raw) > AVATAR_MAX_BYTES:
        raise HTTPException(413, "The picture can be at most 5 MB")
    if not raw:
        raise HTTPException(400, "The file is empty")
    return raw


@router.put("/account/avatar")
async def upload_avatar(file: UploadFile = File(...), user: Mailbox = Depends(require_user), db: Session = Depends(get_db)):
    save_avatar(user, await read_upload(file))
    db.commit()
    return {"avatar_url": avatar_url(user)}


@router.delete("/account/avatar")
def delete_avatar(user: Mailbox = Depends(require_user), db: Session = Depends(get_db)):
    remove_avatar(user)
    db.commit()
    return {"avatar_url": None}


@router.get("/avatar/{mailbox_id}")
def get_avatar(mailbox_id: int, p: Principal = Depends(get_principal), db: Session = Depends(get_db)):
    """Profile pictures are visible to signed-in users and administrators of this server only."""
    m = db.get(Mailbox, mailbox_id)
    path = avatar_path(mailbox_id)
    if not m or not m.avatar_version or not path.is_file():
        raise HTTPException(404, "No profile picture")
    return Response(path.read_bytes(), media_type="image/webp",
                    headers={"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff"})


# ---------------------------------------------------------------- forwarding
def clean_forwards(raw: str, own: str) -> str:
    parts = [p.strip().lower() for p in raw.replace(";", ",").replace("\n", ",").split(",") if p.strip()]
    if len(parts) > MAX_FORWARDS:
        raise HTTPException(400, f"Forward to at most {MAX_FORWARDS} addresses")
    for part in parts:
        if not EMAIL_RE.match(part):
            raise HTTPException(400, f"Not a valid email address: {part}")
        if part == own.lower():
            raise HTTPException(400, "A mailbox cannot forward to itself")
    return ",".join(dict.fromkeys(parts))


def forwarding_out(m: Mailbox) -> dict:
    return {"forward_to": m.forward_to, "forward_keep": m.forward_keep}


class ForwardingIn(BaseModel):
    forward_to: str = Field(default="", max_length=2000)  # empty = forwarding off
    forward_keep: bool = True


@router.get("/account/forwarding")
def get_forwarding(user: Mailbox = Depends(require_user)):
    return forwarding_out(user)


@router.put("/account/forwarding")
def set_forwarding(body: ForwardingIn, user: Mailbox = Depends(require_user), db: Session = Depends(get_db)):
    user.forward_to = clean_forwards(body.forward_to, user.email)
    user.forward_keep = body.forward_keep
    db.commit()
    return forwarding_out(user)
