import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

PROJECT = Path(__file__).resolve().parent.parent
EMBY_IMAGE = 'emby/embyserver@sha256:383bcdaf090eeb1fd66daccfeab59ad51f0181189a98420aaeb27e269d52ee4b'
MORI_IMAGE = os.environ.get('MORI_TV_FULLCHAIN_IMAGE', 'mori-media-agent:tv-fullchain-20261024')


def inside(root):
    base = 'http://127.0.0.1:8096'
    device = uuid.uuid4().hex
    headers = {'Content-Type': 'application/json', 'X-Emby-Authorization': f'Emby Client="mo-isolated-tv", Device="test", DeviceId="{device}", Version="1"'}
    steps = []

    def api(method, route, body=None, access=None):
        outgoing = dict(headers)
        if access:
            outgoing['X-Emby-Token'] = access
        req = urllib.request.Request(base + route, data=None if body is None else json.dumps(body).encode(), headers=outgoing, method=method)
        try:
            with urllib.request.urlopen(req, timeout=12) as response:
                data = response.read()
                steps.append({'method': method, 'path': route, 'status': response.status})
                return json.loads(data) if data else None
        except urllib.error.HTTPError as error:
            detail = error.read(4096).decode(errors='replace')
            for value in [access, (body or {}).get('Pw'), (body or {}).get('Password')]:
                if value:
                    detail = detail.replace(value, '[redacted]')
            raise RuntimeError(f'Emby {method} {route}: HTTP {error.code}: {detail}') from None

    deadline = time.monotonic() + 45
    while True:
        try:
            info = api('GET', '/System/Info/Public')
            break
        except (OSError, RuntimeError):
            if time.monotonic() >= deadline:
                raise RuntimeError('Fresh Emby did not become ready')
            time.sleep(.4)
    name = 'mori' + secrets.token_hex(2)
    password = secrets.token_urlsafe(24)
    api('POST', '/Startup/Configuration', {'UICulture': 'en-US'})
    api('POST', '/Startup/User', {'Name': name, 'Password': password})
    api('POST', '/Startup/Complete', {})
    identity = api('POST', '/Users/AuthenticateByName', {'Username': name, 'Pw': password})
    access = identity['AccessToken']
    user = identity['User']['Id']
    type_options = [
        {'Type': 'Series', 'MetadataFetchers': [], 'ImageFetchers': []},
        {'Type': 'Season', 'MetadataFetchers': [], 'ImageFetchers': []},
        {'Type': 'Episode', 'MetadataFetchers': [], 'ImageFetchers': []},
    ]
    api('POST', '/Library/VirtualFolders', {
        'Name': 'Isolated TV Shows', 'CollectionType': 'tvshows', 'Paths': ['/library'], 'RefreshLibrary': False,
        'LibraryOptions': {'EnableRealtimeMonitor': False, 'ImportCollections': False,
                           'TypeOptions': type_options},
    }, access)
    listing = api('GET', '/Library/VirtualFolders/Query', access=access)
    items = listing if isinstance(listing, list) else listing.get('Items', [])
    selected = next(item for item in items if item.get('Name') == 'Isolated TV Shows')
    assert selected.get('CollectionType') == 'tvshows'
    assert '/library' in selected.get('Locations', [])
    report = {'version': info.get('Version'), 'steps': steps, 'libraryPathsVerified': True,
              'collectionType': selected.get('CollectionType'),
              'typeOptions': selected.get('LibraryOptions', {}).get('TypeOptions', []),
              'outboundNetwork': 'blocked by Docker internal network'}
    (root/'bootstrap-receipt.json').write_text(json.dumps(report, indent=2)+'\n')
    settings = {'root': str(root), 'profile': 'emby', 'libraryBase': base, 'libraryToken': access, 'libraryUserId': user}
    result = subprocess.run(['node', '--import', 'tsx', '/app/tests/fullchain-tv.manual.ts'],
                            input=json.dumps(settings), text=True, capture_output=True, cwd='/app', timeout=155)
    (root/'fullchain.stdout.log').write_text(result.stdout)
    (root/'fullchain.stderr.log').write_text(result.stderr)
    print(json.dumps({'bootstrapPassed': True, 'version': info.get('Version'), 'fullchainExitCode': result.returncode}))
    return result.returncode


def host():
    if not hasattr(os, 'getuid') or not Path('/tmp').is_dir():
        raise RuntimeError('This isolated verifier requires macOS, Linux or WSL with Docker')
    image_id = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{.Id}}', MORI_IMAGE], text=True).strip()
    run_id = uuid.uuid4().hex[:12]
    root = Path(tempfile.mkdtemp(prefix='mori-fullchain-e2e-', dir='/tmp'))
    (root/'config').mkdir()
    (root/'media').mkdir()
    run_dir = PROJECT/'output/verification/fullchain-tv-runs'/run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    network = 'mori-tv-fullchain-net-' + run_id
    emby = 'mori-tv-fullchain-emby-' + run_id
    runner = 'mori-tv-fullchain-runner-' + run_id
    generate = 'mori-tv-fullchain-generate-' + run_id
    decode = 'mori-tv-fullchain-decode-' + run_id
    label = 'mori.run=' + run_id
    receipt = {'runId': run_id, 'scope': 'isolated synthetic TV title/search source and real Emby TV library',
               'moriImage': MORI_IMAGE, 'moriImageId': image_id, 'embyImage': EMBY_IMAGE,
               'root': str(root), 'network': network, 'emby': emby, 'runner': runner,
               'status': 'preparing', 'commands': [], 'cleanupErrors': []}

    def save():
        (run_dir/'run.json').write_text(json.dumps(receipt, indent=2)+'\n')

    def command(name, args, timeout=45):
        log = run_dir/(name+'.log')
        with log.open('w') as output:
            result = subprocess.run(args, stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
        receipt['commands'].append({'name': name, 'exitCode': result.returncode, 'log': str(log.relative_to(PROJECT))})
        save()
        if result.returncode:
            raise RuntimeError(name + ' failed with exit ' + str(result.returncode))

    save()
    try:
        command('network', ['docker', 'network', 'create', '--internal', '--label', label, network])
        command('generate', ['docker', 'run', '--rm', '--name', generate, '--label', label,
                            '--network', 'none', '--cpus', '1', '--memory', '256m', '--pids-limit', '64',
                            '--mount', f'type=bind,source={root},target=/fixture', '--entrypoint', '/bin/ffmpeg', EMBY_IMAGE,
                            '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x72:rate=10',
                            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '3', '-c:v', 'libx264',
                            '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-n', '/fixture/fixture-source.mp4'])
        command('emby-start', ['docker', 'run', '-d', '--name', emby, '--label', label, '--network', network,
                               '--cpus', '1', '--memory', '768m', '--pids-limit', '256',
                               '--mount', f'type=bind,source={root}/config,target=/config',
                               '--mount', f'type=bind,source={root}/media,target=/library', EMBY_IMAGE])
        receipt['status'] = 'running'
        save()
        command('fullchain', ['docker', 'run', '--rm', '--name', runner, '--label', label,
                             '--network', 'container:'+emby, '--user', f'{os.getuid()}:{os.getgid()}',
                             '--cpus', '1', '--memory', '768m', '--pids-limit', '128',
                             '--mount', f'type=bind,source={root},target={root}',
                             '--mount', f'type=bind,source={PROJECT}/tests,target=/app/tests,readonly',
                             '--mount', f'type=bind,source={Path(__file__).resolve()},target=/checks/run.py,readonly',
                             '--entrypoint', 'python', MORI_IMAGE, '/checks/run.py', 'inside', str(root)], 225)
        chain = json.loads((root/'receipt.json').read_text())
        assert chain['status'] == 'passed'
        command('decode', ['docker', 'run', '--rm', '--name', decode, '--label', label,
                          '--network', 'none', '--cpus', '1', '--memory', '256m', '--pids-limit', '64',
                          '--mount', f'type=bind,source={root}/served.mp4,target=/served.mp4,readonly',
                          '--entrypoint', '/bin/ffmpeg', EMBY_IMAGE, '-hide_banner', '-loglevel', 'error',
                          '-i', '/served.mp4', '-f', 'null', '-'])
        receipt.update(status='passed', chain=chain, decodedByFfmpeg=True,
                       bootstrap=json.loads((root/'bootstrap-receipt.json').read_text()),
                       sourceSha256=hashlib.sha256((root/'fixture-source.mp4').read_bytes()).hexdigest(),
                       servedSha256=hashlib.sha256((root/'served.mp4').read_bytes()).hexdigest())
    except BaseException as error:
        receipt.update(status='failed', error=str(error))
    finally:
        for name in ['bootstrap-receipt.json', 'receipt.json', 'fullchain.stdout.log', 'fullchain.stderr.log']:
            if (root/name).is_file():
                shutil.copy2(root/name, run_dir/name)
        for name in [runner, decode, generate, emby]:
            inspect = subprocess.run(['docker', 'inspect', '--format', '{{index .Config.Labels "mori.run"}}', name], capture_output=True, text=True)
            if inspect.returncode == 0:
                if inspect.stdout.strip() != run_id:
                    receipt['cleanupErrors'].append('owner mismatch: '+name)
                    continue
                stop = subprocess.run(['docker', 'rm', '-f', name], capture_output=True, text=True)
                if stop.returncode:
                    receipt['cleanupErrors'].append('remove failed: '+name)
        net_owner = subprocess.run(['docker', 'network', 'inspect', '--format', '{{index .Labels "mori.run"}}', network], capture_output=True, text=True)
        if net_owner.returncode == 0:
            if net_owner.stdout.strip() != run_id:
                receipt['cleanupErrors'].append('network owner mismatch')
            elif subprocess.run(['docker', 'network', 'rm', network], capture_output=True, text=True).returncode:
                receipt['cleanupErrors'].append('network removal failed')
        assert root.parent == Path('/tmp') and root.name.startswith('mori-fullchain-e2e-')
        if not receipt['cleanupErrors']:
            shutil.rmtree(root)
        receipt['ownedTempRemoved'] = not root.exists()
        save()
        print(json.dumps({'status': receipt['status'], 'runId': run_id, 'receipt': str(run_dir/'run.json'),
                          'cleanupErrors': receipt['cleanupErrors'], 'ownedTempRemoved': receipt['ownedTempRemoved']}))
    return 0 if receipt['status'] == 'passed' and not receipt['cleanupErrors'] else 1


if __name__ == '__main__':
    sys.exit(inside(Path(sys.argv[2])) if len(sys.argv) > 1 and sys.argv[1] == 'inside' else host())
