package main

import (
	"strconv"
	"testing"
)

const registryCratesFixtureVersion = "1.0.0"

func TestRegistryCratesIndexSeparators(t *testing.T) {
	t.Parallel()
	for _, separator := range []string{
		"\n", "\r", "\r\n", "\v", "\f", "\x1c", "\x1d", "\x1e",
		"\u0085", "\u2028", "\u2029",
	} {
		index := `{"vers":"1.0.0"}` + separator + `{"vers":"2.0.0"}`
		if len(registryCratesVersions(index)) != 2 {
			t.Errorf("supported sparse-index separator rejected: %q", separator)
		}
	}
}

func TestRegistryCratesYankedTruth(t *testing.T) {
	t.Parallel()
	for _, flag := range []string{fixtureNullJSON, strconv.FormatBool(false), "0", "0.0", `""`, "[]", "{}"} {
		if !registryCratesVersions(`{"vers":"1.0.0","yanked":` + flag + `}`)[registryCratesFixtureVersion] {
			t.Errorf("false yanked value rejected: %s", flag)
		}
	}
	for _, flag := range []string{fixtureTrueJSON, "1", "-1", `"false"`, "[false]", `{"x":null}`} {
		if len(registryCratesVersions(`{"vers":"1.0.0","yanked":`+flag+`}`)) != 0 {
			t.Errorf("true yanked value accepted: %s", flag)
		}
	}
}

func TestRegistryCratesVersions(t *testing.T) {
	t.Parallel()
	index := "invalid\n" + `{"vers":"1.0.0","yanked":false}` + "\n" +
		`{"vers":"2.0.0","yanked":true}` + "\n" + `{"vers":"3.0.0","yanked":0}`
	versions := registryCratesVersions(index)
	if !versions[registryCratesFixtureVersion] || !versions["3.0.0"] || versions["2.0.0"] || len(versions) != 2 {
		t.Fatal("sparse index malformed/yanked filtering changed")
	}
	api := map[string]any{
		"crate":               map[string]any{"newest_version": registryCratesFixtureVersion},
		registryVersionsField: []any{map[string]any{"num": "2.0.0", "yanked": true}, false},
	}
	versions = registryCratesVersions(api)
	if !versions[registryCratesFixtureVersion] || !versions["2.0.0"] || len(versions) != 2 {
		t.Fatal("API version extraction changed")
	}
	if len(registryCratesVersions(nil)) != 0 {
		t.Fatal("malformed crates payload accepted")
	}
}
