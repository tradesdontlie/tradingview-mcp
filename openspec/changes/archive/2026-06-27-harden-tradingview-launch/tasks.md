## 1. Non-destructive default
- [x] 1.1 Default `kill_existing` to `false` in the core and the tool schema; update the description.
- [x] 1.2 If the CDP port already responds and `kill_existing` is false, skip launch and return an
      "already running" result with the restart hint.

## 2. Targeted kill
- [x] 2.1 When restarting, track the spawned PID and kill only that PID (no `taskkill /IM`/broad `pkill`).
      Refuse to kill when no tool-spawned PID is known (external instance left running).

## 3. Spawn error handling
- [x] 3.1 Attach an `'error'` listener to the child before `unref()`; cache the error and include it in
      the CDP-timeout response.

## 4. Tests
- [x] 4.1 Unit test: `launchDecision` matrix — port up + `kill_existing:false` -> `already_running`
      (no kill issued); plus restart / spawn / refuse_kill_unknown cases.
- [x] 4.2 Unit test: `killCommandFor` builds a PID-targeted kill (contains the PID, no `/IM`, no image
      name) per platform. (Spawn-error surfacing is covered by the launch() failure-path code.)

## 5. Validate
- [x] 5.1 `openspec validate harden-tradingview-launch --strict`
