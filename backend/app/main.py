import json
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .db import Base, SessionLocal, create_tables, engine
from .models import AuditLog
from .security import COOKIE_NAME, read_token
from .migrate import migrate
from .routers import admin, admins, profile, analytics, auth, backup, campaigns, cloudflare, filters, mail, push, system, tls


@asynccontextmanager
async def lifespan(app: FastAPI):
    create_tables()
    migrate()
    yield


app = FastAPI(title="MailSomadhan API", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


# ---------------------------------------------------------------- audit log
SECRET_KEYS = {"password", "current_password", "new_password", "passphrase", "token", "client_secret", "client_id",
               "service_account", "web_config", "otp", "code", "state", "secret", "signature_html"}
LARGE_KEYS = {"html", "recipients", "value", "emails"}


def redact(data):
    if isinstance(data, dict):
        out = {}
        for k, v in data.items():
            if k in SECRET_KEYS:
                out[k] = "***" if v else ""
            elif k in LARGE_KEYS and isinstance(v, (str, list)) and len(v) > 200:
                out[k] = f"<{len(v)} {'items' if isinstance(v, list) else 'chars'}>"
            else:
                out[k] = redact(v)
        return out
    if isinstance(data, list):
        return [redact(v) for v in data[:50]]
    return data


def audited(request: Request) -> bool:
    path = request.url.path
    if path == "/api/auth/login":
        return True
    return request.method not in ("GET", "HEAD", "OPTIONS") and path.startswith(("/api/admin/", "/api/account/"))


@app.middleware("http")
async def audit(request: Request, call_next):
    if not audited(request):
        return await call_next(request)
    body = b""
    if "json" in request.headers.get("content-type", ""):
        body = await request.body()
    response = await call_next(request)
    try:
        details, actor, kind = "", "", "admin"
        if body and len(body) < 256_000:
            parsed = json.loads(body)
            if request.url.path == "/api/auth/login" and isinstance(parsed, dict):
                actor = str(parsed.get("identifier", ""))[:320].lower()
                kind = "user" if "@" in actor else "admin"
            details = json.dumps(redact(parsed), ensure_ascii=False)[:4000]
        if not actor:
            token = read_token(request.cookies.get(COOKIE_NAME, ""))
            if token:
                with SessionLocal() as db:
                    from .models import Admin, Mailbox
                    obj = db.get(Admin if token[0] == "admin" else Mailbox, token[1])
                    actor = (obj.username if token[0] == "admin" else obj.email) if obj else f"{token[0]}:{token[1]}"
                    kind = token[0]
        if kind == "user" and request.url.path != "/api/auth/login":
            return response  # webmail users' own account changes are not part of the admin audit trail
        with SessionLocal() as db:
            db.add(AuditLog(actor=actor, actor_kind=kind, ip=request.headers.get("x-real-ip") or (request.client.host if request.client else ""),
                            method=request.method, path=request.url.path[:300], status=response.status_code, details=details))
            db.commit()
    except Exception as exc:  # noqa: BLE001 - auditing must never break the request
        print(f"audit log error: {exc}", flush=True)
    return response


@app.middleware("http")
async def csrf_guard(request: Request, call_next):
    # Session lives in a SameSite=Strict cookie; additionally require a custom header on
    # state-changing requests so plain cross-site form posts can never reach the API.
    # RFC 8058 one-click unsubscribe is POSTed by mail providers without that header; it only
    # accepts a signed token and needs no session, so it is exempt.
    one_click = request.url.path.startswith("/api/public/unsubscribe/")
    if request.method not in ("GET", "HEAD", "OPTIONS") and not one_click and request.headers.get("x-requested-with") != "mailsomadhan":
        return JSONResponse({"detail": "Missing X-Requested-With header"}, status_code=403)
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-store")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    return response


app.include_router(auth.router, prefix="/api")
app.include_router(admin.router, prefix="/api/admin")
app.include_router(admin.scoped, prefix="/api/admin")
app.include_router(mail.router, prefix="/api/mail")
app.include_router(profile.router, prefix="/api")
app.include_router(system.router, prefix="/api/admin")
app.include_router(analytics.router, prefix="/api/admin")
app.include_router(filters.router, prefix="/api/admin")
app.include_router(backup.router, prefix="/api/admin")
app.include_router(campaigns.user_router, prefix="/api/mail")
app.include_router(campaigns.admin_router, prefix="/api/admin")
app.include_router(campaigns.public_router, prefix="/api")
app.include_router(admins.router, prefix="/api/admin")
app.include_router(tls.router, prefix="/api/admin")
app.include_router(cloudflare.router, prefix="/api/admin")
app.include_router(push.admin_router, prefix="/api/admin")
app.include_router(push.user_router, prefix="/api/mail")


@app.get("/api/health")
def health():
    return {"ok": True}
