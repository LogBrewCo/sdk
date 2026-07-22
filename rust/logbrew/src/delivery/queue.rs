use crate::{Event, SdkError};
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{self, Write};
use std::sync::Arc;

pub(super) const REQUEST_SUFFIX: &[u8] = b"]}";

#[derive(Debug)]
struct QueuedEvent {
    sequence: u64,
    bytes: Vec<u8>,
}

#[derive(Debug)]
pub(super) struct DeliveryQueue {
    events: VecDeque<QueuedEvent>,
    event_bytes: usize,
    next_sequence: u64,
    max_events: usize,
    max_event_bytes: usize,
}

impl DeliveryQueue {
    pub(super) fn new(max_events: usize, max_event_bytes: usize) -> Self {
        Self {
            events: VecDeque::new(),
            event_bytes: 0,
            next_sequence: 1,
            max_events,
            max_event_bytes,
        }
    }

    pub(super) fn len(&self) -> usize {
        self.events.len()
    }

    pub(super) fn event_bytes(&self) -> usize {
        self.event_bytes
    }

    pub(super) fn last_sequence(&self) -> Option<u64> {
        self.events.back().map(|event| event.sequence)
    }

    pub(super) fn push(&mut self, bytes: Vec<u8>) -> Result<(), QueueAdmissionError> {
        let next_bytes = self
            .event_bytes
            .checked_add(bytes.len())
            .ok_or(QueueAdmissionError::Full)?;
        if self.events.len() >= self.max_events || next_bytes > self.max_event_bytes {
            return Err(QueueAdmissionError::Full);
        }
        let next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or(QueueAdmissionError::Unavailable)?;
        self.events
            .try_reserve_exact(1)
            .map_err(|_| QueueAdmissionError::Unavailable)?;
        self.events.push_back(QueuedEvent {
            sequence: self.next_sequence,
            bytes,
        });
        self.next_sequence = next_sequence;
        self.event_bytes = next_bytes;
        Ok(())
    }

    pub(super) fn events(&self) -> Result<Vec<Event>, SdkError> {
        let mut events = Vec::new();
        events.try_reserve_exact(self.events.len()).map_err(|_| {
            SdkError::new(
                "serialization_error",
                "queued events could not be previewed",
            )
        })?;
        for event in &self.events {
            events.push(serde_json::from_slice(&event.bytes).map_err(|_| {
                SdkError::new("serialization_error", "queued event bytes are invalid")
            })?);
        }
        Ok(events)
    }

    pub(super) fn freeze(
        &self,
        snapshot_end: u64,
        request_prefix: &[u8],
        max_batch_events: usize,
        max_request_body_bytes: usize,
    ) -> Result<Option<Arc<FrozenPrefix>>, SdkError> {
        let Some(first) = self.events.front() else {
            return Ok(None);
        };
        if first.sequence > snapshot_end {
            return Ok(None);
        }

        let mut body = Vec::new();
        body.try_reserve_exact(request_prefix.len()).map_err(|_| {
            SdkError::new("serialization_error", "request body could not be allocated")
        })?;
        body.extend_from_slice(request_prefix);
        let mut event_count = 0;
        let mut last_sequence = first.sequence;
        for event in self
            .events
            .iter()
            .take_while(|event| event.sequence <= snapshot_end)
            .take(max_batch_events)
        {
            let separator_bytes = usize::from(event_count > 0);
            let candidate_bytes = body
                .len()
                .checked_add(separator_bytes)
                .and_then(|size| size.checked_add(event.bytes.len()))
                .and_then(|size| size.checked_add(REQUEST_SUFFIX.len()))
                .ok_or_else(|| {
                    SdkError::new("serialization_error", "request body size overflowed")
                })?;
            if candidate_bytes > max_request_body_bytes {
                if event_count == 0 {
                    return Err(SdkError::new(
                        "serialization_error",
                        "queued event no longer fits the request body limit",
                    ));
                }
                break;
            }
            body.try_reserve_exact(separator_bytes + event.bytes.len())
                .map_err(|_| {
                    SdkError::new("serialization_error", "request body could not be allocated")
                })?;
            if event_count > 0 {
                body.push(b',');
            }
            body.extend_from_slice(&event.bytes);
            event_count += 1;
            last_sequence = event.sequence;
        }
        body.try_reserve_exact(REQUEST_SUFFIX.len()).map_err(|_| {
            SdkError::new("serialization_error", "request body could not be allocated")
        })?;
        body.extend_from_slice(REQUEST_SUFFIX);
        Ok(Some(Arc::new(FrozenPrefix {
            first_sequence: first.sequence,
            last_sequence,
            event_count,
            body,
        })))
    }

    pub(super) fn acknowledge(&mut self, prefix: &FrozenPrefix) -> Result<(), SdkError> {
        if prefix.event_count == 0 || self.events.len() < prefix.event_count {
            return Err(SdkError::new(
                "queue_state_error",
                "accepted delivery prefix is not retained",
            ));
        }
        let mut expected = prefix.first_sequence;
        for event in self.events.iter().take(prefix.event_count) {
            if event.sequence != expected {
                return Err(SdkError::new(
                    "queue_state_error",
                    "accepted delivery prefix order changed",
                ));
            }
            expected = expected.checked_add(1).ok_or_else(|| {
                SdkError::new("queue_state_error", "accepted delivery sequence overflowed")
            })?;
        }
        let acknowledged_bytes = self
            .events
            .iter()
            .take(prefix.event_count)
            .try_fold(0usize, |total, event| total.checked_add(event.bytes.len()))
            .ok_or_else(|| {
                SdkError::new(
                    "queue_state_error",
                    "accepted delivery byte count overflowed",
                )
            })?;
        let last_sequence = self
            .events
            .get(prefix.event_count - 1)
            .map(|event| event.sequence)
            .ok_or_else(|| {
                SdkError::new("queue_state_error", "accepted delivery prefix disappeared")
            })?;
        if last_sequence != prefix.last_sequence {
            return Err(SdkError::new(
                "queue_state_error",
                "accepted delivery prefix boundary changed",
            ));
        }
        let remaining_bytes = self
            .event_bytes
            .checked_sub(acknowledged_bytes)
            .ok_or_else(|| {
                SdkError::new("queue_state_error", "delivery queue byte count changed")
            })?;

        for _ in 0..prefix.event_count {
            self.events.pop_front().ok_or_else(|| {
                SdkError::new("queue_state_error", "accepted delivery prefix disappeared")
            })?;
        }
        self.event_bytes = remaining_bytes;
        Ok(())
    }
}

#[derive(Debug)]
pub(super) struct FrozenPrefix {
    first_sequence: u64,
    last_sequence: u64,
    pub(super) event_count: usize,
    pub(super) body: Vec<u8>,
}

#[derive(Clone, Copy, Debug)]
pub(super) enum QueueAdmissionError {
    Full,
    Unavailable,
}

struct BoundedJsonWriter {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}

impl BoundedJsonWriter {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            limit,
            exceeded: false,
        }
    }
}

impl Write for BoundedJsonWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let Some(next_len) = self.bytes.len().checked_add(buffer.len()) else {
            self.exceeded = true;
            return Err(io::Error::new(io::ErrorKind::WriteZero, "bounded write"));
        };
        if next_len > self.limit {
            self.exceeded = true;
            return Err(io::Error::new(io::ErrorKind::WriteZero, "bounded write"));
        }
        self.bytes
            .try_reserve_exact(buffer.len())
            .map_err(|_| io::Error::other("bounded allocation"))?;
        self.bytes.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(super) fn serialize_bounded<T: Serialize>(
    value: &T,
    limit: usize,
) -> Result<Vec<u8>, SdkError> {
    let mut writer = BoundedJsonWriter::new(limit);
    match serde_json::to_writer(&mut writer, value) {
        Ok(()) => Ok(writer.bytes),
        Err(_) if writer.exceeded => Err(SdkError::new(
            "event_too_large",
            "event exceeds configured delivery limits",
        )),
        Err(_) => Err(SdkError::new(
            "serialization_error",
            "event could not be serialized",
        )),
    }
}

#[cfg(test)]
mod tests;
