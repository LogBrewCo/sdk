package logbrew

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"time"
)

const (
	defaultFlushInterval  = 2 * time.Second
	defaultFlushThreshold = 100
	defaultRetryBaseDelay = 100 * time.Millisecond
	defaultRetryMaxDelay  = 5 * time.Second
)

const (
	DeliveryStateManual         = "manual"
	DeliveryStateRunning        = "running"
	DeliveryStatePaused         = "paused"
	DeliveryStateShuttingDown   = "shutting_down"
	DeliveryStateShutdownFailed = "shutdown_failed"
	DeliveryStateShutdown       = "shutdown"
)

const (
	DeliveryOutcomeNone                = "none"
	DeliveryOutcomeAccepted            = "accepted"
	DeliveryOutcomeRetryableFailure    = "retryable_failure"
	DeliveryOutcomeAuthenticationPause = "authentication_paused"
	DeliveryOutcomeQuotaPause          = "quota_paused"
	DeliveryOutcomeNonRetryablePause   = "nonretryable_paused"
	DeliveryOutcomeShutdownFailed      = "shutdown_failed"
)

// AutomaticDeliveryConfig configures client-owned delivery through one
// transport. NewClient remains fully manual; NewAutomaticClient opts in.
type AutomaticDeliveryConfig struct {
	Transport      Transport
	FlushInterval  time.Duration
	FlushThreshold int
	RetryBaseDelay time.Duration
	RetryMaxDelay  time.Duration
}

// DeliveryHealth is a fixed, content-free snapshot of local delivery state.
type DeliveryHealth struct {
	State          string `json:"state"`
	PendingEvents  int    `json:"pendingEvents"`
	DroppedEvents  int    `json:"droppedEvents"`
	InFlight       bool   `json:"inFlight"`
	WakePending    bool   `json:"wakePending"`
	LastOutcome    string `json:"lastOutcome"`
	Flushes        uint64 `json:"flushes"`
	Attempts       uint64 `json:"attempts"`
	AcceptedEvents uint64 `json:"acceptedEvents"`
	FailedFlushes  uint64 `json:"failedFlushes"`
	RetrySchedules uint64 `json:"retrySchedules"`
}

type automaticDelivery struct {
	transport      Transport
	flushInterval  time.Duration
	flushThreshold int
	retryBaseDelay time.Duration
	retryMaxDelay  time.Duration
	wake           chan struct{}
	stop           chan struct{}
	done           chan struct{}
	jitter         func(time.Duration) time.Duration
	started        bool
	stopped        bool
}

type deliveryHealthState struct {
	state          string
	inFlight       bool
	wakePending    bool
	lastOutcome    string
	flushes        uint64
	attempts       uint64
	acceptedEvents uint64
	failedFlushes  uint64
	retrySchedules uint64
}

type flushResult struct {
	attempts  int
	retryable bool
	pause     string
}

func configureAutomaticDelivery(config *AutomaticDeliveryConfig, maxQueueSize int) (*automaticDelivery, error) {
	if config == nil {
		return nil, nil
	}
	if config.Transport == nil {
		return nil, &SdkError{Code: "configuration_error", Message: "automatic delivery transport must be configured"}
	}
	if config.FlushInterval < 0 || config.FlushThreshold < 0 || config.RetryBaseDelay < 0 || config.RetryMaxDelay < 0 {
		return nil, &SdkError{Code: "configuration_error", Message: "automatic delivery durations and threshold must be non-negative"}
	}
	interval := config.FlushInterval
	if interval == 0 {
		interval = defaultFlushInterval
	}
	threshold := config.FlushThreshold
	if threshold == 0 {
		threshold = min(defaultFlushThreshold, maxQueueSize)
	}
	if threshold > maxQueueSize {
		return nil, &SdkError{Code: "configuration_error", Message: "automatic delivery threshold must not exceed max queue size"}
	}
	baseDelay := config.RetryBaseDelay
	if baseDelay == 0 {
		baseDelay = defaultRetryBaseDelay
	}
	maxDelay := config.RetryMaxDelay
	if maxDelay == 0 {
		maxDelay = defaultRetryMaxDelay
	}
	if maxDelay < baseDelay {
		return nil, &SdkError{Code: "configuration_error", Message: "automatic delivery max retry delay must not be less than base retry delay"}
	}
	return &automaticDelivery{
		transport:      config.Transport,
		flushInterval:  interval,
		flushThreshold: threshold,
		retryBaseDelay: baseDelay,
		retryMaxDelay:  maxDelay,
		wake:           make(chan struct{}, 1),
		stop:           make(chan struct{}),
		done:           make(chan struct{}),
		jitter:         equalJitter,
	}, nil
}

// DeliveryHealth returns a fixed local snapshot with no event content,
// identifiers, keys, endpoint data, headers, or raw transport errors.
func (c *Client) DeliveryHealth() DeliveryHealth {
	c.mu.Lock()
	defer c.mu.Unlock()
	return DeliveryHealth{
		State:          c.health.state,
		PendingEvents:  len(c.events),
		DroppedEvents:  c.droppedEvents,
		InFlight:       c.health.inFlight,
		WakePending:    c.health.wakePending,
		LastOutcome:    c.health.lastOutcome,
		Flushes:        c.health.flushes,
		Attempts:       c.health.attempts,
		AcceptedEvents: c.health.acceptedEvents,
		FailedFlushes:  c.health.failedFlushes,
		RetrySchedules: c.health.retrySchedules,
	}
}

// ResumeDelivery resumes an automatically managed client after a terminal
// authentication, quota, or non-retryable pause.
func (c *Client) ResumeDelivery() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.automatic == nil {
		return &SdkError{Code: "configuration_error", Message: "automatic delivery is not configured"}
	}
	if c.closed || c.shuttingDown {
		return &SdkError{Code: "shutdown_error", Message: "client is already shut down"}
	}
	c.health.state = DeliveryStateRunning
	c.health.lastOutcome = DeliveryOutcomeNone
	if len(c.events) > 0 {
		c.startAutomaticLocked()
		c.signalAutomaticLocked()
	}
	return nil
}

// Flush sends queued events through a transport while preserving retry
// semantics. It freezes one snapshot, and a nil transport uses an owned
// automatic transport when configured.
func (c *Client) Flush(transport Transport) (*TransportResponse, error) {
	c.mu.Lock()
	if c.closed || c.shuttingDown && !c.shutdownFailed {
		c.mu.Unlock()
		return nil, &SdkError{Code: "shutdown_error", Message: "client is already shut down"}
	}
	transport = c.resolveTransportLocked(transport)
	c.mu.Unlock()
	response, _, err := c.flushSnapshot(transport)
	return response, err
}

// Shutdown flushes queued events, then marks the client closed so later writes
// fail. It first stops automatic scheduling, and a nil transport uses the owned
// automatic transport when configured.
func (c *Client) Shutdown(transport Transport) (*TransportResponse, error) {
	c.mu.Lock()
	if c.closed || c.shuttingDown && !c.shutdownFailed {
		c.mu.Unlock()
		return nil, &SdkError{Code: "shutdown_error", Message: "client is already shut down"}
	}
	wasAutomatic := c.automatic != nil
	c.shuttingDown = true
	c.shutdownFailed = false
	c.health.state = DeliveryStateShuttingDown
	transport = c.resolveTransportLocked(transport)
	started := c.stopAutomaticLocked()
	c.mu.Unlock()

	if started {
		<-c.automatic.done
	}
	response, _, err := c.flushSnapshot(transport)
	c.finishShutdown(err, wasAutomatic)
	return response, err
}

func (c *Client) finishShutdown(err error, wasAutomatic bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err == nil {
		c.closed = true
		c.shuttingDown = false
		c.health.state = DeliveryStateShutdown
		return
	}
	if wasAutomatic {
		c.shutdownFailed = true
		c.health.state = DeliveryStateShutdownFailed
		c.health.lastOutcome = DeliveryOutcomeShutdownFailed
		return
	}
	c.shuttingDown = false
	c.health.state = DeliveryStateManual
}

func (c *Client) resolveTransportLocked(transport Transport) Transport {
	if transport == nil && c.automatic != nil {
		return c.automatic.transport
	}
	return transport
}

func (c *Client) startAutomaticLocked() {
	if c.automatic == nil || c.automatic.started || c.automatic.stopped {
		return
	}
	c.automatic.started = true
	go c.deliveryLoop()
}

func (c *Client) signalAutomaticLocked() {
	if c.automatic == nil || c.automatic.stopped || c.health.state != DeliveryStateRunning || c.health.wakePending {
		return
	}
	c.health.wakePending = true
	select {
	case c.automatic.wake <- struct{}{}:
	default:
	}
}

func (c *Client) stopAutomaticLocked() bool {
	if c.automatic == nil || c.automatic.stopped {
		return c.automatic != nil && c.automatic.started
	}
	c.automatic.stopped = true
	c.health.wakePending = false
	close(c.automatic.stop)
	return c.automatic.started
}

func (c *Client) deliveryLoop() {
	defer close(c.automatic.done)
	timer := time.NewTimer(c.automatic.flushInterval)
	defer timer.Stop()
	retrying := false
	retryStreak := uint64(0)

	for {
		c.mu.Lock()
		paused := c.health.state == DeliveryStatePaused
		c.mu.Unlock()
		if paused {
			stopTimer(timer)
			select {
			case <-c.automatic.stop:
				return
			case <-c.automatic.wake:
				c.mu.Lock()
				c.health.wakePending = false
				c.mu.Unlock()
				retrying = false
				retryStreak = 0
			}
		} else {
			select {
			case <-c.automatic.stop:
				return
			case <-c.automatic.wake:
				c.mu.Lock()
				if retrying {
					c.health.wakePending = true
					c.mu.Unlock()
					continue
				}
				c.health.wakePending = false
				c.mu.Unlock()
			case <-timer.C:
				c.mu.Lock()
				c.health.wakePending = false
				c.mu.Unlock()
			}
		}

		c.mu.Lock()
		stopped := c.automatic.stopped
		paused = c.health.state == DeliveryStatePaused
		c.mu.Unlock()
		if stopped {
			return
		}
		if paused {
			continue
		}
		_, result, _ := c.flushSnapshot(c.automatic.transport)
		c.mu.Lock()
		paused = c.health.state == DeliveryStatePaused
		c.mu.Unlock()
		if paused {
			continue
		}
		retrying = result.retryable
		delay := c.automatic.flushInterval
		if retrying {
			retryStreak++
			delay = c.retryDelay(retryStreak)
		} else {
			retryStreak = 0
		}
		resetTimer(timer, delay)
	}
}

func (c *Client) retryDelay(retryStreak uint64) time.Duration {
	c.mu.Lock()
	c.health.retrySchedules++
	c.mu.Unlock()

	delay := c.automatic.retryBaseDelay
	for current := uint64(1); current < retryStreak && delay < c.automatic.retryMaxDelay; current++ {
		if delay > c.automatic.retryMaxDelay/2 {
			delay = c.automatic.retryMaxDelay
			break
		}
		delay *= 2
	}
	if delay > c.automatic.retryMaxDelay {
		delay = c.automatic.retryMaxDelay
	}
	return c.automatic.jitter(delay)
}

func equalJitter(delay time.Duration) time.Duration {
	half := delay / 2
	if half == 0 {
		return delay
	}
	return half + time.Duration(rand.Int63n(int64(half)+1))
}

func stopTimer(timer *time.Timer) {
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
}

func resetTimer(timer *time.Timer, delay time.Duration) {
	stopTimer(timer)
	timer.Reset(delay)
}

func (c *Client) flushSnapshot(transport Transport) (*TransportResponse, flushResult, error) {
	c.flushMu.Lock()
	defer c.flushMu.Unlock()

	c.mu.Lock()
	if len(c.events) == 0 {
		c.mu.Unlock()
		return &TransportResponse{StatusCode: http.StatusNoContent, Attempts: 0}, flushResult{}, nil
	}
	if transport == nil {
		c.mu.Unlock()
		return nil, flushResult{}, &SdkError{Code: "configuration_error", Message: "transport must be configured"}
	}
	prefixLength := c.pendingPrefix
	body := c.pendingBody
	if body == nil {
		prefixLength = len(c.events)
		var err error
		body, err = json.MarshalIndent(eventBatch{SDK: c.sdk, Events: c.events[:prefixLength]}, "", "  ")
		if err != nil {
			c.mu.Unlock()
			return nil, flushResult{}, &SdkError{Code: "serialization_error", Message: err.Error()}
		}
	}
	c.health.inFlight = true
	c.health.flushes++
	c.mu.Unlock()

	response, result, sendErr := c.sendBody(transport, body)

	c.mu.Lock()
	c.health.inFlight = false
	c.health.attempts += uint64(result.attempts)
	if sendErr == nil {
		remaining := copy(c.events, c.events[prefixLength:])
		clear(c.events[remaining:])
		c.events = c.events[:remaining]
		c.pendingBody = nil
		c.pendingPrefix = 0
		c.health.acceptedEvents += uint64(prefixLength)
		c.health.lastOutcome = DeliveryOutcomeAccepted
		if c.automatic != nil && len(c.events) >= c.automatic.flushThreshold {
			c.signalAutomaticLocked()
		}
	} else {
		if c.pendingBody == nil {
			c.pendingBody = body
			c.pendingPrefix = prefixLength
		}
		c.health.failedFlushes++
		c.health.lastOutcome = DeliveryOutcomeRetryableFailure
		if result.pause != "" && c.automatic != nil {
			c.health.state = DeliveryStatePaused
			c.health.lastOutcome = result.pause
			c.health.wakePending = false
			select {
			case <-c.automatic.wake:
			default:
			}
		}
	}
	c.mu.Unlock()
	return response, result, sendErr
}

func (c *Client) sendBody(transport Transport, body []byte) (*TransportResponse, flushResult, error) {
	maxAttempts := c.maxRetries + 1
	result := flushResult{}
	for attempts := 1; attempts <= maxAttempts; attempts++ {
		result.attempts = attempts
		response, sendErr := transport.Send(c.apiKey, append([]byte(nil), body...))
		if sendErr != nil {
			var transportErr *TransportError
			if !AsTransportError(sendErr, &transportErr) {
				result.pause = DeliveryOutcomeNonRetryablePause
				return nil, result, sendErr
			}
			result.retryable = transportErr.Retryable
			if transportErr.Retryable && attempts < maxAttempts {
				continue
			}
			if !transportErr.Retryable {
				result.pause = DeliveryOutcomeNonRetryablePause
			}
			return nil, result, &SdkError{Code: transportErr.Code, Message: transportErr.Message}
		}
		if response == nil {
			result.pause = DeliveryOutcomeNonRetryablePause
			return nil, result, &SdkError{Code: "transport_error", Message: "transport returned no response"}
		}
		statusCode := response.StatusCode
		switch {
		case statusCode >= 200 && statusCode < 300:
			return &TransportResponse{StatusCode: statusCode, Attempts: attempts}, result, nil
		case statusCode == http.StatusUnauthorized || statusCode == http.StatusForbidden:
			result.pause = DeliveryOutcomeAuthenticationPause
			return nil, result, &SdkError{Code: "unauthenticated", Message: "transport rejected the API key"}
		case statusCode == http.StatusPaymentRequired || statusCode == http.StatusTooManyRequests:
			result.pause = DeliveryOutcomeQuotaPause
			return nil, result, &SdkError{Code: "quota_exceeded", Message: "transport paused delivery for quota"}
		case statusCode == http.StatusRequestTimeout || statusCode >= 500:
			result.retryable = true
			if attempts < maxAttempts {
				continue
			}
			return nil, result, &SdkError{Code: "transport_error", Message: fmt.Sprintf("unexpected transport status %d", statusCode)}
		default:
			result.pause = DeliveryOutcomeNonRetryablePause
			return nil, result, &SdkError{Code: "transport_error", Message: fmt.Sprintf("unexpected transport status %d", statusCode)}
		}
	}
	return nil, result, &SdkError{Code: "transport_error", Message: "exhausted retries"}
}
