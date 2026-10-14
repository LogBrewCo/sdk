package main

import "testing"

func TestBrandOutputPolicy(t *testing.T) {
	t.Parallel()
	outputs := make(map[string][]byte)
	for name := range brandGeneratedAssets() {
		outputs[name] = []byte(repositorySource(t, name))
	}
	if !brandOutputPolicy(outputs) {
		t.Fatal("actual generated output set rejected")
	}
	outputs[brandCanonicalSource] = []byte("unexpected canonical output")
	if brandOutputPolicy(outputs) {
		t.Fatal("canonical source write accepted")
	}
	delete(outputs, brandCanonicalSource)
	for name := range outputs {
		outputs[name] = nil
		break
	}
	if brandOutputPolicy(outputs) || brandOutputPolicy(nil) {
		t.Fatal("incomplete output set accepted")
	}
}
