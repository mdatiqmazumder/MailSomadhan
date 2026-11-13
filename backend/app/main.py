from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .db import Base, engine
from .migrate import migrate
from .routers import admin, analytics, auth, backup, campaigns, filters, mail, system


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(engine)
    migrate()
    yield


app = FastAPI(title="MailSomadhan API", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


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
app.include_router(mail.router, prefix="/api/mail")
app.include_router(system.router, prefix="/api/admin")
app.include_router(analytics.router, prefix="/api/admin")
app.include_router(filters.router, prefix="/api/admin")
app.include_router(backup.router, prefix="/api/admin")
app.include_router(campaigns.user_router, prefix="/api/mail")
app.include_router(campaigns.admin_router, prefix="/api/admin")
app.include_router(campaigns.public_router, prefix="/api")


@app.get("/api/health")
def health():
    return {"ok": True}
