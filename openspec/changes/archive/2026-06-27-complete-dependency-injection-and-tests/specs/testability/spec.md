## ADDED Requirements

### Requirement: Core CDP modules are dependency-injectable
Every core module that performs CDP I/O SHALL accept an optional `_deps` parameter resolved through a
`_resolve(deps)` helper that defaults to the real connection-layer imports, mirroring `src/core/drawing.js`.

#### Scenario: Mocked dependency in a unit test
- **WHEN** a core function is called with `_deps` providing a fake `evaluate`
- **THEN** the function uses the injected `evaluate` and runs without a live CDP connection

#### Scenario: Default behavior unchanged
- **WHEN** a core function is called without `_deps`
- **THEN** it resolves to the real connection-layer helpers and behaves as before

### Requirement: All unit suites run in the default test workflow
The npm test scripts SHALL include every DI-based unit suite so regression coverage runs by default.

#### Scenario: Default run includes sanitization and replay suites
- **WHEN** `npm run test:all` is executed
- **THEN** `tests/sanitization.test.js` and `tests/replay.test.js` are among the suites run

### Requirement: Failure paths have unit coverage
The behaviors tightened across these changes SHALL have failure-path unit tests that run without a live
TradingView.

#### Scenario: Graphics warning path covered
- **WHEN** a pine-graphics read is unit-tested with a mocked broken primitives shape
- **THEN** the test asserts a `_warnings` entry is returned rather than a silent empty result
