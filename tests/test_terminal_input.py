"""Terminal input delivery with isolated PTYs; no shells or user services."""
import asyncio
import errno
import os
import pty
from types import SimpleNamespace
import tty

import pytest
from fastapi import WebSocketDisconnect

from services.api import terminal


class Socket:
    def __init__(self, text):
        self.messages = iter([text])
        self.closed = None

    async def accept(self):
        pass

    async def receive_text(self):
        try:
            return next(self.messages)
        except StopIteration:
            raise WebSocketDisconnect()

    async def close(self, **kwargs):
        self.closed = kwargs


def session_for(master):
    session = terminal.TerminalSession.__new__(terminal.TerminalSession)
    session.master = master
    session.closed = False
    session.proc = SimpleNamespace(poll=lambda: None)
    session.buffer = ''
    session.clients = set()
    session.input_lock = asyncio.Lock()
    return session


@pytest.mark.parametrize('mode', ['short', 'blocked', 'normal'])
def test_attach_delivers_entire_paste(monkeypatch, tmp_path, mode):
    async def scenario():
        master, slave = pty.openpty()
        try:
            tty.setraw(slave)
            os.set_blocking(master, False)
            os.set_blocking(slave, False)
            session = session_for(master)
            monkeypatch.setattr(terminal, 'SESSIONS', {'project:terminal': session})
            monkeypatch.setattr(terminal, 'CLOSING_PROJECTS', {})
            text = 'abc\u20ac\U0001f600\n' * 20000 + '__PASTE_TAIL__\n'
            socket = Socket(text)
            real_write = os.write
            attempts = 0

            def write(fd, data):
                nonlocal attempts
                if fd != master:
                    return real_write(fd, data)
                attempts += 1
                if mode == 'blocked' and attempts == 1:
                    raise BlockingIOError(errno.EAGAIN, 'PTY full')
                return real_write(fd, data[:7] if mode == 'short' else data)

            monkeypatch.setattr(terminal.os, 'write', write)
            writer = asyncio.create_task(terminal.attach(socket, 'project:terminal', tmp_path))
            received = bytearray()

            async def drain():
                while True:
                    try:
                        received.extend(os.read(slave, 65536))
                    except BlockingIOError:
                        if writer.done():
                            return
                        await asyncio.sleep(.001)

            await asyncio.wait_for(asyncio.gather(writer, drain()), timeout=10)
            assert received == text.encode()
            assert socket.closed is None
            assert not session.clients
        finally:
            os.close(master)
            os.close(slave)

    asyncio.run(scenario())


@pytest.mark.parametrize('failure', ['zero', 'error'])
def test_attach_reports_failed_input(monkeypatch, tmp_path, failure):
    async def scenario():
        session = session_for(123)
        monkeypatch.setattr(terminal, 'SESSIONS', {'project:terminal': session})
        monkeypatch.setattr(terminal, 'CLOSING_PROJECTS', {})

        def write(fd, data):
            if failure == 'zero':
                return 0
            raise OSError(errno.EIO, 'PTY unavailable')

        monkeypatch.setattr(terminal.os, 'write', write)
        socket = Socket('echo tail\n')
        await asyncio.wait_for(terminal.attach(socket, 'project:terminal', tmp_path), timeout=1)
        assert socket.closed == {'code': 1011, 'reason': 'Terminal input failed'}
        assert not session.clients

    asyncio.run(scenario())


def test_input_messages_do_not_interleave(monkeypatch):
    async def scenario():
        session = session_for(123)
        received = bytearray()
        first_write = asyncio.Event()

        def write(fd, data):
            received.extend(data[:1])
            first_write.set()
            return 1

        monkeypatch.setattr(terminal.os, 'write', write)
        first = asyncio.create_task(session.write_input('abc\u20ac'))
        await first_write.wait()
        second = asyncio.create_task(session.write_input('XYZ'))
        await asyncio.wait_for(asyncio.gather(first, second), timeout=1)
        assert received == 'abc\u20acXYZ'.encode()

    asyncio.run(scenario())


def test_pending_input_stops_when_session_closes(monkeypatch):
    async def scenario():
        session = session_for(123)
        blocked = asyncio.Event()
        calls = []

        def write(fd, data):
            calls.append(bytes(data))
            blocked.set()
            raise BlockingIOError(errno.EAGAIN, 'PTY full')

        monkeypatch.setattr(terminal.os, 'write', write)
        writer = asyncio.create_task(session.write_input('pending'))
        await blocked.wait()
        session.closed = True
        with pytest.raises(OSError, match='Terminal session closed'):
            await asyncio.wait_for(writer, timeout=1)
        assert calls == [b'pending']
        assert not session.input_lock.locked()

    asyncio.run(scenario())


def test_cancelled_input_releases_lock(monkeypatch):
    async def scenario():
        session = session_for(123)
        blocked = asyncio.Event()

        def write(fd, data):
            blocked.set()
            raise BlockingIOError(errno.EAGAIN, 'PTY full')

        monkeypatch.setattr(terminal.os, 'write', write)
        writer = asyncio.create_task(session.write_input('pending'))
        await blocked.wait()
        writer.cancel()
        with pytest.raises(asyncio.CancelledError):
            await writer
        assert not session.input_lock.locked()
        monkeypatch.setattr(terminal.os, 'write', lambda fd, data: len(data))
        await asyncio.wait_for(session.write_input('next'), timeout=1)

    asyncio.run(scenario())


def test_session_delivers_paste_to_real_child(monkeypatch, tmp_path):
    import hashlib
    import sys

    async def scenario():
        text = 'abc\u20ac\U0001f600\n' * 6000 + '__PASTE_TAIL__\n'
        expected = hashlib.sha256(text.encode()).hexdigest()
        child_code = (
            'import hashlib, os, signal, time, tty\n'
            'signal.alarm(15)\n'
            'tty.setraw(0)\n'
            'print("READY", flush=True)\n'
            'data = bytearray()\n'
            f'while len(data) < {len(text.encode())}:\n'
            f'    data.extend(os.read(0, {len(text.encode())} - len(data)))\n'
            'print(hashlib.sha256(data).hexdigest(), flush=True)\n'
            'time.sleep(10)\n'
        )
        real_popen = terminal.subprocess.Popen

        def start_child(command, **kwargs):
            # Use the production session's PTY/process setup, but never start a shell.
            return real_popen([sys.executable, '-u', '-c', child_code], **kwargs)

        monkeypatch.setattr(terminal.subprocess, 'Popen', start_child)
        monkeypatch.setattr(terminal, 'SESSIONS', {})
        monkeypatch.setattr(terminal, 'CLOSING_PROJECTS', {})
        session = terminal.TerminalSession(tmp_path)
        terminal.SESSIONS['project:terminal'] = session

        class ChildSocket(Socket):
            sent = False

            async def send_text(self, value):
                pass

            async def receive_text(self):
                marker = expected if self.sent else 'READY'
                while marker not in session.buffer:
                    await asyncio.sleep(.01)
                if not self.sent:
                    self.sent = True
                    return text
                return '{"action":"close"}'

        try:
            await asyncio.wait_for(terminal.attach(ChildSocket(text), 'project:terminal', tmp_path), timeout=10)
            assert expected in session.buffer
            assert session.proc.poll() is not None
            assert not terminal.SESSIONS
        finally:
            await session.close()
            terminal.SESSIONS.clear()

    asyncio.run(scenario())
