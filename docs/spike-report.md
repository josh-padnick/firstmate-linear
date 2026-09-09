# Process-event protocol spike

## Target

The adapter targets Firstmate `process-event-adapter/1` with host protocol `1`.
The extension manifest pins both versions and declares only the `linear` adapter name.

## Proven boundaries

- `source.poll` is non-destructive and maps one stable request ID to one stable domain event.
- A retry before or after classification returns the same event ID for that request.
- `result.classify` records the immutable core sequence and returns the stored token without changing event meaning.
- `result.silent` returns true only for ignored or successfully service-relayed events and records transport completion.
- Actionable events stay in Firstmate core until a receipt-gated CLI action commits a durable `core.ack` job.
- The service socket has no public `event.handled` operation.
- If the process exits before acknowledgement, Firstmate retains the captured result and its normal drain re-announces it.
- A restarted service reopens the same SQLite delivery mapping, so it cannot allocate a different event to a retried request.

## Failure decision

The Firstmate adapter contract satisfies the required capture, classification, silent, deduplication, and re-announcement semantics.
The integration therefore uses the extension protocol and does not ship a parallel push-wake or check shim.

## Live result

The package was bound against Firstmate commit `50aeb00` in an isolated home and claim root.
The host polled one recorded event, captured it as sequence `1`, and returned the stored `comment` classification.
`inbox show` issued a one-event receipt, `inbox handle` committed a `core.ack` job, and the service invoked Firstmate's public `handled linear-main 1` interface.
The job completed on its first attempt and Firstmate reported zero pending captures.

The spike also exposed one contract detail that the package now preserves explicitly.
Firstmate sends `config_ref` only with `source.poll` and starts later result operations in a sanitized environment.
The adapter therefore adds the validated service socket reference to its own captured event envelope so classification, silence, and terminal checks return to the same service without relying on inherited process state.
The executable regression test covers that two-call boundary.

## Reproduction

Run the repository test suite, then run Firstmate's extension-binding integration suite at the upstream commit used for a release.
The release checklist also binds `extension/` into an isolated Firstmate home and exercises the host handshake plus all four adapter operations against a temporary service socket.
