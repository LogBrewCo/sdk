package logbrew

import (
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

type retryAfterDirective struct {
	present bool
	valid   bool
	delay   time.Duration
	clamped bool
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
