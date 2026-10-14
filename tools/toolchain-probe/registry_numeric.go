package main

import (
	"math"
	"strconv"
	"time"
)

const (
	registryDefaultTimeout    = 20 * time.Second
	registryDefaultRetries    = 6
	registryDefaultRetryDelay = 10 * time.Second
)

type registryNumericOptions struct {
	timeout time.Duration
	retry   registryRetryPolicy
}

func registryLastValue(arguments *registryArguments, name, fallback string) string {
	values := arguments.values[name]
	if len(values) == 0 {
		return fallback
	}
	return values[len(values)-1]
}

func registrySeconds(raw string, minimum time.Duration) (time.Duration, bool) {
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 ||
		value >= float64(math.MaxInt64)/float64(time.Second) {
		return 0, false
	}
	duration := time.Duration(value * float64(time.Second))
	return duration, duration >= minimum
}

func registryNumericArguments(arguments *registryArguments) *registryNumericOptions {
	if arguments == nil {
		return nil
	}
	timeout, valid := registrySeconds(registryLastValue(arguments, "timeout", "20"), time.Nanosecond)
	if !valid {
		return nil
	}
	delay, valid := registrySeconds(registryLastValue(arguments, "retry-delay", "10"), 0)
	if !valid {
		return nil
	}
	retries, err := strconv.Atoi(registryLastValue(arguments, "retries", "6"))
	if err != nil || retries < 0 {
		return nil
	}
	return &registryNumericOptions{timeout: timeout, retry: registryRetryPolicy{
		retries: retries, delay: delay, absent: arguments.switches["expect-absent"],
	}}
}
