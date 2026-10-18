import errno
import json
import os
import pty
import pwd
import select
import signal
import time
import http.server
import tempfile
import threading
import shutil


def descendants(pid):
    parents = {}
    for entry in os.listdir('/proc'):
        if not entry.isdigit():
            continue
        try:
            with open('/proc/' + entry + '/status') as source:
                for line in source:
                    if line.startswith('PPid:'):
                        parents[int(entry)] = int(line.split()[1])
        except FileNotFoundError:
            pass
    owned = {pid}
    while True:
        found = {child for child, parent in parents.items() if parent in owned}
        if found <= owned:
            return owned
        owned |= found


def alive(pid):
    try:
        with open('/proc/' + str(pid) + '/stat') as source:
            return source.read().rsplit(')', 1)[1].split()[0] != 'Z'
    except FileNotFoundError:
        return False


requested = threading.Event()
release = threading.Event()


class Download(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Length', '100000000')
        self.end_headers()
        self.wfile.flush()
        requested.set()
        release.wait(90)

    def log_message(self, *args):
        pass


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Download)
cache = tempfile.mkdtemp(prefix='vlint-55-download-cancel-')
results = []
for cancellation in ['SIGINT', 'SIGTERM', 'terminal-ctrl-c', 'download-SIGTERM']:
    download = cancellation == 'download-SIGTERM'
    pid, fd = pty.fork()
    if pid == 0:
        if download:
            os.environ['PLAYWRIGHT_BROWSERS_PATH'] = cache
            os.environ['PLAYWRIGHT_DOWNLOAD_HOST'] = 'http://127.0.0.1:' + str(server.server_port)
        else:
            user = pwd.getpwnam('vlintreview')
            os.initgroups(user.pw_name, user.pw_gid)
            os.setgid(user.pw_gid)
            os.setuid(user.pw_uid)
            os.environ['HOME'] = user.pw_dir
            os.environ['SUDO_PROMPT'] = 'VLINT_REVIEW_PASSWORD_PROMPT:'
        os.execv('/lane/dist/vlint-linux-x64', ['/lane/dist/vlint-linux-x64', 'browser', 'install'])
    if download:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    output = bytearray()
    checkpoint_reached = False
    status = None
    owned = {pid}
    downloader_observed = None
    deadline = time.monotonic() + (120 if download else 45)
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b''
            output.extend(chunk)
        if not checkpoint_reached and (requested.is_set() if download else b'VLINT_REVIEW_PASSWORD_PROMPT:' in output):
            checkpoint_reached = True
            owned = descendants(pid)
            if download:
                commands = []
                for child in owned:
                    try:
                        with open('/proc/' + str(child) + '/cmdline', 'rb') as source:
                            commands.append(source.read().decode(errors='replace'))
                    except FileNotFoundError:
                        pass
                downloader_observed = any('oopBrowserDownload.js' in command for command in commands)
            if cancellation == 'terminal-ctrl-c':
                os.write(fd, b'\x03')
            else:
                os.kill(pid, signal.SIGTERM if download else getattr(signal, cancellation))
            deadline = time.monotonic() + 12
        done, value = os.waitpid(pid, os.WNOHANG)
        if done:
            status = value
            break
    if status is None:
        owned |= descendants(pid)
        for child in owned:
            try:
                os.kill(child, signal.SIGKILL)
            except ProcessLookupError:
                pass
        _, status = os.waitpid(pid, 0)
    time.sleep(0.3)
    survivors = sorted(child for child in owned if alive(child))
    os.close(fd)
    results.append({'cancellation': cancellation, 'checkpoint': 'download' if download else 'sudo-password', 'checkpointReached': checkpoint_reached, 'downloaderObserved': downloader_observed, 'ownedProcesses': len(owned), 'exitCode': os.waitstatus_to_exitcode(status), 'survivors': survivors, 'output': output.decode(errors='replace')[-3000:]})
release.set()
server.shutdown()
server.server_close()
shutil.rmtree(cache)
print(json.dumps(results, indent=2))
assert all(result['checkpointReached'] and result['exitCode'] == 2 and not result['survivors'] for result in results)
assert results[-1]['downloaderObserved']
