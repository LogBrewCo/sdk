package logbrew

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func persistenceTestKey(seed byte) []byte {
	return bytes.Repeat([]byte{seed}, 32)
}

func persistentTestConfig(directory string, key []byte) PersistentDeliveryConfig {
	return PersistentDeliveryConfig{
		Directory:      directory,
		EncryptionKey:  key,
		MaxStoredBytes: 4 * 1024 * 1024,
	}
}

func newPersistentTestClient(
	t *testing.T,
	directory string,
	key []byte,
	transport Transport,
) *Client {
	t.Helper()
	client, err := NewPersistentAutomaticClient(
		Config{
			APIKey:       "LOGBREW_API_KEY",
			SDKName:      "logbrew-go-persistence",
			SDKVersion:   "0.1.0",
			MaxRetries:   0,
			MaxQueueSize: 8,
		},
		AutomaticDeliveryConfig{
			Transport:      transport,
			FlushInterval:  time.Hour,
			FlushThreshold: 8,
		},
		persistentTestConfig(directory, key),
	)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func stopPersistentClientWithoutFlush(t *testing.T, client *Client) {
	t.Helper()
	client.mu.Lock()
	started := client.stopAutomaticLocked()
	client.mu.Unlock()
	if started {
		<-client.automatic.done
	}
	if err := client.persistent.close(); err != nil {
		t.Fatal(err)
	}
}

func TestPersistentAutomaticClientRecoversEncryptedEventsOldestFirst(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	key := persistenceTestKey(0x31)
	first := newPersistentTestClient(t, directory, key, newLifecycleTransport(202))
	queueLifecycleLog(t, first, "evt_persist_001")
	queueLifecycleLog(t, first, "evt_persist_002")
	wantPreview, err := first.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	stopPersistentClientWithoutFlush(t, first)

	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) == 0 {
		t.Fatal("persistent delivery did not create encrypted state")
	}
	for _, entry := range entries {
		stored, readErr := os.ReadFile(filepath.Join(directory, entry.Name()))
		if readErr != nil {
			t.Fatal(readErr)
		}
		if bytes.Contains(stored, []byte("evt_persist_001")) ||
			bytes.Contains(stored, []byte("LOGBREW_API_KEY")) ||
			bytes.Contains(stored, []byte(DefaultHTTPEndpoint)) {
			t.Fatalf("persistence file %q leaked protected content", entry.Name())
		}
	}

	transport := newLifecycleTransport(202)
	second := newPersistentTestClient(t, directory, key, transport)
	transport.waitForSends(t, 1)
	body := transport.bodiesSnapshot()[0]
	if string(body) != wantPreview {
		t.Fatalf("recovered body changed order or content\nwant=%s\ngot=%s", wantPreview, body)
	}
	if _, err := second.Shutdown(nil); err != nil {
		t.Fatal(err)
	}
}

func TestPersistentAutomaticClientRetriesIdenticalFailedPrefixAfterRestart(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	key := persistenceTestKey(0x32)
	failed := newLifecycleTransport(503, 503, 503)
	first := newPersistentTestClient(t, directory, key, failed)
	queueLifecycleLog(t, first, "evt_retry_restart_001")
	if _, err := first.Flush(nil); err == nil {
		t.Fatal("expected retryable transport failure")
	}
	wantBody := failed.bodiesSnapshot()[0]
	queueLifecycleLog(t, first, "evt_retry_restart_later_002")
	stopPersistentClientWithoutFlush(t, first)

	accepted := newLifecycleTransport(202, 202)
	second := newPersistentTestClient(t, directory, key, accepted)
	accepted.waitForSends(t, 1)
	if _, err := second.Flush(nil); err != nil {
		t.Fatal(err)
	}
	bodies := accepted.bodiesSnapshot()
	if !bytes.Equal(bodies[0], wantBody) {
		t.Fatal("restart rebuilt the failed prefix instead of retrying frozen bytes")
	}
	if bytes.Contains(bodies[0], []byte("evt_retry_restart_later_002")) ||
		!bytes.Contains(bodies[1], []byte("evt_retry_restart_later_002")) {
		t.Fatal("restart did not retain the later event behind the failed prefix")
	}
	if _, err := second.Shutdown(nil); err != nil {
		t.Fatal(err)
	}
}

func TestPersistentAutomaticClientRejectsWrongKeyTamperAndConcurrentOwner(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	key := persistenceTestKey(0x33)
	first := newPersistentTestClient(t, directory, key, newLifecycleTransport(202))
	queueLifecycleLog(t, first, "evt_owned_001")

	_, err := NewPersistentAutomaticClient(
		Config{APIKey: "LOGBREW_API_KEY", SDKName: "owner", SDKVersion: "0.1.0"},
		AutomaticDeliveryConfig{Transport: newLifecycleTransport(202)},
		persistentTestConfig(directory, key),
	)
	assertSDKErrorCode(t, err, "persistence_in_use")
	stopPersistentClientWithoutFlush(t, first)

	_, err = NewPersistentAutomaticClient(
		Config{APIKey: "LOGBREW_API_KEY", SDKName: "owner", SDKVersion: "0.1.0"},
		AutomaticDeliveryConfig{Transport: newLifecycleTransport(202)},
		persistentTestConfig(directory, persistenceTestKey(0x34)),
	)
	assertSDKErrorCode(t, err, "persistence_key_mismatch")

	statePath := filepath.Join(directory, persistentQueueFile)
	stored, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	stored[len(stored)/2] ^= 0x01
	if err := os.WriteFile(statePath, stored, 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = NewPersistentAutomaticClient(
		Config{APIKey: "LOGBREW_API_KEY", SDKName: "owner", SDKVersion: "0.1.0"},
		AutomaticDeliveryConfig{Transport: newLifecycleTransport(202)},
		persistentTestConfig(directory, key),
	)
	assertSDKErrorCode(t, err, "persistence_integrity_error")
}

func TestPersistentAutomaticClientBoundsAndExplicitPurge(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	key := persistenceTestKey(0x35)
	persistence := persistentTestConfig(directory, key)
	persistence.MaxStoredBytes = 200
	client := newPersistentTestClient(t, directory, key, newLifecycleTransport(202))
	client.persistent.maxStoredBytes = persistence.MaxStoredBytes

	err := client.Log(
		"evt_too_large",
		"2026-06-02T10:00:03Z",
		LogAttributes{Message: strings.Repeat("x", 512), Level: "info"},
	)
	assertSDKErrorCode(t, err, "persistence_overflow")
	if client.PendingEvents() != 0 {
		t.Fatal("overflowing event reached the in-memory queue")
	}
	stopPersistentClientWithoutFlush(t, client)

	if err := PurgePersistentDelivery(persistence); err != nil {
		t.Fatal(err)
	}
	reopened := newPersistentTestClient(t, directory, key, newLifecycleTransport(202))
	if reopened.PendingEvents() != 0 {
		t.Fatal("purge left recoverable events")
	}
	if _, err := reopened.Shutdown(nil); err != nil {
		t.Fatal(err)
	}
}

func TestPersistentAutomaticClientConfigDoesNotChangeDefaultClients(t *testing.T) {
	manual := newLifecycleClient(t, nil)
	if manual.persistent != nil {
		t.Fatal("manual client unexpectedly owns persistence")
	}
	automatic := newLifecycleClient(t, &AutomaticDeliveryConfig{Transport: newLifecycleTransport(202)})
	if automatic.persistent != nil {
		t.Fatal("ordinary automatic client unexpectedly owns persistence")
	}
	if _, err := NewPersistentAutomaticClient(
		Config{APIKey: "LOGBREW_API_KEY", SDKName: "invalid", SDKVersion: "0.1.0"},
		AutomaticDeliveryConfig{Transport: newLifecycleTransport(202)},
		PersistentDeliveryConfig{Directory: t.TempDir(), EncryptionKey: []byte("short")},
	); err == nil {
		t.Fatal("expected a 32-byte persistence key requirement")
	}
}

func TestPersistentStoreAtomicIntentRecoversOnlyCommittedAdmission(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	config := persistentTestConfig(directory, persistenceTestKey(0x36))
	sdk := sdkInfo{Name: "intent", Language: "go", Version: "0.1.0"}
	seed, _, _, _, err := openPersistentStore(config, sdk, 8)
	if err != nil {
		t.Fatal(err)
	}
	if err := seed.close(); err != nil {
		t.Fatal(err)
	}

	failedAfterRename := false
	store, _, _, _, err := openPersistentStoreWithFailure(config, sdk, 8, func(point string) error {
		if point == "after_rename" && !failedAfterRename {
			failedAfterRename = true
			return errors.New("injected")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.admit(persistenceEvent("evt_committed")); err == nil {
		t.Fatal("expected post-rename failure")
	}
	if err := store.close(); err != nil {
		t.Fatal(err)
	}
	recovered, events, _, _, err := openPersistentStore(config, sdk, 8)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].ID != "evt_committed" {
		t.Fatalf("durable intent did not finalize committed admission: %#v", events)
	}
	if err := recovered.close(); err != nil {
		t.Fatal(err)
	}

	failedAfterIntent := false
	store, _, _, _, err = openPersistentStoreWithFailure(config, sdk, 8, func(point string) error {
		if point == "after_intent_sync" && !failedAfterIntent {
			failedAfterIntent = true
			return errors.New("injected")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.admit(persistenceEvent("evt_intent_committed")); err == nil {
		t.Fatal("expected post-intent failure")
	}
	if err := store.close(); err != nil {
		t.Fatal(err)
	}
	recovered, events, _, _, err = openPersistentStore(config, sdk, 8)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].ID != "evt_committed" || events[1].ID != "evt_intent_committed" {
		t.Fatalf("durable pre-rename intent did not finalize admission: %#v", events)
	}
	if err := recovered.close(); err != nil {
		t.Fatal(err)
	}

	failedBeforeIntent := false
	store, _, _, _, err = openPersistentStoreWithFailure(config, sdk, 8, func(point string) error {
		if point == "after_temp_sync" && !failedBeforeIntent {
			failedBeforeIntent = true
			return errors.New("injected")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.admit(persistenceEvent("evt_uncommitted")); err == nil {
		t.Fatal("expected pre-intent failure")
	}
	if err := store.close(); err != nil {
		t.Fatal(err)
	}
	recovered, events, _, _, err = openPersistentStore(config, sdk, 8)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].ID != "evt_committed" || events[1].ID != "evt_intent_committed" {
		t.Fatalf("pre-intent temporary state was treated as admitted: %#v", events)
	}
	if err := recovered.close(); err != nil {
		t.Fatal(err)
	}
}

func TestPersistentStoreRejectsInitialTargetReplacement(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	config := persistentTestConfig(directory, persistenceTestKey(0x47))
	sdk := sdkInfo{Name: "replacement", Language: "go", Version: "0.1.0"}
	replaced := false

	store, _, _, _, err := openPersistentStoreWithFailure(config, sdk, 8, func(point string) error {
		if point == "after_intent_sync" && !replaced {
			replaced = true
			return os.WriteFile(filepath.Join(directory, persistentKeyFile), []byte("replacement"), 0o600)
		}
		return nil
	})
	if store != nil {
		_ = store.close()
	}
	assertSDKErrorCode(t, err, "persistence_integrity_error")
	stored, readErr := os.ReadFile(filepath.Join(directory, persistentKeyFile))
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(stored) != "replacement" {
		t.Fatal("initial target replacement was overwritten")
	}
}

func TestPersistentStoreUsesFreshCiphertextAndOwnerOnlyFiles(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	key := persistenceTestKey(0x37)
	config := persistentTestConfig(directory, key)
	sdk := sdkInfo{Name: "privacy", Language: "go", Version: "0.1.0"}
	store, _, _, _, err := openPersistentStore(config, sdk, 8)
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(directory, persistentQueueFile))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.admit(persistenceEvent("evt_ciphertext_001")); err != nil {
		t.Fatal(err)
	}
	afterFirst, err := os.ReadFile(filepath.Join(directory, persistentQueueFile))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.admit(persistenceEvent("evt_ciphertext_002")); err != nil {
		t.Fatal(err)
	}
	afterSecond, err := os.ReadFile(filepath.Join(directory, persistentQueueFile))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(before, afterFirst) || bytes.Equal(afterFirst, afterSecond) {
		t.Fatal("queue rewrites reused ciphertext")
	}
	for _, stored := range [][]byte{before, afterFirst, afterSecond} {
		if bytes.Contains(stored, []byte("evt_ciphertext")) || bytes.Contains(stored, key) {
			t.Fatal("encrypted state exposed event content or key material")
		}
	}
	directoryInfo, err := os.Stat(directory)
	if err != nil || directoryInfo.Mode().Perm() != 0o700 {
		t.Fatalf("unexpected persistence directory mode: info=%v err=%v", directoryInfo, err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		info, statErr := entry.Info()
		if statErr != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("unexpected mode for %q: info=%v err=%v", entry.Name(), info, statErr)
		}
	}
	if err := store.close(); err != nil {
		t.Fatal(err)
	}
}

func TestPersistentStoreAllowsSDKUpgradeWithoutChangingFailedBody(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	config := persistentTestConfig(directory, persistenceTestKey(0x45))
	oldSDK := sdkInfo{Name: "upgrade", Language: "go", Version: "0.1.0"}
	store, _, _, _, err := openPersistentStore(config, oldSDK, 8)
	if err != nil {
		t.Fatal(err)
	}
	event := persistenceEvent("evt_upgrade_pending")
	if err := store.admit(event); err != nil {
		t.Fatal(err)
	}
	body, err := json.MarshalIndent(eventBatch{SDK: oldSDK, Events: []Event{event}}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.retainPending(body, 1); err != nil {
		t.Fatal(err)
	}
	if err := store.close(); err != nil {
		t.Fatal(err)
	}

	newSDK := sdkInfo{Name: "upgrade", Language: "go", Version: "0.2.0"}
	reopened, events, pending, prefix, err := openPersistentStore(config, newSDK, 8)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].ID != event.ID || prefix != 1 || !bytes.Equal(pending, body) {
		t.Fatalf("SDK upgrade changed recovered work: events=%#v prefix=%d", events, prefix)
	}
	if err := reopened.close(); err != nil {
		t.Fatal(err)
	}
}

func TestPersistentStoreRejectsUnsafeLayoutAndOwnerReplacement(t *testing.T) {
	root := t.TempDir()
	key := persistenceTestKey(0x38)
	symlinkTarget := filepath.Join(root, "target")
	if err := os.Mkdir(symlinkTarget, 0o700); err != nil {
		t.Fatal(err)
	}
	symlinkDirectory := filepath.Join(root, "linked")
	if err := os.Symlink(symlinkTarget, symlinkDirectory); err != nil {
		t.Fatal(err)
	}
	_, err := NewPersistentAutomaticClient(
		Config{APIKey: "LOGBREW_API_KEY", SDKName: "unsafe", SDKVersion: "0.1.0"},
		AutomaticDeliveryConfig{Transport: newLifecycleTransport(202)},
		persistentTestConfig(symlinkDirectory, key),
	)
	assertSDKErrorCode(t, err, "persistence_unsupported")

	directory := filepath.Join(root, "delivery")
	client := newPersistentTestClient(t, directory, key, newLifecycleTransport(202))
	if err := os.WriteFile(filepath.Join(directory, "unexpected.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	err = client.Log("evt_unexpected_layout", "2026-06-02T10:00:03Z", LogAttributes{Message: "queued", Level: "info"})
	assertSDKErrorCode(t, err, "persistence_integrity_error")
	stopPersistentClientWithoutFlush(t, client)
	_, err = NewPersistentAutomaticClient(
		Config{APIKey: "LOGBREW_API_KEY", SDKName: "logbrew-go-persistence", SDKVersion: "0.1.0", MaxQueueSize: 8},
		AutomaticDeliveryConfig{Transport: newLifecycleTransport(202)},
		persistentTestConfig(directory, key),
	)
	assertSDKErrorCode(t, err, "persistence_integrity_error")
	if err := os.Remove(filepath.Join(directory, "unexpected.txt")); err != nil {
		t.Fatal(err)
	}

	client = newPersistentTestClient(t, directory, key, newLifecycleTransport(202))
	oldLock := filepath.Join(root, "old-lock")
	if err := os.Rename(filepath.Join(directory, persistentLockFile), oldLock); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, persistentLockFile), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	err = client.Log("evt_lock_replaced", "2026-06-02T10:00:03Z", LogAttributes{Message: "queued", Level: "info"})
	assertSDKErrorCode(t, err, "persistence_integrity_error")
	_, err = NewPersistentAutomaticClient(
		Config{APIKey: "LOGBREW_API_KEY", SDKName: "logbrew-go-persistence", SDKVersion: "0.1.0", MaxQueueSize: 8},
		AutomaticDeliveryConfig{Transport: newLifecycleTransport(202)},
		persistentTestConfig(directory, key),
	)
	assertSDKErrorCode(t, err, "persistence_integrity_error")
	if err := client.persistent.close(); err != nil {
		t.Fatal(err)
	}
}

func TestPersistentStoreRejectsHardLinksAndPostForkOwnership(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "delivery")
	key := persistenceTestKey(0x39)
	client := newPersistentTestClient(t, directory, key, newLifecycleTransport(202))
	queueLifecycleLog(t, client, "evt_link_001")
	stopPersistentClientWithoutFlush(t, client)
	linked := filepath.Join(root, "linked-queue")
	if err := os.Link(filepath.Join(directory, persistentQueueFile), linked); err != nil {
		t.Skipf("filesystem does not support hard links: %v", err)
	}
	_, err := NewPersistentAutomaticClient(
		Config{APIKey: "LOGBREW_API_KEY", SDKName: "logbrew-go-persistence", SDKVersion: "0.1.0", MaxQueueSize: 8},
		AutomaticDeliveryConfig{Transport: newLifecycleTransport(202)},
		persistentTestConfig(directory, key),
	)
	assertSDKErrorCode(t, err, "persistence_integrity_error")
	if err := os.Remove(linked); err != nil {
		t.Fatal(err)
	}

	lockPath := filepath.Join(directory, persistentLockFile)
	originalLock := filepath.Join(root, "original-lock")
	if err := os.Rename(lockPath, originalLock); err != nil {
		t.Fatal(err)
	}
	externalLock := filepath.Join(root, "external-lock")
	if err := os.WriteFile(externalLock, []byte("external"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(externalLock, 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(externalLock, lockPath); err != nil {
		t.Skipf("filesystem does not support lock hard links: %v", err)
	}
	_, err = NewPersistentAutomaticClient(
		Config{APIKey: "LOGBREW_API_KEY", SDKName: "logbrew-go-persistence", SDKVersion: "0.1.0", MaxQueueSize: 8},
		AutomaticDeliveryConfig{Transport: newLifecycleTransport(202)},
		persistentTestConfig(directory, key),
	)
	assertSDKErrorCode(t, err, "persistence_unsupported")
	info, err := os.Stat(externalLock)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o640 {
		t.Fatalf("rejected lock hard link mode changed to %o", info.Mode().Perm())
	}
	if err := os.Remove(lockPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(externalLock); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(originalLock, lockPath); err != nil {
		t.Fatal(err)
	}

	client = newPersistentTestClient(t, directory, key, newLifecycleTransport(202))
	ownerPID := client.persistent.ownerPID
	client.persistent.ownerPID = ownerPID + 1
	err = client.Log("evt_wrong_process", "2026-06-02T10:00:03Z", LogAttributes{Message: "queued", Level: "info"})
	assertSDKErrorCode(t, err, "persistence_owner_changed")
	client.persistent.ownerPID = ownerPID
	stopPersistentClientWithoutFlush(t, client)
}

func TestPersistentAutomaticClientFreezesPrefixBeforeTransportReturns(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	key := persistenceTestKey(0x48)
	release := make(chan struct{})
	transport := newLifecycleTransport(503)
	transport.block = release
	client := newPersistentTestClient(t, directory, key, transport)
	queueLifecycleLog(t, client, "evt_inflight_restart")

	flushResult := make(chan error, 1)
	go func() {
		_, err := client.Flush(nil)
		flushResult <- err
	}()
	transport.waitForSends(t, 1)
	wantBody := transport.bodiesSnapshot()[0]
	if err := client.persistent.close(); err != nil {
		t.Fatal(err)
	}

	store, events, pending, prefix, err := openPersistentStore(
		persistentTestConfig(directory, key),
		sdkInfo{Name: "logbrew-go-persistence", Language: "go", Version: "0.1.0"},
		8,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || prefix != 1 || !bytes.Equal(pending, wantBody) {
		t.Fatalf("in-flight prefix was not durably frozen: events=%d prefix=%d", len(events), prefix)
	}
	if err := store.close(); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-flushResult; err == nil {
		t.Fatal("closed persistence boundary unexpectedly accepted transport completion")
	}
}

func TestPersistentStoreRejectsQueueReplacementBeforeMutation(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "delivery")
	key := persistenceTestKey(0x44)
	client := newPersistentTestClient(t, directory, key, newLifecycleTransport(202))
	queueLifecycleLog(t, client, "evt_before_replacement")
	queuePath := filepath.Join(directory, persistentQueueFile)
	stored, err := os.ReadFile(queuePath)
	if err != nil {
		t.Fatal(err)
	}
	replacementPath := filepath.Join(directory, "replacement.tmp")
	stored[len(stored)-1] ^= 0x01
	if err := os.WriteFile(replacementPath, stored, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacementPath, queuePath); err != nil {
		t.Fatal(err)
	}
	err = client.Log("evt_after_replacement", "2026-06-02T10:00:03Z", LogAttributes{Message: "queued", Level: "info"})
	assertSDKErrorCode(t, err, "persistence_integrity_error")
	if client.PendingEvents() != 1 {
		t.Fatal("replacement failure mutated the in-memory queue")
	}
	if err := client.persistent.close(); err != nil {
		t.Fatal(err)
	}
}

func TestPersistentStoreRejectsSameKeyCrossDirectoryReplay(t *testing.T) {
	root := t.TempDir()
	key := persistenceTestKey(0x4a)
	firstDirectory := filepath.Join(root, "first")
	first := newPersistentTestClient(t, firstDirectory, key, newLifecycleTransport(202))
	queueLifecycleLog(t, first, "evt_first_directory")
	stopPersistentClientWithoutFlush(t, first)
	firstQueue, err := os.ReadFile(filepath.Join(firstDirectory, persistentQueueFile))
	if err != nil {
		t.Fatal(err)
	}

	secondDirectory := filepath.Join(root, "second")
	second := newPersistentTestClient(t, secondDirectory, key, newLifecycleTransport(202))
	queueLifecycleLog(t, second, "evt_second_directory")
	stopPersistentClientWithoutFlush(t, second)
	if err := os.WriteFile(filepath.Join(secondDirectory, persistentQueueFile), firstQueue, 0o600); err != nil {
		t.Fatal(err)
	}

	replayed, _, _, _, err := openPersistentStore(
		persistentTestConfig(secondDirectory, key),
		sdkInfo{Name: "logbrew-go-persistence", Language: "go", Version: "0.1.0"},
		8,
	)
	if replayed != nil {
		_ = replayed.close()
	}
	assertSDKErrorCode(t, err, "persistence_integrity_error")
}

func TestPersistentStoreRejectsMissingQueueSnapshot(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	key := persistenceTestKey(0x49)
	client := newPersistentTestClient(t, directory, key, newLifecycleTransport(202))
	queueLifecycleLog(t, client, "evt_missing_snapshot")
	stopPersistentClientWithoutFlush(t, client)
	if err := os.Remove(filepath.Join(directory, persistentQueueFile)); err != nil {
		t.Fatal(err)
	}

	_, err := NewPersistentAutomaticClient(
		Config{APIKey: "LOGBREW_API_KEY", SDKName: "logbrew-go-persistence", SDKVersion: "0.1.0", MaxQueueSize: 8},
		AutomaticDeliveryConfig{Transport: newLifecycleTransport(202)},
		persistentTestConfig(directory, key),
	)
	assertSDKErrorCode(t, err, "persistence_integrity_error")

	secondDirectory := filepath.Join(t.TempDir(), "delivery")
	secondConfig := persistentTestConfig(secondDirectory, key)
	second := newPersistentTestClient(t, secondDirectory, key, newLifecycleTransport(202))
	queueLifecycleLog(t, second, "evt_missing_all_state")
	stopPersistentClientWithoutFlush(t, second)
	for _, name := range []string{persistentQueueFile, persistentKeyFile} {
		if err := os.Remove(filepath.Join(secondDirectory, name)); err != nil {
			t.Fatal(err)
		}
	}
	_, err = NewPersistentAutomaticClient(
		Config{APIKey: "LOGBREW_API_KEY", SDKName: "logbrew-go-persistence", SDKVersion: "0.1.0", MaxQueueSize: 8},
		AutomaticDeliveryConfig{Transport: newLifecycleTransport(202)},
		secondConfig,
	)
	assertSDKErrorCode(t, err, "persistence_integrity_error")
	if err := PurgePersistentDelivery(secondConfig); err != nil {
		t.Fatal(err)
	}
	clean := newPersistentTestClient(t, secondDirectory, key, newLifecycleTransport(202))
	if clean.PendingEvents() != 0 {
		t.Fatal("explicit purge did not establish a clean persistence boundary")
	}
	if _, err := clean.Shutdown(nil); err != nil {
		t.Fatal(err)
	}
}

func TestPersistentStoreUsesExactSerializedByteBound(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	key := persistenceTestKey(0x40)
	sdk := sdkInfo{Name: "bounds", Language: "go", Version: "0.1.0"}
	firstEvent := Event{
		Type: "log", ID: "evt_multibyte_001", Timestamp: "2026-06-02T10:00:03Z",
		Attributes: map[string]any{"message": "espresso ☕", "level": "info"},
	}
	encoded, err := json.Marshal(firstEvent)
	if err != nil {
		t.Fatal(err)
	}
	config := persistentTestConfig(directory, key)
	config.MaxStoredBytes = len(encoded)
	store, _, _, _, err := openPersistentStore(config, sdk, 8)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.admit(firstEvent); err != nil {
		t.Fatal(err)
	}
	err = store.admit(persistenceEvent("evt_multibyte_002"))
	assertSDKErrorCode(t, err, "persistence_overflow")
	if err := store.close(); err != nil {
		t.Fatal(err)
	}

	countConfig := persistentTestConfig(filepath.Join(t.TempDir(), "delivery"), persistenceTestKey(0x46))
	countStore, _, _, _, err := openPersistentStore(countConfig, sdk, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := countStore.admit(persistenceEvent("evt_count_001")); err != nil {
		t.Fatal(err)
	}
	err = countStore.admit(persistenceEvent("evt_count_002"))
	assertSDKErrorCode(t, err, "persistence_overflow")
	if err := countStore.close(); err != nil {
		t.Fatal(err)
	}
}

func TestPersistentPurgeRemovesCorruptRecognizedStateAndReleasesLock(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	key := persistenceTestKey(0x41)
	config := persistentTestConfig(directory, key)
	client := newPersistentTestClient(t, directory, key, newLifecycleTransport(202))
	queueLifecycleLog(t, client, "evt_purge_corrupt")
	stopPersistentClientWithoutFlush(t, client)
	if err := os.WriteFile(filepath.Join(directory, persistentIntentFile), []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := PurgePersistentDelivery(config); err != nil {
		t.Fatal(err)
	}
	reopened := newPersistentTestClient(t, directory, key, newLifecycleTransport(202))
	if reopened.PendingEvents() != 0 {
		t.Fatal("corrupt-state purge retained events")
	}
	if _, err := reopened.Shutdown(nil); err != nil {
		t.Fatal(err)
	}
	third := newPersistentTestClient(t, directory, key, newLifecycleTransport(202))
	if _, err := third.Shutdown(nil); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, persistentLockFile), []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := PurgePersistentDelivery(config); err != nil {
		t.Fatal(err)
	}
	afterLockPurge := newPersistentTestClient(t, directory, key, newLifecycleTransport(202))
	if _, err := afterLockPurge.Shutdown(nil); err != nil {
		t.Fatal(err)
	}
}

func TestPersistentAutomaticClientRetainsCaptureDuringAcceptedPrefix(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	key := persistenceTestKey(0x42)
	release := make(chan struct{})
	transport := newLifecycleTransport(202)
	transport.block = release
	client := newPersistentTestClient(t, directory, key, transport)
	queueLifecycleLog(t, client, "evt_inflight_prefix")
	flushResult := make(chan error, 1)
	go func() {
		_, err := client.Flush(nil)
		flushResult <- err
	}()
	transport.waitForSends(t, 1)
	queueLifecycleLog(t, client, "evt_inflight_later")
	close(release)
	if err := <-flushResult; err != nil {
		t.Fatal(err)
	}
	if client.PendingEvents() != 1 {
		t.Fatalf("accepted prefix removed later capture: %d", client.PendingEvents())
	}
	stopPersistentClientWithoutFlush(t, client)

	restartedTransport := newLifecycleTransport(202)
	restarted := newPersistentTestClient(t, directory, key, restartedTransport)
	restartedTransport.waitForSends(t, 1)
	body := restartedTransport.bodiesSnapshot()[0]
	if bytes.Contains(body, []byte("evt_inflight_prefix")) || !bytes.Contains(body, []byte("evt_inflight_later")) {
		t.Fatalf("restart exposed accepted prefix or lost later capture: %s", body)
	}
	if _, err := restarted.Shutdown(nil); err != nil {
		t.Fatal(err)
	}
}

func TestPersistentAutomaticClientFailedShutdownRecoversFrozenBody(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	key := persistenceTestKey(0x43)
	failed := newLifecycleTransport(503, 503, 503)
	client := newPersistentTestClient(t, directory, key, failed)
	queueLifecycleLog(t, client, "evt_shutdown_restart")
	if _, err := client.Shutdown(nil); err == nil {
		t.Fatal("expected failed shutdown")
	}
	wantBody := failed.bodiesSnapshot()[0]
	if health := client.DeliveryHealth(); health.State != DeliveryStateShutdownFailed || health.PendingEvents != 1 {
		t.Fatalf("failed shutdown lost durable work: %#v", health)
	}
	if err := client.persistent.close(); err != nil {
		t.Fatal(err)
	}

	accepted := newLifecycleTransport(202)
	restarted := newPersistentTestClient(t, directory, key, accepted)
	accepted.waitForSends(t, 1)
	if !bytes.Equal(accepted.bodiesSnapshot()[0], wantBody) {
		t.Fatal("failed shutdown body changed across restart")
	}
	if _, err := restarted.Shutdown(nil); err != nil {
		t.Fatal(err)
	}
}

func persistenceEvent(id string) Event {
	return Event{
		Type:       "log",
		ID:         id,
		Timestamp:  "2026-06-02T10:00:03Z",
		Attributes: map[string]any{"message": "queued", "level": "info"},
	}
}

func assertSDKErrorCode(t *testing.T, err error, code string) {
	t.Helper()
	typed, ok := err.(*SdkError)
	if !ok || typed.Code != code {
		t.Fatalf("expected %s, got %T %v", code, err, err)
	}
}
