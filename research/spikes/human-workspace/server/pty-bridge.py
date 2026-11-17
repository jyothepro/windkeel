#!/usr/bin/env python3
"""A PTY with no native Node module.

node-pty needs a compiler or a matching prebuild in the sandbox image; Python's `pty` is in the
standard library of every image Windkeel uses. The workspace server spawns this with:

  fd 0  bytes typed by the person      -> pty master
  fd 1  pty master output              -> the person's terminal
  fd 3  control lines "rows cols\\n"    -> TIOCSWINSZ on the pty

and the bridge exits with the shell's exit status.
"""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

shell = os.environ.get("WINDKEEL_WS_SHELL") or os.environ.get("SHELL") or "/bin/bash"
cwd = os.environ.get("WINDKEEL_WS_CWD") or os.getcwd()
env = {k: v for k, v in os.environ.items() if not k.startswith("WINDKEEL_WS_")}
env["TERM"] = "xterm-256color"

pid, master = pty.fork()
if pid == 0:
    try:
        os.chdir(cwd)
    except OSError:
        pass
    os.execvpe(shell, [shell, "-l"], env)

CTRL = 3
ctrl_buf = b""
fds = [0, master, CTRL]


def set_size(rows, cols):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    try:
        os.kill(pid, signal.SIGWINCH)
    except ProcessLookupError:
        pass


set_size(24, 80)

while True:
    try:
        ready, _, _ = select.select(fds, [], [])
    except InterruptedError:
        continue
    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError as e:  # EIO when the shell exits
            if e.errno != errno.EIO:
                raise
            data = b""
        if not data:
            break
        os.write(1, data)
    if 0 in ready:
        data = os.read(0, 65536)
        if not data:
            fds.remove(0)
            os.kill(pid, signal.SIGHUP)
        else:
            os.write(master, data)
    if CTRL in ready:
        data = os.read(CTRL, 4096)
        if not data:
            fds.remove(CTRL)
        ctrl_buf += data
        while b"\n" in ctrl_buf:
            line, ctrl_buf = ctrl_buf.split(b"\n", 1)
            try:
                rows, cols = (int(x) for x in line.split())
                if 0 < rows < 1000 and 0 < cols < 1000:
                    set_size(rows, cols)
            except ValueError:
                pass

_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) & 0xFF)
