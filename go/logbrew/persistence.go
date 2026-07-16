package logbrew

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"io"
	"os"
	"strings"
)

const (
	defaultMaxStoredBytes = 4 * 1024 * 1024
	persistenceVersion    = 1
	persistentKeyFile     = ".key-check.lbk"
	persistentQueueFile   = ".queue.lbq"
)

var persistenceKeyCheck = []byte("logbrew-go-persistence-key-check-v1")

// PersistentDeliveryConfig opts an owned automatic client into encrypted
// restart persistence. EncryptionKey must contain exactly 32 caller-owned
// bytes and is never written to storage.
type PersistentDeliveryConfig struct {
	// Directory is the dedicated owner-only storage leaf.
	Directory string
	// EncryptionKey is a stable caller-owned 32-byte AES-256 key.
	EncryptionKey []byte
	// MaxStoredBytes bounds canonical serialized event bytes. Zero uses 4 MiB.
	MaxStoredBytes int
}

type persistedQueue struct {
	Version       int               `json:"version"`
	Events        []json.RawMessage `json:"events"`
	PendingBody   []byte            `json:"pendingBody,omitempty"`
	PendingPrefix int               `json:"pendingPrefix,omitempty"`
}

type persistentStore struct {
	files          persistentFiles
	aead           cipher.AEAD
	key            []byte
	maxEvents      int
	maxStoredBytes int
	ownerPID       int
	ownerMarker    [sha256.Size]byte
	queue          persistedQueue
	keyDigest      [sha256.Size]byte
	queueDigest    [sha256.Size]byte
	keyDigestSet   bool
	queueDigestSet bool
	failed         error
}

// NewPersistentAutomaticClient creates an owned automatic client whose one
// delivery queue is durably encrypted before capture returns.
func NewPersistentAutomaticClient(
	config Config,
	delivery AutomaticDeliveryConfig,
	persistence PersistentDeliveryConfig,
) (*Client, error) {
	client, err := newClient(config, &delivery)
	if err != nil {
		return nil, err
	}
	store, recovered, pendingBody, pendingPrefix, err := openPersistentStore(
		persistence,
		client.sdk,
		client.maxQueueSize,
	)
	if err != nil {
		return nil, err
	}
	client.persistent = store
	client.events = recovered
	client.pendingBody = pendingBody
	client.pendingPrefix = pendingPrefix
	if len(client.events) > 0 {
		client.mu.Lock()
		client.startAutomaticLocked()
		client.signalAutomaticLocked()
		client.mu.Unlock()
	}
	return client, nil
}

// PurgePersistentDelivery removes only recognized LogBrew persistence files
// while holding exclusive ownership. It intentionally does not require the
// previous encryption key, allowing recovery from a lost caller-owned key.
func PurgePersistentDelivery(config PersistentDeliveryConfig) error {
	if strings.TrimSpace(config.Directory) == "" || len(config.EncryptionKey) != 32 {
		return persistenceSDKError("persistence_configuration_error")
	}
	files, err := openPersistentFiles(config.Directory, nil, false)
	if err != nil {
		return err
	}
	purgeErr := files.purge()
	closeErr := files.close()
	if purgeErr != nil {
		return purgeErr
	}
	return closeErr
}

func openPersistentStore(
	config PersistentDeliveryConfig,
	sdk sdkInfo,
	maxEvents int,
) (*persistentStore, []Event, []byte, int, error) {
	return openPersistentStoreWithFailure(config, sdk, maxEvents, nil)
}

func openPersistentStoreWithFailure(
	config PersistentDeliveryConfig,
	_ sdkInfo,
	maxEvents int,
	fail persistenceFailure,
) (*persistentStore, []Event, []byte, int, error) {
	if err := validatePersistentConfig(config); err != nil {
		return nil, nil, nil, 0, err
	}
	maxStoredBytes := config.MaxStoredBytes
	if maxStoredBytes == 0 {
		maxStoredBytes = defaultMaxStoredBytes
	}
	files, err := openPersistentFiles(config.Directory, fail, true)
	if err != nil {
		return nil, nil, nil, 0, err
	}
	key := append([]byte(nil), config.EncryptionKey...)
	block, err := aes.NewCipher(key)
	if err != nil {
		files.close()
		clear(key)
		return nil, nil, nil, 0, persistenceSDKError("persistence_configuration_error")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		files.close()
		clear(key)
		return nil, nil, nil, 0, persistenceSDKError("persistence_configuration_error")
	}
	store := &persistentStore{
		files:          files,
		aead:           aead,
		key:            key,
		maxEvents:      maxEvents,
		maxStoredBytes: maxStoredBytes,
		ownerPID:       os.Getpid(),
	}
	if err := store.initialize(); err != nil {
		store.closeIgnoringOwner()
		return nil, nil, nil, 0, err
	}
	events, err := store.decodeEvents()
	if err != nil {
		store.closeIgnoringOwner()
		return nil, nil, nil, 0, err
	}
	return store,
		events,
		append([]byte(nil), store.queue.PendingBody...),
		store.queue.PendingPrefix,
		nil
}

func validatePersistentConfig(config PersistentDeliveryConfig) error {
	if strings.TrimSpace(config.Directory) == "" {
		return persistenceSDKError("persistence_configuration_error")
	}
	if len(config.EncryptionKey) != 32 || config.MaxStoredBytes < 0 || config.MaxStoredBytes > 16*1024*1024 {
		return persistenceSDKError("persistence_configuration_error")
	}
	return nil
}

func (s *persistentStore) initialize() error {
	if err := s.ensureUsable(); err != nil {
		return err
	}
	freshBoundary, err := s.files.freshBoundary()
	if err != nil {
		return err
	}
	ownerMarker, err := s.files.ownerMarker()
	if err != nil || len(ownerMarker) != sha256.Size {
		return persistenceSDKError("persistence_integrity_error")
	}
	copy(s.ownerMarker[:], ownerMarker)
	clear(ownerMarker)
	keyExists, err := s.files.exists(persistentKeyFile)
	if err != nil {
		return err
	}
	queueExists, err := s.files.exists(persistentQueueFile)
	if err != nil {
		return err
	}
	if !keyExists && !queueExists && !freshBoundary {
		return persistenceSDKError("persistence_integrity_error")
	}
	createdKey := false
	if !keyExists {
		if queueExists {
			return persistenceSDKError("persistence_integrity_error")
		}
		plainKeyCheck := append(append([]byte(nil), persistenceKeyCheck...), s.ownerMarker[:]...)
		encoded, encodeErr := s.encrypt("key-check", plainKeyCheck)
		clear(plainKeyCheck)
		if encodeErr != nil {
			return encodeErr
		}
		if err := s.files.atomicReplace(persistentKeyFile, encoded, nil); err != nil {
			return s.fail(err)
		}
		createdKey = true
	}
	encodedKeyCheck, err := s.files.read(persistentKeyFile, 1024)
	if err != nil {
		return err
	}
	expectedKeyCheck := append(append([]byte(nil), persistenceKeyCheck...), s.ownerMarker[:]...)
	decodedKeyCheck, err := s.decrypt("key-check", encodedKeyCheck)
	if err != nil {
		return persistenceSDKError("persistence_key_mismatch")
	}
	if !bytes.Equal(decodedKeyCheck, expectedKeyCheck) {
		return persistenceSDKError("persistence_integrity_error")
	}
	clear(decodedKeyCheck)
	clear(expectedKeyCheck)
	s.keyDigest = sha256.Sum256(encodedKeyCheck)
	s.keyDigestSet = true

	if !queueExists {
		if !createdKey {
			return persistenceSDKError("persistence_integrity_error")
		}
		s.queue = persistedQueue{
			Version: persistenceVersion,
			Events:  make([]json.RawMessage, 0),
		}
		return s.writeQueue(s.queue)
	}
	encodedQueue, err := s.files.read(persistentQueueFile, s.maxFileBytes())
	if err != nil {
		return err
	}
	plainQueue, err := s.decrypt("queue", encodedQueue)
	if err != nil {
		return persistenceSDKError("persistence_integrity_error")
	}
	defer clear(plainQueue)
	decoder := json.NewDecoder(bytes.NewReader(plainQueue))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&s.queue); err != nil {
		return persistenceSDKError("persistence_integrity_error")
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return err
	}
	s.queueDigest = sha256.Sum256(encodedQueue)
	s.queueDigestSet = true
	return s.validateQueue(s.queue)
}

func (s *persistentStore) admit(event Event) error {
	if err := s.ensureUsable(); err != nil {
		return err
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		return &SdkError{Code: "serialization_error", Message: "event could not be serialized"}
	}
	if len(s.queue.Events) >= s.maxEvents || s.storedBytes()+len(encoded) > s.maxStoredBytes {
		return persistenceSDKError("persistence_overflow")
	}
	next := clonePersistedQueue(s.queue)
	next.Events = append(next.Events, append(json.RawMessage(nil), encoded...))
	if err := s.writeQueue(next); err != nil {
		return err
	}
	s.queue = next
	return nil
}

func (s *persistentStore) retainPending(body []byte, prefix int) error {
	if err := s.ensureUsable(); err != nil {
		return err
	}
	if prefix <= 0 || prefix > len(s.queue.Events) || len(body) == 0 {
		return s.fail(persistenceSDKError("persistence_integrity_error"))
	}
	next := clonePersistedQueue(s.queue)
	next.PendingBody = append([]byte(nil), body...)
	next.PendingPrefix = prefix
	if err := s.writeQueue(next); err != nil {
		return err
	}
	s.queue = next
	return nil
}

func (s *persistentStore) acknowledge(prefix int) error {
	if err := s.ensureUsable(); err != nil {
		return err
	}
	if prefix <= 0 || prefix > len(s.queue.Events) {
		return s.fail(persistenceSDKError("persistence_integrity_error"))
	}
	next := clonePersistedQueue(s.queue)
	remaining := make([]json.RawMessage, len(next.Events)-prefix)
	copy(remaining, next.Events[prefix:])
	for index := 0; index < prefix; index++ {
		clear(next.Events[index])
	}
	next.Events = remaining
	next.PendingBody = nil
	next.PendingPrefix = 0
	if err := s.writeQueue(next); err != nil {
		return err
	}
	s.queue = next
	return nil
}

func (s *persistentStore) writeQueue(queue persistedQueue) error {
	if err := s.validateQueue(queue); err != nil {
		return s.fail(err)
	}
	plain, err := json.Marshal(queue)
	if err != nil {
		return s.fail(persistenceSDKError("persistence_integrity_error"))
	}
	defer clear(plain)
	encoded, err := s.encrypt("queue", plain)
	if err != nil {
		return s.fail(err)
	}
	defer clear(encoded)
	var expected *[sha256.Size]byte
	if s.queueDigestSet {
		expected = &s.queueDigest
	}
	if err := s.files.atomicReplace(persistentQueueFile, encoded, expected); err != nil {
		return s.fail(err)
	}
	s.queueDigest = sha256.Sum256(encoded)
	s.queueDigestSet = true
	return nil
}

func (s *persistentStore) validateQueue(queue persistedQueue) error {
	if queue.Version != persistenceVersion {
		return persistenceSDKError("persistence_integrity_error")
	}
	if len(queue.Events) > s.maxEvents {
		return persistenceSDKError("persistence_overflow")
	}
	total := 0
	for _, raw := range queue.Events {
		total += len(raw)
		if total > s.maxStoredBytes {
			return persistenceSDKError("persistence_overflow")
		}
		var event Event
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&event); err != nil || event.ID == "" || event.Type == "" || event.Timestamp == "" {
			return persistenceSDKError("persistence_integrity_error")
		}
		if err := ensureJSONEOF(decoder); err != nil {
			return err
		}
	}
	if queue.PendingPrefix < 0 || queue.PendingPrefix > len(queue.Events) {
		return persistenceSDKError("persistence_integrity_error")
	}
	if (queue.PendingPrefix == 0) != (len(queue.PendingBody) == 0) {
		return persistenceSDKError("persistence_integrity_error")
	}
	if len(queue.PendingBody) > s.maxStoredBytes*2+1024*1024 {
		return persistenceSDKError("persistence_overflow")
	}
	return nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return persistenceSDKError("persistence_integrity_error")
	}
	return nil
}

func (s *persistentStore) decodeEvents() ([]Event, error) {
	events := make([]Event, 0, len(s.queue.Events))
	for _, raw := range s.queue.Events {
		var event Event
		if err := json.Unmarshal(raw, &event); err != nil {
			return nil, persistenceSDKError("persistence_integrity_error")
		}
		events = append(events, event)
	}
	return events, nil
}

func (s *persistentStore) encrypt(kind string, plain []byte) ([]byte, error) {
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, persistenceSDKError("persistence_io_error")
	}
	sealed := s.aead.Seal(nil, nonce, plain, persistenceAAD(kind, s.ownerMarker))
	encoded := make([]byte, 0, len(persistenceEnvelopeMagic)+len(nonce)+len(sealed))
	encoded = append(encoded, persistenceEnvelopeMagic...)
	encoded = append(encoded, nonce...)
	encoded = append(encoded, sealed...)
	return encoded, nil
}

func (s *persistentStore) decrypt(kind string, encoded []byte) ([]byte, error) {
	minimum := len(persistenceEnvelopeMagic) + s.aead.NonceSize() + s.aead.Overhead()
	if len(encoded) < minimum || !bytes.Equal(encoded[:len(persistenceEnvelopeMagic)], persistenceEnvelopeMagic) {
		return nil, persistenceSDKError("persistence_integrity_error")
	}
	nonceStart := len(persistenceEnvelopeMagic)
	nonceEnd := nonceStart + s.aead.NonceSize()
	plain, err := s.aead.Open(nil, encoded[nonceStart:nonceEnd], encoded[nonceEnd:], persistenceAAD(kind, s.ownerMarker))
	if err != nil {
		return nil, persistenceSDKError("persistence_integrity_error")
	}
	return plain, nil
}

func persistenceAAD(kind string, ownerMarker [sha256.Size]byte) []byte {
	aad := []byte("logbrew-go-persistence-v1:" + kind + ":")
	return append(aad, ownerMarker[:]...)
}

func clonePersistedQueue(queue persistedQueue) persistedQueue {
	cloned := queue
	cloned.Events = make([]json.RawMessage, len(queue.Events))
	for index := range queue.Events {
		cloned.Events[index] = append(json.RawMessage(nil), queue.Events[index]...)
	}
	cloned.PendingBody = append([]byte(nil), queue.PendingBody...)
	return cloned
}

func (s *persistentStore) storedBytes() int {
	total := 0
	for _, event := range s.queue.Events {
		total += len(event)
	}
	return total
}

func (s *persistentStore) maxFileBytes() int64 {
	return int64(s.maxStoredBytes)*4 + 1024*1024
}

func (s *persistentStore) ensureUsable() error {
	if s == nil || s.files == nil || s.ownerPID != os.Getpid() {
		return persistenceSDKError("persistence_owner_changed")
	}
	if s.failed != nil {
		return s.failed
	}
	if err := s.files.verifyBoundary(); err != nil {
		return s.fail(err)
	}
	if err := s.files.validateLayout(); err != nil {
		return s.fail(err)
	}
	if s.keyDigestSet {
		encoded, err := s.files.read(persistentKeyFile, 1024)
		if err != nil || sha256.Sum256(encoded) != s.keyDigest {
			return s.fail(persistenceSDKError("persistence_integrity_error"))
		}
	}
	if s.queueDigestSet {
		encoded, err := s.files.read(persistentQueueFile, s.maxFileBytes())
		if err != nil || sha256.Sum256(encoded) != s.queueDigest {
			return s.fail(persistenceSDKError("persistence_integrity_error"))
		}
	}
	return nil
}

func (s *persistentStore) fail(err error) error {
	if err == nil {
		return nil
	}
	s.failed = err
	return err
}

func (s *persistentStore) close() error {
	if s == nil {
		return nil
	}
	if s.ownerPID != os.Getpid() {
		return persistenceSDKError("persistence_owner_changed")
	}
	return s.closeIgnoringOwner()
}

func (s *persistentStore) closeIgnoringOwner() error {
	if s == nil {
		return nil
	}
	clear(s.key)
	clear(s.ownerMarker[:])
	s.aead = nil
	if s.files == nil {
		return nil
	}
	err := s.files.close()
	s.files = nil
	return err
}

func persistenceSDKError(code string) *SdkError {
	messages := map[string]string{
		"persistence_configuration_error": "persistent delivery configuration is invalid",
		"persistence_unsupported":         "persistent delivery is unsupported on this filesystem",
		"persistence_in_use":              "persistent delivery directory is already owned",
		"persistence_owner_changed":       "persistent delivery process ownership changed",
		"persistence_key_mismatch":        "persistent delivery key does not match",
		"persistence_integrity_error":     "persistent delivery state failed integrity checks",
		"persistence_io_error":            "persistent delivery storage operation failed",
		"persistence_overflow":            "persistent delivery storage limit exceeded",
	}
	message, ok := messages[code]
	if !ok {
		message = "persistent delivery failed"
	}
	return &SdkError{Code: code, Message: message}
}
