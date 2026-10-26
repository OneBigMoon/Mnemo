#!/usr/bin/env python3
"""Manual isolated acceptance: real public HTTPS source -> Mori download -> fresh Jellyfin scan/playback.

Host mode owns Docker objects, independently downloads the source, runs the in-network driver,
and decodes the Jellyfin-served file with ffmpeg. Inside mode performs only HTTP/file checks.
Never uses real accounts, remote metadata providers, or private credentials.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import socket
import stat as stat_mode
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

PROJECT = Path(__file__).resolve().parent.parent
JELLYFIN_IMAGE = 'jellyfin/jellyfin@sha256:7ae36aab93ef9b6aaff02b37f8bb23df84bb2d7a3f6054ec8fc466072a648ce2'
DRIVER_IMAGE = 'python:3.12-slim-bookworm'
MORI_IMAGE = os.environ.get('MORI_JELLYFIN_REAL_IMAGE', 'mori-media-agent:jellyfin-nonroot-20261025')
SOURCE_URL = os.environ.get('MORI_REAL_SOURCE_URL', 'https://media.w3.org/2010/05/sintel/trailer.mp4')
TITLE = 'Sintel Trailer'
YEAR = 2010
DISPLAY_TITLE = '{} ({})'.format(TITLE, YEAR)
ROOT_PREFIX = 'mori-jellyfin-real-'
JELLYFIN_UID = 1001
JELLYFIN_GID = 1001
EVIDENCE = PROJECT / 'docs/evidence/jellyfin-nonroot-real-source-20261025.json'
FRAME_EVIDENCE = PROJECT / 'docs/evidence/jellyfin-nonroot-real-source-frame-20261025.png'
LOCAL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def safe_headers(headers):
    keys = ['Date', 'Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag',
            'Last-Modified', 'Server', 'Cache-Control', 'Age']
    return {key: headers.get(key) for key in keys if headers.get(key) is not None}


def local_json(url, method='GET', headers=None, body=None, timeout=30):
    outgoing = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        outgoing.setdefault('Content-Type', 'application/json')
    request = urllib.request.Request(url, data=data, method=method, headers=outgoing)
    with LOCAL_OPENER.open(request, timeout=timeout) as response:
        payload = response.read()
        return response.status, response.headers, json.loads(payload) if payload else None


class Jellyfin:
    def __init__(self, base):
        self.base = base.rstrip('/')
        self.device = uuid.uuid4().hex
        self.token = None
        self.user = None

    def call(self, method, route, params=None, body=None, timeout=30, auth=True):
        url = self.base + route
        if params:
            url += '?' + urllib.parse.urlencode(params)
        headers = {
            'Accept': 'application/json',
            'X-Emby-Authorization': 'MediaBrowser Client="mori-real-acceptance", Device="fixture", DeviceId="{}", Version="1"'.format(self.device),
        }
        if auth and self.token:
            headers['X-Emby-Token'] = self.token
        outgoing = body
        if body is not None:
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(url, data=None if outgoing is None else json.dumps(outgoing).encode(),
                                         method=method, headers=headers)
        try:
            with LOCAL_OPENER.open(request, timeout=timeout) as response:
                payload = response.read()
                return response.status, response.headers, json.loads(payload) if payload else None
        except urllib.error.HTTPError as error:
            detail = error.read(2048).decode(errors='replace')
            for secret in [self.token]:
                if secret:
                    detail = detail.replace(secret, '[redacted]')
            raise RuntimeError('Jellyfin {} {}: HTTP {}: {}'.format(method, route, error.code, detail[:400])) from None

    def wait_ready(self, seconds=180):
        deadline = time.monotonic() + seconds
        while True:
            try:
                _, _, info = self.call('GET', '/System/Info/Public', auth=False)
                return info
            except (OSError, RuntimeError):
                if time.monotonic() >= deadline:
                    raise RuntimeError('fresh Jellyfin did not become ready')
                time.sleep(0.5)

    def bootstrap(self):
        info = self.wait_ready()
        name = 'mori' + secrets.token_hex(3)
        password = secrets.token_urlsafe(24)
        self.call('POST', '/Startup/Configuration', body={
            'UICulture': 'en-US', 'MetadataCountryCode': 'US', 'PreferredMetadataLanguage': 'en'}, auth=False)
        self.call('GET', '/Startup/User', auth=False)
        self.call('POST', '/Startup/User', body={'Name': name, 'Password': password}, auth=False)
        self.call('POST', '/Startup/Complete', body={}, auth=False)
        identity = None
        for attempt in range(20):
            try:
                _, _, identity = self.call('POST', '/Users/AuthenticateByName',
                                           body={'Username': name, 'Pw': password}, auth=False)
                break
            except RuntimeError:
                if attempt == 19:
                    raise
                time.sleep(0.5)
        self.token = identity['AccessToken']
        self.user = identity['User']['Id']
        library = 'Mori Real Source Movies'
        options = {'EnableRealtimeMonitor': False, 'ImportCollections': False,
                   'TypeOptions': [{'Type': 'Movie', 'MetadataFetchers': [], 'ImageFetchers': []}]}
        query = urllib.parse.urlencode({'name': library, 'collectionType': 'movies',
                                        'paths': '/library', 'refreshLibrary': 'false'})
        self.call('POST', '/Library/VirtualFolders?' + query, body={'LibraryOptions': options})
        _, _, folders = self.call('GET', '/Library/VirtualFolders')
        items = folders if isinstance(folders, list) else folders.get('Items', [])
        selected = next((item for item in items if item.get('Name') == library), None)
        if not selected:
            raise RuntimeError('fresh Jellyfin did not retain the movie library')
        actual_type = selected.get('CollectionType') or selected.get('LibraryOptions', {}).get('CollectionType')
        if actual_type != 'movies' or '/library' not in selected.get('Locations', []):
            raise RuntimeError('fresh Jellyfin library configuration mismatch')
        return {
            'version': info.get('Version'),
            'serverName': info.get('ServerName'),
            'library': {'name': library, 'collectionType': actual_type,
                        'locations': selected.get('Locations'),
                        'metadataFetchersDisabled': True},
            'outboundNetwork': 'Jellyfin is attached only to a Docker internal network',
        }

    def refresh(self):
        self.call('POST', '/Library/Refresh')

    def items(self):
        _, _, data = self.call('GET', '/Items', params={
            'Recursive': 'true', 'IncludeItemTypes': 'Movie',
            'Fields': 'Path,MediaSources,ProductionYear,RunTimeTicks,ProviderIds',
            'UserId': self.user or '',
        })
        return data.get('Items', []) if isinstance(data, dict) else []

    def stream(self, item_id, destination, range_header=None):
        url = self.base + '/Videos/{}/stream.mp4?Static=true'.format(urllib.parse.quote(item_id))
        headers = {'X-Emby-Token': self.token, 'Accept-Encoding': 'identity'}
        if range_header:
            headers['Range'] = range_header
        request = urllib.request.Request(url, headers=headers)
        digest = hashlib.sha256()
        total = 0
        with LOCAL_OPENER.open(request, timeout=180) as response:
            status = response.status
            metadata = safe_headers(response.headers)
            if destination:
                handle = open(destination, 'wb')
            else:
                handle = None
            try:
                for chunk in iter(lambda: response.read(1024 * 1024), b''):
                    total += len(chunk)
                    digest.update(chunk)
                    if handle:
                        handle.write(chunk)
            finally:
                if handle:
                    handle.close()
        return {'status': status, 'bytes': total, 'sha256': digest.hexdigest(), 'headers': metadata}


class Mori:
    def __init__(self, base):
        self.base = base.rstrip('/')
        self.cookie = ''

    def call(self, method, route, body=None, timeout=40, auth=True):
        headers = {}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        if auth and self.cookie:
            headers['Cookie'] = self.cookie
        request = urllib.request.Request(self.base + route, data=None if body is None else json.dumps(body).encode(),
                                         method=method, headers=headers)
        try:
            with LOCAL_OPENER.open(request, timeout=timeout) as response:
                payload = response.read()
                return response.status, response.headers, json.loads(payload) if payload else None
        except urllib.error.HTTPError as error:
            detail = error.read(2048).decode(errors='replace')
            raise RuntimeError('Mori {} {}: HTTP {}: {}'.format(method, route, error.code, detail[:400])) from None

    def wait_ready(self, seconds=120):
        deadline = time.monotonic() + seconds
        while True:
            try:
                self.call('GET', '/api/health', auth=False)
                return
            except (OSError, RuntimeError):
                if time.monotonic() >= deadline:
                    raise RuntimeError('Mori did not become ready')
                time.sleep(0.5)

    def setup(self, password, setup_token):
        _, headers, _ = self.call('POST', '/api/setup', body={'password': password, 'setupToken': setup_token}, auth=False)
        cookie = headers.get('Set-Cookie', '').split(';', 1)[0]
        if not cookie.startswith('mori_session='):
            raise RuntimeError('Mori setup did not issue a session cookie')
        self.cookie = cookie
        self.call('POST', '/api/login', body={'password': password}, auth=False)
        return {'initialized': True, 'loginVerified': True}


def expected_path(root, rel):
    if not rel.parts or any(part in ('', '.', '..') for part in rel.parts):
        raise RuntimeError('unsafe downloaded path')
    return root / 'library' / Path(*rel.parts)


def wait_items(jellyfin, expected_file, expected_size, timeout=120):
    deadline = time.monotonic() + timeout
    refreshed_again = False
    last_count = 0
    while time.monotonic() < deadline:
        items = jellyfin.items()
        last_count = len(items)
        for item in items:
            if item.get('Path') != expected_file:
                continue
            sources = item.get('MediaSources') or []
            ready = any(
                source.get('Size') == expected_size
                and isinstance(source.get('RunTimeTicks'), (int, float))
                and source.get('RunTimeTicks') > 0
                and any(stream.get('Type') == 'Video' and re.match(r'^[a-zA-Z0-9_.+-]{1,64}$', str(stream.get('Codec') or ''))
                        for stream in (source.get('MediaStreams') or []))
                for source in sources
            )
            if ready:
                return item, items
        if not refreshed_again and time.monotonic() > deadline - timeout / 2:
            jellyfin.refresh()
            refreshed_again = True
        time.sleep(1)
    raise RuntimeError('Jellyfin did not expose a playable movie item for the downloaded file (saw {} items)'.format(last_count))


def inside(argv):
    root = Path(argv[2]).resolve()
    jellyfin_name, mori_name, run_id = argv[3], argv[4], argv[5]
    if not re.match(r'^mori-jellyfin-real-[a-zA-Z0-9]+$', root.name):
        raise RuntimeError('unexpected fixture root')
    if not re.match(r'^[a-z0-9-]+$', run_id):
        raise RuntimeError('unexpected run id')
    input_file = root / 'driver-input.json'
    settings = json.loads(input_file.read_text())
    input_file.unlink()
    setup_token = settings['setupToken']
    source_url = settings['sourceUrl']
    title, year = settings['title'], settings['year']
    (root / 'mori.env').unlink(missing_ok=True)
    display = '{} ({})'.format(title, year)
    reference = root / 'reference.mp4'
    reference_size = reference.stat().st_size
    reference_sha = sha256_file(reference)
    stage = 'bootstrap Jellyfin'
    receipt = {
        'schemaVersion': 1, 'status': 'running', 'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'runId': run_id, 'source': {'url': source_url, 'referenceBytes': reference_size, 'referenceSha256': reference_sha},
        'credentials': 'ephemeral random credentials generated inside this fixture; never written to disk outside the run root',
        'profile': 'jellyfin', 'scope': {
            'download': 'native Mori downloader over real public HTTPS',
            'metadata': 'Mori NFO only; TMDB key blank; Jellyfin remote metadata fetchers disabled',
            'library': 'fresh real Jellyfin as non-root UID 1001, internal Docker network, shared bind-mounted library',
            'identityAndSearch': 'not exercised in this run: task created through POST /api/tasks',
            'accounts': 'no real accounts',
        },
    }
    jellyfin_ip = socket.gethostbyname(jellyfin_name)
    mori_ip = socket.gethostbyname(mori_name)
    jellyfin = Jellyfin('http://{}:8096'.format(jellyfin_ip))
    mori = Mori('http://{}:4180'.format(mori_ip))
    receipt['addressing'] = {
        'jellyfin': jellyfin_ip, 'mori': mori_ip,
        'reason': 'Mori authorizes IP Host headers only; the driver targets internal container IPs',
    }
    try:
        jellyfin_info = jellyfin.bootstrap()
        receipt['jellyfin'] = jellyfin_info
        stage = 'setup Mori'
        mori.wait_ready()
        password = secrets.token_urlsafe(24)
        receipt['mori'] = mori.setup(password, setup_token)
        stage = 'configure Mori library'
        mori.call('PUT', '/api/config', body={
            'defaultTitleAction': 'download',
            'download': {'directory': '/downloads', 'concurrency': 1, 'aria2Url': '', 'aria2Secret': ''},
            'library': {
                'profile': 'jellyfin', 'language': 'zh-CN', 'rename': True, 'artwork': False,
                'serverUrl': jellyfin.base, 'serverToken': jellyfin.token,
                'pathFrom': '/downloads', 'pathTo': '/library', 'userId': jellyfin.user,
            },
        })
        stage = 'create direct download task'
        started = time.monotonic()
        status, _, created = mori.call('POST', '/api/tasks', body={
            'title': display, 'url': source_url, 'kind': 'direct',
            'media': {'type': 'movie', 'title': title, 'year': year},
        })
        if status != 201:
            raise RuntimeError('Mori did not create the task')
        task_id = created['task']['id']
        samples = []
        task = None
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline:
            _, _, listing = mori.call('GET', '/api/tasks')
            task = next((item for item in listing.get('tasks', []) if item.get('id') == task_id), None)
            if not task:
                raise RuntimeError('created task disappeared')
            if len(samples) < 40:
                samples.append({'atMs': int((time.monotonic() - started) * 1000), 'status': task.get('status'),
                                'bytes': task.get('bytes', 0), 'total': task.get('total')})
            if task.get('status') in ('failed', 'cancelled', 'paused', 'needs_attention'):
                raise RuntimeError('Mori download ended in status {}'.format(task.get('status')))
            if task.get('status') == 'completed':
                break
            time.sleep(0.25)
        else:
            raise RuntimeError('Mori download did not complete in time')
        elapsed_ms = int((time.monotonic() - started) * 1000)
        task_path = str(task.get('path') or '')
        prefix = '/downloads/'
        if not task_path.startswith(prefix):
            raise RuntimeError('completed task path is outside /downloads')
        rel = PurePosixPath(task_path[len(prefix):])
        local_file = expected_path(root, rel)
        stat = local_file.stat()
        if not local_file.is_file() or local_file.is_symlink() or stat.st_size != reference_size:
            raise RuntimeError('downloaded artifact size or type mismatch')
        media_mode = stat_mode.S_IMODE(stat.st_mode)
        directory_mode = stat_mode.S_IMODE(local_file.parent.stat().st_mode)
        if media_mode != 0o644 or directory_mode & 0o005 != 0o005:
            raise RuntimeError('published media is not cross-UID readable: file {:o}, directory {:o}'.format(
                media_mode, directory_mode))
        artifact_sha = sha256_file(local_file)
        if artifact_sha != reference_sha:
            raise RuntimeError('downloaded artifact bytes differ from the independent reference')
        leftovers = [p.name for p in (root / 'library').rglob('.mori-*')]
        if leftovers:
            raise RuntimeError('downloader temporary files remain: {}'.format(leftovers))
        nfo_path = local_file.with_suffix('.nfo')
        nfo_mode = stat_mode.S_IMODE(nfo_path.stat().st_mode)
        if nfo_mode != 0o644:
            raise RuntimeError('published NFO is not cross-UID readable: {:o}'.format(nfo_mode))
        nfo_text = nfo_path.read_text()
        nfo_title = re.search(r'<title>([^<]*)</title>', nfo_text)
        nfo_year = re.search(r'<year>(\d+)</year>', nfo_text)
        if not nfo_title or nfo_title.group(1) != title or not nfo_year or int(nfo_year.group(1)) != year:
            raise RuntimeError('generated NFO does not preserve the confirmed title and year')
        if 'type="tmdb"' in nfo_text:
            raise RuntimeError('generated NFO invented a TMDB identity')
        receipt['download'] = {
            'taskId': task_id, 'status': task.get('status'), 'elapsedMs': elapsed_ms,
            'path': task_path, 'downloadRoot': task.get('downloadRoot'),
            'bytes': stat.st_size, 'sha256': artifact_sha, 'matchesReference': True,
            'mediaMode': '{:04o}'.format(media_mode), 'directoryMode': '{:04o}'.format(directory_mode),
            'samples': samples, 'temporaryFilesRemaining': leftovers,
        }
        receipt['nfo'] = {'file': str(nfo_path.relative_to(root)), 'bytes': nfo_path.stat().st_size,
                          'mode': '{:04o}'.format(nfo_mode), 'sha256': sha256_file(nfo_path),
                          'title': nfo_title.group(1), 'year': int(nfo_year.group(1))}
        stage = 'wait for Jellyfin scan'
        expected_server_path = '/library/' + rel.as_posix()
        jellyfin.refresh()
        item, all_items = wait_items(jellyfin, expected_server_path, stat.st_size)
        if item.get('Type') != 'Movie':
            raise RuntimeError('Jellyfin did not classify the file as a Movie')
        if item.get('ProductionYear') != year:
            raise RuntimeError('Jellyfin did not resolve the confirmed year')
        if item.get('Name') not in (title, display):
            raise RuntimeError('Jellyfin title does not match the confirmed title')
        sources = item.get('MediaSources') or []
        source = next(source for source in sources if source.get('Path') == expected_server_path)
        streams = source.get('MediaStreams') or []
        video = next(stream for stream in streams if stream.get('Type') == 'Video')
        receipt['jellyfin']['item'] = {
            'id': item.get('Id'), 'name': item.get('Name'), 'type': item.get('Type'),
            'productionYear': item.get('ProductionYear'), 'path': item.get('Path'),
            'runTimeTicks': source.get('RunTimeTicks'), 'size': source.get('Size'),
            'protocol': source.get('Protocol'), 'container': source.get('Container'),
            'videoCodec': video.get('Codec'), 'width': video.get('Width'), 'height': video.get('Height'),
            'supportsDirectPlay': source.get('SupportsDirectPlay'),
            'supportsDirectStream': source.get('SupportsDirectStream'),
            'supportsTranscoding': source.get('SupportsTranscoding'),
            'visibleItems': len(all_items),
        }
        stage = 'verify Mori library integration against real Jellyfin'
        attempts = 0
        library = None
        for attempts in range(1, 6):
            _, _, verified = mori.call('POST', '/api/tasks/{}/library'.format(task_id), timeout=40)
            library = verified.get('task', {}).get('library') or {}
            if library.get('status') in ('verified', 'failed'):
                break
            time.sleep(2)
        if library.get('status') != 'verified' or library.get('playable') is not True:
            raise RuntimeError('Mori library verification did not pass: {}'.format(library.get('status')))
        if library.get('serverPath') != expected_server_path or library.get('itemId') != item.get('Id'):
            raise RuntimeError('Mori library verification returned a different item')
        receipt['library'] = {'syncAttempts': attempts, 'status': library.get('status'),
                              'playable': library.get('playable'), 'itemId': library.get('itemId'),
                              'serverPath': library.get('serverPath'), 'message': library.get('message')}
        stage = 'stream Jellyfin item'
        served = root / 'served.mp4'
        full = jellyfin.stream(item['Id'], served)
        if full['status'] != 200 or full['bytes'] != reference_size or full['sha256'] != reference_sha:
            raise RuntimeError('Jellyfin full stream did not match the real source bytes')
        ranged = jellyfin.stream(item['Id'], None, range_header='bytes=0-1023')
        if ranged['status'] != 206 or ranged['bytes'] != 1024:
            raise RuntimeError('Jellyfin range stream did not return 206 with 1024 bytes')
        if ranged['sha256'] != hashlib.sha256(reference.read_bytes()[:1024]).hexdigest():
            raise RuntimeError('Jellyfin range stream bytes differ from the reference')
        content_range = ranged['headers'].get('Content-Range')
        if content_range != 'bytes 0-1023/{}'.format(reference_size):
            raise RuntimeError('Jellyfin range Content-Range mismatch: {}'.format(content_range))
        stage = 'stream Mori task'
        _, _, anonymous = None, None, None
        try:
            mori.call('GET', '/api/tasks/{}/stream'.format(task_id), auth=False)
            raise RuntimeError('anonymous Mori stream unexpectedly succeeded')
        except RuntimeError as error:
            if 'HTTP 401' not in str(error):
                raise
            anonymous = 401
        mori_served = root / 'mori-served.mp4'
        headers = {'Cookie': mori.cookie, 'Accept-Encoding': 'identity'}
        request = urllib.request.Request('{}/api/tasks/{}/stream'.format(mori.base, task_id), headers=headers)
        digest = hashlib.sha256()
        total = 0
        with LOCAL_OPENER.open(request, timeout=180) as response:
            mori_status = response.status
            with open(mori_served, 'wb') as handle:
                for chunk in iter(lambda: response.read(1024 * 1024), b''):
                    total += len(chunk)
                    digest.update(chunk)
                    handle.write(chunk)
        if mori_status != 200 or total != reference_size or digest.hexdigest() != reference_sha:
            raise RuntimeError('Mori stream did not match the real source bytes')
        receipt['stream'] = {
            'jellyfinFull': {'status': full['status'], 'bytes': full['bytes'], 'sha256': full['sha256'],
                             'matchesReference': True, 'contentType': full['headers'].get('Content-Type')},
            'jellyfinRange': {'status': ranged['status'], 'bytes': ranged['bytes'], 'sha256': ranged['sha256'],
                              'contentRange': content_range},
            'moriFull': {'status': mori_status, 'bytes': total, 'sha256': digest.hexdigest(), 'matchesReference': True},
            'anonymousMoriStreamStatus': anonymous,
        }
        receipt['checks'] = {
            'realHttpsSource': True, 'moriDownloadMatchesIndependentReference': True,
            'moriNfoPreservesIdentity': True, 'noTmdbIdentityInvented': True,
            'jellyfinScannedPath': True, 'jellyfinTypeAndYear': True,
            'jellyfinPlayableMediaSource': True, 'moriVerifiesRealJellyfinItem': True,
            'jellyfinStreamMatchesReference': True, 'jellyfinRangeSupported': True,
            'moriStreamMatchesReference': True, 'anonymousMoriStreamRejected': True,
            'publishedMediaReadableByOtherUid': True, 'publishedNfoReadableByOtherUid': True,
        }
        receipt['status'] = 'passed'
    except BaseException as error:
        receipt['status'] = 'failed'
        receipt['failedStage'] = stage
        message = str(error)
        for secret in [setup_token, jellyfin.token, mori.cookie]:
            if secret:
                message = message.replace(secret, '[redacted]')
        receipt['error'] = message[:600]
        raise
    finally:
        receipt['finishedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        target = root / 'driver-receipt.json'
        target.write_text(json.dumps(receipt, indent=2) + '\n')
        os.chmod(target, 0o644)
        print(json.dumps({'status': receipt['status'], 'failedStage': receipt.get('failedStage')}))
    return 0


def docker(args, timeout=120):
    return subprocess.run(['docker'] + args, capture_output=True, text=True, timeout=timeout)


def image_info(name):
    result = docker(['image', 'inspect', name], timeout=60)
    if result.returncode:
        raise RuntimeError('missing image: {}'.format(name))
    data = json.loads(result.stdout)[0]
    return {'name': name, 'id': data.get('Id'), 'os': data.get('Os'), 'architecture': data.get('Architecture'),
            'repoDigests': data.get('RepoDigests', []), 'size': data.get('Size')}


def host():
    if not hasattr(os, 'getuid') or not Path('/tmp').is_dir():
        raise RuntimeError('this isolated verifier requires macOS, Linux or WSL with Docker')
    if EVIDENCE.exists() or FRAME_EVIDENCE.exists():
        raise RuntimeError('evidence target already exists; refusing to overwrite')
    images = {name: image_info(name) for name in [JELLYFIN_IMAGE, MORI_IMAGE, DRIVER_IMAGE]}
    docker_version = docker(['version', '--format', '{{.Server.Version}}'], timeout=60)
    if docker_version.returncode:
        raise RuntimeError('Docker server is unavailable')
    run_id = uuid.uuid4().hex[:12]
    label = 'mori.realrun=' + run_id
    root = Path(tempfile.mkdtemp(prefix=ROOT_PREFIX, dir='/tmp'))
    os.chmod(root, 0o777)
    run_dir = PROJECT / 'output/verification/jellyfin-real-source-runs' / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    for name in ['library', 'jellyfin-config', 'jellyfin-cache', 'mori-data']:
        (root / name).mkdir()
        os.chmod(root / name, 0o777)
    inner = 'mori-real-inner-' + run_id
    outer = 'mori-real-outer-' + run_id
    jellyfin_name = 'mori-real-jf-' + run_id
    mori_name = 'mori-real-mori-' + run_id
    driver_name = 'mori-real-driver-' + run_id
    receipt = {
        'schemaVersion': 1, 'runId': run_id, 'status': 'preparing',
        'scope': ('real public HTTPS source -> native Mori download and NFO -> fresh non-root (UID 1001) real Jellyfin '
                  'scan, identity, PlaybackInfo and direct stream across UIDs; no real accounts, no TMDB, '
                  'no remote metadata providers'),
        'source': {'url': SOURCE_URL, 'title': TITLE, 'year': YEAR},
        'images': images, 'root': str(root), 'containers': [jellyfin_name, mori_name, driver_name],
        'networks': [inner, outer], 'commands': [], 'cleanupErrors': [],
        'environment': {
            'hostOs': subprocess.run(['sw_vers', '-productVersion'], capture_output=True, text=True).stdout.strip(),
            'hostArch': subprocess.run(['uname', '-m'], capture_output=True, text=True).stdout.strip(),
            'dockerServer': docker_version.stdout.strip(),
            'moriPlatform': 'linux/amd64 under host emulation',
            'jellyfinPlatform': 'linux/arm64 native',
            'jellyfinUser': '{}:{}'.format(JELLYFIN_UID, JELLYFIN_GID),
            'jellyfinRunsAsRoot': False,
        },
    }

    def save():
        (run_dir / 'run.json').write_text(json.dumps(receipt, indent=2) + '\n')

    def command(name, args, timeout=120, check=True):
        log = run_dir / (name + '.log')
        with log.open('w') as output:
            result = subprocess.run(args, stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
        receipt['commands'].append({'name': name, 'exitCode': result.returncode,
                                    'log': str(log.relative_to(PROJECT))})
        save()
        if check and result.returncode:
            raise RuntimeError('{} failed with exit {}'.format(name, result.returncode))
        return result.returncode

    save()
    setup_token = None
    frame_created = False
    try:
        receipt['status'] = 'downloading reference'
        save()
        reference = root / 'reference.mp4'
        command('reference-download', ['curl', '--fail', '--location', '--silent', '--show-error',
                                       '--max-time', '180', '--output', str(reference), SOURCE_URL], timeout=200)
        head_request = urllib.request.Request(SOURCE_URL, method='HEAD')
        with urllib.request.urlopen(head_request, timeout=60) as response:
            head_status = response.status
            headers = safe_headers(response.headers)
        reference_size = reference.stat().st_size
        declared = int(headers.get('Content-Length', '0') or '0')
        if head_status != 200 or declared != reference_size:
            raise RuntimeError('public source HEAD and reference download disagree')
        if not (headers.get('Content-Type') or '').startswith('video/mp4'):
            raise RuntimeError('public source is not video/mp4')
        if headers.get('Accept-Ranges') != 'bytes':
            raise RuntimeError('public source does not advertise byte ranges')
        with open(reference, 'rb') as handle:
            magic = handle.read(12)
        receipt['source'].update({
            'httpStatus': head_status, 'headers': headers, 'referenceBytes': reference_size,
            'referenceSha256': sha256_file(reference), 'sniff': magic[4:8].decode(errors='replace'),
            'license': 'Sintel trailer, Blender Foundation, CC-BY 3.0; hosted by W3C',
        })
        if magic[4:8] != b'ftyp':
            raise RuntimeError('reference download is not an MP4 file')
        setup_token = secrets.token_urlsafe(32)
        (root / 'driver-input.json').write_text(json.dumps({
            'setupToken': setup_token, 'sourceUrl': SOURCE_URL, 'title': TITLE, 'year': YEAR,
        }))
        os.chmod(root / 'driver-input.json', 0o600)
        (root / 'mori.env').write_text('MORI_SETUP_TOKEN={}\nMORI_COOKIE_SECURE=0\n'.format(setup_token))
        os.chmod(root / 'mori.env', 0o600)
        receipt['status'] = 'starting isolated services'
        save()
        command('network-inner', ['docker', 'network', 'create', '--internal', '--label', label, inner])
        command('network-outer', ['docker', 'network', 'create', '--label', label, outer])
        command('jellyfin-start', ['docker', 'run', '-d', '--name', jellyfin_name, '--label', label,
                                   '--network', inner, '--cpus', '2', '--memory', '1024m', '--pids-limit', '512',
                                   '--user', '{}:{}'.format(JELLYFIN_UID, JELLYFIN_GID),
                                   '--mount', 'type=bind,source={},target=/config'.format(root / 'jellyfin-config'),
                                   '--mount', 'type=bind,source={},target=/cache'.format(root / 'jellyfin-cache'),
                                   '--mount', 'type=bind,source={},target=/library'.format(root / 'library'),
                                   JELLYFIN_IMAGE])
        command('mori-start', ['docker', 'run', '-d', '--name', mori_name, '--label', label,
                               '--platform', 'linux/amd64', '--network', outer,
                               '--cpus', '2', '--memory', '1024m', '--pids-limit', '256',
                               '--env-file', str(root / 'mori.env'),
                               '--mount', 'type=bind,source={},target=/downloads'.format(root / 'library'),
                               '--mount', 'type=bind,source={},target=/data'.format(root / 'mori-data'),
                               MORI_IMAGE])
        command('mori-attach-inner', ['docker', 'network', 'connect', inner, mori_name])
        receipt['status'] = 'running in-network driver'
        save()
        driver_log = (run_dir / 'driver.log').open('w')
        try:
            result = subprocess.run([
                'docker', 'run', '--rm', '--name', driver_name, '--label', label,
                '--network', inner, '--cpus', '1', '--memory', '512m', '--pids-limit', '128',
                '--mount', 'type=bind,source={},target={}'.format(root, root),
                '--mount', 'type=bind,source={},target=/check/run.py,readonly'.format(Path(__file__).resolve()),
                '--entrypoint', 'python', DRIVER_IMAGE, '/check/run.py', 'inside',
                str(root), jellyfin_name, mori_name, run_id,
            ], text=True, stdout=driver_log, stderr=subprocess.STDOUT, timeout=360)
        finally:
            driver_log.close()
        receipt['commands'].append({'name': 'driver', 'exitCode': result.returncode,
                                    'log': str((run_dir / 'driver.log').relative_to(PROJECT))})
        driver_receipt_path = root / 'driver-receipt.json'
        if not driver_receipt_path.is_file():
            raise RuntimeError('in-network driver did not write a receipt')
        driver_receipt = json.loads(driver_receipt_path.read_text())
        if result.returncode or driver_receipt.get('status') != 'passed':
            raise RuntimeError('in-network driver failed at {}'.format(driver_receipt.get('failedStage')))
        receipt['driver'] = driver_receipt
        receipt['status'] = 'probing served file'
        save()
        served = root / 'served.mp4'
        if sha256_file(served) != receipt['source']['referenceSha256']:
            raise RuntimeError('served file differs from the real source')
        probe = run_probe(root, label, run_dir)
        receipt['probe'] = probe
        receipt['decode'] = run_decode(root, label, run_dir)
        if receipt['decode']['exitCode'] != 0:
            raise RuntimeError('ffmpeg could not decode the Jellyfin-served file')
        frame = root / 'frame.png'
        extract_frame(root, label, run_dir, frame)
        if FRAME_EVIDENCE.exists():
            raise RuntimeError('frame evidence appeared during the run')
        shutil.copyfile(frame, FRAME_EVIDENCE)
        frame_created = True
        width, height = png_size(frame)
        receipt['frame'] = {'file': str(FRAME_EVIDENCE.relative_to(PROJECT)),
                            'bytes': frame.stat().st_size, 'sha256': sha256_file(frame),
                            'width': width, 'height': height, 'mediaTimeSeconds': 10}
        receipt['checks'] = dict(driver_receipt['checks'])
        receipt['checks'].update({'servedFileMatchesReference': True, 'ffprobeReadable': True,
                                  'ffmpegDecodedWithoutError': True, 'frameExtracted': True})
        receipt['status'] = 'passed'
        receipt['limitations'] = [
            'identity and resource search were not re-exercised here; the task was created through POST /api/tasks',
            'TMDB is not configured, so the NFO carries only the confirmed title and year',
            'Jellyfin web-client playback was not exercised; playability is proven by PlaybackInfo, direct stream bytes and ffmpeg decode',
            'Jellyfin ran as non-root UID 1001 while Mori wrote as UID 1000 through a Linux bind mount; NAS/SMB ACL, Windows, mobile or physical x86_64 access was not used',
            'Mori runs linux/amd64 under emulation on this arm64 host',
        ]
    except BaseException as error:
        receipt.update(status='failed', error=str(error)[:600])
        for name in [jellyfin_name, mori_name]:
            logs = docker(['logs', '--tail', '80', name], timeout=30)
            text = (logs.stdout or '') + (logs.stderr or '')
            if setup_token:
                text = text.replace(setup_token, '[redacted]')
            (run_dir / (name + '.log')).write_text(text)
        save()
    finally:
        for name in [driver_name, jellyfin_name, mori_name]:
            inspect = docker(['inspect', '--format', '{{index .Config.Labels "mori.realrun"}}', name], timeout=30)
            if inspect.returncode == 0:
                if inspect.stdout.strip() != run_id:
                    receipt['cleanupErrors'].append('owner mismatch: ' + name)
                    continue
                if docker(['rm', '-f', name], timeout=60).returncode:
                    receipt['cleanupErrors'].append('remove failed: ' + name)
        for network in [inner, outer]:
            owner = docker(['network', 'inspect', '--format', '{{index .Labels "mori.realrun"}}', network], timeout=30)
            if owner.returncode == 0:
                if owner.stdout.strip() != run_id:
                    receipt['cleanupErrors'].append('network owner mismatch: ' + network)
                elif docker(['network', 'rm', network], timeout=30).returncode:
                    receipt['cleanupErrors'].append('network removal failed: ' + network)
        for label_name in [jellyfin_name, mori_name, driver_name]:
            if docker(['inspect', label_name], timeout=30).returncode == 0:
                receipt['cleanupErrors'].append('container still present: ' + label_name)
        for network in [inner, outer]:
            if docker(['network', 'inspect', network], timeout=30).returncode == 0:
                receipt['cleanupErrors'].append('network still present: ' + network)
        if root.exists():
            if (root / 'driver-receipt.json').is_file():
                shutil.copy2(root / 'driver-receipt.json', run_dir / 'driver-receipt.json')
            if (root / 'served.mp4').is_file():
                shutil.copy2(root / 'served.mp4', run_dir / 'served.mp4')
            if (root / 'frame.png').is_file():
                shutil.copy2(root / 'frame.png', run_dir / 'frame.png')
            nfos = sorted((root / 'library').glob('*.nfo'))
            if nfos:
                shutil.copy2(nfos[0], run_dir / 'nfo.xml')
            try:
                shutil.rmtree(root)
            except OSError as error:
                receipt['cleanupErrors'].append('temp removal failed: {}'.format(error))
        receipt['ownedTempRemoved'] = not root.exists()
        receipt['credentialsRemoved'] = receipt['ownedTempRemoved']
        receipt['finishedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        save()
        if receipt['status'] == 'passed' and not receipt['cleanupErrors']:
            if EVIDENCE.exists():
                receipt.update(status='failed', error='evidence file appeared during the run')
                save()
            else:
                evidence = {k: v for k, v in receipt.items() if k not in ('root',)}
                evidence['task'] = 'Mori 真实公网源 -> 非root Jellyfin 跨UID扫描/识别/播放隔离验收'
                evidence['date'] = '2026-10-25'
                evidence['state'] = 'passed'
                EVIDENCE.write_text(json.dumps(evidence, indent=2) + '\n')
        elif frame_created and FRAME_EVIDENCE.exists():
            FRAME_EVIDENCE.unlink()
        print(json.dumps({'status': receipt['status'], 'runId': run_id,
                          'receipt': str(run_dir / 'run.json'), 'evidence': str(EVIDENCE),
                          'cleanupErrors': receipt['cleanupErrors'],
                          'ownedTempRemoved': receipt['ownedTempRemoved']}))
    return 0 if receipt['status'] == 'passed' and not receipt['cleanupErrors'] else 1


def run_probe(root, label, run_dir):
    target = root / 'probe.json'
    name = 'mori-real-probe-' + uuid.uuid4().hex[:8]
    log_path = run_dir / 'probe.log'
    with log_path.open('w') as log:
        result = subprocess.run([
            'docker', 'run', '--rm', '--name', name, '--label', label, '--network', 'none',
            '--mount', 'type=bind,source={},target=/served.mp4,readonly'.format(root / 'served.mp4'),
            '--entrypoint', '/usr/lib/jellyfin-ffmpeg/ffprobe', JELLYFIN_IMAGE,
            '-v', 'error', '-show_entries',
            'format=format_name,duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,pix_fmt,sample_rate,channels',
            '-of', 'json', '/served.mp4',
        ], stdout=subprocess.PIPE, stderr=log, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError('ffprobe failed')
    data = json.loads(result.stdout)
    target.write_text(json.dumps(data, indent=2) + '\n')
    shutil.copy2(target, run_dir / 'probe.json')
    return data


def run_decode(root, label, run_dir):
    name = 'mori-real-decode-' + uuid.uuid4().hex[:8]
    log_path = run_dir / 'decode.log'
    with log_path.open('w') as log:
        result = subprocess.run([
            'docker', 'run', '--rm', '--name', name, '--label', label, '--network', 'none',
            '--mount', 'type=bind,source={},target=/served.mp4,readonly'.format(root / 'served.mp4'),
            '--entrypoint', '/usr/lib/jellyfin-ffmpeg/ffmpeg', JELLYFIN_IMAGE,
            '-hide_banner', '-v', 'error', '-i', '/served.mp4', '-f', 'null', '-',
        ], stdout=log, stderr=subprocess.STDOUT, timeout=180)
    return {'exitCode': result.returncode, 'stderr': log_path.read_text()[:2000],
            'log': str(log_path.relative_to(PROJECT))}


def extract_frame(root, label, run_dir, target):
    name = 'mori-real-frame-' + uuid.uuid4().hex[:8]
    log_path = run_dir / 'frame.log'
    with log_path.open('w') as log:
        result = subprocess.run([
            'docker', 'run', '--rm', '--name', name, '--label', label, '--network', 'none',
            '--mount', 'type=bind,source={},target=/served.mp4,readonly'.format(root / 'served.mp4'),
            '--mount', 'type=bind,source={},target=/out'.format(root),
            '--entrypoint', '/usr/lib/jellyfin-ffmpeg/ffmpeg', JELLYFIN_IMAGE,
            '-hide_banner', '-v', 'error', '-ss', '10', '-i', '/served.mp4',
            '-frames:v', '1', '-update', '1', '-y', '/out/frame.png',
        ], stdout=log, stderr=subprocess.STDOUT, timeout=120)
    if result.returncode or not target.is_file():
        raise RuntimeError('frame extraction failed')
    data = target.read_bytes()[:8]
    if data != b'\x89PNG\r\n\x1a\n':
        raise RuntimeError('extracted frame is not a PNG')


def png_size(path):
    data = path.read_bytes()[:24]
    if len(data) < 24 or data[:8] != b'\x89PNG\r\n\x1a\n':
        raise RuntimeError('invalid PNG evidence')
    return struct.unpack('>II', data[16:24])


if __name__ == '__main__':
    try:
        code = inside(sys.argv) if len(sys.argv) > 1 and sys.argv[1] == 'inside' else host()
    except KeyboardInterrupt:
        code = 130
    except BaseException as error:
        sys.stderr.write('Jellyfin real-source verifier failed: {}\n'.format(str(error)[:600]))
        code = 1
    sys.exit(code)
