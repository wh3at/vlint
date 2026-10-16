import errno
import os
import pty
import select
import signal
import sys
import time

binary, cwd, mode = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    args = [binary, "init"]
    if mode == "flags":
        args += ["--environment", "windows:firefox", "--environment", "iphone:webkit"]
    os.execv(binary, args)
steps = [] if mode == "flags" else [(b"Platform (", b"windows\n"), (b"Browser (", b"firefox\n"), (b"Platform (", b"iphone\n"), (b"Browser (", b"webkit\n"), (b"Platform (", b"done\n")]
buffer = b""
transcript = b""
deadline = time.monotonic() + 15
try:
    while time.monotonic() < deadline:
        if select.select([fd], [], [], 0.1)[0]:
            try:
                data = os.read(fd, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            transcript += data
            buffer += data
            if steps and steps[0][0] in buffer:
                _, answer = steps.pop(0)
                os.write(fd, answer)
                buffer = b""
    else:
        os.kill(pid, signal.SIGKILL)
        raise RuntimeError("terminal timed out: " + repr(transcript))
    _, status = os.waitpid(pid, 0)
    sys.stdout.buffer.write(transcript)
    if steps:
        raise RuntimeError("terminal did not request all selections")
    if mode == "flags" and b"Platform (" in transcript:
        raise RuntimeError("flags entered interactive mode")
    sys.exit(os.waitstatus_to_exitcode(status))
finally:
    os.close(fd)
