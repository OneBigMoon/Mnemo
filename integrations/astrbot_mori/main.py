"""AstrBot command adapter for Mori's authenticated bridge; Python 3.9+."""
import asyncio
import hashlib
import hmac
import http.client
import json
import logging
import random
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime
from urllib.parse import urlsplit

from astrbot.api import AstrBotConfig
from astrbot.api.event import AstrMessageEvent, MessageChain, filter
from astrbot.api.star import Context, Star, StarTools


PLATFORMS = {
    "aiocqhttp": "qq", "qq_official": "qq", "qq_official_webhook": "qq",
    "wecom": "wechat", "wecom_ai_bot": "wechat",
    "weixin_official_account": "wechat", "weixin_oc": "wechat",
    "lark": "feishu",
}

logger = logging.getLogger("astrbot.mori")


def signed_notification(action, platform, body, secret, timestamp=None):
    peer = body.get("peer")
    if platform not in {"qq", "wechat", "feishu"} or not secret:
        raise ValueError("Bridge configuration is incomplete")
    if not isinstance(peer, str) or not peer.strip() or len(peer) > 200 or re.search(r"[\x00-\x1f\x7f]", peer):
        raise ValueError("Invalid notification session")
    timestamp = str(int(time.time()) if timestamp is None else timestamp)
    if action == "poll" and set(body) == {"peer", "nonce"}:
        nonce = body["nonce"]
        if not isinstance(nonce, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", nonce):
            raise ValueError("Invalid poll nonce")
        canonical = ["notifications.poll", platform, timestamp, peer, nonce]
    elif action == "ack" and {"peer", "id", "claimToken", "outcome"} <= set(body) <= {"peer", "id", "claimToken", "outcome", "receipt"}:
        for key in ("id", "claimToken"):
            if not isinstance(body[key], str) or not body[key] or len(body[key]) > 256 or re.search(r"[\s\x00-\x1f\x7f]", body[key]):
                raise ValueError("Invalid notification identity")
        receipt = body.get("receipt", "")
        if body["outcome"] not in {"delivered", "unknown", "rejected"} or not isinstance(receipt, str) or len(receipt) > 512 or re.search(r"[\x00-\x1f\x7f]", receipt):
            raise ValueError("Invalid notification acknowledgement")
        canonical = ["notifications.ack", platform, timestamp, peer, body["id"], body["claimToken"], body["outcome"], receipt]
    else:
        raise ValueError("Invalid notification request")
    canonical = json.dumps(canonical, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    headers = {"Content-Type": "application/json", "X-Mori-Timestamp": timestamp, "X-Mori-Signature": hmac.new(secret.encode("utf-8"), canonical, hashlib.sha256).hexdigest()}
    return json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), headers


def notification_time(value):
    if not isinstance(value, str) or len(value) > 50:
        raise ValueError("Invalid notification time")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Notification time needs a timezone")
    return parsed.timestamp()


class BridgeHTTPError(ValueError):
    def __init__(self, status):
        super().__init__("Bridge HTTP %d" % status)
        self.status = status


class NotificationJournal:
    MAX_ROWS = 5500
    KEEP_RECEIPTS = 500

    def __init__(self, path):
        self.db = sqlite3.connect(path, timeout=5)
        self.db.row_factory = sqlite3.Row
        try:
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA synchronous=FULL")
            with self.db:
                self.db.execute("""CREATE TABLE IF NOT EXISTS deliveries (
                    id TEXT NOT NULL, claim_token TEXT NOT NULL,
                    platform TEXT NOT NULL, peer TEXT NOT NULL, expires_at REAL NOT NULL,
                    state TEXT NOT NULL, receipt TEXT NOT NULL DEFAULT '', acked INTEGER NOT NULL DEFAULT 0,
                    obsolete_status INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (id, claim_token))""")
                if not any(row[1] == "obsolete_status" for row in self.db.execute("PRAGMA table_info(deliveries)")):
                    self.db.execute("ALTER TABLE deliveries ADD COLUMN obsolete_status INTEGER NOT NULL DEFAULT 0")
                self.db.execute("UPDATE deliveries SET state='unknown', receipt='astrbot:interrupted' WHERE state='dispatching'")
        except BaseException:
            self.db.close()
            raise

    def has_room(self, count=10):
        # Settled or obsolete expired attempts cannot be polled again; keep recent receipts too.
        with self.db:
            self.db.execute("""DELETE FROM deliveries WHERE rowid IN (
                SELECT rowid FROM deliveries WHERE (acked=1 OR obsolete_status!=0) AND expires_at < ?
                ORDER BY rowid DESC LIMIT -1 OFFSET ?)""", (time.time() - 300, self.KEEP_RECEIPTS))
        return self.db.execute("SELECT COUNT(*) FROM deliveries").fetchone()[0] + count <= self.MAX_ROWS

    def begin(self, platform, peer, claim):
        row = self.db.execute("SELECT * FROM deliveries WHERE id=? AND claim_token=?", (claim["id"], claim["claimToken"])).fetchone()
        if row:
            if row["platform"] != platform or row["peer"] != peer:
                raise ValueError("Notification destination changed")
            return row
        if not self.has_room(1):
            raise ValueError("Notification journal capacity reached")
        with self.db:
            self.db.execute("INSERT INTO deliveries (id,claim_token,platform,peer,expires_at,state) VALUES (?,?,?,?,?,'dispatching')", (claim["id"], claim["claimToken"], platform, peer, notification_time(claim["expiresAt"])))
        return None

    def finish(self, notification_id, claim_token, state):
        receipt = "astrbot:send_message:" + state
        with self.db:
            self.db.execute("UPDATE deliveries SET state=?, receipt=? WHERE id=? AND claim_token=?", (state, receipt, notification_id, claim_token))
        return receipt

    def pending(self, platform, peer):
        return self.db.execute("SELECT * FROM deliveries WHERE platform=? AND peer=? AND acked=0 AND obsolete_status=0 AND state!='dispatching' ORDER BY rowid LIMIT 10", (platform, peer)).fetchall()

    def acknowledged(self, notification_id, claim_token):
        with self.db:
            self.db.execute("UPDATE deliveries SET acked=1 WHERE id=? AND claim_token=?", (notification_id, claim_token))

    def obsolete(self, notification_id, claim_token, status):
        with self.db:
            self.db.execute("UPDATE deliveries SET obsolete_status=? WHERE id=? AND claim_token=?", (status, notification_id, claim_token))

    def close(self):
        self.db.close()


def signed_message(platform, peer, message_id, text, secret, timestamp=None):
    if platform not in {"qq", "wechat", "feishu"} or not secret:
        raise ValueError("Bridge configuration is incomplete")
    if not isinstance(peer, str) or not peer.strip() or len(peer) > 200 or re.search(r"[\x00-\x1f\x7f]", peer):
        raise ValueError("Invalid session")
    if not message_id or not isinstance(text, str) or not text.strip() or len(text) > 4000:
        raise ValueError("Invalid message")
    event_id = hashlib.sha256(json.dumps([platform, peer, str(message_id)], ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    timestamp = str(int(time.time()) if timestamp is None else timestamp)
    body = {"eventId": event_id, "peer": peer, "text": text}
    canonical = json.dumps([platform, timestamp, event_id, peer, text], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    headers = {"Content-Type": "application/json", "X-Mori-Timestamp": timestamp, "X-Mori-Signature": hmac.new(secret.encode("utf-8"), canonical, hashlib.sha256).hexdigest()}
    return json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), headers


def bridge_post(base_url, platform, payload, headers, action=None):
    target = urlsplit(base_url)
    if target.scheme not in ("http", "https") or not target.hostname or target.username or target.password or target.query or target.fragment:
        raise ValueError("Invalid Mori URL")
    connection_type = http.client.HTTPSConnection if target.scheme == "https" else http.client.HTTPConnection
    connection = connection_type(target.hostname, target.port, timeout=10)
    deadline = time.monotonic() + 18
    try:
        path = target.path.rstrip("/") + "/api/channels/bridge/" + platform
        if action is not None:
            if action not in {"poll", "ack"}:
                raise ValueError("Invalid notification action")
            path += "/notifications/" + action
        connection.request("POST", path, payload, headers)
        sock = connection.sock
        if sock:
            sock.settimeout(max(0.1, deadline - time.monotonic()))
        response = connection.getresponse()
        if response.status != 200:
            # Never expose the server's error body or retry a possibly executed command.
            raise BridgeHTTPError(response.status)
        chunks, size = [], 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Bridge deadline exceeded")
            if sock:
                sock.settimeout(remaining)
            chunk = response.read1(8192)
            if not chunk:
                break
            size += len(chunk)
            if size > 256 * 1024:
                raise ValueError("Bridge response too large")
            chunks.append(chunk)
        reply = json.loads(b"".join(chunks))
        if not isinstance(reply, dict) or (action is None and not isinstance(reply.get("text"), str)):
            raise ValueError("Invalid bridge response")
        return reply
    finally:
        connection.close()


def reply_text(reply):
    text = reply["text"][:4000]
    results = reply.get("results")
    if isinstance(results, list) and results:
        lines = []
        for item in results[:5]:
            if not isinstance(item, dict):
                continue
            title = str(item.get("title", "资源"))[:150]
            url = str(item.get("url", ""))[:1200]
            lines.append("%s\n%s" % (title, url))
        text += "\n\n" + "\n\n".join(lines) + "\n\n请在 Mori 界面选择资源；下载需明确发送 /mori 下载 HTTP(S)直链。"
    return text[:10000]


class MoriPlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.context = context
        self.config = config
        self._limit = asyncio.Semaphore(2)
        self._threads = threading.BoundedSemaphore(2)
        self._pending = 0
        self._running = set()
        self._closed = False
        self._notification_task = None
        self._journal = None

    async def initialize(self):
        if self._closed or self._notification_task is not None or self.config.get("notifications_enabled") is not True:
            return
        sessions = self.config.get("allowed_sessions", [])
        if not isinstance(sessions, list) or not sessions or len(sessions) > 128 or not self.config.get("bridge_secret"):
            logger.warning("Mori notifications require a signing key and 1–128 explicitly authorized sessions")
            return
        self._journal = NotificationJournal(StarTools.get_data_dir() / "notifications.sqlite3")
        self._notification_task = asyncio.create_task(self._poll_notifications())

    def _notification_platform(self, peer):
        sessions = self.config.get("allowed_sessions", [])
        if self._closed or self.config.get("notifications_enabled") is not True or not isinstance(sessions, list) or len(sessions) > 128 or peer not in sessions:
            return None
        if not isinstance(peer, str) or len(peer) > 200 or re.search(r"[\x00-\x1f\x7f]", peer):
            return None
        parts = peer.split(":", 2)
        if len(parts) != 3 or not all(parts) or parts[1] not in {"GroupMessage", "FriendMessage", "OtherMessage"}:
            return None
        adapter = self.context.get_platform_inst(parts[0])
        if adapter is None:
            return None
        platform = self.config.get("platform", "auto")
        if platform == "auto":
            platform = PLATFORMS.get(adapter.meta().name)
        return platform if platform in {"qq", "wechat", "feishu"} else None

    def _notification_request_sync(self, action, platform, body):
        if not self._threads.acquire(blocking=False):
            raise ValueError("Bridge workers busy")
        try:
            sessions = self.config.get("allowed_sessions", [])
            if self._closed or self.config.get("notifications_enabled") is not True or not isinstance(sessions, list) or body["peer"] not in sessions:
                raise ValueError("Notification session no longer authorized")
            payload, headers = signed_notification(action, platform, body, str(self.config.get("bridge_secret", "")))
            return bridge_post(str(self.config.get("mori_url", "")), platform, payload, headers, action)
        finally:
            self._threads.release()

    async def _notification_request(self, action, platform, body):
        async with self._limit:
            if self._notification_platform(body["peer"]) != platform:
                raise ValueError("Notification session no longer authorized")
            return await asyncio.wait_for(asyncio.to_thread(self._notification_request_sync, action, platform, body), timeout=20)

    async def _ack_notification(self, platform, peer, notification_id, claim_token, outcome, receipt):
        if self._notification_platform(peer) != platform:
            return False
        body = {"peer": peer, "id": notification_id, "claimToken": claim_token, "outcome": outcome, "receipt": receipt}
        try:
            reply = await self._notification_request("ack", platform, body)
            if reply.get("ok") is not True:
                raise ValueError("Invalid acknowledgement response")
            self._journal.acknowledged(notification_id, claim_token)
            return True
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if isinstance(exc, BridgeHTTPError) and exc.status in {404, 409}:
                self._journal.obsolete(notification_id, claim_token, exc.status)
                logger.warning("Mori notification attempt for %s is obsolete (HTTP %d); manual reconciliation required", notification_id, exc.status)
                return True
            logger.warning("Mori notification ack failed for %s (%s)", notification_id, type(exc).__name__)
            return False

    async def _deliver_notification(self, platform, peer, claim, deadline):
        if self._notification_platform(peer) != platform:
            return False
        existing = self._journal.begin(platform, peer, claim)
        if existing:
            if existing["obsolete_status"]:
                return True
            state = existing["state"]
            if state == "dispatching":
                state = "unknown"
                receipt = self._journal.finish(claim["id"], claim["claimToken"], state)
            else:
                receipt = existing["receipt"]
            return await self._ack_notification(platform, peer, claim["id"], claim["claimToken"], state, receipt)

        started = False

        async def send():
            nonlocal started
            if self._notification_platform(peer) != platform or time.monotonic() >= deadline:
                return False
            started = True
            return await self.context.send_message(peer, MessageChain().message(claim["text"]))

        try:
            result = await asyncio.wait_for(send(), timeout=20)
            state = "delivered" if result is True else "rejected" if result is False else "unknown"
        except asyncio.CancelledError:
            self._journal.finish(claim["id"], claim["claimToken"], "unknown" if started else "rejected")
            raise
        except NotImplementedError:
            state = "rejected"
        except Exception as exc:
            state = "unknown" if started else "rejected"
            logger.warning("Mori notification send failed for %s (%s)", claim["id"], type(exc).__name__)
        receipt = self._journal.finish(claim["id"], claim["claimToken"], state)
        return await self._ack_notification(platform, peer, claim["id"], claim["claimToken"], state, receipt)

    async def _notification_cycle(self, platform, peer):
        for row in self._journal.pending(platform, peer):
            if not await self._ack_notification(platform, peer, row["id"], row["claim_token"], row["state"], row["receipt"]):
                return False
        if not self._journal.has_room():
            logger.error("Mori notification journal is full; claiming paused until acknowledgements are reconciled")
            return False
        poll_started = time.monotonic()
        reply = await self._notification_request("poll", platform, {"peer": peer, "nonce": secrets.token_hex(16)})
        server_time = notification_time(reply.get("serverTime"))
        claims = reply.get("notifications")
        if not isinstance(claims, list) or len(claims) > 10:
            raise ValueError("Invalid notification batch")
        for claim in claims:
            if not isinstance(claim, dict) or set(claim) != {"id", "taskId", "text", "claimToken", "expiresAt"}:
                raise ValueError("Invalid notification claim fields")
            if not isinstance(claim.get("text"), str) or not claim["text"].strip() or len(claim["text"]) > 4000:
                raise ValueError("Invalid notification text")
            for key in ("id", "taskId", "claimToken"):
                value = claim.get(key)
                if not isinstance(value, str) or not value or len(value) > 256 or re.search(r"[\s\x00-\x1f\x7f]", value):
                    raise ValueError("Invalid notification identity")
            notification_time(claim.get("expiresAt"))
        success = True
        for claim in claims:
            if self._notification_platform(peer) != platform:
                return False
            # Anchor the lease before HTTP so network latency cannot extend a claim.
            deadline = poll_started + min(120, notification_time(claim["expiresAt"]) - server_time)
            success = await self._deliver_notification(platform, peer, claim, deadline) and success
        return success

    async def _poll_notifications(self):
        index, failures = 0, 0
        while not self._closed and self.config.get("notifications_enabled") is True:
            try:
                sessions = self.config.get("allowed_sessions", [])
                destinations = [(self._notification_platform(peer), peer) for peer in sessions] if isinstance(sessions, list) and len(sessions) <= 128 else []
                destinations = list(dict.fromkeys((platform, peer) for platform, peer in destinations if platform))
                success = True
                if destinations:
                    platform, peer = destinations[index % len(destinations)]
                    index = (index + 1) % len(destinations)
                    success = await self._notification_cycle(platform, peer)
                failures = 0 if success else min(failures + 1, 4)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                failures = min(failures + 1, 4)
                logger.warning("Mori notification polling failed (%s)", type(exc).__name__)
            await asyncio.sleep(min(60, 5 * 2 ** failures) + random.uniform(0, 1))

    def _request(self, platform, peer, message_id, text):
        if not self._threads.acquire(blocking=False):
            raise ValueError("Bridge workers busy")
        try:
            if self._closed:
                raise ValueError("Plugin stopped")
            payload, headers = signed_message(platform, peer, message_id, text, str(self.config.get("bridge_secret", "")))
            return bridge_post(str(self.config.get("mori_url", "")), platform, payload, headers)
        finally:
            self._threads.release()

    @filter.command("mori")
    async def mori(self, event: AstrMessageEvent):
        """/mori 搜索片名、订阅剧集、查询任务或提交明确的下载直链。"""
        platform = self.config.get("platform", "auto")
        if platform == "auto":
            platform = PLATFORMS.get(event.get_platform_name())
        sender = str(event.get_sender_id())
        peer = event.unified_msg_origin
        users, sessions = self.config.get("allowed_users", []), self.config.get("allowed_sessions", [])
        if self._closed or platform not in {"qq", "wechat", "feishu"} or not isinstance(users, list) or not isinstance(sessions, list) or "%s:%s" % (platform, sender) not in users or peer not in sessions:
            return
        event.stop_event()
        match = re.match(r"^/?mori(?:\s+|$)(.*)$", event.message_str.strip(), re.DOTALL)
        text = match.group(1).strip() if match else ""
        if not text or len(text) > 4000:
            yield event.plain_result("用法：/mori 搜索 沙丘；/mori 订阅 三体；/mori 任务状态；/mori 下载 HTTP(S)直链。消息最多 4000 字。")
            return
        if self._pending >= 8:
            yield event.plain_result("Mori 正忙，请稍后再试。尚未提交本次操作。")
            return
        task = asyncio.current_task()
        self._running.add(task)
        self._pending += 1
        try:
            async with self._limit:
                if self._closed:
                    return
                try:
                    message_id = getattr(event.message_obj, "message_id", None)
                    reply = await asyncio.wait_for(asyncio.to_thread(self._request, platform, peer, message_id, text), timeout=20)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    if not self._closed:
                        yield event.plain_result("Mori 请求未确认，请检查连接、签名密钥和授权。请先在 Mori 核对任务，勿重复提交下载或订阅。")
                    return
                if not self._closed:
                    formatted = reply_text(reply)
                    for start in range(0, len(formatted), 2500):
                        if self._closed:
                            return
                        yield event.plain_result(formatted[start:start + 2500])
        finally:
            self._pending -= 1
            self._running.discard(task)

    async def terminate(self):
        self._closed = True
        tasks = [task for task in self._running if task is not asyncio.current_task()]
        if self._notification_task is not None and self._notification_task is not asyncio.current_task():
            tasks.append(self._notification_task)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if self._journal is not None:
            self._journal.close()
            self._journal = None
