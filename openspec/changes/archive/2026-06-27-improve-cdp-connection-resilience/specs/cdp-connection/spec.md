## ADDED Requirements

### Requirement: CDP discovery is time-bounded
CDP target discovery SHALL impose a request deadline so a wedged TradingView cannot block a tool call
indefinitely.

#### Scenario: Discovery hangs
- **WHEN** the CDP `/json/list` endpoint accepts the connection but never responds
- **THEN** the request aborts at the deadline and the connection attempt fails fast

### Requirement: Transient socket drops self-heal once
The `evaluate()` path SHALL retry exactly once after a connection-reset class error by reconnecting the
client before re-issuing the call, then propagate the error if the retry also fails.

#### Scenario: Socket dropped mid-call
- **WHEN** the CDP socket drops between obtaining the client and evaluating
- **THEN** the client is rebuilt and the evaluation is retried once
- **AND** a persistent failure still surfaces an error to the caller

### Requirement: Liveness probing does not tax every call
The connection liveness check SHALL be throttled (or replaced by a disconnect handler) so it does not add
a CDP round-trip to every single tool invocation.

#### Scenario: Rapid successive calls
- **WHEN** multiple tool calls occur within a short window on a healthy connection
- **THEN** the liveness probe is not re-run for each call

### Requirement: Connection wait is bounded in total
The connection retry budget SHALL bound total elapsed wait so the system fails reasonably fast when
TradingView is down, rather than only capping each individual backoff delay.

#### Scenario: TradingView is down
- **WHEN** no CDP target is reachable
- **THEN** the connection attempt gives up within the bounded total wait

### Requirement: Streams never corrupt the MCP transport
Stream functions SHALL NOT write to `process.stdout`/`process.stderr` when reachable from the MCP path;
output SHALL go through an injectable sink owned by the CLI consumer.

#### Scenario: Stream invoked outside the CLI
- **WHEN** a stream function runs without a CLI output sink
- **THEN** it does not write JSONL/banner text to the process stdio streams

### Requirement: Streams back off and escalate on repeated errors
On repeated CDP errors a stream SHALL back off exponentially (to a cap) and SHALL surface a visible
error signal after a threshold of consecutive failures, rather than retrying silently forever.

#### Scenario: Extended CDP outage
- **WHEN** the CDP connection fails repeatedly during a stream
- **THEN** the retry delay increases up to a cap
- **AND** after the consecutive-failure threshold an error event/line is emitted
