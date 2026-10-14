package logbrew_test

import (
	"io"
	"net/http"
	"testing"
)

type bodyPanicOperation string

const (
	bodyPanicRead  bodyPanicOperation = "read"
	bodyPanicClose bodyPanicOperation = "close"
	bodyPanicWrite bodyPanicOperation = "write"
)

type panicBody struct {
	operation bodyPanicOperation
	value     any
}

func (body *panicBody) Read([]byte) (int, error) {
	if body.operation == bodyPanicRead {
		panic(body.value)
	}

	return 0, io.EOF
}

func (body *panicBody) Close() error {
	if body.operation == bodyPanicClose {
		panic(body.value)
	}

	return nil
}

func (body *panicBody) Write(data []byte) (int, error) {
	if body.operation == bodyPanicWrite {
		panic(body.value)
	}

	return len(data), nil
}

type responseTransport struct{ body io.ReadCloser }

func (transport responseTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return &http.Response{
		Status: "", StatusCode: http.StatusOK, Proto: "", ProtoMajor: 0, ProtoMinor: 0,
		Header: nil, Body: transport.body, ContentLength: 0, TransferEncoding: nil,
		Close: false, Uncompressed: false, Trailer: nil, Request: nil, TLS: nil,
	}, nil
}

func TestHTTPClientBodyPanicKeepsOriginalValueAndFailedSpan(t *testing.T) {
	t.Parallel()

	for _, operation := range []bodyPanicOperation{bodyPanicRead, bodyPanicClose, bodyPanicWrite} {
		t.Run(string(operation), func(t *testing.T) {
			t.Parallel()
			client := newHTTPTestClient(t)
			marker := &struct{ message string }{message: "private body panic marker"}
			transport := newHTTPTestTransport(t, client, responseTransport{
				body: &panicBody{operation: operation, value: marker},
			}, true)
			response := roundTripHTTPTestRequest(t, transport)
			assertHTTPTestPanic(t, marker, func() { invokeHTTPTestBody(t, response.Body, operation) })

			payload, events := previewHTTPTestEvents(t, client, 1)
			if events[0].Attributes.Status != httpTestErrorStatus {
				t.Fatal("body panic recorded as success")
			}

			assertHTTPTestPrivateMarkers(t, payload, "private body panic marker", "private write marker")
			assertHTTPTestBodyClose(t, response, operation, marker)

			afterClose, _ := previewHTTPTestEvents(t, client, 1)
			if payload != afterClose {
				t.Fatal("Close rewrote the panic span")
			}
		})
	}
}

func roundTripHTTPTestRequest(t *testing.T, transport http.RoundTripper) *http.Response {
	t.Helper()
	ctx := newHTTPTestParentContext(t)

	response, err := transport.RoundTrip(newHTTPTestRequest(ctx, t, "https://example.test/private"))
	if err != nil {
		t.Fatal(err)
	}

	return response
}

func invokeHTTPTestBody(t *testing.T, body io.ReadCloser, operation bodyPanicOperation) {
	t.Helper()

	switch operation {
	case bodyPanicRead:
		_, _ = body.Read(make([]byte, 1))
	case bodyPanicClose:
		_ = body.Close()
	case bodyPanicWrite:
		writer, ok := body.(io.Writer)
		if !ok {
			t.Fatal("upgraded response lost its writer")
		}

		_, _ = writer.Write([]byte("private write marker"))
	}
}

func assertHTTPTestBodyClose(t *testing.T, response *http.Response, operation bodyPanicOperation, marker any) {
	t.Helper()

	if operation == bodyPanicClose {
		assertHTTPTestPanic(t, marker, func() { closeHTTPTestBody(t, response) })
	} else {
		closeHTTPTestBody(t, response)
	}
}
