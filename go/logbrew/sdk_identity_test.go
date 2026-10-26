package logbrew

import (
	"runtime/debug"
	"testing"
)

func TestClientDefaultsSDKIdentityWhenEmpty(t *testing.T) {
	client, err := NewClient(Config{APIKey: "LOGBREW_API_KEY"})
	if err != nil {
		t.Fatalf("build client: %v", err)
	}
	if client.sdk.Name != "logbrew-go" || client.sdk.Version != defaultSDKVersion() || client.sdk.Language != "go" {
		t.Fatalf("unexpected default sdk identity: %+v", client.sdk)
	}
}

func TestClientKeepsExplicitSDKIdentity(t *testing.T) {
	client, err := NewClient(Config{APIKey: "LOGBREW_API_KEY", SDKName: "logbrew-go-custom", SDKVersion: "9.9.9"})
	if err != nil {
		t.Fatalf("build client: %v", err)
	}
	if client.sdk.Name != "logbrew-go-custom" || client.sdk.Version != "9.9.9" {
		t.Fatalf("explicit sdk identity changed: %+v", client.sdk)
	}
	if _, err := NewClient(Config{APIKey: "LOGBREW_API_KEY", SDKName: "  "}); err == nil {
		t.Fatal("expected whitespace sdk_name to fail validation")
	}
}

func TestSDKVersionFromBuildInfo(t *testing.T) {
	dependency := func(version string, replace *debug.Module) *debug.BuildInfo {
		return &debug.BuildInfo{
			Main: debug.Module{Path: "example.com/app", Version: "(devel)"},
			Deps: []*debug.Module{
				{Path: "github.com/LogBrewCo/sdk/go/logbrew/gin", Version: "v0.1.4"},
				{Path: sdkModulePath, Version: version, Replace: replace},
			},
		}
	}
	cases := []struct {
		name string
		info *debug.BuildInfo
		want string
	}{
		{"no build info", nil, "0+unknown"},
		{"dependency", dependency("v0.2.2", nil), "0.2.2"},
		{"replaced dependency", dependency("v0.2.2", &debug.Module{Path: sdkModulePath, Version: "v0.2.3"}), "0.2.3"},
		{"local replacement", dependency("v0.2.2", &debug.Module{Path: "../logbrew"}), "0+unknown"},
		{"main module", &debug.BuildInfo{Main: debug.Module{Path: sdkModulePath, Version: "(devel)"}}, "0+unknown"},
		{"absent", &debug.BuildInfo{Main: debug.Module{Path: "example.com/app"}}, "0+unknown"},
	}
	for _, testCase := range cases {
		if got := sdkVersionFromBuildInfo(testCase.info); got != testCase.want {
			t.Errorf("%s: got %q, want %q", testCase.name, got, testCase.want)
		}
	}
}
