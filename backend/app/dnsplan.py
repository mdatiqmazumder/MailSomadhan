"""Work out which DNS changes a domain needs, given the records its DNS provider has now.

Pure functions (no network), used by the Cloudflare automatic setup. Every change has a key the
admin selects in the panel; changes that would overwrite something the admin set up themselves
(for example MX records that send mail elsewhere) are never selected by default.
"""
import re

SPF_END_RE = re.compile(r"^([~?+-]?all|redirect=.*)$", re.I)


def desired_records(domain: str, primary_host: str, selector: str, dkim_public: str) -> dict:
    return {
        "MX": {"type": "MX", "name": domain, "content": primary_host, "priority": 10},
        "SPF": {"type": "TXT", "name": domain, "content": f"v=spf1 mx a:{primary_host} ~all"},
        "DKIM": {"type": "TXT", "name": f"{selector}._domainkey.{domain}", "content": f"v=DKIM1; k=rsa; p={dkim_public}"},
        "DMARC": {"type": "TXT", "name": f"_dmarc.{domain}", "content": f"v=DMARC1; p=quarantine; rua=mailto:postmaster@{domain}"},
    }


def spf_allows(value: str, host: str) -> bool:
    terms = value.lower().split()
    return "mx" in terms or "+mx" in terms or f"a:{host.lower()}" in terms or host.lower() in value.lower()


def merge_spf(value: str, host: str) -> str:
    """Add this server to an existing SPF record without dropping what is already allowed."""
    terms = value.split()
    add = ["mx", f"a:{host}"]
    for i, term in enumerate(terms):
        if i and SPF_END_RE.match(term):
            return " ".join(terms[:i] + add + terms[i:])
    return " ".join(terms + add + ["~all"])


def _norm(txt: str) -> str:
    return re.sub(r"\s+", "", txt).lower()


def _fresh(existing: list[dict], want: dict, same) -> list[dict]:
    """Changes that leave exactly one record: the wanted one. Every other record of this kind is
    deleted first; a record that already matches exactly is kept rather than deleted and re-added."""
    keep = next((r for r in existing if same(r)), None)
    changes = [{"op": "delete", "id": r["id"]} for r in existing if r is not keep]
    if keep is None:
        changes.append({"op": "create", **want})
    return changes


def plan(domain: str, primary_host: str, selector: str, dkim_public: str, existing: list[dict]) -> list[dict]:
    """Returns one entry per mail record:
    {purpose, status: ok|create|update|replace|kept, summary, current[], selected, changes[]}
    `changes` are operations for mailsomadhan-cloudflare apply."""
    want = desired_records(domain, primary_host, selector, dkim_public)
    domain = domain.lower()
    host = primary_host.lower()

    def at(rtype: str, name: str) -> list[dict]:
        return [r for r in existing if r["type"] == rtype and r["name"].lower() == name.lower()]

    out = []

    # MX
    mx = at("MX", domain)
    entry = {"purpose": "MX", "record": want["MX"], "current": [f"{r.get('priority') or ''} {r['content']}".strip() for r in mx]}
    if any(r["content"].rstrip(".").lower() == host for r in mx):
        others = [r for r in mx if r["content"].rstrip(".").lower() != host]
        entry.update(status="ok", summary="Mail for this domain is delivered to this server.", selected=False, changes=[])
        if others:
            entry["summary"] += f" {len(others)} other MX record(s) also exist and receive part of the mail."
    elif not mx:
        entry.update(status="create", summary=f"Add an MX record pointing to {host}.", selected=True,
                     changes=[{"op": "create", **want["MX"]}])
    else:
        entry.update(status="replace", selected=False,
                     summary="Mail for this domain currently goes to another server. Replacing the MX records sends all new mail to this server instead.",
                     changes=[{"op": "delete", "id": r["id"]} for r in mx] + [{"op": "create", **want["MX"]}])
    entry["fresh"] = _fresh(mx, want["MX"], lambda r: r["content"].rstrip(".").lower() == host and (r.get("priority") or 10) == 10)
    out.append(entry)

    # SPF
    spf = [r for r in at("TXT", domain) if r["content"].lower().startswith("v=spf1")]
    entry = {"purpose": "SPF", "record": want["SPF"], "current": [r["content"] for r in spf]}
    if len(spf) == 1 and spf_allows(spf[0]["content"], host):
        entry.update(status="ok", summary="The SPF record already allows this server.", selected=False, changes=[])
    elif not spf:
        entry.update(status="create", summary="Add an SPF record that allows this server to send.", selected=True,
                     changes=[{"op": "create", **want["SPF"]}])
    elif len(spf) == 1:
        merged = merge_spf(spf[0]["content"], host)
        entry.update(status="update", record={**want["SPF"], "content": merged}, selected=True,
                     summary="Add this server to the existing SPF record; everything it already allows stays allowed.",
                     changes=[{"op": "update", "id": spf[0]["id"], **want["SPF"], "content": merged}])
    else:
        merged = merge_spf(spf[0]["content"], host) if not spf_allows(spf[0]["content"], host) else spf[0]["content"]
        entry.update(status="replace", record={**want["SPF"], "content": merged}, selected=False,
                     summary=f"There are {len(spf)} SPF records, which makes SPF fail everywhere. Keep only one that also allows this server.",
                     changes=[{"op": "update", "id": spf[0]["id"], **want["SPF"], "content": merged}]
                     + [{"op": "delete", "id": r["id"]} for r in spf[1:]])
    entry["fresh"] = _fresh(spf, want["SPF"], lambda r: _norm(r["content"]) == _norm(want["SPF"]["content"]))
    out.append(entry)

    # DKIM
    dkim = at("TXT", want["DKIM"]["name"])
    entry = {"purpose": "DKIM", "record": want["DKIM"], "current": [r["content"] for r in dkim]}
    if any(_norm(r["content"]) == _norm(want["DKIM"]["content"]) for r in dkim):
        entry.update(status="ok", summary="The DKIM key is published.", selected=False, changes=[])
    elif not dkim:
        entry.update(status="create", summary="Publish the DKIM key that signs this domain's mail.", selected=True,
                     changes=[{"op": "create", **want["DKIM"]}])
    else:
        entry.update(status="update", summary="Replace the outdated DKIM key with the current one.", selected=True,
                     changes=[{"op": "update", "id": dkim[0]["id"], **want["DKIM"]}])
    entry["fresh"] = _fresh([r for r in dkim if r["content"].lower().startswith("v=dkim1")], want["DKIM"], lambda r: _norm(r["content"]) == _norm(want["DKIM"]["content"]))
    out.append(entry)

    # DMARC: an existing policy is the admin's choice and is never changed.
    dmarc = [r for r in at("TXT", want["DMARC"]["name"]) if r["content"].lower().startswith("v=dmarc1")]
    entry = {"purpose": "DMARC", "record": want["DMARC"], "current": [r["content"] for r in dmarc]}
    if any(_norm(r["content"]) == _norm(want["DMARC"]["content"]) for r in dmarc):
        entry.update(status="ok", summary="The DMARC policy is published.", selected=False, changes=[])
    elif dmarc:
        entry.update(status="kept", summary="A DMARC policy already exists and is left as it is.", selected=False, changes=[])
    else:
        entry.update(status="create", summary="Add a DMARC policy (suspicious mail is sent to junk).", selected=True,
                     changes=[{"op": "create", **want["DMARC"]}])
    entry["fresh"] = _fresh(dmarc, want["DMARC"], lambda r: _norm(r["content"]) == _norm(want["DMARC"]["content"]))
    out.append(entry)
    for e in out:
        # "Delete existing and add fresh" is offered when it would change something.
        e["can_replace"] = bool(e["current"]) and bool(e["fresh"])
        if not e["can_replace"]:
            e["fresh"] = []
    return out
