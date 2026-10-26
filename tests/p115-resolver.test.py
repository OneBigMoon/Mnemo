import contextlib
import errno
import importlib.metadata
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "integrations/p115_resolver/main.py"
spec = importlib.util.spec_from_file_location("p115_resolver", SCRIPT)
resolver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resolver)
CANARY = "fixture-private-access-value"
FILE_ID = "9007199254740993"


class FakeURL(str):
    def __new__(cls, url="https://download.example.invalid/file?sign=fixture", **fields):
        value = super().__new__(cls, url)
        value.id = FILE_ID
        value.name = "影片.mkv"
        value.size = 1234
        value.sha1 = "a" * 40
        value.is_dir = False
        value.headers = {"Cookie": CANARY, "Authorization": CANARY}
        value.__dict__.update(fields)
        return value

    def __repr__(self):
        raise AssertionError("SDK objects must not be represented")


class Scenario:
    def __init__(self):
        self.constructors = []
        self.calls = []
        self.normalized = []
        self.page = {"state": True, "data": {"list": [], "count": 0}}
        self.permission = {"state": True, "data": {}}
        self.link = FakeURL()
        self.link_error = None

    def construct(self, **kwargs):
        self.constructors.append(kwargs)
        if set(kwargs) != {"cookies", "app", "console_qrcode"} or not isinstance(kwargs["cookies"], str):
            raise AssertionError("Only explicit cookie strings and pinned constructor arguments are permitted")
        print(CANARY)
        print(CANARY, file=sys.stderr)
        return FakeClient(self)

    def normalize(self, raw):
        self.normalized.append(raw)
        return raw["fixture"]


class FakeClient:
    def __init__(self, scenario):
        self.scenario = scenario
        self.headers = {"Cookie": CANARY}

    def __repr__(self):
        raise AssertionError("Never represent a client")

    def __getattr__(self, name):
        raise AssertionError("Unexpected SDK method: " + name)

    def share_snap(self, payload, **kwargs):
        self.scenario.calls.append(("share_snap", payload, kwargs))
        return self.scenario.page

    def share_skip_login_check(self, payload, **kwargs):
        self.scenario.calls.append(("share_skip_login_check", payload, kwargs))
        return self.scenario.permission

    def share_skip_login_download_url(self, payload, **kwargs):
        self.scenario.calls.append(("share_skip_login_download_url", payload, kwargs))
        if self.scenario.link_error:
            raise self.scenario.link_error
        return self.scenario.link

    def share_download_url(self, payload, **kwargs):
        self.scenario.calls.append(("share_download_url", payload, kwargs))
        if self.scenario.link_error:
            raise self.scenario.link_error
        return self.scenario.link


class ProtocolTests(unittest.TestCase):
    def test_strict_schema_rejects_login_inputs_and_unselected_sdk_operations(self):
        invalid = [None, [], {}, {"op": "share_receive"}, {"op": "health", "cookie": CANARY}]
        base = {"op": "list", "shareCode": "share123"}
        for field, value in [("shareCode", "https://115.com/s/share123"), ("shareCode", "a" * 65), ("receiveCode", None), ("receiveCode", "x\ny"), ("cookie", None), ("cookie", 1), ("cookie", "a" * 8193), ("cookie", "a\r\nb"), ("cookie", "中文"), ("parentId", 0), ("parentId", "../1"), ("offset", True), ("offset", -1), ("offset", 2**31), ("limit", 100), ("method", "login")]:
            invalid.append({**base, field: value})
        invalid.extend([{"op": "link", "shareCode": "share123", "fileId": value} for value in [None, "0", 1, "1/2", "9" * 33]])
        with patch.object(resolver, "load_sdk", side_effect=AssertionError("Invalid input must not import or construct the SDK")):
            for request in invalid:
                with self.subTest(index=invalid.index(request)):
                    response = resolver.execute(request)
                    self.assertEqual(response, resolver.error_response("invalid_input"))

    def test_one_bounded_json_input_rejects_duplicates_nonfinite_and_trailing_objects(self):
        invalid = [b"", b"\xff", b'{"op":"health","op":"link"}', b'{"op":"health"}{}', b'{"op":NaN}', b"x" * (resolver.MAX_INPUT + 1), b"[" * 2000]
        for raw in invalid:
            with self.subTest(length=len(raw)):
                with self.assertRaises(resolver.ResolverError) as caught:
                    resolver.read_request(io.BytesIO(raw))
                self.assertEqual(caught.exception.code, "invalid_input")
        self.assertEqual(resolver.read_request(io.BytesIO(b'{"op":"health"}\n')), {"op": "health"})

    def test_output_limit_emits_one_static_error(self):
        output = io.StringIO()
        resolver.write_response({"ok": True, "data": {"value": CANARY * (resolver.MAX_OUTPUT // len(CANARY) + 1)}}, output)
        self.assertEqual(json.loads(output.getvalue()), resolver.error_response("upstream_error"))
        self.assertNotIn(CANARY, output.getvalue())
        self.assertEqual(output.getvalue().count("\n"), 1)


class SDKTests(unittest.TestCase):
    def setUp(self):
        self.scenario = Scenario()

    @contextlib.contextmanager
    def sdk(self, version="0.0.9.7.2", failure=None):
        def import_module(name):
            if failure:
                raise failure
            if name == "p115client":
                return types.SimpleNamespace(P115Client=self.scenario.construct)
            if name == "p115client.tool.attr":
                return types.SimpleNamespace(normalize_attr_simple=self.scenario.normalize)
            raise AssertionError("Unexpected import")

        with patch.object(resolver.sys, "version_info", (3, 12, 0)), patch.object(resolver.importlib.metadata, "version", return_value=version), patch.object(resolver.importlib, "import_module", side_effect=import_module):
            yield

    def test_health_imports_correct_version_without_constructing_an_account(self):
        with self.sdk():
            response = resolver.execute({"op": "health"})
        self.assertEqual(response, {"ok": True, "data": {"available": True, "version": "0.0.9.7.2"}})
        self.assertEqual(self.scenario.constructors, [])
        self.assertEqual(self.scenario.calls, [])

    def test_health_missing_dependency_or_wrong_version_is_unavailable(self):
        for version, failure in [("0.0.9.7.2", ModuleNotFoundError(CANARY)), ("0.0.0", None)]:
            with self.subTest(version=version), self.sdk(version, failure):
                self.assertEqual(resolver.execute({"op": "health"}), {"ok": True, "data": {"available": False, "version": None}})
                self.assertEqual(resolver.execute({"op": "list", "shareCode": "share123"}), resolver.error_response("unavailable"))
        self.assertEqual(self.scenario.constructors, [])

    def test_anonymous_list_is_one_page_with_precise_ids_and_explicit_empty_cookie(self):
        self.scenario.page = {"state": True, "data": {"list": [
            {"fixture": {"id": int(FILE_ID), "name": "影片.mkv", "is_dir": False, "size": 1234, "sha1": "a" * 40}},
            {"fixture": {"id": 10, "name": "目录", "is_dir": True, "size": 999}},
        ], "count": "205"}}
        stdout, stderr = io.StringIO(), io.StringIO()
        with self.sdk(), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            response = resolver.execute({"op": "list", "shareCode": "share123", "receiveCode": "abcd", "parentId": "9", "offset": 100})
        self.assertEqual(self.scenario.constructors, [{"cookies": "", "app": "web", "console_qrcode": False}])
        self.assertEqual(self.scenario.calls, [("share_snap", {"share_code": "share123", "receive_code": "abcd", "cid": "9", "offset": 100, "limit": 100}, {"timeout": 8})])
        self.assertEqual(response["data"], {"entries": [
            {"id": FILE_ID, "name": "影片.mkv", "directory": False, "size": 1234, "sha1": "A" * 40},
            {"id": "10", "name": "目录", "directory": True, "size": 0},
        ], "total": 205, "nextOffset": 102})
        self.assertEqual((stdout.getvalue(), stderr.getvalue()), ("", ""))
        self.assertNotIn(CANARY, json.dumps(response))

    def test_single_page_limit_never_recurses_or_silently_truncates(self):
        entry = {"fixture": {"id": 1, "name": "file.mkv", "is_dir": False, "size": 1}}
        self.scenario.page = {"state": True, "data": {"list": [entry] * 100, "count": 1000}}
        with self.sdk():
            response = resolver.execute({"op": "list", "shareCode": "share123"})
        self.assertEqual(len(response["data"]["entries"]), 100)
        self.assertEqual(response["data"]["nextOffset"], 100)
        self.assertEqual(len(self.scenario.calls), 1)
        self.scenario.page["data"]["list"].append(entry)
        with self.sdk():
            self.assertEqual(resolver.execute({"op": "list", "shareCode": "share123"}), resolver.error_response("upstream_error"))

    def test_anonymous_link_checks_permission_then_requires_a_real_file_url(self):
        with self.sdk():
            response = resolver.execute({"op": "link", "shareCode": "share123", "receiveCode": "abcd", "fileId": FILE_ID})
        self.assertEqual([call[0] for call in self.scenario.calls], ["share_skip_login_check", "share_skip_login_download_url"])
        for method, payload, kwargs in self.scenario.calls:
            self.assertEqual(payload, {"share_code": "share123", "receive_code": "abcd", "file_id": FILE_ID})
            self.assertEqual(kwargs["timeout"], 8)
            if method.endswith("download_url"):
                self.assertIs(kwargs["strict"], True)
        self.assertEqual(response["data"]["headers"], {"User-Agent": "Mozilla/5.0"})
        self.assertEqual(response["data"]["sha1"], "A" * 40)
        self.assertNotIn(CANARY, json.dumps(response))
        self.assertEqual(set(response["data"]), {"url", "name", "size", "sha1", "headers"})

    def test_explicit_account_cookie_uses_only_authenticated_share_file_api(self):
        cookie = "UID=fixture; CID=fixture; SEID=fixture"
        with self.sdk():
            response = resolver.execute({"op": "link", "shareCode": "share123", "cookie": cookie, "fileId": FILE_ID})
        self.assertTrue(response["ok"])
        self.assertEqual(self.scenario.constructors[0]["cookies"], cookie)
        self.assertEqual([call[0] for call in self.scenario.calls], ["share_download_url"])
        self.assertNotIn(cookie, json.dumps(response))

    def test_permission_state_alone_cannot_produce_success_or_trigger_login_fallback(self):
        self.scenario.permission = {"state": True, "data": {"unrecognized_flag": True}}
        self.scenario.link_error = PermissionError(CANARY)
        with self.sdk():
            response = resolver.execute({"op": "link", "shareCode": "share123", "fileId": FILE_ID})
        self.assertEqual(response, resolver.error_response("access_denied"))
        self.assertEqual([call[0] for call in self.scenario.calls], ["share_skip_login_check", "share_skip_login_download_url"])
        self.assertNotIn(CANARY, json.dumps(response))

    def test_denied_permission_never_calls_a_download_or_cloud_write_api(self):
        self.scenario.permission = {"state": False, "errno": 50038, "message": CANARY}
        with self.sdk():
            response = resolver.execute({"op": "link", "shareCode": "share123", "fileId": FILE_ID})
        self.assertEqual(response, resolver.error_response("access_denied"))
        self.assertEqual([call[0] for call in self.scenario.calls], ["share_skip_login_check"])

    def test_directory_wrong_file_and_unsafe_or_empty_urls_are_rejected(self):
        for link, code in [(FakeURL(is_dir=True), "invalid_input"), (FakeURL(id="2"), "upstream_error"), (FakeURL(""), "upstream_error"), (FakeURL("file:///etc/passwd"), "upstream_error"), (FakeURL("https://user:pass@example.invalid/file"), "upstream_error"), (FakeURL("https://example.invalid/file\r\nx"), "upstream_error"), (FakeURL(name="../file.mkv"), "upstream_error"), (FakeURL(size=True), "upstream_error")]:
            self.scenario.link = link
            with self.subTest(code=code), self.sdk():
                response = resolver.execute({"op": "link", "shareCode": "share123", "fileId": FILE_ID})
            self.assertEqual(response, resolver.error_response(code))

    def test_sdk_and_http_errors_have_only_static_messages(self):
        auth_error = type("P115AuthenticationError", (OSError,), {})
        http_error = type("FakeHTTPError", (Exception,), {})
        cases = [(auth_error(CANARY), "access_denied"), (FileNotFoundError(CANARY), "not_found"), (OSError(errno.EBUSY, CANARY), "rate_limited"), (TimeoutError(CANARY), "upstream_error"), (RuntimeError(CANARY), "upstream_error")]
        for status, code in [(401, "access_denied"), (403, "access_denied"), (404, "not_found"), (410, "expired"), (429, "rate_limited"), (500, "upstream_error")]:
            failure = http_error(CANARY)
            failure.response = types.SimpleNamespace(status_code=status)
            cases.append((failure, code))
        for failure, code in cases:
            self.scenario.link_error = failure
            with self.subTest(code=code), self.sdk():
                response = resolver.execute({"op": "link", "shareCode": "share123", "fileId": FILE_ID})
            self.assertEqual(response, resolver.error_response(code))
            self.assertNotIn(CANARY, json.dumps(response))

    def test_provider_errno_mapping_never_echoes_provider_body(self):
        for number, code in [(4100026, "not_found"), (50038, "access_denied"), (40101004, "access_denied"), (590075, "rate_limited"), (99999999, "upstream_error")]:
            self.scenario.page = {"state": False, "errno": number, "message": CANARY, "data": {"Cookie": CANARY}}
            with self.subTest(number=number), self.sdk():
                response = resolver.execute({"op": "list", "shareCode": "share123"})
            self.assertEqual(response, resolver.error_response(code))


class ProcessTests(unittest.TestCase):
    def fake_package(self, directory):
        package = Path(directory) / "p115client"
        (package / "tool").mkdir(parents=True)
        (package / "__init__.py").write_text('''import os
import sys
import time
os.write(1, b"fixture-native-output")
os.write(2, b"fixture-native-error")
class P115Client:
    def __init__(self, cookies, app, console_qrcode):
        assert isinstance(cookies, str)
        self.headers = {}
    def share_snap(self, payload, **kwargs):
        time.sleep(60)
''')
        (package / "tool/__init__.py").write_text("")
        (package / "tool/attr.py").write_text("def normalize_attr_simple(raw):\n    return raw\n")
        metadata = Path(directory) / "p115client-0.0.9.7.2.dist-info"
        metadata.mkdir()
        (metadata / "METADATA").write_text("Metadata-Version: 2.1\nName: p115client\nVersion: 0.0.9.7.2\n")

    def invoke(self, directory, raw, deadline=20):
        script = """import importlib.util
import os
spec = importlib.util.spec_from_file_location('resolver_child', %s)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.PROCESS_TIMEOUT = %d
module.main()
os._exit(0)
""" % (repr(str(SCRIPT)), deadline)
        return subprocess.run([sys.executable, "-c", script], input=raw, capture_output=True, timeout=4, env={"PYTHONPATH": directory, "PYTHONDONTWRITEBYTECODE": "1"})

    @unittest.skipIf(sys.version_info < (3, 12), "SDK runtime requires Python 3.12+")
    def test_child_health_suppresses_native_sdk_output_and_stays_offline(self):
        with tempfile.TemporaryDirectory(prefix="mori-p115-test-") as directory:
            self.fake_package(directory)
            result = self.invoke(directory, b'{"op":"health"}')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {"ok": True, "data": {"available": True, "version": "0.0.9.7.2"}})
        self.assertEqual(result.stdout.count(b"\n"), 1)
        self.assertEqual(result.stderr, b"")

    @unittest.skipIf(sys.version_info < (3, 12), "SDK runtime requires Python 3.12+")
    def test_total_deadline_terminates_sdk_that_ignores_http_timeout(self):
        with tempfile.TemporaryDirectory(prefix="mori-p115-test-") as directory:
            self.fake_package(directory)
            start = time.monotonic()
            result = self.invoke(directory, b'{"op":"list","shareCode":"share123"}', deadline=1)
            duration = time.monotonic() - start
        self.assertLess(duration, 3)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), resolver.error_response("upstream_error"))
        self.assertEqual(result.stderr, b"")


if __name__ == "__main__":
    unittest.main()
