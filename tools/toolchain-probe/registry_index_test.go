package main

import "testing"

func TestRegistryCratesIndexPath(t *testing.T) {
	t.Parallel()
	for name, want := range map[string]string{
		"": "//", "a": "1/a", "ab": "2/ab", "abc": "3/a/abc", "abcd": "ab/cd/abcd",
		"logbrew": "lo/gb/logbrew", "åbc": "3/å/åbc",
	} {
		if got := registryCratesIndexPath(name); got != want {
			t.Errorf("index path for %q: got %q, want %q", name, got, want)
		}
	}
}
