<?php

declare(strict_types=1);

namespace LogBrew;

/** Builder for one immutable, privacy-bounded telemetry context. */
final class TelemetryContextBuilder
{
    private ?TelemetryResource $resource = null;

    /** @var array<string, mixed>|null */
    private ?array $trace = null;

    /** @var array<string, string>|null */
    private ?array $session = null;

    /** @var array{id:string, kind:string}|null */
    private ?array $subject = null;

    /** @var array<string, string> */
    private array $tags = [];

    /** Set stable resource identity. */
    public function withResource(TelemetryResource $resource): self
    {
        $this->resource = $resource;
        return $this;
    }

    /** Set exact W3C correlation from an existing LogBrew trace. */
    public function withTrace(LogBrewTraceContext $trace): self
    {
        return $this->withTraceIds(
            $trace->traceId,
            $trace->spanId,
            $trace->parentSpanId,
            $trace->sampled
        );
    }

    /** Set exact W3C trace and optional span correlation. */
    public function withTraceIds(
        string $traceId,
        ?string $spanId = null,
        ?string $parentSpanId = null,
        ?bool $sampled = null
    ): self {
        $trace = ['traceId' => TelemetryContextValue::traceId($traceId)];
        $normalizedSpanId = TelemetryContextValue::optionalSpanId($spanId, 'spanId');
        if ($normalizedSpanId !== null) {
            $trace['spanId'] = $normalizedSpanId;
        }
        $normalizedParentSpanId = TelemetryContextValue::optionalSpanId($parentSpanId, 'parentSpanId');
        if ($normalizedParentSpanId !== null) {
            $trace['parentSpanId'] = $normalizedParentSpanId;
        }
        if ($sampled !== null) {
            $trace['sampled'] = $sampled;
        }
        $this->trace = $trace;
        return $this;
    }

    /** Set opaque current and optional previous session identities. */
    public function withSession(string $id, ?string $previousId = null): self
    {
        $normalizedId = TelemetryContextValue::requiredId($id, 'session id');
        $normalizedPreviousId = TelemetryContextValue::optionalId($previousId, 'session previousId');
        if ($normalizedPreviousId === $normalizedId) {
            throw TelemetryContextValue::invalid('session previousId must differ from id');
        }
        $session = ['id' => $normalizedId];
        if ($normalizedPreviousId !== null) {
            $session['previousId'] = $normalizedPreviousId;
        }
        $this->session = $session;
        return $this;
    }

    /** Set an opaque anonymous or user subject ID; never pass direct PII. */
    public function withSubject(string $id, string $kind): self
    {
        if ($kind !== 'anonymous' && $kind !== 'user') {
            throw TelemetryContextValue::invalid('subject kind must be anonymous or user');
        }
        $this->subject = [
            'id' => TelemetryContextValue::requiredId($id, 'subject id'),
            'kind' => $kind,
        ];
        return $this;
    }

    /** Add or replace one bounded low-cardinality tag. */
    public function withTag(string $key, string $value): self
    {
        $normalizedKey = TelemetryContextValue::tagKey($key);
        $this->tags[$normalizedKey] = TelemetryContextValue::requiredString($value, "tag value for {$normalizedKey}");
        if (count($this->tags) > TelemetryContextValue::MAX_TAGS) {
            TelemetryContextValue::requireTagCount(count($this->tags));
        }
        return $this;
    }

    /** @param array<string, string> $tags */
    public function withTags(array $tags): self
    {
        foreach ($tags as $key => $value) {
            if (!is_string($key) || !is_string($value)) {
                throw TelemetryContextValue::invalid('tags must contain string keys and values');
            }
            $this->withTag($key, $value);
        }
        return $this;
    }

    /** Validate, detach, and build one non-empty schema-v1 context. */
    public function build(): TelemetryContext
    {
        $value = ['schemaVersion' => TelemetryContext::SCHEMA_VERSION];
        if ($this->resource !== null) {
            $value['resource'] = $this->resource->toArray();
        }
        if ($this->trace !== null) {
            $value['trace'] = $this->trace;
        }
        if ($this->session !== null) {
            $value['session'] = $this->session;
        }
        if ($this->subject !== null) {
            $value['subject'] = $this->subject;
        }
        if ($this->tags !== []) {
            ksort($this->tags, SORT_STRING);
            TelemetryContextValue::requireTagCount(count($this->tags));
            $value['tags'] = $this->tags;
        }

        return TelemetryContext::fromArray($value);
    }
}
