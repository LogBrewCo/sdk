package logbrew

import "testing"

func TestIssueFrameInAppSeparatesApplicationFrames(t *testing.T) {
	const app = "example.com/store"
	cases := []struct {
		module, main string
		want         *bool
	}{
		{"example.com/store/articles", app, boolPtr(true)},
		{"example.com/store", app, boolPtr(true)},
		{"main", app, boolPtr(true)},
		{"example.com/storefront", app, boolPtr(false)},
		{"runtime", app, boolPtr(false)},
		{"net/http", app, boolPtr(false)},
		{"github.com/LogBrewCo/sdk/go/logbrew/gin", app, boolPtr(false)},
		{"github.com/gin-gonic/gin", app, boolPtr(false)},
		{"github.com/gin-gonic/gin", "", nil},
		{"github.com/gin-gonic/gin", "command-line-arguments", nil},
		{"runtime", "", boolPtr(false)},
		{"", app, nil},
	}
	for _, c := range cases {
		got := issueFrameInApp(c.module, c.main)
		if (got == nil) != (c.want == nil) || got != nil && *got != *c.want {
			t.Errorf("issueFrameInApp(%q, %q) = %v, want %v", c.module, c.main, got, c.want)
		}
	}
}

func TestCapturedPanicFramesMarkRuntimeAndSDKFramesNotInApp(t *testing.T) {
	frames := CaptureIssueStackFrames()
	if len(frames) == 0 {
		t.Fatal("no frames captured")
	}
	for _, frame := range frames {
		if frame.Module == "runtime" || frame.Module == "testing" {
			if frame.InApp == nil || *frame.InApp {
				t.Errorf("frame %s.%s inApp = %v, want false", frame.Module, frame.Function, frame.InApp)
			}
		}
	}
}
