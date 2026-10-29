package logbrew

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"strings"
	"time"
)

const (
	DeliveryBackoffSourceNone   = "none"
	DeliveryBackoffSourceClient = "client"
	DeliveryBackoffSourceServer = "server"
)

const (
	DeliveryBackoffOutcomeNone      = "none"
	DeliveryBackoffOutcomeScheduled = "scheduled"
	DeliveryBackoffOutcomeHonored   = "honored"
	DeliveryBackoffOutcomeClamped   = "clamped"
	DeliveryBackoffOutcomeFallback  = "fallback"
)

// A rate-limited batch waits from 1 second to 1 hour before it is sent again.
const (
	minRateLimitWait       = time.Second
	maxRateLimitWait       = time.Hour
	rateLimitBodyLimit     = 4096
	rateLimitCodeLimited   = "rate_limited"
	rateLimitCodeExhausted = "usage_limit_exceeded"
)

type retryAfterDirective struct {
	present bool
	valid   bool
	delay   time.Duration
	clamped bool
	// code is a known `code` from a 429 response body.
	code string
}

type retryAfterTransport interface {
	sendWithRetryAfter(string, []byte, time.Duration) (*TransportResponse, retryAfterDirective, error)
}

func parseRetryAfter(values []string, now time.Time, maximum time.Duration) retryAfterDirective {
	if len(values) == 0 {
		return retryAfterDirective{}
	}
	directive := retryAfterDirective{present: true}
	if len(values) != 1 || maximum <= 0 {
		return directive
	}
	value := strings.Trim(values[0], " \t")
	if value == "" {
		return directive
	}

	if delay, valid, clamped := parseRetryAfterSeconds(value, maximum); valid {
		directive.valid = true
		directive.delay = delay
		directive.clamped = clamped
		return directive
	}

	date, err := time.Parse(http.TimeFormat, value)
	if err != nil || !date.After(now) {
		return directive
	}
	delay := date.Sub(now)
	directive.valid = true
	if delay > maximum {
		directive.delay = maximum
		directive.clamped = true
		return directive
	}
	directive.delay = delay
	return directive
}

// parseRateLimitRetryAfter reads Retry-After on a 429, where a past date counts as zero.
func parseRateLimitRetryAfter(values []string, now time.Time) retryAfterDirective {
	directive := parseRetryAfter(values, now, maxRateLimitWait)
	if directive.present && !directive.valid && len(values) == 1 {
		if _, err := time.Parse(http.TimeFormat, strings.Trim(values[0], " \t")); err == nil {
			directive.valid = true
		}
	}
	return directive
}

// readRateLimitCode reads at most 4 KiB of a 429 body, only to find a known code.
func readRateLimitCode(body io.Reader) string {
	data, err := io.ReadAll(io.LimitReader(body, rateLimitBodyLimit+1))
	if err != nil || len(data) > rateLimitBodyLimit {
		return ""
	}
	var parsed struct {
		Code string `json:"code"`
	}
	if json.Unmarshal(data, &parsed) != nil || (parsed.Code != rateLimitCodeLimited && parsed.Code != rateLimitCodeExhausted) {
		return ""
	}
	return parsed.Code
}

// rateLimitDelay bounds a rate-limit wait to 1 second through 1 hour, then adds up to 10 percent jitter.
func rateLimitDelay(delay time.Duration, jitter func(time.Duration) time.Duration) time.Duration {
	delay = min(max(delay, minRateLimitWait), maxRateLimitWait)
	return min(delay+jitter(delay/10), maxRateLimitWait)
}

func parseRetryAfterSeconds(value string, maximum time.Duration) (time.Duration, bool, bool) {
	maximumSeconds := uint64(maximum / time.Second)
	seconds := uint64(0)
	for _, current := range []byte(value) {
		if current < '0' || current > '9' {
			return 0, false, false
		}
		digit := uint64(current - '0')
		if seconds > maximumSeconds/10 || seconds == maximumSeconds/10 && digit > maximumSeconds%10 {
			return maximum, true, true
		}
		seconds = seconds*10 + digit
	}
	return time.Duration(seconds) * time.Second, true, false
}

func selectBackoff(clientDelay time.Duration, directive retryAfterDirective) (time.Duration, string, string) {
	if !directive.present {
		return clientDelay, DeliveryBackoffSourceClient, DeliveryBackoffOutcomeScheduled
	}
	if !directive.valid || directive.delay < clientDelay {
		return clientDelay, DeliveryBackoffSourceClient, DeliveryBackoffOutcomeFallback
	}
	outcome := DeliveryBackoffOutcomeHonored
	if directive.clamped {
		outcome = DeliveryBackoffOutcomeClamped
	}
	return directive.delay, DeliveryBackoffSourceServer, outcome
}

func incrementCounter(value uint64) uint64 {
	if value == math.MaxUint64 {
		return value
	}
	return value + 1
}

func durationMillis(delay time.Duration) uint64 {
	if delay <= 0 {
		return 0
	}
	milliseconds := delay / time.Millisecond
	if delay%time.Millisecond != 0 {
		milliseconds++
	}
	return uint64(milliseconds)
}
