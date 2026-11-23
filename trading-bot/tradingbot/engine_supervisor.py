"""Supervise the trading engine's single worker thread."""
import threading


class EngineSupervisor:
    STATES = {"STOPPED", "STARTING", "RUNNING", "STOPPING", "ERROR"}

    def __init__(self, runner, args=(), stop_timeout=15):
        self.runner = runner
        self.args = tuple(args)
        self.stop_timeout = stop_timeout

        self._lock = threading.RLock()
        self._thread = None
        self._stop_event = None
        self._state = "STOPPED"
        self._error = None

    def start(self):
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return False, self.status()

            self._stop_event = threading.Event()
            self._error = None
            self._state = "STARTING"

            self._thread = threading.Thread(
                target=self._run,
                name="tree-bot-engine",
                daemon=True,
            )

            try:
                self._thread.start()
            except Exception as exc:
                self._state = "ERROR"
                self._error = repr(exc)
                return False, self.status()

            return True, self.status()

    def _run(self):
        with self._lock:
            if self._state == "STARTING":
                self._state = "RUNNING"

        try:
            self.runner(*self.args, stop_event=self._stop_event)
        except Exception as exc:
            with self._lock:
                self._state = "ERROR"
                self._error = repr(exc)
        else:
            with self._lock:
                self._state = "STOPPED"

    def stop(self):
        with self._lock:
            thread = self._thread

            if thread is None or not thread.is_alive():
                if self._state != "ERROR":
                    self._state = "STOPPED"
                return True, self.status()

            self._state = "STOPPING"
            self._stop_event.set()

        thread.join(self.stop_timeout)

        with self._lock:
            stopped = not thread.is_alive()

            if stopped and self._state != "ERROR":
                self._state = "STOPPED"

            return stopped, self.status()

    def status(self):
        with self._lock:
            alive = self._thread is not None and self._thread.is_alive()
            return {
                "state": self._state,
                "alive": alive,
                "error": self._error,
            }
