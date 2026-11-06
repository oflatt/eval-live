"""Run opted-in collectors in separate processes; the parent owns persistence."""
from contextlib import contextmanager
from dataclasses import dataclass, field
import multiprocessing
from multiprocessing.connection import wait
import signal
import threading
import time

from .benchmarks import ProcessError, RunContext
from .store import validate_tables

STOP_GRACE_SECONDS = 1.0


@contextmanager
def ignore_interrupts():
    """Let cleanup finish after Ctrl+C, even if the user presses it again."""
    if threading.current_thread() is not threading.main_thread():
        yield
        return
    previous = signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        yield
    finally:
        signal.signal(signal.SIGINT, previous)


@dataclass
class Outcome:
    tables: dict = field(default_factory=dict)
    processes: list = field(default_factory=list)
    status: str = "success"
    error: str | None = None


def measure(function, arguments):
    context = RunContext(*arguments)
    outcome = Outcome(processes=context.processes)
    try:
        tables = function(context)
        validate_tables(tables, user=True)
        outcome.tables = tables
    except KeyboardInterrupt:
        outcome.status, outcome.error = "interrupted", "interrupted by user"
    except Exception as error:
        outcome.status = error.result.status if isinstance(error, ProcessError) else "failure"
        outcome.error = str(error)
    return outcome


def _interrupt(signum, frame):
    # RunContext.command catches this and terminates its subprocess group.
    raise KeyboardInterrupt


def _entry(connection, function, arguments):
    signal.signal(signal.SIGINT, signal.SIG_IGN)  # the parent coordinates cancellation
    signal.signal(signal.SIGTERM, _interrupt)
    try:
        outcome = measure(function, arguments)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        connection.send(outcome)
    finally:
        connection.close()


class Worker:
    def __init__(self, function, arguments):
        self.cancel_deadline = None
        self.closed = False
        self.outcome = Outcome(status="interrupted", error="interrupted while receiving collector result")
        context = multiprocessing.get_context("spawn")
        self.connection, sender = context.Pipe(duplex=False)
        self.process = context.Process(target=_entry, args=(sender, function, arguments))
        try:
            self.process.start()
        except BaseException:
            with ignore_interrupts():
                sender.close()
                if self.process.pid is not None:
                    self.cancel()
                    self.result()
                else:
                    self.connection.close()
            raise
        finally:
            sender.close()

    def cancel(self):
        """Request cancellation; result() enforces a bounded grace period."""
        if self.closed or self.cancel_deadline is not None:
            return
        self.cancel_deadline = time.monotonic() + STOP_GRACE_SECONDS
        if self.process.is_alive():
            self.process.terminate()

    def result(self):
        """Receive diagnostics and reap the worker, forcibly if cancellation stalls."""
        if self.closed:
            return self.outcome
        try:
            if self.cancel_deadline is not None:
                remaining = max(0, self.cancel_deadline - time.monotonic())
                if not self.connection.poll(remaining) and self.process.is_alive():
                    self.process.kill()
            self.outcome = self.connection.recv()
        except (EOFError, OSError):
            self.outcome = Outcome(status="interrupted" if self.cancel_deadline is not None else "failure",
                                   error="collector process exited without returning a result")
        finally:
            with ignore_interrupts():
                self.connection.close()
                self.process.join(STOP_GRACE_SECONDS)
                if self.process.is_alive():
                    self.process.kill()
                    self.process.join()
                self.process.close()
                self.closed = True
        return self.outcome


def completed(workers):
    """Wait for any result, including a worker that exited unexpectedly."""
    ready = wait([worker.connection for worker in workers])
    return next(worker for worker in workers if worker.connection in ready)
