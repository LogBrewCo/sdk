//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package logbrew

import (
	"crypto/sha256"
	"os"
	"syscall"
)

func (f *unixPersistentFiles) atomicReplace(name string, data []byte, expected *[sha256.Size]byte) error {
	if name != persistentKeyFile && name != persistentQueueFile {
		return persistenceSDKError("persistence_integrity_error")
	}
	if err := f.verifyBoundary(); err != nil {
		return err
	}
	if len(data) == 0 || int64(len(data)) > maxPersistenceFileBytes {
		return persistenceSDKError("persistence_integrity_error")
	}
	if present, err := f.exists(persistentIntentFile); err != nil || present {
		if err != nil {
			return err
		}
		return persistenceSDKError("persistence_integrity_error")
	}
	if present, err := f.exists(persistentTempFile); err != nil || present {
		if err != nil {
			return err
		}
		return persistenceSDKError("persistence_integrity_error")
	}
	temp, tempIdentity, err := f.createOwnedFile(persistentTempFile)
	if err != nil {
		return err
	}
	defer temp.Close()
	if err := f.writeAndSync(temp, data); err != nil {
		return err
	}
	if err := f.failAt("after_temp_sync"); err != nil {
		return err
	}
	if identity, err := f.verifyOpenFile(f.path(persistentTempFile), temp, false); err != nil || identity != tempIdentity {
		return persistenceSDKError("persistence_integrity_error")
	}
	digest := sha256.Sum256(data)
	intent := encodePersistenceIntent(name, digest)
	intentHandle, _, err := f.createOwnedFile(persistentIntentFile)
	if err != nil {
		return err
	}
	if err := f.writeAndSync(intentHandle, intent); err != nil {
		intentHandle.Close()
		return err
	}
	if err := intentHandle.Close(); err != nil {
		return persistenceSDKError("persistence_io_error")
	}
	if err := f.syncDirectory(); err != nil {
		return err
	}
	if err := f.failAt("after_intent_sync"); err != nil {
		return err
	}
	if identity, err := f.verifyOpenFile(f.path(persistentTempFile), temp, false); err != nil || identity != tempIdentity {
		return persistenceSDKError("persistence_integrity_error")
	}
	if expected != nil {
		current, err := f.read(name, maxPersistenceFileBytes)
		if err != nil || sha256.Sum256(current) != *expected {
			return persistenceSDKError("persistence_integrity_error")
		}
	} else if present, err := f.exists(name); err != nil || present {
		if err != nil {
			return err
		}
		return persistenceSDKError("persistence_integrity_error")
	}
	if err := os.Rename(f.path(persistentTempFile), f.path(name)); err != nil {
		return persistenceSDKError("persistence_io_error")
	}
	if err := f.failAt("after_rename"); err != nil {
		return err
	}
	if err := f.syncDirectory(); err != nil {
		return err
	}
	committed, err := f.read(name, maxPersistenceFileBytes)
	if err != nil || sha256.Sum256(committed) != digest {
		return persistenceSDKError("persistence_integrity_error")
	}
	if err := f.removeVerified(persistentIntentFile); err != nil {
		return err
	}
	return f.syncDirectory()
}

func (f *unixPersistentFiles) recoverTransaction() error {
	intentExists, err := f.exists(persistentIntentFile)
	if err != nil {
		return err
	}
	tempExists, err := f.exists(persistentTempFile)
	if err != nil {
		return err
	}
	if !intentExists {
		if tempExists {
			if err := f.removeVerified(persistentTempFile); err != nil {
				return err
			}
			return f.syncDirectory()
		}
		return nil
	}
	encodedIntent, err := f.read(persistentIntentFile, persistenceIntentSize)
	if err != nil {
		return err
	}
	target, digest, err := decodePersistenceIntent(encodedIntent)
	if err != nil {
		return err
	}
	if tempExists {
		tempData, readErr := f.read(persistentTempFile, maxPersistenceFileBytes)
		if readErr != nil || sha256.Sum256(tempData) != digest {
			return persistenceSDKError("persistence_integrity_error")
		}
		if err := os.Rename(f.path(persistentTempFile), f.path(target)); err != nil {
			return persistenceSDKError("persistence_io_error")
		}
	} else {
		targetData, readErr := f.read(target, maxPersistenceFileBytes)
		if readErr != nil || sha256.Sum256(targetData) != digest {
			return persistenceSDKError("persistence_integrity_error")
		}
	}
	if err := f.syncDirectory(); err != nil {
		return err
	}
	targetData, err := f.read(target, maxPersistenceFileBytes)
	if err != nil || sha256.Sum256(targetData) != digest {
		return persistenceSDKError("persistence_integrity_error")
	}
	if err := f.removeVerified(persistentIntentFile); err != nil {
		return err
	}
	return f.syncDirectory()
}

func (f *unixPersistentFiles) createOwnedFile(name string) (*os.File, persistenceFileIdentity, error) {
	path := f.path(name)
	fd, err := syscall.Open(path, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, persistenceFileIdentity{}, persistenceSDKError("persistence_io_error")
	}
	if err := syscall.Fchmod(fd, 0o600); err != nil {
		syscall.Close(fd)
		return nil, persistenceFileIdentity{}, persistenceSDKError("persistence_unsupported")
	}
	handle := os.NewFile(uintptr(fd), name)
	identity, err := f.verifyOpenFile(path, handle, false)
	if err != nil {
		handle.Close()
		return nil, persistenceFileIdentity{}, err
	}
	return handle, identity, nil
}

func (f *unixPersistentFiles) writeAndSync(handle *os.File, data []byte) error {
	for written := 0; written < len(data); {
		count, err := handle.Write(data[written:])
		if err != nil || count <= 0 {
			return persistenceSDKError("persistence_io_error")
		}
		written += count
	}
	if err := handle.Sync(); err != nil {
		return persistenceSDKError("persistence_io_error")
	}
	return nil
}

func encodePersistenceIntent(target string, digest [sha256.Size]byte) []byte {
	kind := byte(0)
	if target == persistentKeyFile {
		kind = 1
	} else if target == persistentQueueFile {
		kind = 2
	}
	encoded := make([]byte, persistenceIntentSize)
	encoded[0] = persistenceIntentVersion
	encoded[1] = kind
	copy(encoded[2:], digest[:])
	return encoded
}

func decodePersistenceIntent(encoded []byte) (string, [sha256.Size]byte, error) {
	var digest [sha256.Size]byte
	if len(encoded) != persistenceIntentSize || encoded[0] != persistenceIntentVersion {
		return "", digest, persistenceSDKError("persistence_integrity_error")
	}
	var target string
	switch encoded[1] {
	case 1:
		target = persistentKeyFile
	case 2:
		target = persistentQueueFile
	default:
		return "", digest, persistenceSDKError("persistence_integrity_error")
	}
	copy(digest[:], encoded[2:])
	return target, digest, nil
}
