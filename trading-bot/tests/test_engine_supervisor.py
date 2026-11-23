import threading
import time
import unittest

from tradingbot.engine_supervisor import EngineSupervisor


class EngineSupervisorTests(unittest.TestCase):
    def test_start_and_stop(self):
        entered = threading.Event()

        def runner(stop_event=None):
            entered.set()
            stop_event.wait(3)

        supervisor = EngineSupervisor(runner, stop_timeout=2)

        started, state = supervisor.start()
        self.assertTrue(started)
        self.assertTrue(entered.wait(1))

        stopped, state = supervisor.stop()
        self.assertTrue(stopped)
        self.assertEqual(state["state"], "STOPPED")
        self.assertFalse(state["alive"])

    def test_duplicate_start_is_rejected(self):
        entered = threading.Event()

        def runner(stop_event=None):
            entered.set()
            stop_event.wait(3)

        supervisor = EngineSupervisor(runner)
        first, _ = supervisor.start()
        self.assertTrue(first)
        self.assertTrue(entered.wait(1))

        second, state = supervisor.start()
        self.assertFalse(second)
        self.assertTrue(state["alive"])

        supervisor.stop()

    def test_runner_error_is_reported(self):
        def runner(stop_event=None):
            raise RuntimeError("test failure")

        supervisor = EngineSupervisor(runner)
        supervisor.start()

        deadline = time.time() + 2
        while supervisor.status()["alive"] and time.time() < deadline:
            time.sleep(0.01)

        state = supervisor.status()
        self.assertEqual(state["state"], "ERROR")
        self.assertIn("test failure", state["error"])

    def test_stop_when_already_stopped(self):
        supervisor = EngineSupervisor(lambda stop_event=None: None)
        stopped, state = supervisor.stop()

        self.assertTrue(stopped)
        self.assertEqual(state["state"], "STOPPED")


if __name__ == "__main__":
    unittest.main()
