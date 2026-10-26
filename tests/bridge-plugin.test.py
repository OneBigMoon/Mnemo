import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import types
import threading
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, Mock, patch


for name in ("astrbot", "astrbot.api", "astrbot.api.event", "astrbot.api.star"):
    sys.modules[name] = types.ModuleType(name)
sys.modules["astrbot.api"].AstrBotConfig = dict
sys.modules["astrbot.api.event"].AstrMessageEvent = object


class MessageChain:
    def message(self, text):
        self.text = text
        return self


sys.modules["astrbot.api.event"].MessageChain = MessageChain
sys.modules["astrbot.api.event"].filter = types.SimpleNamespace(command=lambda _name: lambda handler: handler)
sys.modules["astrbot.api.star"].Context = object
sys.modules["astrbot.api.star"].Star = type("Star", (), {"__init__": lambda self, context: None})
sys.modules["astrbot.api.star"].StarTools = types.SimpleNamespace(get_data_dir=lambda: (_ for _ in ()).throw(AssertionError("Tests must use temporary plugin data")))
path = Path(__file__).resolve().parents[1] / "integrations/astrbot_mori/main.py"
spec = importlib.util.spec_from_file_location("mori_plugin", path)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


class Event:
    message_str = "/mori 搜索 沙丘"
    unified_msg_origin = "fixture:GroupMessage:42"
    message_obj = types.SimpleNamespace(message_id="message-123")

    def get_platform_name(self):
        return "aiocqhttp"

    def get_sender_id(self):
        return "7"

    def stop_event(self):
        pass

    def plain_result(self, text):
        return text


async def collect(bot, event):
    return [result async for result in bot.mori(event)]


class ProtocolTests(unittest.TestCase):
    def test_http_failure_preserves_status_without_reading_response_body(self):
        response = Mock(status=409)
        response.read1.side_effect = AssertionError("Error bodies must not be read")
        connection = Mock(sock=None)
        connection.getresponse.return_value = response
        with patch.object(plugin.http.client, "HTTPConnection", return_value=connection):
            with self.assertRaises(plugin.BridgeHTTPError) as raised:
                plugin.bridge_post("http://127.0.0.1:4317", "qq", b"{}", {}, "ack")
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(str(raised.exception), "Bridge HTTP 409")
        response.read1.assert_not_called()
        connection.close.assert_called_once()

    def test_notification_signatures_match_canonical_contract(self):
        signing_value = "local-notification-fixture"
        for action, body, canonical in [
            ("poll", {"peer": Event.unified_msg_origin, "nonce": "nonce-123"}, ["notifications.poll", "qq", "1790000000", Event.unified_msg_origin, "nonce-123"]),
            ("ack", {"peer": Event.unified_msg_origin, "id": "notice-1", "claimToken": "attempt-1", "outcome": "delivered", "receipt": "astrbot:delivered"}, ["notifications.ack", "qq", "1790000000", Event.unified_msg_origin, "notice-1", "attempt-1", "delivered", "astrbot:delivered"]),
        ]:
            with self.subTest(action=action):
                raw, headers = plugin.signed_notification(action, "qq", body, signing_value, 1790000000)
                self.assertEqual(json.loads(raw), body)
                expected = hmac.new(signing_value.encode(), json.dumps(canonical, ensure_ascii=False, separators=(",", ":")).encode(), hashlib.sha256).hexdigest()
                self.assertEqual(headers["X-Mori-Timestamp"], "1790000000")
                self.assertEqual(headers["X-Mori-Signature"], expected)
        with self.assertRaises(ValueError):
            plugin.signed_notification("poll", "qq", {"peer": Event.unified_msg_origin, "nonce": "invalid nonce"}, signing_value)
        with self.assertRaises(ValueError):
            plugin.signed_notification("ack", "qq", {"peer": Event.unified_msg_origin, "id": "id", "claimToken": "attempt", "outcome": "read"}, signing_value)

    def test_notification_http_paths_use_existing_bounded_transport(self):
        captured = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                captured.append((self.path, json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                reply = {"notifications": [], "serverTime": "2026-10-24T00:00:00Z"} if self.path.endswith("/poll") else {"ok": True}
                raw = json.dumps(reply).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            for action, body in [("poll", {"peer": Event.unified_msg_origin, "nonce": "nonce"}), ("ack", {"peer": Event.unified_msg_origin, "id": "id", "claimToken": "attempt", "outcome": "unknown"})]:
                payload, headers = plugin.signed_notification(action, "qq", body, "local-notification-fixture")
                reply = plugin.bridge_post("http://127.0.0.1:%s" % server.server_port, "qq", payload, headers, action)
                self.assertIsInstance(reply, dict)
            self.assertEqual([item[0] for item in captured], ["/api/channels/bridge/qq/notifications/poll", "/api/channels/bridge/qq/notifications/ack"])
        finally:
            server.shutdown()
            worker.join(timeout=2)
            server.server_close()

    def test_signature_matches_javascript_canonical_contract(self):
        raw, headers = plugin.signed_message("qq", "peer", "id", "搜索 沙丘", "fixture-signing-value", 1790000000)
        body = json.loads(raw)
        canonical = json.dumps(["qq", "1790000000", body["eventId"], "peer", "搜索 沙丘"], ensure_ascii=False, separators=(",", ":")).encode()
        expected = hmac.new(b"fixture-signing-value", canonical, hashlib.sha256).hexdigest()
        self.assertEqual(headers["X-Mori-Signature"], expected)
        self.assertEqual(set(body), {"eventId", "peer", "text"})
        self.assertEqual(raw, plugin.signed_message("qq", "peer", "id", "搜索 沙丘", "fixture-signing-value", 1790000000)[0])
        self.assertNotEqual(raw, plugin.signed_message("qq", "peer", "other", "搜索 沙丘", "fixture-signing-value", 1790000000)[0])
        with self.assertRaises(ValueError):
            plugin.signed_message("qq", "peer", "", "x", "fixture-signing-value")

    def test_reply_is_bounded_and_does_not_auto_download(self):
        reply = plugin.reply_text({"text": "搜索完成", "results": [{"title": "沙丘", "url": "https://example.invalid/movie.mp4"}] * 30})
        self.assertLessEqual(len(reply), 10000)
        self.assertEqual(reply.count("https://example.invalid/movie.mp4"), 5)
        self.assertIn("明确发送", reply)

    def test_local_http_transport_and_response(self):
        captured = {}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                captured["path"] = self.path
                captured["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                captured["signature"] = self.headers["X-Mori-Signature"]
                body = json.dumps({"text": "任务状态"}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.handle_request, daemon=True)
        worker.start()
        try:
            payload, headers = plugin.signed_message("qq", "peer", "id", "任务状态", "fixture-signing-value")
            reply = plugin.bridge_post("http://127.0.0.1:%s" % server.server_port, "qq", payload, headers)
            self.assertEqual(reply["text"], "任务状态")
            self.assertEqual(captured["path"], "/api/channels/bridge/qq")
            self.assertEqual(captured["signature"], headers["X-Mori-Signature"])
        finally:
            worker.join(timeout=2)
            server.server_close()


class EventTests(unittest.IsolatedAsyncioTestCase):
    def config(self):
        return {"mori_url": "http://127.0.0.1:4317", "bridge_secret": "fixture-signing-value", "allowed_users": ["qq:7"], "allowed_sessions": [Event.unified_msg_origin]}

    async def test_default_deny_and_authorized_reply(self):
        denied = plugin.MoriPlugin(None, {})
        with patch.object(plugin, "bridge_post", side_effect=AssertionError("must not dispatch")):
            self.assertEqual(await collect(denied, Event()), [])
        bot = plugin.MoriPlugin(None, self.config())
        with patch.object(plugin, "bridge_post", return_value={"text": "结果", "results": [{"title": "片名", "url": "https://example.invalid/x"}]}):
            replies = await collect(bot, Event())
        self.assertIn("结果", replies[0])
        self.assertIn("片名", replies[0])
        self.assertEqual(bot._pending, 0)
        await bot.terminate()
        self.assertEqual(await collect(bot, Event()), [])

    async def test_cancellation_never_replies_and_backpressure(self):
        bot = plugin.MoriPlugin(None, self.config())
        bot._pending = 8
        self.assertIn("尚未提交", (await collect(bot, Event()))[0])
        bot._pending = 0
        started = asyncio.Event()

        async def pending(*args):
            started.set()
            await asyncio.Event().wait()

        with patch.object(plugin.asyncio, "to_thread", pending):
            running = asyncio.create_task(collect(bot, Event()))
            await started.wait()
            await bot.terminate()
            self.assertTrue(running.cancelled())
        self.assertEqual(bot._pending, 0)


def notification_claim(notification_id="notice-1", seconds=120):
    now = datetime.now(timezone.utc)
    return {"id": notification_id, "taskId": "task-1", "text": "下载完成：示例影片（任务 task-1）", "claimToken": "attempt-1", "expiresAt": (now + timedelta(seconds=seconds)).isoformat()}


class JournalTests(unittest.TestCase):
    def test_legacy_journal_adds_obsolete_status_without_losing_outcome(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "legacy.sqlite3"
            with sqlite3.connect(path) as db:
                db.execute("""CREATE TABLE deliveries (
                    id TEXT NOT NULL, claim_token TEXT NOT NULL, platform TEXT NOT NULL,
                    peer TEXT NOT NULL, expires_at REAL NOT NULL, state TEXT NOT NULL,
                    receipt TEXT NOT NULL DEFAULT '', acked INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (id, claim_token))""")
                db.execute("INSERT INTO deliveries VALUES (?,?,?,?,?,?,?,?)", ("notice-1", "attempt-1", "qq", Event.unified_msg_origin, time.time() + 120, "unknown", "previous-receipt", 0))
            journal = plugin.NotificationJournal(path)
            try:
                row = journal.begin("qq", Event.unified_msg_origin, notification_claim())
                self.assertEqual((row["state"], row["receipt"], row["acked"], row["obsolete_status"]), ("unknown", "previous-receipt", 0, 0))
                journal.obsolete("notice-1", "attempt-1", 409)
                self.assertEqual(journal.pending("qq", Event.unified_msg_origin), [])
            finally:
                journal.close()

    def test_restart_recovers_dispatching_as_unknown_and_preserves_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "notifications.sqlite3"
            claim = notification_claim()
            journal = plugin.NotificationJournal(path)
            self.assertIsNone(journal.begin("qq", Event.unified_msg_origin, claim))
            journal.close()
            journal = plugin.NotificationJournal(path)
            try:
                row = journal.begin("qq", Event.unified_msg_origin, claim)
                self.assertEqual(row["state"], "unknown")
                self.assertEqual(len(journal.pending("qq", Event.unified_msg_origin)), 1)
                with self.assertRaises(ValueError):
                    journal.begin("qq", "other:GroupMessage:42", claim)
            finally:
                journal.close()

    def test_capacity_never_discards_unacknowledged_attempts(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = plugin.NotificationJournal(Path(directory) / "notifications.sqlite3")
            journal.MAX_ROWS = 2
            try:
                for i in range(2):
                    claim = notification_claim("notice-%d" % i, seconds=-1000)
                    journal.begin("qq", Event.unified_msg_origin, claim)
                    journal.finish(claim["id"], claim["claimToken"], "unknown")
                self.assertFalse(journal.has_room(1))
                with self.assertRaises(ValueError):
                    journal.begin("qq", Event.unified_msg_origin, notification_claim("notice-3"))
                self.assertEqual(len(journal.pending("qq", Event.unified_msg_origin)), 2)
            finally:
                journal.close()

    def test_pruning_keeps_recent_receipts_and_unknown_attempts(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = plugin.NotificationJournal(Path(directory) / "notifications.sqlite3")
            journal.MAX_ROWS = 4
            journal.KEEP_RECEIPTS = 2
            try:
                unknown = notification_claim("unknown", seconds=-1000)
                journal.begin("qq", Event.unified_msg_origin, unknown)
                journal.finish(unknown["id"], unknown["claimToken"], "unknown")
                for i in range(5):
                    claim = notification_claim("notice-%d" % i, seconds=-1000)
                    journal.begin("qq", Event.unified_msg_origin, claim)
                    journal.finish(claim["id"], claim["claimToken"], "delivered")
                    journal.acknowledged(claim["id"], claim["claimToken"])
                self.assertTrue(journal.has_room(1))
                ids = {row[0] for row in journal.db.execute("SELECT id FROM deliveries")}
                self.assertEqual(ids, {"unknown", "notice-3", "notice-4"})
            finally:
                journal.close()


class FakeContext:
    def __init__(self):
        self.send_message = AsyncMock(return_value=True)

    def get_platform_inst(self, platform_id):
        if platform_id in {"fixture", "other"}:
            return types.SimpleNamespace(meta=lambda: types.SimpleNamespace(name="aiocqhttp"))
        return None


class NotificationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.directory.name)
        self.path_patch = patch.object(plugin.StarTools, "get_data_dir", return_value=self.data_dir)
        self.path_patch.start()
        self.bots = []

    async def asyncTearDown(self):
        for bot in self.bots:
            await bot.terminate()
        self.path_patch.stop()
        self.directory.cleanup()

    def new_bot(self, journal=True):
        config = {"mori_url": "http://127.0.0.1:4317", "bridge_secret": "local-notification-fixture", "notifications_enabled": True, "allowed_users": ["qq:7"], "allowed_sessions": [Event.unified_msg_origin]}
        bot = plugin.MoriPlugin(FakeContext(), config)
        if journal:
            bot._journal = plugin.NotificationJournal(self.data_dir / ("notifications-%d.sqlite3" % len(self.bots)))
        self.bots.append(bot)
        return bot

    def reply(self, claims):
        return {"notifications": claims, "serverTime": datetime.now(timezone.utc).isoformat()}

    async def test_success_commits_before_send_and_only_replays_ack(self):
        bot = self.new_bot()
        claim = notification_claim()
        acknowledgements = []
        fail_ack = True

        async def send(peer, chain):
            row = bot._journal.db.execute("SELECT state FROM deliveries").fetchone()
            self.assertEqual(row["state"], "dispatching")
            self.assertEqual(peer, Event.unified_msg_origin)
            self.assertEqual(chain.text, claim["text"])
            return True

        async def transport(action, platform, body):
            nonlocal fail_ack
            self.assertEqual(platform, "qq")
            self.assertEqual(body["peer"], Event.unified_msg_origin)
            if action == "poll":
                return self.reply([claim])
            acknowledgements.append(body)
            if fail_ack:
                fail_ack = False
                raise OSError("fixture connection failure")
            return {"ok": True}

        bot.context.send_message.side_effect = send
        with patch.object(bot, "_notification_request", side_effect=transport):
            self.assertFalse(await bot._notification_cycle("qq", Event.unified_msg_origin))
            self.assertEqual(bot._journal.db.execute("SELECT state,acked FROM deliveries").fetchone()["state"], "delivered")
            self.assertTrue(await bot._notification_cycle("qq", Event.unified_msg_origin))
        self.assertEqual(bot.context.send_message.await_count, 1)
        self.assertEqual(len(acknowledgements), 3)
        self.assertTrue(all(body["outcome"] == "delivered" for body in acknowledgements))
        self.assertEqual(bot._journal.db.execute("SELECT acked FROM deliveries").fetchone()[0], 1)

    async def test_restarted_unknown_is_acknowledged_without_resending(self):
        bot = self.new_bot()
        claim = notification_claim()
        bot._journal.begin("qq", Event.unified_msg_origin, claim)
        path = self.data_dir / "notifications-0.sqlite3"
        bot._journal.close()
        bot._journal = plugin.NotificationJournal(path)
        acknowledgements = []

        async def transport(action, platform, body):
            if action == "poll":
                return self.reply([claim])
            acknowledgements.append(body)
            return {"ok": True}

        with patch.object(bot, "_notification_request", side_effect=transport):
            self.assertTrue(await bot._notification_cycle("qq", Event.unified_msg_origin))
        bot.context.send_message.assert_not_awaited()
        self.assertTrue(acknowledgements)
        self.assertTrue(all(body["outcome"] == "unknown" for body in acknowledgements))

    async def test_obsolete_ack_survives_restart_and_does_not_block_replacement_claim(self):
        for status in (404, 409):
            with self.subTest(status=status):
                bot = self.new_bot()
                path = self.data_dir / ("notifications-%d.sqlite3" % (len(self.bots) - 1))
                old = notification_claim()
                replacement = {**old, "claimToken": "attempt-2"}
                bot._journal.begin("qq", Event.unified_msg_origin, old)
                bot._journal.finish(old["id"], old["claimToken"], "unknown")
                acknowledgements = []
                claims = [replacement]

                async def transport(action, platform, body):
                    if action == "poll":
                        return self.reply(claims)
                    acknowledgements.append(body["claimToken"])
                    if body["claimToken"] == old["claimToken"]:
                        raise plugin.BridgeHTTPError(status)
                    return {"ok": True}

                with patch.object(bot, "_notification_request", side_effect=transport):
                    self.assertTrue(await bot._notification_cycle("qq", Event.unified_msg_origin))
                    old_row = bot._journal.begin("qq", Event.unified_msg_origin, old)
                    self.assertEqual((old_row["state"], old_row["acked"], old_row["obsolete_status"]), ("unknown", 0, status))
                    self.assertEqual(bot.context.send_message.await_count, 1)
                    bot._journal.close()
                    bot._journal = plugin.NotificationJournal(path)
                    claims = [old, replacement]
                    self.assertTrue(await bot._notification_cycle("qq", Event.unified_msg_origin))
                self.assertEqual(bot.context.send_message.await_count, 1)
                self.assertEqual(acknowledgements.count(old["claimToken"]), 1)
                self.assertEqual(bot._journal.pending("qq", Event.unified_msg_origin), [])
                self.assertEqual(bot._journal.begin("qq", Event.unified_msg_origin, old)["obsolete_status"], status)
                replacement_row = bot._journal.begin("qq", Event.unified_msg_origin, replacement)
                self.assertEqual((replacement_row["state"], replacement_row["acked"]), ("delivered", 1))

    async def test_transient_http_ack_failure_remains_pending_for_replay(self):
        for status in (500, 503):
            with self.subTest(status=status):
                bot = self.new_bot()
                claim = notification_claim()
                bot._journal.begin("qq", Event.unified_msg_origin, claim)
                receipt = bot._journal.finish(claim["id"], claim["claimToken"], "delivered")
                with patch.object(bot, "_notification_request", side_effect=[plugin.BridgeHTTPError(status), {"ok": True}]):
                    self.assertFalse(await bot._ack_notification("qq", Event.unified_msg_origin, claim["id"], claim["claimToken"], "delivered", receipt))
                    row = bot._journal.pending("qq", Event.unified_msg_origin)[0]
                    self.assertEqual((row["state"], row["acked"], row["obsolete_status"]), ("delivered", 0, 0))
                    self.assertTrue(await bot._ack_notification("qq", Event.unified_msg_origin, claim["id"], claim["claimToken"], "delivered", receipt))
                self.assertEqual(bot._journal.pending("qq", Event.unified_msg_origin), [])
                bot.context.send_message.assert_not_awaited()

    async def test_boolean_results_and_send_errors_are_classified(self):
        for result, expected in [(False, "rejected"), (None, "unknown"), (TimeoutError("fixture"), "unknown"), (NotImplementedError("fixture"), "rejected")]:
            with self.subTest(expected=expected, result=type(result).__name__):
                bot = self.new_bot()
                claim = notification_claim()
                if isinstance(result, BaseException):
                    bot.context.send_message.side_effect = result
                else:
                    bot.context.send_message.return_value = result
                with patch.object(bot, "_ack_notification", new=AsyncMock(return_value=True)) as acknowledge:
                    self.assertTrue(await bot._deliver_notification("qq", Event.unified_msg_origin, claim, time.monotonic() + 120))
                self.assertEqual(acknowledge.await_args.args[4], expected)
                self.assertEqual(bot._journal.db.execute("SELECT state FROM deliveries").fetchone()[0], expected)

    async def test_expired_claim_never_reaches_context_send(self):
        bot = self.new_bot()
        claim = notification_claim(seconds=-1)
        with patch.object(bot, "_notification_request", side_effect=[self.reply([claim]), {"ok": True}]) as transport:
            self.assertTrue(await bot._notification_cycle("qq", Event.unified_msg_origin))
        bot.context.send_message.assert_not_awaited()
        self.assertEqual(transport.await_args.args[2]["outcome"], "rejected")

    async def test_batch_limit_and_server_destination_cannot_redirect_delivery(self):
        bot = self.new_bot()
        with patch.object(bot, "_notification_request", return_value=self.reply([notification_claim("notice-%d" % i) for i in range(11)])):
            with self.assertRaises(ValueError):
                await bot._notification_cycle("qq", Event.unified_msg_origin)
        bot.context.send_message.assert_not_awaited()
        claim = {**notification_claim(), "peer": "other:GroupMessage:999", "platform": "feishu"}
        with patch.object(bot, "_notification_request", return_value=self.reply([claim])):
            with self.assertRaises(ValueError):
                await bot._notification_cycle("qq", Event.unified_msg_origin)
        bot.context.send_message.assert_not_awaited()

    async def test_unlisted_or_wrong_platform_destination_never_reaches_http(self):
        bot = self.new_bot()
        with patch.object(plugin, "bridge_post", side_effect=AssertionError("Must not contact the bridge")) as request:
            for platform, peer in [("qq", "other:GroupMessage:999"), ("feishu", Event.unified_msg_origin)]:
                with self.subTest(platform=platform, peer=peer):
                    with self.assertRaises(ValueError):
                        await bot._notification_request("poll", platform, {"peer": peer, "nonce": "fixture-nonce"})
            request.assert_not_called()
        bot.context.send_message.assert_not_awaited()

    async def test_disabled_or_removed_session_during_poll_cannot_send(self):
        for change in [lambda config: config.update(notifications_enabled=False), lambda config: config.update(allowed_sessions=[])]:
            bot = self.new_bot()

            async def transport(action, platform, body):
                change(bot.config)
                return self.reply([notification_claim()])

            with patch.object(bot, "_notification_request", side_effect=transport):
                self.assertFalse(await bot._notification_cycle("qq", Event.unified_msg_origin))
            bot.context.send_message.assert_not_awaited()
            self.assertEqual(bot._journal.db.execute("SELECT COUNT(*) FROM deliveries").fetchone()[0], 0)

    async def test_terminate_during_send_marks_unknown_and_starts_no_more_sends(self):
        bot = self.new_bot()
        started = asyncio.Event()

        async def pending(peer, chain):
            started.set()
            await asyncio.Event().wait()

        bot.context.send_message.side_effect = pending
        with patch.object(bot, "_notification_request", return_value=self.reply([notification_claim(), notification_claim("notice-2")])) as transport:
            bot._notification_task = asyncio.create_task(bot._notification_cycle("qq", Event.unified_msg_origin))
            await started.wait()
            await bot.terminate()
            self.assertTrue(bot._notification_task.cancelled())
        self.assertEqual(bot.context.send_message.await_count, 1)
        self.assertEqual(transport.await_count, 1)
        journal = plugin.NotificationJournal(self.data_dir / "notifications-0.sqlite3")
        try:
            rows = journal.pending("qq", Event.unified_msg_origin)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["state"], "unknown")
        finally:
            journal.close()

    async def test_initialize_uses_plugin_data_once_and_default_is_disabled(self):
        bot = self.new_bot(journal=False)
        bot.config.pop("notifications_enabled")
        await bot.initialize()
        self.assertIsNone(bot._notification_task)
        self.assertFalse(list(self.data_dir.iterdir()))
        bot.config["notifications_enabled"] = True

        async def idle():
            await asyncio.Event().wait()

        with patch.object(bot, "_poll_notifications", side_effect=idle) as poller:
            await bot.initialize()
            task = bot._notification_task
            await bot.initialize()
            self.assertIs(bot._notification_task, task)
            await asyncio.sleep(0)
            self.assertEqual(poller.call_count, 1)
        self.assertTrue((self.data_dir / "notifications.sqlite3").is_file())

    async def test_round_robin_and_failure_backoff_are_bounded(self):
        bot = self.new_bot()
        bot.config["allowed_sessions"].append("other:FriendMessage:43")
        bot.config["allowed_sessions"].append(Event.unified_msg_origin)
        delays, peers = [], []

        async def cycle(platform, peer):
            peers.append(peer)
            return False

        async def sleep(delay):
            delays.append(delay)
            if len(delays) == 6:
                raise asyncio.CancelledError

        with patch.object(bot, "_notification_cycle", side_effect=cycle), patch.object(plugin.asyncio, "sleep", side_effect=sleep), patch.object(plugin.random, "uniform", return_value=0):
            with self.assertRaises(asyncio.CancelledError):
                await bot._poll_notifications()
        self.assertEqual(peers, [Event.unified_msg_origin, "other:FriendMessage:43"] * 3)
        self.assertEqual(delays, [10, 20, 40, 60, 60, 60])


if __name__ == "__main__":
    unittest.main()
