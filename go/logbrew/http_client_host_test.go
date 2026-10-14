package logbrew_test

import (
	"io"
	"strings"
	"testing"
)

func TestHTTPClientHostBoundsAndPrivacy(t *testing.T) {
	t.Parallel()

	const (
		maxLabelLength = 63
		maxHostLength  = 253
	)

	label := strings.Repeat("a", maxLabelLength)
	prefix := strings.Repeat(label+".", 3)
	longest := prefix + strings.Repeat("a", maxHostLength-len(prefix))

	cases := []struct{ name, host, expected string }{
		{name: "label limit", host: label + ".example", expected: label + ".example"},
		{name: "overlong label", host: label + "a.example", expected: ""},
		{name: "host length limit", host: longest, expected: longest},
		{name: "overlong host", host: longest + "a", expected: ""},
		{name: "empty label", host: "api..example", expected: ""},
		{name: "leading dash", host: "-api.example", expected: ""},
		{name: "trailing dash", host: "api-.example", expected: ""},
		{name: "numeric host", host: "123.456", expected: ""},
		{name: "unicode host", host: "münich.example", expected: ""},
		{name: "trailing dot", host: "API.EXAMPLE.", expected: "api.example"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			client := newHTTPTestClient(t)
			base := responseTransport{body: io.NopCloser(strings.NewReader(""))}
			transport := newHTTPTestTransport(t, client, base, false)
			request := newHTTPTestRequest(newHTTPTestParentContext(t), t, "https://"+test.host+"/private-path")
			response := doHTTPTestRequest(t, newHTTPTestDoer(transport), request)

			err := response.Body.Close()
			if err != nil {
				t.Fatal(err)
			}

			payload, events := previewHTTPTestEvents(t, client, 1)
			if events[0].Attributes.Metadata.Host != test.expected {
				t.Fatal("host bound or redaction changed")
			}

			assertHTTPTestPrivateMarkers(t, payload, "private-path")
		})
	}
}
