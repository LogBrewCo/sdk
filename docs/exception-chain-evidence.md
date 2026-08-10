# Exception-chain evidence

One reported exception is often only the wrapper. The actionable failure can
be an earlier cause, a runtime context exception, one member of an aggregate,
or a suppressed exception. LogBrew issue events can therefore carry a bounded
`exceptionChain` beside the existing `exception` and `stackFrames` fields.

## Wire contract

`exceptionChain.entries` is a parent-first array with one to eight entries.
Entry IDs are contiguous array indexes. Entry `0` is always the parentless
`reported` exception. Every later entry names an earlier `parentId` and one of
`cause`, `context`, `aggregate_member`, or `suppressed`. `truncated: true`
means a depth, width, cycle, unreadable runtime edge, or SDK bound prevented a
complete graph.

The reported entry deliberately repeats the legacy exception and stack
evidence. Its type and mechanism must exactly match `exception`; its frames
must exactly match `stackFrames`. This keeps older readers useful while newer
API, CLI, dashboard, and agent consumers can explain the full graph. SDKs
reject contradictory roots, forward parent references, gaps, and oversized
graphs before queue admission.

Every entry carries explicit evidence states:

- `messageState` is `captured`, `truncated`, `redacted`, or `not_captured`.
  A message is present only for `captured` or `truncated`.
- `stackFramesState` is `captured`, `truncated`, or `not_captured`. Frames are
  present only for `captured` or `truncated` and remain capped at 32.
- Optional module and mechanism fields retain bounded code/runtime identity
  and handled state without requiring exception text.

SDKs never invent a cause, message, frame, or historical backfill. Automatic
runtime projection normally marks exception messages `redacted` and omits the
text. A `captured` message is caller-owned evidence and must already be
approved for telemetry. Structured frames keep bounded code identity; they do
not contain source lines, locals, arguments, or raw stack text.

## Runtime projection

Automatic helpers follow the native relationship model where the runtime has
one: JavaScript `cause` and `AggregateError`, Python cause/context and exception
groups, JVM causes and suppressed exceptions, .NET inner and aggregate
exceptions, Go `Unwrap`, Rust `Error::source`, PHP previous exceptions, Ruby
causes, Swift/Objective-C underlying `NSError` values, and Unity inner and
aggregate exceptions. Cycles and unsafe accessors fail closed and set the
chain's truncation receipt.

C and portable C++ have no universal runtime cause API. Their public issue
detail types accept the same manual bounded chain, validate it against the
legacy root, and serialize the identical wire shape. This preserves evidence
honestly instead of guessing from strings or implementation-specific memory.

Framework adapters stay thin over their ecosystem core. An adapter that uses
the core exception helper inherits the same chain, bounds, and privacy states;
it must not rebuild a weaker wrapper-only issue payload.
