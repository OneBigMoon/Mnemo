"""One-shot, read-only 115 share resolver. Python >=3.12; JSON stdin/stdout only."""

import contextlib
import errno
import importlib
import importlib.metadata
import json
import os
import re
import signal
import sys
from urllib.parse import urlsplit


SDK_VERSION = "0.0.9.7.2"
SDK_COMMIT = "856e4f8f09ce034534bd458f06d3dee4474a1698"
USER_AGENT = "Mozilla/5.0"
PAGE_SIZE = 100
HTTP_TIMEOUT = 8
PROCESS_TIMEOUT = 20
MAX_INPUT = 64 * 1024
MAX_OUTPUT = 256 * 1024
MAX_OFFSET = 2**31 - 1
MAX_SAFE_INTEGER = 2**53 - 1
MESSAGES = {
    "unavailable": "115 share resolver is unavailable.",
    "invalid_input": "Invalid resolver request.",
    "access_denied": "The share requires permission or valid access data.",
    "expired": "The share has expired.",
    "not_found": "The shared file was not found.",
    "rate_limited": "The share provider is rate limited.",
    "upstream_error": "The share provider could not complete the request.",
}


class ResolverError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(MESSAGES[code])


def error_response(code):
    return {"ok": False, "error": {"code": code, "message": MESSAGES[code]}}


def validate_request(request):
    if not isinstance(request, dict) or not isinstance(request.get("op"), str):
        raise ResolverError("invalid_input")
    operation = request["op"]
    if operation == "health":
        if set(request) != {"op"}:
            raise ResolverError("invalid_input")
        return request
    common = {"op", "shareCode", "receiveCode", "cookie"}
    allowed = common | ({"parentId", "offset"} if operation == "list" else {"fileId"})
    if operation not in {"list", "link"} or not set(request) <= allowed:
        raise ResolverError("invalid_input")
    share_code = request.get("shareCode")
    receive_code = request.get("receiveCode", "")
    cookie = request.get("cookie", "")
    if not isinstance(share_code, str) or not re.fullmatch(r"[A-Za-z0-9]{1,64}", share_code):
        raise ResolverError("invalid_input")
    if not isinstance(receive_code, str) or not re.fullmatch(r"[A-Za-z0-9]{0,32}", receive_code):
        raise ResolverError("invalid_input")
    if not isinstance(cookie, str) or len(cookie) > 8192 or re.search(r"[^\x20-\x7e]", cookie) or (cookie and not cookie.strip()):
        raise ResolverError("invalid_input")
    result = {**request, "receiveCode": receive_code, "cookie": cookie}
    if operation == "list":
        parent = request.get("parentId", "0")
        offset = request.get("offset", 0)
        if not isinstance(parent, str) or not re.fullmatch(r"0|[1-9][0-9]{0,31}", parent):
            raise ResolverError("invalid_input")
        if type(offset) is not int or not 0 <= offset <= MAX_OFFSET:
            raise ResolverError("invalid_input")
        result.update(parentId=parent, offset=offset)
    elif not isinstance(request.get("fileId"), str) or not re.fullmatch(r"[1-9][0-9]{0,31}", request["fileId"]):
        raise ResolverError("invalid_input")
    return result


def load_sdk():
    if not (3, 12) <= sys.version_info < (4, 0):
        raise ResolverError("unavailable")
    try:
        if importlib.metadata.version("p115client") != SDK_VERSION:
            raise ResolverError("unavailable")
        module = importlib.import_module("p115client")
        attrs = importlib.import_module("p115client.tool.attr")
        if not callable(module.P115Client) or not callable(attrs.normalize_attr_simple):
            raise ResolverError("unavailable")
        return module.P115Client, attrs.normalize_attr_simple
    except Exception:
        raise ResolverError("unavailable") from None


def provider_error(code):
    # Codes are from check_response in the pinned SDK; unknown codes stay opaque.
    if type(code) not in {str, int}:
        return "upstream_error"
    if str(code) in {"20013", "20018", "31003", "50015", "70005", "70008", "90008", "430004", "4100026"}:
        return "not_found"
    if str(code) in {"50038", "51011", "40101004", "40101009", "40101010", "40101017", "40101032"}:
        return "access_denied"
    if str(code) == "590075":
        return "rate_limited"
    return "upstream_error"


def checked_response(response):
    if not isinstance(response, dict):
        raise ResolverError("upstream_error")
    if response.get("state") is not True:
        raise ResolverError(provider_error(response.get("errno", response.get("errNo", response.get("code")))))
    return response


def exception_code(exc):
    if isinstance(exc, ResolverError):
        return exc.code
    if isinstance(exc, IsADirectoryError):
        return "invalid_input"
    if isinstance(exc, PermissionError) or type(exc).__name__ in {"P115LoginError", "P115AuthenticationError", "P115AccessError"}:
        return "access_denied"
    if isinstance(exc, FileNotFoundError):
        return "not_found"
    if isinstance(exc, OSError) and exc.errno in {errno.EACCES, errno.EPERM, errno.ENOENT, errno.EBUSY}:
        return {errno.EACCES: "access_denied", errno.EPERM: "access_denied", errno.ENOENT: "not_found", errno.EBUSY: "rate_limited"}[exc.errno]
    status = getattr(exc, "status", None) or getattr(exc, "status_code", None)
    if status is None:
        status = getattr(getattr(exc, "response", None), "status_code", None)
    if not isinstance(status, int):
        return "upstream_error"
    return {401: "access_denied", 403: "access_denied", 404: "not_found", 410: "expired", 429: "rate_limited"}.get(status, "upstream_error")


def output_id(value):
    if type(value) is int:
        value = str(value)
    if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]{0,31}", value):
        raise ResolverError("upstream_error")
    return value


def file_fields(name, size, sha1):
    if not isinstance(name, str) or not name or len(name) > 512 or re.search(r"[/\\\x00-\x1f\x7f]", name):
        raise ResolverError("upstream_error")
    if type(size) is not int or not 0 <= size <= MAX_SAFE_INTEGER:
        raise ResolverError("upstream_error")
    result = {"name": name, "size": size}
    if sha1:
        if not isinstance(sha1, str) or not re.fullmatch(r"[A-Fa-f0-9]{40}", sha1):
            raise ResolverError("upstream_error")
        result["sha1"] = sha1.upper()
    return result


def list_share(client, normalize, request):
    payload = {"share_code": request["shareCode"], "receive_code": request["receiveCode"], "cid": request["parentId"], "offset": request["offset"], "limit": PAGE_SIZE}
    response = checked_response(client.share_snap(payload, timeout=HTTP_TIMEOUT))
    data = response.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("list"), list) or len(data["list"]) > PAGE_SIZE:
        raise ResolverError("upstream_error")
    entries = []
    for raw in data["list"]:
        if not isinstance(raw, dict):
            raise ResolverError("upstream_error")
        item = normalize(raw)
        if not isinstance(item, dict) or type(item.get("is_dir")) is not bool:
            raise ResolverError("upstream_error")
        directory = item["is_dir"]
        fields = file_fields(item.get("name"), 0 if directory else item.get("size"), None if directory else item.get("sha1"))
        item_id = output_id(item.get("id"))
        if not directory and item_id == "0":
            raise ResolverError("upstream_error")
        entries.append({"id": item_id, "directory": directory, **fields})
    result = {"entries": entries}
    total = data.get("count")
    if total is not None:
        if isinstance(total, str) and re.fullmatch(r"[0-9]{1,16}", total):
            total = int(total)
        if type(total) is not int or not 0 <= total <= MAX_SAFE_INTEGER:
            raise ResolverError("upstream_error")
        result["total"] = total
    next_offset = request["offset"] + len(entries)
    if entries and (next_offset < total if total is not None else len(entries) == PAGE_SIZE):
        if next_offset > MAX_OFFSET:
            raise ResolverError("upstream_error")
        result["nextOffset"] = next_offset
    return result


def link_share(client, request):
    payload = {"share_code": request["shareCode"], "receive_code": request["receiveCode"], "file_id": request["fileId"]}
    if request["cookie"]:
        link = client.share_download_url(payload, strict=True, timeout=HTTP_TIMEOUT)
    else:
        checked_response(client.share_skip_login_check(payload, timeout=HTTP_TIMEOUT))
        link = client.share_skip_login_download_url(payload, strict=True, timeout=HTTP_TIMEOUT)
    if not isinstance(link, str) or getattr(link, "is_dir", None) is not False:
        raise ResolverError("invalid_input")
    if output_id(getattr(link, "id", None)) != request["fileId"]:
        raise ResolverError("upstream_error")
    url = str(link)
    if not url or len(url) > 8192 or re.search(r"[\x00-\x20\x7f]", url):
        raise ResolverError("upstream_error")
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ResolverError("upstream_error")
    fields = file_fields(getattr(link, "name", None), getattr(link, "size", None), getattr(link, "sha1", None))
    return {"url": url, **fields, "headers": {"User-Agent": USER_AGENT}}


def execute(request):
    try:
        request = validate_request(request)
        with open(os.devnull, "w") as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
            try:
                constructor, normalize = load_sdk()
            except ResolverError:
                if request["op"] == "health":
                    return {"ok": True, "data": {"available": False, "version": None}}
                raise
            if request["op"] == "health":
                return {"ok": True, "data": {"available": True, "version": SDK_VERSION}}
            # An explicit string, including the anonymous empty string, must never trigger QR login.
            client = constructor(cookies=request["cookie"], app="web", console_qrcode=False)
            client.headers["user-agent"] = USER_AGENT
            data = list_share(client, normalize, request) if request["op"] == "list" else link_share(client, request)
            return {"ok": True, "data": data}
    except Exception as exc:
        return error_response(exception_code(exc))


def json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ResolverError("invalid_input")
        result[key] = value
    return result


def reject_constant(_value):
    raise ResolverError("invalid_input")


def read_request(stream):
    raw = stream.read(MAX_INPUT + 1)
    if not raw or len(raw) > MAX_INPUT:
        raise ResolverError("invalid_input")
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=json_object, parse_constant=reject_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise ResolverError("invalid_input") from None


def write_response(response, stream):
    try:
        encoded = json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_OUTPUT:
            raise ValueError("Response limit")
    except (ValueError, UnicodeError):
        encoded = json.dumps(error_response("upstream_error"), separators=(",", ":")).encode("utf-8")
    stream.write(encoded.decode("utf-8") + "\n")
    stream.flush()


def main():
    # Keep one protocol descriptor; SDK/native logging must never reach stdout or stderr.
    output = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
    with open(os.devnull, "w") as quiet:
        os.dup2(quiet.fileno(), sys.stdout.fileno())
        os.dup2(quiet.fileno(), sys.stderr.fileno())

    def timed_out(_signum, _frame):
        write_response(error_response("upstream_error"), output)
        os._exit(0)

    signal.signal(signal.SIGALRM, timed_out)
    signal.setitimer(signal.ITIMER_REAL, PROCESS_TIMEOUT)
    try:
        response = execute(read_request(sys.stdin.buffer))
    except Exception as exc:
        response = error_response(exception_code(exc))
    signal.setitimer(signal.ITIMER_REAL, 0)
    write_response(response, output)


if __name__ == "__main__":
    main()
    # SDK shutdown hooks can emit diagnostics; this one-shot child owns all its handles.
    os._exit(0)
