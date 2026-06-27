# tradingview-launch Specification

## Purpose
TBD - created by archiving change harden-tradingview-launch. Update Purpose after archive.
## Requirements
### Requirement: Launch does not kill existing sessions by default
`tv_launch` SHALL default to not killing existing TradingView processes, and SHALL skip launching when a
CDP-responsive instance is already running.

#### Scenario: Already running
- **WHEN** `tv_launch` is invoked and the CDP port already responds, with `kill_existing` not set
- **THEN** no process is killed and the result indicates TradingView is already running with a restart hint

#### Scenario: Explicit restart
- **WHEN** `tv_launch` is invoked with `kill_existing: true`
- **THEN** a restart is performed

### Requirement: Restart kills only the spawned process
When a restart is requested, the launcher SHALL terminate only the process it previously spawned (by
PID), not all processes matching the TradingView image name.

#### Scenario: Multiple TradingView windows open
- **WHEN** a restart is requested while several TradingView windows are open
- **THEN** only the tool-managed process is terminated and unrelated windows are left running

### Requirement: Spawn failures are surfaced
The launcher SHALL attach an error handler to the spawned process and SHALL surface a spawn failure in
its response rather than misreporting it as a CDP-not-responding timeout.

#### Scenario: Binary fails to start
- **WHEN** the spawned TradingView process emits an error (e.g. permission denied)
- **THEN** the launch result reports that spawn error as the cause

