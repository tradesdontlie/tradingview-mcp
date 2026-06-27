## ADDED Requirements

### Requirement: Screenshot retention is bounded
Screenshot capture SHALL enforce a configurable retention policy (by age, count, or total bytes) so the
`screenshots/` directory does not grow without bound across repeated runs.

#### Scenario: Old screenshots pruned
- **WHEN** a capture is taken and the directory exceeds the configured retention bound
- **THEN** screenshots beyond the bound are removed

#### Scenario: Persistence configurable
- **WHEN** a caller requests a non-persistent capture
- **THEN** the artifact is not retained beyond its use according to the configured policy

### Requirement: Filenames are traversal-safe
Screenshot output filenames SHALL be reduced to a safe basename so caller-supplied path segments cannot
write outside the screenshots directory.

#### Scenario: Path traversal attempt
- **WHEN** a filename containing `..` path segments is supplied
- **THEN** the file is written inside the screenshots directory under a sanitized name

### Requirement: Capture I/O is efficient and non-blocking
Screenshot writes SHALL decode the image payload once and SHALL use asynchronous file writes so the
stdio transport is not blocked.

#### Scenario: Single decode, async write
- **WHEN** a screenshot is captured
- **THEN** the base64 payload is decoded a single time and written with an asynchronous write
- **AND** the reported byte size is taken from that same decoded buffer
