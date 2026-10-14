package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestPythonPublicSmokeBindingOverlapsWithinLimitAndKeepsOrder(t *testing.T) {
	t.Parallel()
	directory, selection := pythonManifestFixture(t)
	responses := pythonPublicBundleFixture(t, directory, selection)
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	entered := make(chan struct{}, len(responses))
	release := make(chan struct{})
	var active, requests atomic.Int32
	var exceeded atomic.Bool
	client := new(http.Client)
	client.Transport = pythonRegistryFixtureTransport(func(request *http.Request) (*http.Response, error) {
		current := active.Add(1)
		defer active.Add(-1)
		if current > pythonRegistryConnections {
			exceeded.Store(true)
		}
		requests.Add(1)
		entered <- struct{}{}
		select {
		case <-release:
		case <-request.Context().Done():
			return nil, request.Context().Err()
		}
		response := new(http.Response)
		response.Request, response.StatusCode = request, http.StatusOK
		response.Body = io.NopCloser(bytes.NewReader(responses[request.URL.String()]))
		return response, nil
	})
	var observer sync.WaitGroup
	observer.Go(func() { releasePythonBindingGate(ctx, t, entered, release) })
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	options := pythonSmokeOptions{versions: selection.versions, artifacts: "", manifest: "", receipt: false}
	wheels, bound := bindPythonSmokeAtRoot(ctx, options, root, client, nil, nil)
	closeError := root.Close()
	observer.Wait()
	if !bound || closeError != nil || active.Load() != 0 || exceeded.Load() ||
		int(requests.Load()) != len(responses) || len(wheels) != len(pythonReleaseCatalog()) {
		t.Fatal("binding lost its worker limit, joined cleanup, exact request set, or complete result")
	}
	for index, spec := range pythonReleaseCatalog() {
		if wheels[index].id != spec.id || wheels[index].version != selection.versions[spec.id] {
			t.Fatal("completion order changed the canonical receipt order")
		}
	}
}

func releasePythonBindingGate(ctx context.Context, t *testing.T, entered, release chan struct{}) {
	t.Helper()
	for range pythonRegistryConnections {
		select {
		case <-entered:
		case <-ctx.Done():
			t.Error("artifact binding did not overlap independent packages")
			return
		}
	}
	close(release)
}

func TestPythonPublicSmokeBindingCancelsAndJoinsFailedFetch(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	var requests, active atomic.Int32
	started := make(chan struct{})
	client := new(http.Client)
	client.Transport = pythonRegistryFixtureTransport(func(request *http.Request) (*http.Response, error) {
		active.Add(1)
		defer active.Add(-1)
		if requests.Add(1) == 1 {
			select {
			case <-started:
			case <-request.Context().Done():
				return nil, request.Context().Err()
			}
			return nil, io.ErrUnexpectedEOF
		}
		close(started)
		<-request.Context().Done()
		return nil, request.Context().Err()
	})
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	options := pythonSmokeDefaults(func(string) string { return "" })
	wheels, bound := bindPythonSmokeAtRoot(ctx, options, root, client, nil, nil)
	closeError := root.Close()
	if bound || wheels != nil || closeError != nil || requests.Load() != pythonRegistryConnections ||
		active.Load() != 0 || ctx.Err() != nil {
		t.Fatal("failed fetch retained partial results, started another package, or failed to join cancellation")
	}
}
