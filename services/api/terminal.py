"""Reconnectable owner-only PTYs, separate from experiment worker jobs."""

import asyncio
import codecs
import json
import os
import pty
import psutil
import signal
import subprocess
import time
from pathlib import Path

from fastapi import WebSocket, WebSocketDisconnect


class TerminalSession:
    def __init__(self, cwd):
        self.master, slave = pty.openpty()
        self.proc = subprocess.Popen(
            ['/bin/zsh' if Path('/bin/zsh').exists() else '/bin/bash', '-i'],
            cwd=cwd,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
            env={**os.environ, 'TERM': 'xterm-256color'},
        )
        os.close(slave)
        os.set_blocking(self.master, False)
        self.decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
        self.buffer = ''
        self.clients = set()
        self.last_seen = time.monotonic()
        self.closed = False
        self.input_lock = asyncio.Lock()
        self.close_complete = asyncio.Event()
        self.close_error = None
        self.reader = asyncio.create_task(self.pump())

    async def write_input(self, text):
        # Keep a paste intact across short writes and across attached clients.
        async with self.input_lock:
            pending = memoryview(text.encode())
            while pending:
                if self.closed:
                    raise OSError('Terminal session closed')
                try:
                    written = os.write(self.master, pending[:65536])
                except BlockingIOError:
                    # Let the reader and other sessions run while the PTY drains.
                    await asyncio.sleep(.03)
                    continue
                if written == 0:
                    raise OSError('Terminal input made no progress')
                pending = pending[written:]
                await asyncio.sleep(0)

    async def publish(self, value):
        if not value or self.closed:
            return
        self.buffer = (self.buffer + value)[-131072:]
        for ws in tuple(self.clients):
            try:
                await ws.send_text(value)
            except Exception:
                self.clients.discard(ws)

    async def pump(self):
        try:
            while self.proc.poll() is None and not self.closed:
                if not self.clients and time.monotonic() - self.last_seen > 1800:
                    await self.close()
                    return
                try:
                    await self.publish(self.decoder.decode(os.read(self.master, 65536)))
                except BlockingIOError:
                    pass
                except OSError:
                    break
                await asyncio.sleep(.03)
        finally:
            await self.publish(self.decoder.decode(b'', final=True))

    @staticmethod
    def _process_groups_in_session(session_id):
        groups = set()
        for process in psutil.process_iter(['pid', 'status']):
            pid = process.info['pid']
            if process.info.get('status') == psutil.STATUS_ZOMBIE:
                continue
            try:
                if os.getsid(pid) == session_id:
                    groups.add(os.getpgid(pid))
            except (ProcessLookupError, PermissionError, psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        return groups

    def _terminate_processes(self):
        # A PTY shell can leave background jobs in other process groups within
        # its session. Signal every group in that owned session, then escalate
        # if a child ignores SIGHUP or SIGTERM.
        session_id = self.proc.pid
        for sig, grace_period in (
            (signal.SIGHUP, .4),
            (signal.SIGTERM, .4),
            (signal.SIGKILL, .1),
        ):
            groups = self._process_groups_in_session(session_id)
            if not groups:
                break
            for process_group in groups:
                try:
                    os.killpg(process_group, sig)
                except ProcessLookupError:
                    pass
                except PermissionError:
                    continue
            deadline = time.monotonic() + grace_period
            while time.monotonic() < deadline and self._process_groups_in_session(session_id):
                time.sleep(.02)

        try:
            self.proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=1)

    async def close(self):
        if self.closed:
            await self.close_complete.wait()
            if self.close_error is not None:
                raise self.close_error
            return
        self.closed = True
        try:
            for ws in tuple(self.clients):
                try:
                    await ws.close(code=1001, reason='Terminal session closed')
                except Exception:
                    pass
            self.clients.clear()

            await asyncio.to_thread(self._terminate_processes)
            try:
                os.close(self.master)
            except OSError:
                pass

            reader = self.reader
            if reader is not asyncio.current_task():
                reader.cancel()
                await asyncio.gather(reader, return_exceptions=True)
        except BaseException as exc:
            self.close_error = exc
            raise
        finally:
            self.close_complete.set()


SESSIONS = {}
CLOSING_PROJECTS = {}


def project_is_closing(project_id):
    return CLOSING_PROJECTS.get(str(project_id), 0) > 0


async def close_project(project_id):
    project_id = str(project_id)
    CLOSING_PROJECTS[project_id] = CLOSING_PROJECTS.get(project_id, 0) + 1

    keys = [key for key in SESSIONS if key.partition(':')[0] == project_id]
    sessions = [SESSIONS.pop(key) for key in keys]
    for session in sessions:
        await session.close()


def reopen_project(project_id):
    project_id = str(project_id)
    count = CLOSING_PROJECTS.get(project_id, 0)
    if count <= 1:
        CLOSING_PROJECTS.pop(project_id, None)
    else:
        CLOSING_PROJECTS[project_id] = count - 1


async def attach(ws, key, cwd):
    project_id = key.partition(':')[0]
    if project_is_closing(project_id):
        await ws.close(code=1001)
        return

    session = SESSIONS.get(key)
    if session is not None and (session.closed or session.proc.poll() is not None):
        SESSIONS.pop(key, None)
        await session.close()
        session = None

    if session is None:
        if len(SESSIONS) >= 32:
            old_key = next((k for k, value in SESSIONS.items() if not value.clients), None)
            if old_key is None:
                await ws.close(code=1013)
                return
            old_session = SESSIONS.pop(old_key)
            await old_session.close()

        if project_is_closing(project_id):
            await ws.close(code=1001)
            return
        session = SESSIONS[key] = TerminalSession(cwd)

    await ws.accept()
    if session.closed or project_is_closing(project_id):
        await ws.close(code=1001)
        return

    session.clients.add(ws)
    try:
        if session.buffer:
            await ws.send_text(session.buffer)
        while True:
            text = await ws.receive_text()
            session.last_seen = time.monotonic()
            if text.startswith('{"resize":'):
                import fcntl
                import struct
                import termios

                size = json.loads(text)['resize']
                rows = min(1000, max(1, int(size['rows'])))
                columns = min(1000, max(1, int(size['cols'])))
                fcntl.ioctl(
                    session.master,
                    termios.TIOCSWINSZ,
                    struct.pack('HHHH', rows, columns, 0, 0),
                )
            elif text == '{"action":"close"}':
                if SESSIONS.get(key) is session:
                    SESSIONS.pop(key, None)
                await session.close()
                break
            elif not session.closed:
                await session.write_input(text)
    except WebSocketDisconnect:
        pass
    except OSError:
        if not session.closed:
            await ws.close(code=1011, reason='Terminal input failed')
    finally:
        session.clients.discard(ws)
        session.last_seen = time.monotonic()


async def close_all():
    sessions = list(SESSIONS.values())
    SESSIONS.clear()
    for session in sessions:
        await session.close()
    CLOSING_PROJECTS.clear()
