"""Exercise the installed pinned SDK's objects/normalizer without network or login."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys


def forbid(*_args, **_kwargs):
    os._exit(73)


socket.socket.connect = forbid
socket.socket.connect_ex = forbid
socket.create_connection = forbid
socket.getaddrinfo = forbid

from p115client import P115Client
from p115client.type import P115URL

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mori_resolver", root / "integrations/p115_resolver/main.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
calls = []
P115Client.login = forbid
P115Client.share_receive = forbid


def listing(self, payload, **kwargs):
    assert self.headers["user-agent"] == "Mozilla/5.0"
    assert payload["limit"] == 100 and payload["cid"] == "0"
    assert kwargs["timeout"] == 8
    calls.append("list")
    return {"state": True, "data": {"count": "2", "list": [
        {"cid": "12", "pid": "0", "n": "Folder"},
        {"fid": "9007199254740993", "cid": "0", "n": "Fixture.mp4", "s": "12", "sha": "A" * 40},
    ]}}


def permission(self, payload, **kwargs):
    assert payload["file_id"] == "9007199254740993"
    calls.append("permission")
    return {"state": True, "data": {}}


def anonymous(self, payload, **kwargs):
    calls.append("anonymous")
    return P115URL("https://example.invalid/video", id=9007199254740993, name="Fixture.mp4", size=12, sha1="A" * 40, is_dir=False)


def authenticated(self, payload, **kwargs):
    calls.append("authenticated")
    return P115URL("https://example.invalid/video", id=9007199254740993, name="Fixture.mp4", size=12, sha1="A" * 40, is_dir=False)


P115Client.share_snap = listing
P115Client.share_skip_login_check = permission
P115Client.share_skip_login_download_url = anonymous
P115Client.share_download_url = authenticated

health = helper.execute({"op": "health"})
assert health == {"ok": True, "data": {"available": True, "version": "0.0.9.7.2"}}
base = {"shareCode": "fixtureShare", "receiveCode": "A1B2", "cookie": ""}
result = helper.execute({"op": "list", **base, "parentId": "0", "offset": 0})
assert result.get("ok"), result
assert result["data"]["entries"][0] == {"id": "12", "name": "Folder", "directory": True, "size": 0}
assert result["data"]["entries"][1]["id"] == "9007199254740993"
for cookie in ["", "UID=1; CID=fixture; SEID=fixture"]:
    result = helper.execute({"op": "link", **base, "cookie": cookie, "fileId": "9007199254740993"})
    assert result.get("ok"), result
    assert result["data"]["headers"] == {"User-Agent": "Mozilla/5.0"}
    assert "cookie" not in json.dumps(result).lower()
assert calls == ["list", "permission", "anonymous", "authenticated"], calls
print(json.dumps({"sdk": "0.0.9.7.2", "checks": 4, "network": "blocked", "login": "blocked", "cloudWrites": "blocked"}))
sys.stdout.flush()
os._exit(0)
