# Redacted fixtures

This directory contains only identity-safe GraphQL shapes suitable for deterministic replay.

Set `FM_LINEAR_RECORD_DIR` to a private empty directory while running a trusted live cycle.
The transport replaces identifiers, names, email addresses, URLs, titles, descriptions, and human-authored content before writing mode-`0600` files.
Review every recorded fixture before committing it.

Set `FM_LINEAR_FIXTURE_DIR` to replay a lexically ordered fixture directory without network access.
File names containing `fail-429`, `fail-500`, or another status simulate that HTTP response.
File names containing `malformed` simulate an invalid JSON response.
